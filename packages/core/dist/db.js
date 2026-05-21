import pg from 'pg';
const { Pool } = pg;
function requireEnv(name) {
    const val = process.env[name];
    if (!val)
        throw new Error(`Missing required env var: ${name}`);
    return val;
}
export const reader = new Pool({
    connectionString: requireEnv('SCI_DB_READER_URL'),
    max: 5,
});
export const writer = new Pool({
    connectionString: requireEnv('SCI_DB_WRITER_URL'),
    max: 3,
});
export async function checkConnection() {
    try {
        await reader.query('SELECT 1');
        return true;
    }
    catch {
        return false;
    }
}
/** Gracefully drain both pools. Call before process.exit to avoid exit 134. */
export async function drainPools() {
    await Promise.allSettled([reader.end(), writer.end()]);
}
//# sourceMappingURL=db.js.map