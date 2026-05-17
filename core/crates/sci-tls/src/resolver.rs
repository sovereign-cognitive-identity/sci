//! Per-host leaf cert resolution for rustls.
//!
//! When a client opens TLS to (say) `api.anthropic.com` through the
//! agent, rustls calls our `ResolvesServerCert::resolve` with the SNI
//! it received. We mint a leaf cert for that exact hostname signed by
//! the local Sci CA and hand it back. Subsequent requests to the same
//! hostname reuse a cached `CertifiedKey`.
//!
//! The leaf cert chain is `[leaf, ca]` — including the CA in the chain
//! so clients that haven't yet trusted the CA see "untrusted root,"
//! not "incomplete chain," and we get a clean error path. Once the
//! user trusts the CA in their system pool the chain validates.

use crate::ca::{Ca, sig_algo};
use crate::{Result, TlsError};
use once_cell::sync::OnceCell;
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, KeyUsagePurpose, SanType};
use rustls::ServerConfig;
use rustls::crypto::ring::sign;
use rustls::pki_types::CertificateDer;
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use time::{Duration, OffsetDateTime};

/// Manual `Debug` because `KeyPair` (transitively held via `Ca`) doesn't
/// expose key bytes via Debug, and the `ResolvesServerCert` trait
/// requires `Debug + Send + Sync` on implementors. We surface the cache
/// size and CA fingerprint head — useful for diagnostics, no secrets.
pub struct CertResolver {
    ca:    Arc<Ca>,
    /// `hostname → CertifiedKey`. Cached for the resolver's lifetime;
    /// cert validity is 1 year so the cache won't grow stale before
    /// the user notices.
    cache: Mutex<HashMap<String, Arc<CertifiedKey>>>,
    /// CA cert as a `CertificateDer` so we can splice it into each
    /// leaf's chain without re-parsing the PEM per request. Built
    /// lazily on first use.
    ca_der: OnceCell<CertificateDer<'static>>,
}

impl std::fmt::Debug for CertResolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let cache_len = self.cache.lock().map(|c| c.len()).unwrap_or(0);
        f.debug_struct("CertResolver")
            .field("cached_hosts", &cache_len)
            .finish_non_exhaustive()
    }
}

impl CertResolver {
    pub fn new(ca: Arc<Ca>) -> Self {
        Self {
            ca,
            cache:  Mutex::new(HashMap::new()),
            ca_der: OnceCell::new(),
        }
    }

    fn ca_der(&self) -> Result<&CertificateDer<'static>> {
        self.ca_der.get_or_try_init(|| {
            let mut reader = self.ca.cert_pem.as_bytes();
            let der = rustls_pemfile::certs(&mut reader)
                .next()
                .ok_or_else(|| TlsError::Pem("no certs in ca.crt".into()))?
                .map_err(|e| TlsError::Pem(format!("ca.crt parse: {e}")))?;
            Ok(der)
        })
    }

    fn mint(&self, hostname: &str) -> Result<Arc<CertifiedKey>> {
        // Reject malformed / empty SNIs — a leaf cert with an empty
        // CN serves no purpose and rustls will refuse to ship it.
        if hostname.is_empty() {
            return Err(TlsError::Pem("empty SNI".into()));
        }

        let mut params = CertificateParams::new(vec![hostname.to_string()])?;
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, hostname);
        params.distinguished_name = dn;

        let now = OffsetDateTime::now_utc();
        params.not_before = now;
        params.not_after  = now + Duration::days(365);

        // SANs already include `hostname` from `CertificateParams::new`;
        // `extended_key_usages` defaults to ServerAuth via rcgen's CA
        // signing path. Explicit keyUsages match the TS leaf:
        params.key_usages = vec![
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::KeyEncipherment,
        ];
        // Belt-and-suspenders SAN — `new(vec![hostname])` covers it but
        // older rcgen versions varied on whether the CN duplicated into
        // SAN automatically. Explicit beats subtle.
        params.subject_alt_names = vec![SanType::DnsName(hostname.try_into().map_err(|_| {
            TlsError::Pem(format!("bad SNI for SAN: {hostname:?}"))
        })?)];

        let leaf_kp = KeyPair::generate_for(sig_algo())?;
        let leaf    = params.signed_by(&leaf_kp, &self.ca.issuer_cert, &self.ca.key_pair)?;

        // Build chain: [leaf, ca]. Including CA mirrors what the TS
        // agent does (concat leaf + CA PEMs) so clients see the same
        // chain shape across both implementations.
        let leaf_der = leaf.der().clone();
        let ca_der   = self.ca_der()?.clone();
        let chain    = vec![leaf_der, ca_der];

        // Convert key into a rustls `SigningKey`. rcgen's
        // `serialize_der` returns PKCS#8 DER bytes; wrap in the
        // matching pki-types newtype so `any_supported_type` knows
        // how to interpret them.
        let pkcs8 = rustls::pki_types::PrivatePkcs8KeyDer::from(leaf_kp.serialize_der());
        let signing_key = sign::any_supported_type(&pkcs8.into())
            .map_err(|e| TlsError::Rustls(format!("signing key: {e}")))?;

        Ok(Arc::new(CertifiedKey::new(chain, signing_key)))
    }
}

impl ResolvesServerCert for CertResolver {
    fn resolve(&self, client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let sni = client_hello.server_name()?;
        if let Ok(mut cache) = self.cache.lock() {
            if let Some(ck) = cache.get(sni) {
                return Some(ck.clone());
            }
            // Mint outside the lock would be cleaner concurrency-wise,
            // but a brief stall on a cold-cache miss is not the bottleneck
            // — the cert mint is sub-50ms on M-series. Hold the lock and
            // keep the implementation linear.
            match self.mint(sni) {
                Ok(ck) => {
                    cache.insert(sni.to_string(), ck.clone());
                    Some(ck)
                }
                Err(e) => {
                    // No way to surface this through the rustls trait;
                    // log and let the handshake fail with "no cert."
                    // Caller sees a TLS alert; agent stderr shows what
                    // went wrong.
                    eprintln!("[sci-tls] mint failed for {sni:?}: {e}");
                    None
                }
            }
        } else {
            None
        }
    }
}

/// Build a rustls `ServerConfig` ready to feed into
/// `tokio_rustls::TlsAcceptor`. Same shape every platform shell uses;
/// they just need to plug it into their own TCP-accept loop.
pub fn make_server_config(ca: Arc<Ca>) -> Result<ServerConfig> {
    let resolver = Arc::new(CertResolver::new(ca));
    let mut cfg = ServerConfig::builder()
        .with_no_client_auth()
        .with_cert_resolver(resolver);

    // The TS agent only speaks HTTP/1.1 to keep the MITM parser simple
    // (HTTP/2 over MITM means HPACK + frame parsing). Match that for now.
    // Upgrading to ALPN h2 is its own ticket; the gain is small for
    // request-shaped AI traffic.
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(cfg)
}
