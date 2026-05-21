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
import { Duplex } from 'stream';
export class PrefixedSocket extends Duplex {
    _underlying;
    _prefix;
    _flowing = false;
    constructor(socket, prefix) {
        super({ allowHalfOpen: true });
        this._underlying = socket;
        this._prefix = prefix && prefix.length > 0 ? prefix : null;
        socket.on('data', (chunk) => {
            if (!this.push(chunk))
                socket.pause();
        });
        socket.on('end', () => this.push(null));
        socket.on('error', (err) => this.destroy(err));
        socket.on('close', () => this.push(null));
    }
    _read(_size) {
        if (this._prefix) {
            const p = this._prefix;
            this._prefix = null;
            this.push(p);
            return;
        }
        if (!this._flowing) {
            this._flowing = true;
            this._underlying.resume();
        }
        else {
            // Resume in case backpressure paused the underlying socket
            this._underlying.resume();
        }
    }
    _write(chunk, encoding, callback) {
        this._underlying.write(chunk, encoding, callback);
    }
    _final(callback) {
        this._underlying.end();
        callback();
    }
    _destroy(err, callback) {
        this._underlying.destroy(err ?? undefined);
        callback(err);
    }
    // tls.Server.emit('connection', socket) uses these:
    get remoteAddress() { return this._underlying.remoteAddress; }
    get remotePort() { return this._underlying.remotePort; }
    get localAddress() { return this._underlying.localAddress; }
    get localPort() { return this._underlying.localPort; }
}
//# sourceMappingURL=prefixed-socket.js.map