/**
 * Write queue consumer — drains the write_queue table.
 *
 * Phase 0: Augmentor writes synchronously and marks items 'done' immediately.
 * Phase 1: This consumer handles any 'pending' items (future async writes,
 *           failed retries, or manually queued operations).
 *
 * Run as a sidecar: `node packages/core/dist/queue-consumer.js`
 */
import { writer, reader } from './db.js';
const POLL_INTERVAL_MS = 5_000;
const MAX_RETRIES = 3;
const BATCH_SIZE = 50;
async function processBatch() {
    const client = await writer.connect();
    let processed = 0;
    try {
        // Claim a batch atomically — skip locked rows so multiple consumers can run safely
        const { rows } = await client.query(`UPDATE write_queue
       SET status = 'processing'
       WHERE id IN (
         SELECT id FROM write_queue
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, operation, payload, status`, [BATCH_SIZE]);
        for (const item of rows) {
            try {
                await dispatch(item);
                await client.query(`UPDATE write_queue SET status = 'done', processed_at = NOW() WHERE id = $1`, [item.id]);
                processed++;
            }
            catch (err) {
                console.error(`[queue] Failed to process ${item.id} (${item.operation}):`, err);
                // Check retry count from metadata; fail permanently after MAX_RETRIES
                const retries = (item.payload.__retries ?? 0) + 1;
                if (retries >= MAX_RETRIES) {
                    await client.query(`UPDATE write_queue SET status = 'failed', processed_at = NOW() WHERE id = $1`, [item.id]);
                }
                else {
                    await client.query(`UPDATE write_queue
             SET status = 'pending',
                 payload = payload || $2::jsonb
             WHERE id = $1`, [item.id, JSON.stringify({ __retries: retries })]);
                }
            }
        }
    }
    finally {
        client.release();
    }
    return processed;
}
// Dispatch table — extend as new operation types are added
async function dispatch(item) {
    switch (item.operation) {
        case 'store_episodic':
        case 'store_semantic':
        case 'store_identity':
            // Already handled synchronously by Augmentor in Phase 0/1.
            // Future async operations (e.g. re-embedding on model change) go here.
            break;
        default:
            console.warn(`[queue] Unknown operation: ${item.operation} — marking done`);
    }
}
async function run() {
    console.log('[queue] Consumer started. Polling every', POLL_INTERVAL_MS, 'ms');
    // Report pending count on start
    const { rows } = await reader.query(`SELECT COUNT(*) FROM write_queue WHERE status = 'pending'`);
    console.log(`[queue] ${rows[0].count} pending items on startup`);
    const poll = async () => {
        try {
            const n = await processBatch();
            if (n > 0)
                console.log(`[queue] Processed ${n} items`);
        }
        catch (err) {
            console.error('[queue] Poll error:', err);
        }
        setTimeout(poll, POLL_INTERVAL_MS);
    };
    await poll();
}
run().catch(err => {
    console.error('[queue] Fatal:', err);
    process.exit(1);
});
//# sourceMappingURL=queue-consumer.js.map