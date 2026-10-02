/**
 * utils/questionCache.js
 * ──────────────────────────────────────────────────────────────────────────
 * In-memory LRU-style question cache.
 *
 * WHY:  Every call to /api/questions currently hits MongoDB.  With many
 *       concurrent users on the same paper, 100 users = 100 identical DB
 *       reads.  This cache ensures those 100 reads are replaced by 1 DB
 *       read + 99 in-memory hits.
 *
 * HOW:
 *  – Cache key  : "year_exam||subject"  (or special "passage" key)
 *  – Cache value: { data: [...questions], cachedAt: timestamp }
 *  – TTL        : QUESTION_CACHE_TTL_MS  (default 2 hours)
 *  – Max entries: MAX_CACHE_ENTRIES  (oldest entry evicted when full)
 *
 * Progress data is NEVER cached here — it always goes straight to/from DB
 * so users never lose their answers on restart.
 * ──────────────────────────────────────────────────────────────────────────
 */

const QUESTION_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_CACHE_ENTRIES = 200; // max unique paper+subject combinations kept in RAM

class QuestionCache {
    constructor() {
        // Map preserves insertion order → easy LRU eviction
        this._store = new Map();
        this._hits = 0;
        this._misses = 0;
    }

    /** Build the canonical cache key */
    static makeKey(year_exam, subject) {
        return `${year_exam || '__ALL__'}||${subject || '__ALL__'}`;
    }

    /**
     * Get cached questions for a paper/subject.
     * Returns null on miss or when TTL has expired.
     */
    get(year_exam, subject) {
        const key = QuestionCache.makeKey(year_exam, subject);
        const entry = this._store.get(key);
        if (!entry) { this._misses++; return null; }
        if (Date.now() - entry.cachedAt > QUESTION_CACHE_TTL_MS) {
            this._store.delete(key);
            this._misses++;
            return null;
        }
        // Move to end (most-recently-used)
        this._store.delete(key);
        this._store.set(key, entry);
        this._hits++;
        return entry.data;
    }

    /**
     * Store questions in cache.
     * Evicts the oldest entry when MAX_CACHE_ENTRIES is reached.
     */
    set(year_exam, subject, questions) {
        const key = QuestionCache.makeKey(year_exam, subject);
        if (this._store.size >= MAX_CACHE_ENTRIES && !this._store.has(key)) {
            // Evict the oldest (first) entry
            const oldestKey = this._store.keys().next().value;
            this._store.delete(oldestKey);
        }
        this._store.set(key, { data: questions, cachedAt: Date.now() });
    }

    /** Invalidate one specific paper (e.g. after an admin edit) */
    invalidate(year_exam, subject) {
        this._store.delete(QuestionCache.makeKey(year_exam, subject));
    }

    /** Wipe entire cache (e.g. after a bulk data sync) */
    clear() {
        this._store.clear();
    }

    /** Diagnostic info for admin */
    stats() {
        return {
            entries: this._store.size,
            hits: this._hits,
            misses: this._misses,
            hitRate: this._hits + this._misses === 0
                ? '0%'
                : `${((this._hits / (this._hits + this._misses)) * 100).toFixed(1)}%`
        };
    }
}

// Singleton shared across the process
const questionCache = new QuestionCache();
module.exports = questionCache;
