export interface WGKeypair {
    privateKey: string;
    publicKey: string;
}
/**
 * Generate an X25519 (Curve25519) keypair and return wireguard-format
 * base64 strings. wireguard uses the 32-byte raw private key (clamped) and
 * the 32-byte raw public key. Node's createPrivateKey/createPublicKey expose
 * those bytes via DER; we slice them out.
 */
export declare function generateKeypair(): WGKeypair;
/** Derive the public key from a base64 private key. Useful for verification. */
export declare function derivePublic(privateKeyB64: string): string;
export declare function generatePresharedKey(): string;
export interface ServerConfig {
    privateKey: string;
    serverIp: string;
    subnet: string;
    listenPort: number;
    peers: PeerConfig[];
    postUp?: string;
    postDown?: string;
}
export interface PeerConfig {
    publicKey: string;
    presharedKey?: string | null;
    allowedIp: string;
    comment?: string;
}
export declare function renderServerConfig(c: ServerConfig): string;
export interface ClientConfig {
    privateKey: string;
    assignedIp: string;
    subnetCidr: string;
    serverPublicKey: string;
    serverEndpoint: string;
    presharedKey?: string | null;
    /** What the client should route through the tunnel. Default: just the
     *  proxy subnet — only AI traffic goes through Sci. */
    allowedIps?: string;
    dns?: string;
    proxyHttpUrl?: string;
    proxyApiBase?: string;
    serverIp?: string;
}
export declare function renderClientConfig(c: ClientConfig): string;
//# sourceMappingURL=wireguard.d.ts.map