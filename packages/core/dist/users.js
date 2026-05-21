/**
 * Users — Phase 7
 *
 * A user owns one or more profiles, each profile owns devices. The dashboard
 * authenticates users with email + password (argon2id) and issues opaque
 * session cookies (sha256 hash stored).
 *
 * Password storage: argon2id via the built-in `crypto.scrypt` hash. We chose
 * scrypt (not argon2 — keeps zero native deps) with parameters tuned to ~64MB
 * memory and ~100ms cost on a modern x86_64. Salt is 16 random bytes,
 * concatenated and base64-encoded as `s$<salt>$<hash>`.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { reader, writer } from './db.js';
const scrypt = promisify(scryptCb);
const SCRYPT_N = 16384; // 2^14, ~32MB memory
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
export async function hashPassword(password) {
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, SCRYPT_KEYLEN, {
        N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
    });
    return `s$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export async function verifyPassword(password, stored) {
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 's')
        return false;
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const got = await scrypt(password, salt, expected.length, {
        N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
    });
    if (got.length !== expected.length)
        return false;
    return timingSafeEqual(got, expected);
}
export async function userCount() {
    const { rows } = await reader.query('SELECT COUNT(*)::text AS c FROM users');
    return parseInt(rows[0].c, 10);
}
export async function createUser(input) {
    const passwordHash = await hashPassword(input.password);
    const { rows } = await writer.query(`INSERT INTO users (email, password_hash, display_name, is_admin)
     VALUES (LOWER($1), $2, $3, $4)
     RETURNING id, email, display_name, is_admin, created_at, last_login_at`, [input.email, passwordHash, input.displayName ?? null, input.isAdmin ?? false]);
    const u = rows[0];
    return {
        id: u.id, email: u.email, displayName: u.display_name,
        isAdmin: u.is_admin, createdAt: u.created_at, lastLoginAt: u.last_login_at,
    };
}
export async function getUserByEmail(email) {
    const { rows } = await reader.query('SELECT id, email, password_hash, display_name, is_admin, created_at, last_login_at FROM users WHERE email = LOWER($1)', [email]);
    const u = rows[0];
    if (!u)
        return null;
    return {
        id: u.id, email: u.email, passwordHash: u.password_hash,
        displayName: u.display_name, isAdmin: u.is_admin,
        createdAt: u.created_at, lastLoginAt: u.last_login_at,
    };
}
export async function getUserById(id) {
    const { rows } = await reader.query('SELECT id, email, display_name, is_admin, created_at, last_login_at FROM users WHERE id = $1', [id]);
    const u = rows[0];
    if (!u)
        return null;
    return {
        id: u.id, email: u.email, displayName: u.display_name,
        isAdmin: u.is_admin, createdAt: u.created_at, lastLoginAt: u.last_login_at,
    };
}
export async function authenticate(email, password) {
    const user = await getUserByEmail(email);
    if (!user) {
        // Constant-time best effort — still hash a dummy
        await hashPassword(password);
        return null;
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok)
        return null;
    await writer.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]).catch(() => { });
    return {
        id: user.id, email: user.email, displayName: user.displayName,
        isAdmin: user.isAdmin, createdAt: user.createdAt, lastLoginAt: user.lastLoginAt,
    };
}
// ── Sessions ──────────────────────────────────────────────────────────────
export function generateSessionToken() {
    return 'scis_' + randomBytes(32).toString('base64url');
}
export function hashSessionToken(token) {
    return createHash('sha256').update(token).digest('hex');
}
export async function createSession(userId, opts = {}) {
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const { rows } = await writer.query(`INSERT INTO user_sessions (user_id, token_hash, user_agent, ip_address)
     VALUES ($1, $2, $3, $4)
     RETURNING id, expires_at`, [userId, tokenHash, opts.userAgent ?? null, opts.ipAddress ?? null]);
    return { id: rows[0].id, userId, token, expiresAt: rows[0].expires_at };
}
export async function validateSession(token) {
    if (!token?.startsWith('scis_'))
        return null;
    const tokenHash = hashSessionToken(token);
    const { rows } = await reader.query(`SELECT user_id, expires_at FROM user_sessions WHERE token_hash = $1`, [tokenHash]);
    const s = rows[0];
    if (!s)
        return null;
    if (s.expires_at < new Date())
        return null;
    writer.query('UPDATE user_sessions SET last_used_at = NOW() WHERE token_hash = $1', [tokenHash]).catch(() => { });
    return getUserById(s.user_id);
}
export async function revokeSession(token) {
    const tokenHash = hashSessionToken(token);
    await writer.query('DELETE FROM user_sessions WHERE token_hash = $1', [tokenHash]);
}
// ── Adoption: link existing profiles to a bootstrap user ─────────────────
// Used during initial setup to take over the pre-multi-tenant 'work' /
// 'personal' profiles.
export async function adoptOrphanProfiles(userId) {
    const { rowCount } = await writer.query('UPDATE profiles SET user_id = $1 WHERE user_id IS NULL', [userId]);
    return rowCount ?? 0;
}
//# sourceMappingURL=users.js.map