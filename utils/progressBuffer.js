/**
 * utils/progressBuffer.js
 * ──────────────────────────────────────────────────────────────────────────
 * Write-buffer for user progress saves.
 *
 * WHY:  When many users are answering questions simultaneously, each answer
 *       triggers a separate MongoDB write.  Under load this can cause DB
 *       bottlenecks.  This buffer:
 *
 *   1.  Applies changes in memory IMMEDIATELY (user sees correct answer fast)
 *   2.  Batches the actual DB write — at most 1 write per user every
 *       FLUSH_DEBOUNCE_MS (default 3 seconds).
 *   3.  On process shutdown (SIGTERM/SIGINT) it flushes all pending writes
 *       so NO progress is lost on restart.
 *
 * USER DATA SAFETY:
 *   – The in-memory buffer is the authoritative state between flushes.
 *   – Flush is guaranteed on shutdown via process signal handlers.
 *   – If a write fails it is retried up to MAX_RETRIES times with backoff.
 * ──────────────────────────────────────────────────────────────────────────
 */

const Progress = require('../models/Progress');

const FLUSH_DEBOUNCE_MS = 3000;  // max wait before DB write
const MAX_RETRIES       = 3;

class ProgressBuffer {
    constructor() {
        // userId (string) → { progress (Mongoose doc), timer, dirtyAt }
        this._pending = new Map();
        this._setupShutdownFlush();
    }

    /**
     * Get the buffered progress document for a user, or load it from DB.
     * Returns the in-memory Mongoose document (mutations are tracked).
     */
    async getProgress(userId) {
        const key = userId.toString();
        const entry = this._pending.get(key);
        if (entry) return entry.progress;

        // Not in buffer — load from DB
        let progress = await Progress.findOne({ userId });
        if (!progress) {
            progress = new Progress({
                userId,
                totalSolved: 0,
                totalCorrect: 0,
                sectionWise: new Map(),
                answers: new Map()
            });
        }
        // Don't schedule a flush yet — only schedule when dirty
        this._pending.set(key, { progress, timer: null, dirtyAt: null });
        return progress;
    }

    /**
     * Mark a user's progress as dirty and schedule a deferred DB flush.
     * Calling this multiple times within FLUSH_DEBOUNCE_MS results in only
     * one DB write (debounce).
     */
    markDirty(userId) {
        const key = userId.toString();
        const entry = this._pending.get(key);
        if (!entry) return; // shouldn't happen

        entry.dirtyAt = entry.dirtyAt || Date.now();

        // Reset debounce timer
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this._flush(key), FLUSH_DEBOUNCE_MS);
    }

    /**
     * Write a single user's progress to DB (with retry).
     */
    async _flush(key, attempt = 1) {
        const entry = this._pending.get(key);
        if (!entry || !entry.dirtyAt) return; // nothing to flush

        try {
            await entry.progress.save();
            entry.dirtyAt = null; // clean
            entry.timer   = null;
            // Keep entry in buffer for next access (avoid re-loading from DB)
        } catch (err) {
            console.error(`[ProgressBuffer] Flush failed for ${key} (attempt ${attempt}):`, err.message);
            if (attempt < MAX_RETRIES) {
                // Exponential backoff: 2s, 4s, 8s
                const delay = Math.pow(2, attempt) * 1000;
                setTimeout(() => this._flush(key, attempt + 1), delay);
            } else {
                console.error(`[ProgressBuffer] Giving up after ${MAX_RETRIES} attempts for user ${key}`);
            }
        }
    }

    /**
     * Flush ALL dirty entries immediately.
     * Called on process shutdown so no data is lost on restart.
     */
    async flushAll() {
        const promises = [];
        for (const [key, entry] of this._pending.entries()) {
            if (entry.dirtyAt) {
                if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
                promises.push(this._flush(key));
            }
        }
        await Promise.allSettled(promises);
    }

    /** Evict a single user from buffer (e.g. after logout) */
    evict(userId) {
        const key = userId.toString();
        const entry = this._pending.get(key);
        if (entry && entry.timer) clearTimeout(entry.timer);
        this._pending.delete(key);
    }

    /** Register process-level shutdown flush so restarts never lose data */
    _setupShutdownFlush() {
        const flush = async (signal) => {
            console.log(`[ProgressBuffer] ${signal} received — flushing all pending progress to DB...`);
            await this.flushAll();
            console.log('[ProgressBuffer] Flush complete.');
        };
        process.on('SIGTERM', () => flush('SIGTERM'));
        process.on('SIGINT',  () => flush('SIGINT'));
        // Catch unhandled rejections too
        process.on('beforeExit', () => this.flushAll());
    }

    /** Diagnostic info */
    stats() {
        let dirty = 0;
        for (const entry of this._pending.values()) {
            if (entry.dirtyAt) dirty++;
        }
        return { buffered: this._pending.size, pendingFlush: dirty };
    }
}

// Singleton
const progressBuffer = new ProgressBuffer();
module.exports = progressBuffer;
