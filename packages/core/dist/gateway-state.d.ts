export interface GatewayState {
    id: string;
    wgPrivateKey: string;
    wgPublicKey: string;
    wgListenPort: number;
    wgSubnet: string;
    wgServerIp: string;
    proxyIp: string;
    externalEndpoint: string | null;
    nextPeerOctet: number;
}
export declare function getGatewayState(): Promise<GatewayState | null>;
export declare function ensureGatewayState(opts?: {
    externalEndpoint?: string;
    listenPort?: number;
}): Promise<GatewayState>;
export declare function setExternalEndpoint(endpoint: string): Promise<void>;
//# sourceMappingURL=gateway-state.d.ts.map