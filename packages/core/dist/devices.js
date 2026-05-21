/**
 * Devices — each device has a wireguard peer + an associated sci agent
 * (token + tier). Adding a device:
 *   1. generates a wireguard keypair (private key returned to user once)
 *   2. allocates the next free IP in the gateway subnet
 *   3. registers an agent + token tied to the device
 *   4. inserts the devices row
 *   5. notifies the gateway to reload its peer list
 *
 * Revoking a device:
 *   1. soft-deletes the device (status='revoked', revoked_at=NOW())
 *   2. revokes the agent's tokens (DELETE FROM agent_tokens WHERE agent_id = …)
 *   3. notifies the gateway
 *
 * The gateway reload is best-effort: if the gateway URL isn't set or the
 * call fails, peer changes still apply on the next gateway sync poll.
 */
import { reader, writer } from './db.js';
import { registerAgent } from './auth.js';
import { generateKeypair, generatePresharedKey } from './wireguard.js';
export async function listDevices(opts) {
    const where = opts.includeRevoked ? '' : `AND status = 'active'`;
    const { rows } = await reader.query(`SELECT id, user_id, profile_id, agent_id, name, platform,
            wg_public_key, wg_assigned_ip, status,
            created_at, last_seen_at, revoked_at
     FROM devices
     WHERE user_id = $1 ${where}
     ORDER BY created_at DESC`, [opts.userId]);
    return rows.map(r => ({
        id: r.id, userId: r.user_id, profileId: r.profile_id, agentId: r.agent_id,
        name: r.name, platform: r.platform,
        wgPublicKey: r.wg_public_key, wgAssignedIp: r.wg_assigned_ip,
        status: r.status, createdAt: r.created_at,
        lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at,
    }));
}
export async function getDevice(id) {
    const { rows } = await reader.query(`SELECT id, user_id, profile_id, agent_id, name, platform,
            wg_public_key, wg_assigned_ip, status,
            created_at, last_seen_at, revoked_at
     FROM devices WHERE id = $1`, [id]);
    const r = rows[0];
    if (!r)
        return null;
    return {
        id: r.id, userId: r.user_id, profileId: r.profile_id, agentId: r.agent_id,
        name: r.name, platform: r.platform,
        wgPublicKey: r.wg_public_key, wgAssignedIp: r.wg_assigned_ip,
        status: r.status, createdAt: r.created_at,
        lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at,
    };
}
export async function getDeviceByPublicKey(pubkey) {
    const { rows } = await reader.query(`SELECT id, user_id, profile_id, agent_id, name, platform,
            wg_public_key, wg_assigned_ip, status,
            created_at, last_seen_at, revoked_at
     FROM devices WHERE wg_public_key = $1`, [pubkey]);
    const r = rows[0];
    if (!r)
        return null;
    return {
        id: r.id, userId: r.user_id, profileId: r.profile_id, agentId: r.agent_id,
        name: r.name, platform: r.platform,
        wgPublicKey: r.wg_public_key, wgAssignedIp: r.wg_assigned_ip,
        status: r.status, createdAt: r.created_at,
        lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at,
    };
}
async function allocateNextIp() {
    // Atomically increment next_peer_octet, return previous value.
    const { rows } = await writer.query(`UPDATE gateway_state SET next_peer_octet = next_peer_octet + 1, updated_at = NOW()
     RETURNING wg_subnet, (next_peer_octet - 1) AS next_peer_octet`);
    const r = rows[0];
    if (!r)
        throw new Error('gateway_state not initialized — run setup first');
    // Compose IP: subnet 10.13.13.0/24 → 10.13.13.<octet>
    const base = r.wg_subnet.split('/')[0].split('.').slice(0, 3).join('.');
    if (r.next_peer_octet > 254)
        throw new Error('subnet exhausted');
    return `${base}.${r.next_peer_octet}`;
}
export async function createDevice(input) {
    // Resolve profile name (registerAgent takes profileName, not profileId)
    const { rows: profRows } = await reader.query('SELECT name FROM profiles WHERE id = $1 AND user_id = $2', [input.profileId, input.userId]);
    const profileName = profRows[0]?.name;
    if (!profileName)
        throw new Error('profile not found or not owned by user');
    // 1. Register agent (issues sci token + creates agents row)
    const tier = input.tier ?? 'standard';
    const agentName = `device:${input.userId.slice(0, 8)}:${input.name}`.slice(0, 64);
    const agent = await registerAgent(agentName, tier, profileName);
    // 2. Generate / accept wireguard keys
    let kp;
    let returnedPriv = '';
    if (input.publicKey) {
        kp = { privateKey: '', publicKey: input.publicKey };
    }
    else {
        kp = generateKeypair();
        returnedPriv = kp.privateKey;
    }
    const psk = generatePresharedKey();
    // 3. Allocate IP
    const assignedIp = await allocateNextIp();
    // 4. Insert device row
    const { rows } = await writer.query(`INSERT INTO devices
       (user_id, profile_id, agent_id, name, platform,
        wg_public_key, wg_preshared_key, wg_assigned_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at`, [input.userId, input.profileId, agent.agentId, input.name, input.platform ?? null,
        kp.publicKey, psk, assignedIp]);
    const deviceId = rows[0].id;
    // 5. Load gateway state for the response
    const { rows: gwRows } = await reader.query(`SELECT wg_public_key, external_endpoint, wg_listen_port,
            wg_subnet, wg_server_ip, proxy_ip
     FROM gateway_state LIMIT 1`);
    const gw = gwRows[0];
    if (!gw)
        throw new Error('gateway_state missing');
    const endpoint = gw.external_endpoint ?? `localhost:${gw.wg_listen_port}`;
    return {
        device: {
            id: deviceId, userId: input.userId, profileId: input.profileId, agentId: agent.agentId,
            name: input.name, platform: input.platform ?? null,
            wgPublicKey: kp.publicKey, wgAssignedIp: assignedIp,
            status: 'active', createdAt: rows[0].created_at,
            lastSeenAt: null, revokedAt: null,
        },
        wgPrivateKey: returnedPriv,
        wgPresharedKey: psk,
        agentToken: agent.token,
        agentTier: tier,
        server: {
            publicKey: gw.wg_public_key,
            endpoint,
            subnet: gw.wg_subnet,
            serverIp: gw.wg_server_ip,
            proxyIp: gw.proxy_ip,
        },
    };
}
export async function revokeDevice(deviceId, userId) {
    // Verify ownership
    const { rows } = await reader.query('SELECT agent_id, status FROM devices WHERE id = $1 AND user_id = $2', [deviceId, userId]);
    const d = rows[0];
    if (!d)
        throw new Error('device not found');
    if (d.status === 'revoked')
        return;
    await writer.query(`UPDATE devices SET status = 'revoked', revoked_at = NOW() WHERE id = $1`, [deviceId]);
    await writer.query('DELETE FROM agent_tokens WHERE agent_id = $1', [d.agent_id]);
}
export async function touchDeviceLastSeen(agentId) {
    await writer.query(`UPDATE devices SET last_seen_at = NOW() WHERE agent_id = $1 AND status = 'active'`, [agentId]).catch(() => { });
}
export async function listActivePeers() {
    const { rows } = await reader.query(`SELECT id, name, wg_public_key, wg_preshared_key, wg_assigned_ip
     FROM devices WHERE status = 'active'
     ORDER BY created_at`);
    return rows.map(r => ({
        publicKey: r.wg_public_key,
        presharedKey: r.wg_preshared_key,
        assignedIp: r.wg_assigned_ip,
        deviceName: r.name,
        deviceId: r.id,
    }));
}
//# sourceMappingURL=devices.js.map