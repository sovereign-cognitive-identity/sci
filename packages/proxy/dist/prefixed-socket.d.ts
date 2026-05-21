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
import type net from 'net';
export declare class PrefixedSocket extends Duplex {
    private _underlying;
    private _prefix;
    private _flowing;
    constructor(socket: net.Socket, prefix: Buffer | null);
    _read(_size: number): void;
    _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (err?: Error | null) => void): void;
    _final(callback: (err?: Error | null) => void): void;
    _destroy(err: Error | null, callback: (err: Error | null) => void): void;
    get remoteAddress(): string | undefined;
    get remotePort(): number | undefined;
    get localAddress(): string | undefined;
    get localPort(): number | undefined;
}
//# sourceMappingURL=prefixed-socket.d.ts.map