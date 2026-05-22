/**
 * Sci CA + per-host leaf cert generation for the local agent.
 *
 * Adapted from `packages/proxy/src/tls.ts`. Same node-forge-based shape,
 * different paths (configDir is per-config, not hardcoded), and tightened
 * for single-user use (no multi-tenant cert distribution concerns).
 *
 * The CA is generated once on first run at `<configDir>/ca.crt` +
 * `<configDir>/ca.key`. Per-host leaf certs are generated on demand and
 * cached in memory.
 *
 * For a TLS-terminating MITM proxy to be trusted by client tools, the user
 * must add the CA to their system trust store. v0.5 prints instructions on
 * first generation; SCI-114 phase G automates this.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import tls from 'tls';
import forge from 'node-forge';
const certCache = new Map();
/**
 * Returns the CA cert + private key, generating them on first call if absent.
 *
 * @param configDir  where to read/write `ca.crt` and `ca.key`
 */
export function ensureCA(configDir) {
    const certPath = join(configDir, 'ca.crt');
    const keyPath = join(configDir, 'ca.key');
    if (!existsSync(configDir))
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
    if (existsSync(certPath) && existsSync(keyPath)) {
        const pair = {
            cert: readFileSync(certPath, 'utf-8'),
            key: readFileSync(keyPath, 'utf-8'),
        };
        // Validate the key is RSA PKCS#1 (what node-forge requires for signing).
        // If enrollment wrote a PKCS#8 or EC key, forge.pki.privateKeyFromPem
        // throws "ASN.1 object does not contain an RSAPrivateKey". Detect that
        // here and fall through to regenerate rather than failing every TLS handshake.
        try {
            forge.pki.privateKeyFromPem(pair.key);
            return pair;
        }
        catch {
            process.stderr.write('[sci-agent] CA key is not RSA PKCS#1 — regenerating local CA.\n');
        }
    }
    process.stderr.write('[sci-agent] generating Sci CA (one-time)...\n');
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
    const attrs = [
        { name: 'commonName', value: 'Sci Local CA' },
        { name: 'organizationName', value: 'Sci' },
        { name: 'countryName', value: 'US' },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
        { name: 'subjectKeyIdentifier' },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const pair = {
        cert: forge.pki.certificateToPem(cert),
        key: forge.pki.privateKeyToPem(keys.privateKey),
    };
    writeFileSync(certPath, pair.cert, { mode: 0o644 });
    writeFileSync(keyPath, pair.key, { mode: 0o600 });
    // Compute fingerprint for the user's reference. They'll need to verify
    // this matches when installing the CA into their system trust store.
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const md = forge.md.sha256.create();
    md.update(der);
    const fingerprint = md
        .digest()
        .toHex()
        .toUpperCase()
        .match(/.{2}/g)
        ?.join(':') ?? '?';
    process.stderr.write(`[sci-agent] CA written to ${configDir}\n` +
        `[sci-agent] CA fingerprint (sha256): ${fingerprint}\n` +
        `[sci-agent]\n` +
        `[sci-agent] To trust this CA on macOS:\n` +
        `[sci-agent]   security add-trusted-cert -r trustRoot \\\n` +
        `[sci-agent]     -k ~/Library/Keychains/login.keychain-db ${certPath}\n` +
        `[sci-agent]\n` +
        `[sci-agent] Or pass --cacert ${certPath} to curl-style tools.\n`);
    return pair;
}
/** Returns a TLS SecureContext for the given hostname, signing a new leaf
 *  cert with the Sci CA on first call and caching after. */
export function getContextForHost(hostname, ca) {
    const cached = certCache.get(hostname);
    if (cached)
        return cached;
    const caKey = forge.pki.privateKeyFromPem(ca.key);
    const caCert = forge.pki.certificateFromPem(ca.cert);
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = Date.now().toString(16);
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    cert.setSubject([{ name: 'commonName', value: hostname }]);
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
    ]);
    cert.sign(caKey, forge.md.sha256.create());
    const ctx = tls.createSecureContext({
        cert: forge.pki.certificateToPem(cert) + '\n' + ca.cert,
        key: forge.pki.privateKeyToPem(keys.privateKey),
    });
    certCache.set(hostname, ctx);
    return ctx;
}
/** SNI callback factory — closes over the CA so the TLSSocket can call it. */
export function makeSNICallback(ca) {
    return (servername, cb) => {
        try {
            cb(null, getContextForHost(servername, ca));
        }
        catch (err) {
            cb(err instanceof Error ? err : new Error(String(err)));
        }
    };
}
/** Path helpers for callers that want to point users at the CA file. */
export function caCertPath(configDir) { return join(configDir, 'ca.crt'); }
export function caKeyPath(configDir) { return join(configDir, 'ca.key'); }
//# sourceMappingURL=cert.js.map