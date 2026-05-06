/**
 * Minimal UDP DNS server for fake IP assignment.
 *
 * Listens on 127.0.0.1:5353 (no root needed).
 * - AI domains  → fake IPs in 198.18.0.0/15 (from fake-ip.ts)
 * - Everything  → forwarded to 8.8.8.8 (real DNS)
 *
 * Configured via /etc/resolver/<domain> for per-domain resolution on macOS.
 * Only DNS queries for AI-owned domains ever reach this server.
 *
 * DNS packet format is minimal: we only handle A record queries.
 */

import dgram from 'dgram'
import { assignFakeIP, isAIHostname } from './fake-ip.js'

export const DNS_PORT = parseInt(process.env['SCI_DNS_PORT'] ?? '15353')
const REAL_DNS = '8.8.8.8'
const REAL_DNS_PORT = 53

// ── DNS packet helpers ────────────────────────────────────────────────────────

/** Parse the question section hostname from a DNS query buffer. */
function parseQueryName(buf: Buffer, offset: number): { name: string; nextOffset: number } {
  const labels: string[] = []
  let pos = offset

  while (pos < buf.length) {
    const len = buf[pos]!
    if (len === 0) { pos++; break }
    if ((len & 0xc0) === 0xc0) { // pointer — shouldn't appear in queries
      pos += 2; break
    }
    labels.push(buf.slice(pos + 1, pos + 1 + len).toString('ascii'))
    pos += 1 + len
  }

  return { name: labels.join('.'), nextOffset: pos }
}

/** Build a DNS A-record response. */
function buildAResponse(query: Buffer, txid: number, hostname: string, ip: string): Buffer {
  const ipParts = ip.split('.').map(Number)

  // Find where the question section starts (after the 12-byte header)
  const { nextOffset: questionEnd } = parseQueryName(query, 12)
  const questionSection = query.slice(12, questionEnd + 4) // name + QTYPE + QCLASS

  const response = Buffer.allocUnsafe(12 + questionSection.length + 16)
  let off = 0

  // Header
  response.writeUInt16BE(txid, off); off += 2      // Transaction ID
  response.writeUInt16BE(0x8180, off); off += 2    // Flags: QR=1, AA=1, RD=1, RA=1
  response.writeUInt16BE(1, off); off += 2         // QDCOUNT = 1
  response.writeUInt16BE(1, off); off += 2         // ANCOUNT = 1
  response.writeUInt16BE(0, off); off += 2         // NSCOUNT = 0
  response.writeUInt16BE(0, off); off += 2         // ARCOUNT = 0

  // Question section (copy from query)
  questionSection.copy(response, off)
  off += questionSection.length

  // Answer section
  response.writeUInt16BE(0xc00c, off); off += 2    // Name: pointer to offset 12
  response.writeUInt16BE(1, off); off += 2         // TYPE = A
  response.writeUInt16BE(1, off); off += 2         // CLASS = IN
  response.writeUInt32BE(300, off); off += 4       // TTL = 300s
  response.writeUInt16BE(4, off); off += 2         // RDLENGTH = 4
  for (const octet of ipParts) {
    response.writeUInt8(octet, off); off++
  }

  return response.slice(0, off)
}

/** Build a DNS NOERROR response with no answers (suppresses AAAA without error). */
function buildEmptyResponse(txid: number, query: Buffer): Buffer {
  const { nextOffset: questionEnd } = parseQueryName(query, 12)
  const questionSection = query.slice(12, questionEnd + 4)
  const response = Buffer.allocUnsafe(12 + questionSection.length)
  let off = 0
  response.writeUInt16BE(txid, off); off += 2
  response.writeUInt16BE(0x8180, off); off += 2  // QR=1, AA=1, RD=1, RA=1, RCODE=0
  response.writeUInt16BE(1, off); off += 2       // QDCOUNT=1
  response.writeUInt16BE(0, off); off += 2       // ANCOUNT=0
  response.writeUInt16BE(0, off); off += 2       // NSCOUNT=0
  response.writeUInt16BE(0, off); off += 2       // ARCOUNT=0
  questionSection.copy(response, off)
  return response
}

/** Build a DNS NXDOMAIN response (for failed forwards). */
function buildNXDomain(txid: number): Buffer {
  const buf = Buffer.allocUnsafe(12)
  buf.writeUInt16BE(txid, 0)
  buf.writeUInt16BE(0x8183, 2)  // QR=1, RD=1, RA=1, RCODE=3 (NXDOMAIN)
  buf.writeUInt32BE(0, 4)
  buf.writeUInt32BE(0, 8)
  return buf
}

// ── DNS server ────────────────────────────────────────────────────────────────

export function startDNSServer(): dgram.Socket {
  const server = dgram.createSocket('udp4')

  server.on('message', (msg, rinfo) => {
    if (msg.length < 12) return

    const txid = msg.readUInt16BE(0)
    const flags = msg.readUInt16BE(2)
    const isQuery = (flags & 0x8000) === 0
    if (!isQuery) return

    const qdCount = msg.readUInt16BE(4)
    if (qdCount !== 1) return

    const { name, nextOffset } = parseQueryName(msg, 12)
    const qtype = msg.readUInt16BE(nextOffset)

    const QTYPE_A    = 1
    const QTYPE_AAAA = 28

    if (isAIHostname(name)) {
      if (qtype === QTYPE_A) {
        // Return fake IPv4 — routes to our TUN
        const fakeIP = assignFakeIP(name)
        process.stderr.write(`[dns] ${name} → ${fakeIP} (fake A)\n`)
        server.send(buildAResponse(msg, txid, name, fakeIP), rinfo.port, rinfo.address)
      } else if (qtype === QTYPE_AAAA) {
        // Suppress AAAA — return NOERROR with no answers so client falls back to A.
        // Without this, clients prefer IPv6 and bypass our IPv4 fake IP route entirely.
        process.stderr.write(`[dns] ${name} AAAA suppressed\n`)
        server.send(buildEmptyResponse(txid, msg), rinfo.port, rinfo.address)
      } else {
        forwardToRealDNS(msg, txid, rinfo, server)
      }
    } else {
      // Non-AI domain — forward everything to real DNS
      forwardToRealDNS(msg, txid, rinfo, server)
    }
  })

  server.on('error', (err) => {
    process.stderr.write(`[dns] error: ${err.message}\n`)
  })

  server.bind(DNS_PORT, '127.0.0.1', () => {
    process.stderr.write(`[dns] Listening on 127.0.0.1:${DNS_PORT}\n`)
  })

  return server
}

/** Forward a DNS query to 8.8.8.8 and relay the response back. */
function forwardToRealDNS(
  query: Buffer,
  txid: number,
  rinfo: dgram.RemoteInfo,
  server: dgram.Socket
): void {
  const upstream = dgram.createSocket('udp4')

  const timeout = setTimeout(() => {
    upstream.close()
    server.send(buildNXDomain(txid), rinfo.port, rinfo.address)
  }, 3000)

  upstream.once('message', (response) => {
    clearTimeout(timeout)
    upstream.close()
    server.send(response, rinfo.port, rinfo.address)
  })

  upstream.on('error', () => {
    clearTimeout(timeout)
    upstream.close()
    server.send(buildNXDomain(txid), rinfo.port, rinfo.address)
  })

  upstream.send(query, REAL_DNS_PORT, REAL_DNS)
}
