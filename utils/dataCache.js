/**
 * utils/dataCache.js
 * ──────────────────────────────────────────────────────────────────────────
 * Question data cache that lives on the SERVER DISK (os.tmpdir()/mpscpyq_data) plus a small RAM layer.
 *
 *  - one gzip file per exam paper  (exam_<hash>.json.gz + a tiny .meta.json)
 *  - /api/questions is answered from these files / from pre-gzipped response buffers,
 *    so the database is read ONCE per exam instead of once per student
 *  - the HTTP response is stored already gzipped: serving it costs almost no CPU and little bandwidth
 *  - change detection: at most one cheap DB probe per minute (document count); when the count changed,
 *    only the exams whose count changed are dropped (new exams / deleted questions are noticed automatically)
 *  - AI fixes, /admin/clear-cache and the admin "Clear data cache" button invalidate immediately
 *  - safety TTL (DATA_CACHE_TTL_HOURS, default 6) for edits that do not change the count
 * ──────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const Question = require('../models/Question');

const DATA_DIR = path.join(os.tmpdir(), 'mpscpyq_data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

const TTL_MS = (parseInt(process.env.DATA_CACHE_TTL_HOURS || '6', 10) || 6) * 3600 * 1000;
const MEM_EXAMS = 40;                      // parsed exams kept in RAM
const RESP_MAX_BYTES = 64 * 1024 * 1024;   // gzipped responses kept in RAM
const PROBE_EVERY_MS = 60 * 1000;

const NULL_KEY = '__no_exam__';
const keyOf = (examId) => (examId == null || examId === '' ? NULL_KEY : String(examId));
const baseName = (examId) => 'exam_' + crypto.createHash('sha1').update(keyOf(examId)).digest('hex').slice(0, 20);
const dataFile = (examId) => path.join(DATA_DIR, baseName(examId) + '.json.gz');
const metaFile = (examId) => path.join(DATA_DIR, baseName(examId) + '.meta.json');

const mem = new Map();        // key -> { questions, cachedAt, count }
const loading = new Map();    // key -> Promise (several students asking at once = ONE db read)
const responses = new Map();  // key -> { buf, bytes }
let responseBytes = 0;
const counters = { dbReads: 0, diskReads: 0, memHits: 0, responseHits: 0, responseBuilds: 0 };

let changeListener = null;
const onDataChanged = (fn) => { changeListener = fn; };

const hasPassage = (q) => [q.passage_marathi, q.passage_english, q.passage_text].some(x => x && x !== 'null');
const byQnum = (a, b) => (a.qnum || 0) - (b.qnum || 0);
const examQuery = (examId) => (examId == null || examId === '' ? { $or: [{ year_exam: null }, { year_exam: '' }] } : { year_exam: examId });

async function writeAtomic(file, buf) {
    const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, file);
}

function clearResponses() { responses.clear(); responseBytes = 0; }

function touchMem(key, entry) {
    mem.delete(key); mem.set(key, entry);
    while (mem.size > MEM_EXAMS) mem.delete(mem.keys().next().value);
}

// ---- one exam -----------------------------------------------------------------------------------------
async function loadFromDb(examId) {
    counters.dbReads++;
    const questions = await Question.find(examQuery(examId)).lean();
    questions.sort(byQnum);
    const entry = { questions, cachedAt: Date.now(), count: questions.length };
    try {
        const body = await gzip(JSON.stringify({ examId: examId == null ? null : examId, cachedAt: entry.cachedAt, count: entry.count, questions }));
        await writeAtomic(dataFile(examId), body);
        await writeAtomic(metaFile(examId), Buffer.from(JSON.stringify({ examId: examId == null ? null : examId, cachedAt: entry.cachedAt, count: entry.count, bytes: body.length })));
    } catch (e) { console.error('dataCache: could not write to disk:', e.message); }
    return entry;
}

async function loadFromDisk(examId) {
    try {
        const raw = await fsp.readFile(dataFile(examId));
        const obj = JSON.parse((await gunzip(raw)).toString('utf8'));
        if (!obj || !Array.isArray(obj.questions)) return null;
        if (Date.now() - (obj.cachedAt || 0) > TTL_MS) return null; // too old -> read the DB again
        counters.diskReads++;
        return { questions: obj.questions, cachedAt: obj.cachedAt, count: obj.count };
    } catch (e) { return null; }
}

async function getExam(examId) {
    const key = keyOf(examId);
    const m = mem.get(key);
    if (m && Date.now() - m.cachedAt <= TTL_MS) { touchMem(key, m); counters.memHits++; return m.questions; }
    if (loading.has(key)) return loading.get(key);
    const p = (async () => {
        let entry = await loadFromDisk(examId);
        if (!entry) entry = await loadFromDb(examId);
        touchMem(key, entry);
        return entry.questions;
    })().finally(() => loading.delete(key));
    loading.set(key, p);
    return p;
}

async function invalidateExam(examId) {
    mem.delete(keyOf(examId));
    clearResponses();
    await fsp.unlink(dataFile(examId)).catch(() => {});
    await fsp.unlink(metaFile(examId)).catch(() => {});
}

async function invalidateAll() {
    mem.clear();
    clearResponses();
    let files = [];
    try { files = await fsp.readdir(DATA_DIR); } catch (e) {}
    await Promise.all(files.filter(f => f.startsWith('exam_')).map(f => fsp.unlink(path.join(DATA_DIR, f)).catch(() => {})));
}

// ---- queries --------------------------------------------------------------------------------------------
async function collect({ examIds, subject, passageOnly, limit }) {
    const lists = await Promise.all(examIds.map(id => getExam(id)));
    let out = [];
    for (const list of lists) {
        for (const q of list) {
            if (subject && q.subject !== subject) continue;
            if (passageOnly && !hasPassage(q)) continue;
            out.push(q);
        }
    }
    out.sort(byQnum);
    if (limit) out = out.slice(0, limit);
    return out;
}

// the whole HTTP body, gzipped, ready to send. Cached in RAM (LRU by bytes).
async function responseFor(opts) {
    const sig = crypto.createHash('sha1').update(JSON.stringify([
        [...opts.examIds].map(keyOf).sort(), opts.subject || '', !!opts.passageOnly, opts.limit || 0
    ])).digest('hex');
    const hit = responses.get(sig);
    if (hit) { responses.delete(sig); responses.set(sig, hit); counters.responseHits++; return hit.buf; }

    counters.responseBuilds++;
    const data = await collect(opts);
    const buf = await gzip(JSON.stringify({ success: true, data }));
    if (buf.length <= RESP_MAX_BYTES / 2) {
        responses.set(sig, { buf, bytes: buf.length });
        responseBytes += buf.length;
        while (responseBytes > RESP_MAX_BYTES && responses.size > 1) {
            const k = responses.keys().next().value;
            responseBytes -= responses.get(k).bytes;
            responses.delete(k);
        }
    }
    return buf;
}

// ---- change detection (max 1 cheap DB probe per minute) -------------------------------------------------------
let lastProbe = 0, probeCount = null, probing = false;
async function checkFreshness() {
    if (probing || Date.now() - lastProbe < PROBE_EVERY_MS) return;
    probing = true; lastProbe = Date.now();
    try {
        const n = await Question.estimatedDocumentCount();
        if (probeCount !== null && n !== probeCount) await reconcile();
        probeCount = n;
    } catch (e) { /* the next request will probe again */ }
    finally { probing = false; }
}

// drop only the exams whose question count changed; tell the app (new exams must appear in the exam list)
async function reconcile() {
    const rows = await Question.aggregate([{ $group: { _id: '$year_exam', c: { $sum: 1 } } }]);
    const live = new Map(rows.map(r => [keyOf(r._id), r.c]));
    let files = [];
    try { files = (await fsp.readdir(DATA_DIR)).filter(f => f.endsWith('.meta.json')); } catch (e) {}
    let changed = false;
    for (const f of files) {
        try {
            const meta = JSON.parse(await fsp.readFile(path.join(DATA_DIR, f), 'utf8'));
            if ((live.get(keyOf(meta.examId)) || 0) !== meta.count) { await invalidateExam(meta.examId); changed = true; }
        } catch (e) {}
    }
    changed = true; // the exam list itself may have a new paper
    if (changed && changeListener) { try { changeListener(); } catch (e) {} }
}

// ---- admin: stats + warm-up -----------------------------------------------------------------------------
async function stats() {
    let bytes = 0, exams = [];
    let files = [];
    try { files = await fsp.readdir(DATA_DIR); } catch (e) {}
    for (const f of files) {
        try {
            const st = await fsp.stat(path.join(DATA_DIR, f));
            bytes += st.size;
            if (f.endsWith('.meta.json')) {
                const meta = JSON.parse(await fsp.readFile(path.join(DATA_DIR, f), 'utf8'));
                exams.push({ examId: meta.examId, count: meta.count, bytes: meta.bytes || 0, cachedAt: meta.cachedAt });
            }
        } catch (e) {}
    }
    return {
        examsCached: exams.length, bytes, exams,
        ramExams: mem.size, ramResponses: responses.size, ramResponseBytes: responseBytes,
        counters: { ...counters }
    };
}

const warmJob = { running: false, total: 0, done: 0, failed: 0, stop: false, message: '' };
const warmStatus = () => ({ ...warmJob });

// load exams into the disk cache in the background. refresh=true re-reads them from the database.
async function warm(examIds, refresh) {
    if (warmJob.running) throw new Error('A data warm-up is already running.');
    Object.assign(warmJob, { running: true, total: examIds.length, done: 0, failed: 0, stop: false, message: '' });
    (async () => {
        for (const id of examIds) {
            if (warmJob.stop) { warmJob.message = 'Stopped.'; break; }
            try {
                if (refresh) await invalidateExam(id);
                await getExam(id);
            } catch (e) { warmJob.failed++; warmJob.message = e.message; }
            warmJob.done++;
            await new Promise(r => setTimeout(r, 30)); // be gentle with the database
        }
        warmJob.running = false;
        if (!warmJob.message) warmJob.message = 'Done.';
    })();
}
const stopWarm = () => { warmJob.stop = true; };

module.exports = { getExam, responseFor, collect, invalidateExam, invalidateAll, checkFreshness, onDataChanged, stats, warm, stopWarm, warmStatus, DATA_DIR, keyOf };
