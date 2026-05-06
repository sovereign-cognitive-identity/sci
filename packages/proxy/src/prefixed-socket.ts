/**
 * A Duplex stream that prepends a buffer to the read side of a net.Socket.
 *
 * We use this when SNI sniffing has consumed the first bytes of a TCP stream:
 * the peeked bytes need to be re-fed to whatever consumer comes next (e.g. a
 * tls.Server doing TLS termination). Plain socket.unshift() doesn't work
 * reliably with tls.Server because the TLS internals don't always read via
 * the standard Readable stream API.
 *
 * Wrapping in a Duplex gives us full control: we push the prefix as the first
 * read, then forward data from the underlying socket. Writes go straight to
 * the socket.
 */

import { Duplex } from 'stream'
import type net from 'net'

export class PrefixedSocket extends Duplex {
  private _underlying: net.Socket
  private _prefix: Buffer | null
  private _flowing = false

  constructor(socket: net.Socket, prefix: Buffer | null) {
    super({ allowHalfOpen: true })
    this._underlying = socket
    this._prefix = prefix && prefix.length > 0 ? prefix : null

    socket.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) socket.pause()
    })
    socket.on('end', () => this.push(null))
    socket.on('error', (err) => this.destroy(err))
    socket.on('close', () => this.push(null))
  }

  override _read(_size: number): void {
    if (this._prefix) {
      const p = this._prefix
      this._prefix = null
      this.push(p)
      return
    }
    if (!this._flowing) {
      this._flowing = true
      this._underlying.resume()
    } else {
      // Resume in case backpressure paused the underlying socket
      this._underlying.resume()
    }
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
    this._underlying.write(chunk, encoding, callback)
  }

  override _final(callback: (err?: Error | null) => void): void {
    this._underlying.end()
    callback()
  }

  override _destroy(err: Error | null, callback: (err: Error | null) => void): void {
    this._underlying.destroy(err ?? undefined)
    callback(err)
  }

  // tls.Server.emit('connection', socket) uses these:
  get remoteAddress(): string | undefined { return this._underlying.remoteAddress }
  get remotePort(): number | undefined { return this._underlying.remotePort }
  get localAddress(): string | undefined { return this._underlying.localAddress }
  get localPort(): number | undefined { return this._underlying.localPort }
}
