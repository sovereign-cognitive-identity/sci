//! CA generation + on-disk persistence.
//!
//! Drop-in compatible with `packages/agent/src/cert.ts`:
//!   * subject = `CN=Sci Local CA, O=Sci, C=US`
//!   * issuer = same (self-signed)
//!   * 10-year validity
//!   * basicConstraints CA:TRUE; keyUsage keyCertSign + cRLSign + digitalSignature
//!   * RSA-2048, SHA-256
//!   * PEM-encoded `ca.crt` (mode 0644) + `ca.key` (mode 0600)

use crate::{Result, TlsError};
use rcgen::{
    BasicConstraints, Certificate, CertificateParams, DistinguishedName, DnType, IsCa, KeyPair,
    KeyUsagePurpose, SignatureAlgorithm,
};
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use time::{Duration, OffsetDateTime};

/// Owned CA — both the parsed certificate (for chain construction in
/// rustls) and the keypair (so we can sign new leaves without re-parsing
/// the PEM on every request).
///
/// `cert_pem` is the on-disk PEM (preserved when loading from disk so
/// the user's trust pool keeps validating against the same fingerprint).
/// `issuer_cert` is an in-memory `Certificate` re-instantiated from the
/// same params + key — used as the `signed_by(.., &issuer, ..)` argument
/// when minting leaves. Same DN, same key → leaves validate against the
/// trusted on-disk CA byte-for-byte.
pub struct Ca {
    pub cert_pem:    String,
    pub key_pair:    KeyPair,
    pub(crate) issuer_cert: Certificate,
}

impl std::fmt::Debug for Ca {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Don't dump the keypair into logs. Subject + the first 32
        // chars of the cert PEM is enough fingerprint context.
        f.debug_struct("Ca")
            .field("cert_pem_head", &&self.cert_pem[..self.cert_pem.len().min(64)])
            .finish_non_exhaustive()
    }
}

impl Ca {
    pub fn cert_path(dir: impl AsRef<Path>) -> PathBuf { dir.as_ref().join("ca.crt") }
    pub fn key_path(dir: impl AsRef<Path>)  -> PathBuf { dir.as_ref().join("ca.key") }
}

/// Load `dir/ca.crt` + `dir/ca.key` if both exist; otherwise generate a
/// new CA and write both files. The directory must exist — we don't
/// `mkdir -p` here because the platform shell is the right layer for
/// "ensure config dir" decisions.
pub fn ensure_ca(dir: impl AsRef<Path>) -> Result<Ca> {
    let dir = dir.as_ref();
    let cert_path = Ca::cert_path(dir);
    let key_path  = Ca::key_path(dir);

    if cert_path.exists() && key_path.exists() {
        return load_ca(&cert_path, &key_path);
    }

    let ca = generate_ca()?;
    write_ca(&ca, &cert_path, &key_path)?;
    Ok(ca)
}

fn load_ca(cert_path: &Path, key_path: &Path) -> Result<Ca> {
    let cert_pem = fs::read_to_string(cert_path)?;
    let key_pem  = fs::read_to_string(key_path)?;

    // KeyPair::from_pem reads PKCS#8 PEM. The TS agent writes PKCS#1
    // ("BEGIN RSA PRIVATE KEY") via node-forge by default — which
    // rcgen also accepts, but only via `KeyPair::from_pem_and_sign_algo`.
    // Try the simpler form first; fall back to the explicit-algo
    // variant for older TS-generated keys.
    let key_pair = KeyPair::from_pem(&key_pem)
        .or_else(|_| KeyPair::from_pem_and_sign_algo(&key_pem, sig_algo()))
        .map_err(|e| TlsError::Pem(format!("ca.key: {e}")))?;

    let issuer_params = CertificateParams::from_ca_cert_pem(&cert_pem)
        .map_err(|e| TlsError::Pem(format!("ca.crt: {e}")))?;

    // Re-self-sign with the loaded keypair to recover a Certificate
    // value the leaf-signing API needs. Same DN + same params → leaves
    // signed against this Certificate are validated by the original
    // on-disk CA cert that the user has already trusted.
    let issuer_cert = issuer_params.self_signed(&key_pair)?;
    Ok(Ca { cert_pem, key_pair, issuer_cert })
}

fn generate_ca() -> Result<Ca> {
    let mut params = CertificateParams::new(Vec::<String>::new())?;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);

    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName,       "Sci Local CA");
    dn.push(DnType::OrganizationName, "Sci");
    dn.push(DnType::CountryName,      "US");
    params.distinguished_name = dn;

    let now = OffsetDateTime::now_utc();
    params.not_before = now;
    // 10 years matches the TS agent. Long-lived CAs reduce churn —
    // a user re-trusting their CA every year is friction we don't need.
    params.not_after  = now + Duration::days(365 * 10);

    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];

    let key_pair    = KeyPair::generate_for(sig_algo())?;
    let issuer_cert = params.self_signed(&key_pair)?;
    let cert_pem    = issuer_cert.pem();

    Ok(Ca { cert_pem, key_pair, issuer_cert })
}

fn write_ca(ca: &Ca, cert_path: &Path, key_path: &Path) -> Result<()> {
    fs::write(cert_path, ca.cert_pem.as_bytes())?;
    set_mode(cert_path, 0o644)?;

    let key_pem = ca.key_pair.serialize_pem();
    let mut f = fs::File::create(key_path)?;
    f.write_all(key_pem.as_bytes())?;
    set_mode(key_path, 0o600)?;
    Ok(())
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<()> {
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(mode);
    fs::set_permissions(path, perms)?;
    Ok(())
}

/// Static ref to the signature algorithm we use — ECDSA P-256 + SHA-256.
///
/// The TS agent (`packages/agent/src/cert.ts`) uses RSA-2048 because
/// node-forge was the simplest JavaScript option. rcgen 0.13 can't
/// generate RSA keys natively (it would need `aws-lc-rs` which adds a
/// cmake build dep on every user's machine), so the Rust core uses
/// ECDSA P-256 instead. Smaller signatures (~64 vs ~256 bytes), faster
/// handshakes, modern best practice; rustls + ring + Apple/Android/
/// Windows trust stores all accept it without configuration.
///
/// Loading an existing CA from disk: rcgen accepts both RSA (from a
/// previous TS install) and ECDSA PEMs via `KeyPair::from_pem`. So
/// users migrating from the TS agent keep their CA — only freshly-
/// generated CAs are ECDSA.
pub(crate) fn sig_algo() -> &'static SignatureAlgorithm {
    &rcgen::PKCS_ECDSA_P256_SHA256
}
