import { type AgentTier } from './auth.js';
export interface Device {
    id: string;
    userId: string;
    profileId: string;
    agentId: string;
    name: string;
    platform: string | null;
    wgPublicKey: string;
    wgAssignedIp: string;
    status: 'active' | 'revoked';
    createdAt: Date;
    lastSeenAt: Date | null;
    revokedAt: Date | null;
}
export interface NewDevice {
    device: Device;
    /** Plaintext WireGuard private key — show once, never stored. */
    wgPrivateKey: string;
    wgPresharedKey: string | null;
    /** Plaintext sci agent token — show once. */
    agentToken: string;
    agentTier: AgentTier;
    /** Server's wg public key + endpoint, for client config rendering. */
    server: {
        publicKey: string;
        endpoint: string;
        subnet: string;
        serverIp: string;
        proxyIp: string;
    };
}
export interface DeviceListOpts {
    userId: string;
    includeRevoked?: boolean;
}
export declare function listDevices(opts: DeviceListOpts): Promise<Device[]>;
export declare function getDevice(id: string): Promise<Device | null>;
export declare function getDeviceByPublicKey(pubkey: string): Promise<Device | null>;
export interface CreateDeviceInput {
    userId: string;
    profileId: string;
    name: string;
    platform?: string;
    /** Tier for the device's agent. Default 'standard'. */
    tier?: AgentTier;
    /** If supplied, use this wireguard public key (client-side keygen).
     *  Otherwise the server generates a keypair and returns the private key. */
    publicKey?: string;
}
export declare function createDevice(input: CreateDeviceInput): Promise<NewDevice>;
export declare function revokeDevice(deviceId: string, userId: string): Promise<void>;
export declare function touchDeviceLastSeen(agentId: string): Promise<void>;
/**
 * For the gateway sync endpoint: list every active peer with assigned IP.
 * Returns the data the gateway needs to render its `[Peer]` blocks.
 */
export interface PeerSnapshot {
    publicKey: string;
    presharedKey: string | null;
    assignedIp: string;
    deviceName: string;
    deviceId: string;
}
export declare function listActivePeers(): Promise<PeerSnapshot[]>;
//# sourceMappingURL=devices.d.ts.map