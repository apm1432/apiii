'use strict';
const crypto = require('crypto');

/**
 * Mongo "lease" so only ONE running instance long-polls Telegram at a time.
 *
 * Koyeb starts the NEW instance while the OLD one is still running, and stops the old one only after the new one
 * is healthy. If both poll getUpdates with the same bot token Telegram answers "409 Conflict".
 * With this lease the new instance does NOT poll while the old one holds it: the old instance keeps serving the
 * bot, the new one just waits, and the moment the old one stops (it releases the lease on SIGTERM) the new one
 * takes over within `retryMs`. If the old one dies without releasing, the lease expires after `ttlMs`.
 *
 *   getCollection : () => MongoDB collection (called lazily)
 *   onAcquire     : async () => start polling
 *   onLose        : async () => stop polling
 */
function createPollingLock({ getCollection, onAcquire, onLose, id = 'telegram-polling',
                             ttlMs = 30000, renewMs = 10000, retryMs = 3000, log = console }) {
    const owner = crypto.randomBytes(6).toString('hex');
    let held = false, stopped = false, timer = null, waitingLogged = false;

    // 'ok' = we hold the lease (new or renewed), 'busy' = another instance holds a valid lease, 'error' = DB problem
    async function tryLock() {
        const now = new Date();
        try {
            await getCollection().updateOne(
                { _id: id, $or: [{ owner }, { expiresAt: { $lt: now } }] },
                { $set: { owner, expiresAt: new Date(now.getTime() + ttlMs), updatedAt: now } },
                { upsert: true }
            );
            return 'ok';
        } catch (e) {
            if (e && e.code === 11000) return 'busy';    // document exists, owned by someone else, lease still valid
            log.error('[telegram lock] error:', e && e.message);
            return 'error';
        }
    }

    async function release() {
        try {
            await getCollection().updateOne({ _id: id, owner }, { $set: { expiresAt: new Date(0) } });
        } catch (e) { /* lease simply expires */ }
    }

    async function tick() {
        timer = null;
        if (stopped) return;
        const r = await tryLock();
        if (stopped) { if (r === 'ok') await release(); return; }
        if (r === 'ok' && !held) {
            held = true;
            log.log(`🤖 Telegram polling lock acquired (${owner}) - starting polling`);
            try { await onAcquire(); } catch (e) { log.error('[telegram] start polling failed:', e && e.message); }
        } else if (r === 'busy' && held) {
            held = false;
            log.error('[telegram] polling lock lost - pausing polling');
            try { await onLose(); } catch (e) { /* ignore */ }
        } else if (r === 'busy' && !waitingLogged) {
            waitingLogged = true;
            log.log('⏳ Telegram polling is held by the previous instance - waiting for it to stop (no 409 conflicts)...');
        }
        if (!stopped) timer = setTimeout(tick, held ? renewMs : retryMs);
    }

    return {
        owner,
        isHeld: () => held,
        start() { stopped = false; return tick(); },
        async stop() {
            stopped = true;
            if (timer) { clearTimeout(timer); timer = null; }
            if (held) {
                held = false;
                try { await onLose(); } catch (e) { /* ignore */ }   // stop polling FIRST ...
                await release();                                      // ... then let the next instance in
                log.log('[telegram] polling stopped, lock released');
            }
        },
    };
}

module.exports = { createPollingLock };
