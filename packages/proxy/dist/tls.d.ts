import tls from 'tls';
export interface CertPair {
    cert: string;
    key: string;
}
export declare function getCACertPath(): string;
export declare function getCAKeyPath(): string;
export declare function ensureCACert(): CertPair;
export declare function getCertForHost(hostname: string, ca: CertPair): tls.SecureContext;
export declare function makeSNICallback(ca: CertPair): (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => void;
//# sourceMappingURL=tls.d.ts.map