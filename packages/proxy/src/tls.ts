/**
 * TLS certificate management for the Sci VPN proxy.
 *
 * Uses node-forge for proper CA cert generation and per-host cert signing.
 * The CA is generated once and stored in ~/.sci/certs/.
 * Per-host certs are generated on-demand and cached in memory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import tls from 'tls'
import forge from 'node-forge'

const CERT_DIR = join(homedir(), '.sci', 'certs')
const certCache = new Map<string, tls.SecureContext>()

export interface CertPair { cert: string; key: string }

export function getCACertPath(): string { return join(CERT_DIR, 'ca.crt') }
export function getCAKeyPath(): string  { return join(CERT_DIR, 'ca.key') }

// ── CA cert ───────────────────────────────────────────────────────────────────

export function ensureCACert(): CertPair {
  if (!existsSync(CERT_DIR)) mkdirSync(CERT_DIR, { recursive: true })

  const certPath = getCACertPath()
  const keyPath  = getCAKeyPath()

  if (existsSync(certPath) && existsSync(keyPath)) {
    return { cert: readFileSync(certPath, 'utf-8'), key: readFileSync(keyPath, 'utf-8') }
  }

  process.stderr.write('[tls] Generating Sci CA certificate...\n')

  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter  = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10)

  const attrs = [
    { name: 'commonName',         value: 'Sci Local CA' },
    { name: 'organizationName',   value: 'Sci' },
    { name: 'countryName',        value: 'US' },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
    { name: 'subjectKeyIdentifier' },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())

  const pem = { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) }
  writeFileSync(certPath, pem.cert)
  writeFileSync(keyPath,  pem.key)
  process.stderr.write(`[tls] CA cert written to ${CERT_DIR}\n`)
  return pem
}

// ── Per-host cert (signed by our CA) ─────────────────────────────────────────

export function getCertForHost(hostname: string, ca: CertPair): tls.SecureContext {
  const cached = certCache.get(hostname)
  if (cached) return cached

  const caKey  = forge.pki.privateKeyFromPem(ca.key)
  const caCert = forge.pki.certificateFromPem(ca.cert)

  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = Date.now().toString(16)
  cert.validity.notBefore = new Date()
  cert.validity.notAfter  = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1)

  cert.setSubject([{ name: 'commonName', value: hostname }])
  cert.setIssuer(caCert.subject.attributes)
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
  ])
  cert.sign(caKey, forge.md.sha256.create())

  const ctx = tls.createSecureContext({
    cert: forge.pki.certificateToPem(cert) + '\n' + ca.cert,
    key:  forge.pki.privateKeyToPem(keys.privateKey),
  })
  certCache.set(hostname, ctx)
  return ctx
}

// ── SNI callback ──────────────────────────────────────────────────────────────

export function makeSNICallback(
  ca: CertPair
): (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => void {
  return (servername, cb) => {
    try {
      cb(null, getCertForHost(servername, ca))
    } catch (err) {
      cb(err instanceof Error ? err : new Error(String(err)))
    }
  }
}
