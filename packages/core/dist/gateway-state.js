/**
 * Gateway state — singleton row holding the wireguard server's identity
 * and its subnet plan. Created once during `sci setup` (or first call to
 * `ensureGatewayState`).
 */
import { reader, writer } from './db.js';
import { generateKeypair } from './wireguard.js';
export async function getGatewayState() {
    const { rows } = await reader.query(`SELECT id, wg_private_key, wg_public_key, wg_listen_port, wg_subnet,
            wg_server_ip, proxy_ip, external_endpoint, next_peer_octet
     FROM gateway_state LIMIT 1`);
    const r = rows[0];
    if (!r)
        return null;
    return {
        id: r.id,
        wgPrivateKey: r.wg_private_key,
        wgPublicKey: r.wg_public_key,
        wgListenPort: r.wg_listen_port,
        wgSubnet: r.wg_subnet,
        wgServerIp: r.wg_server_ip,
        proxyIp: r.proxy_ip,
        externalEndpoint: r.external_endpoint,
        nextPeerOctet: r.next_peer_octet,
    };
}
export async function ensureGatewayState(opts = {}) {
    const existing = await getGatewayState();
    if (existing)
        return existing;
    const kp = generateKeypair();
    const port = opts.listenPort ?? 51820;
    await writer.query(`INSERT INTO gateway_state
       (wg_private_key, wg_public_key, wg_listen_port, external_endpoint)
     VALUES ($1, $2, $3, $4)`, [kp.privateKey, kp.publicKey, port, opts.externalEndpoint ?? null]);
    return (await getGatewayState());
}
export async function setExternalEndpoint(endpoint) {
    await writer.query(`UPDATE gateway_state SET external_endpoint = $1, updated_at = NOW()`, [endpoint]);
}
//# sourceMappingURL=gateway-state.js.map