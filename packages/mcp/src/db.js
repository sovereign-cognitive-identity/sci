import pg from 'pg';
const { Pool } = pg;
function requireEnv(name) {
    const val = process.env[name];
    if (!val)
        throw new Error(`Missing required env var: ${name}`);
    return val;
}
// db_reader role — used by all read operations
export const reader = new Pool({
    connectionString: requireEnv('SCI_DB_READER_URL'),
    max: 5,
});
// db_writer role — used exclusively by Augmentor
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
//# sourceMappingURL=db.js.map