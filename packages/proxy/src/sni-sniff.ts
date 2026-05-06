/**
 * TLS ClientHello SNI sniffer.
 *
 * Peeks the first bytes of a TCP stream, parses the TLS ClientHello, and
 * extracts the Server Name Indication extension. Used by the SOCKS5 server
 * to decide whether to intercept (TLS terminate) or pass through (raw tunnel)
 * a given connection.
 *
 * Necessary because all Anthropic hostnames (api.anthropic.com, claude.ai,
 * assets-proxy.anthropic.com, etc.) resolve to the same IP, and Chromium
 * has cached real IPs that bypass /etc/hosts. The IP alone tells us nothing
 * about which service the client is actually trying to reach — only the SNI
 * does.
 */

import type net from 'net'

/**
 * Parse SNI from a TLS ClientHello buffer.
 * Returns the server name (e.g. "api.anthropic.com") or null if not found.
 *
 * TLS ClientHello layout:
 *   Record header     (5 bytes): type(1) version(2) length(2)
 *   Handshake header  (4 bytes): type(1) length(3)
 *   Client version    (2)
 *   Random            (32)
 *   Session ID        (variable: 1 byte length + body)
 *   Cipher suites     (variable: 2 byte length + body)
 *   Compression       (variable: 1 byte length + body)
 *   Extensions        (variable: 2 byte length + body)
 *
 * SNI extension (type 0x0000):
 *   Server name list length (2)
 *   Name type (1) — 0x00 for host_name
 *   Host name length (2)
 *   Host name (variable)
 */
export function parseSNI(buf: Buffer): string | null {
  try {
    if (buf.length < 5) return null
    if (buf[0] !== 0x16) return null               // not TLS handshake
    if (buf.length < 5 + 4) return null            // need handshake header

    let p = 5                                       // skip record header
    if (buf[p] !== 0x01) return null               // not ClientHello
    p += 4                                          // skip handshake header (type + 3-byte length)
    p += 2                                          // skip client version
    p += 32                                         // skip random

    if (p >= buf.length) return null
    const sessionIdLen = buf[p]!
    p += 1 + sessionIdLen

    if (p + 2 > buf.length) return null
    const cipherSuitesLen = buf.readUInt16BE(p)
    p += 2 + cipherSuitesLen

    if (p >= buf.length) return null
    const compMethodsLen = buf[p]!
    p += 1 + compMethodsLen

    if (p + 2 > buf.length) return null             // no extensions
    const extLen = buf.readUInt16BE(p)
    p += 2
    const extEnd = Math.min(p + extLen, buf.length)

    while (p + 4 <= extEnd) {
      const extType = buf.readUInt16BE(p)
      const extDataLen = buf.readUInt16BE(p + 2)
      p += 4
      if (p + extDataLen > extEnd) return null

      if (extType === 0x0000) {
        // SNI extension
        if (extDataLen < 5) return null
        // server_name_list length (2 bytes) — we just iterate the list
        let q = p + 2
        const listEnd = p + extDataLen
        while (q + 3 <= listEnd) {
          const nameType = buf[q]!
          const nameLen = buf.readUInt16BE(q + 1)
          if (q + 3 + nameLen > listEnd) return null
          if (nameType === 0x00) {
            return buf.slice(q + 3, q + 3 + nameLen).toString('ascii')
          }
          q += 3 + nameLen
        }
        return null
      }

      p += extDataLen
    }
    return null
  } catch {
    return null
  }
}

/**
 * Read enough bytes from `socket` to parse the TLS ClientHello.
 * Returns the buffered bytes (so the caller can unshift them back) and the
 * extracted SNI (or null if no SNI / not TLS).
 *
 * Times out and returns whatever was read if no full ClientHello arrives.
 */
export function peekClientHello(
  socket: net.Socket,
  timeoutMs = 3000
): Promise<{ buffer: Buffer; sni: string | null }> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0)
    let done = false

    const finish = () => {
      if (done) return
      done = true
      socket.removeListener('data', onData)
      clearTimeout(timer)
      resolve({ buffer: buf, sni: parseSNI(buf) })
    }

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])

      // Not TLS at all? Bail immediately.
      if (buf.length >= 1 && buf[0] !== 0x16) return finish()

      // Need at least the record header to know how much to read
      if (buf.length < 5) return

      const recordLen = buf.readUInt16BE(3)
      // Have we read the full first TLS record? It contains the ClientHello.
      if (buf.length >= 5 + recordLen) return finish()

      // ClientHello can fit in one record (typically <16KB) — keep reading
    }

    const timer = setTimeout(finish, timeoutMs)
    socket.on('data', onData)
  })
}
