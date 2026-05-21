import tls from 'tls';
export interface CertPair {
    cert: string;
    key: string;
}
/**
 * Returns the CA cert + private key, generating them on first call if absent.
 *
 * @param configDir  where to read/write `ca.crt` and `ca.key`
 */
export declare function ensureCA(configDir: string): CertPair;
/** Returns a TLS SecureContext for the given hostname, signing a new leaf
 *  cert with the Sci CA on first call and caching after. */
export declare function getContextForHost(hostname: string, ca: CertPair): tls.SecureContext;
/** SNI callback factory — closes over the CA so the TLSSocket can call it. */
export declare function makeSNICallback(ca: CertPair): (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => void;
/** Path helpers for callers that want to point users at the CA file. */
export declare function caCertPath(configDir: string): string;
export declare function caKeyPath(configDir: string): string;
