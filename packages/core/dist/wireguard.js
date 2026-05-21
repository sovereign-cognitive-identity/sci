/**
 * WireGuard key generation + config rendering.
 *
 * We do this in pure Node (no shell-out to `wg`) so the control plane and the
 * gateway container both work the same way regardless of whether wireguard
 * tooling is installed locally. Curve25519 keypairs are generated with
 * crypto.generateKeyPairSync('x25519').
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'crypto';
/**
 * Generate an X25519 (Curve25519) keypair and return wireguard-format
 * base64 strings. wireguard uses the 32-byte raw private key (clamped) and
 * the 32-byte raw public key. Node's createPrivateKey/createPublicKey expose
 * those bytes via DER; we slice them out.
 */
export function generateKeypair() {
    const { privateKey, publicKey } = generateKeyPairSync('x25519');
    // X25519 PKCS#8 DER for a private key is 48 bytes; the last 32 are the raw key.
    const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
    const rawPriv = privDer.subarray(privDer.length - 32);
    // SPKI DER for the public key is 44 bytes; the last 32 are the raw key.
    const pubDer = publicKey.export({ type: 'spki', format: 'der' });
    const rawPub = pubDer.subarray(pubDer.length - 32);
    return {
        privateKey: rawPriv.toString('base64'),
        publicKey: rawPub.toString('base64'),
    };
}
/** Derive the public key from a base64 private key. Useful for verification. */
export function derivePublic(privateKeyB64) {
    const raw = Buffer.from(privateKeyB64, 'base64');
    if (raw.length !== 32)
        throw new Error('invalid wireguard private key length');
    // Re-construct PKCS8 DER for X25519: 30 2e 02 01 00 30 05 06 03 2b 65 6e 04 22 04 20 <32 bytes>
    const prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
    const der = Buffer.concat([prefix, raw]);
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    const pub = createPublicKey(key);
    const pubDer = pub.export({ type: 'spki', format: 'der' });
    return pubDer.subarray(pubDer.length - 32).toString('base64');
}
export function generatePresharedKey() {
    return randomBytes(32).toString('base64');
}
export function renderServerConfig(c) {
    const lines = [];
    lines.push('[Interface]');
    lines.push(`PrivateKey = ${c.privateKey}`);
    lines.push(`Address = ${c.serverIp}/${c.subnet.split('/')[1]}`);
    lines.push(`ListenPort = ${c.listenPort}`);
    if (c.postUp)
        lines.push(`PostUp = ${c.postUp}`);
    if (c.postDown)
        lines.push(`PostDown = ${c.postDown}`);
    lines.push('');
    for (const peer of c.peers) {
        if (peer.comment)
            lines.push(`# ${peer.comment}`);
        lines.push('[Peer]');
        lines.push(`PublicKey = ${peer.publicKey}`);
        if (peer.presharedKey)
            lines.push(`PresharedKey = ${peer.presharedKey}`);
        lines.push(`AllowedIPs = ${peer.allowedIp}`);
        lines.push('');
    }
    return lines.join('\n');
}
export function renderClientConfig(c) {
    const lines = [];
    lines.push('[Interface]');
    lines.push(`PrivateKey = ${c.privateKey}`);
    lines.push(`Address = ${c.assignedIp}/${c.subnetCidr}`);
    if (c.dns)
        lines.push(`DNS = ${c.dns}`);
    lines.push('');
    lines.push('[Peer]');
    lines.push(`PublicKey = ${c.serverPublicKey}`);
    if (c.presharedKey)
        lines.push(`PresharedKey = ${c.presharedKey}`);
    lines.push(`AllowedIPs = ${c.allowedIps ?? '10.13.13.0/24'}`);
    lines.push(`Endpoint = ${c.serverEndpoint}`);
    lines.push(`PersistentKeepalive = 25`);
    if (c.proxyHttpUrl || c.proxyApiBase) {
        lines.push('');
        lines.push('# Sci proxy settings (informational — set as HTTPS_PROXY on the device):');
        if (c.proxyHttpUrl)
            lines.push(`# HTTPS_PROXY=${c.proxyHttpUrl}`);
        if (c.proxyApiBase)
            lines.push(`# SCI_API_BASE=${c.proxyApiBase}`);
    }
    return lines.join('\n');
}
//# sourceMappingURL=wireguard.js.map