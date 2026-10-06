/**
 * utils/imageStore.js
 * ──────────────────────────────────────────────────────────────────────────
 * Telegram question images, cached on the SERVER DISK (os.tmpdir()/mpscpyq_images).
 *  - an image is downloaded from Telegram ONCE; every later view is served from disk
 *  - downloads are de-duplicated (10 students opening the same new image = 1 Telegram request)
 *  - atomic writes (temp file + rename): a half-downloaded file can never be served
 *  - admin tools: disk usage, cached / remaining counts per exam, pre-cache one exam or all exams,
 *    clear one exam / everything, trim to a size, change the size limit
 * ──────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const axios = require('axios');
const Question = require('../models/Question');
const AppSetting = require('../models/AppSetting');

const CACHE_DIR = path.join(os.tmpdir(), 'mpscpyq_images');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) {}

let maxBytes = (parseInt(process.env.IMAGE_CACHE_MAX_MB || '900', 10) || 900) * 1024 * 1024;
const getMaxBytes = () => maxBytes;

async function loadSettings() {
    try {
        const s = await AppSetting.findOne({ key: 'imageCacheMaxMb' }).lean();
        if (s && Number(s.value) > 0) maxBytes = Math.round(Number(s.value)) * 1024 * 1024;
    } catch (e) {}
}
async function setMaxMb(mb) {
    const v = Math.max(50, Math.min(100000, Math.round(Number(mb) || 0)));
    maxBytes = v * 1024 * 1024;
    try { await AppSetting.updateOne({ key: 'imageCacheMaxMb' }, { $set: { value: v } }, { upsert: true }); } catch (e) {}
    scheduleCleanup(true);
    return v;
}

const counters = { diskHits: 0, telegramFetches: 0, failures: 0 };

// ---- file ids -> file name --------------------------------------------------------------------------------
function parseFileIds(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(decodeURIComponent(String(raw))); } catch (e) { return { '0': String(raw) }; }
}
const safeName = (id) => String(id).replace(/[^a-zA-Z0-9-_]/g, '') + '.jpg';
function filenameFor(raw) {
    const ids = Object.values(parseFileIds(raw)).filter(Boolean);
    return ids.length ? safeName(ids[0]) : null;
}

const botTokens = () => (process.env.TELEGRAM_BOT_TOKENS || '').split(',').map(t => t.replace(/['"]/g, '').trim()).filter(Boolean);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- download (de-duplicated, atomic) -----------------------------------------------------------------------------
const inflight = new Map();

async function downloadFromTelegram(ids, fullPath) {
    for (const token of botTokens()) {
        for (const id of ids) {
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const fileRes = await axios.get(`https://api.telegram.org/bot${token}/getFile?file_id=${id}`, { timeout: 15000 });
                    if (!fileRes.data || !fileRes.data.ok) break;
                    const imgRes = await axios.get(`https://api.telegram.org/file/bot${token}/${fileRes.data.result.file_path}`, { responseType: 'arraybuffer', timeout: 30000 });
                    const buf = Buffer.from(imgRes.data);
                    if (!buf.length) break;
                    const tmp = fullPath + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
                    await fsp.writeFile(tmp, buf);
                    await fsp.rename(tmp, fullPath);
                    counters.telegramFetches++;
                    return buf.length;
                } catch (err) {
                    const st = err.response && err.response.status;
                    if (st === 429 && attempt === 0) { // Telegram asks us to slow down: wait, then retry once
                        const wait = Math.min(Number(err.response.data && err.response.data.parameters && err.response.data.parameters.retry_after) || 3, 20);
                        await sleep(wait * 1000);
                        continue;
                    }
                    break;
                }
            }
        }
    }
    return 0;
}

// Returns { file, full, size, cached } or null when no bot has the image.
async function ensureImage(raw) {
    const ids = Object.values(parseFileIds(raw)).filter(Boolean);
    if (!ids.length) return null;
    const file = safeName(ids[0]);
    const full = path.join(CACHE_DIR, file);
    try {
        const st = await fsp.stat(full);
        if (st.size > 0) {
            counters.diskHits++;
            const now = new Date(); fsp.utimes(full, now, now).catch(() => {}); // LRU "last used"
            return { file, full, size: st.size, cached: true };
        }
    } catch (e) { /* not on disk yet */ }

    if (inflight.has(file)) return inflight.get(file);
    const p = (async () => {
        const size = await downloadFromTelegram(ids, full);
        if (!size) { counters.failures++; return null; }
        scheduleCleanup();
        return { file, full, size, cached: false };
    })().finally(() => inflight.delete(file));
    inflight.set(file, p);
    return p;
}

// ---- directory info / cleanup ------------------------------------------------------------------------------------
async function dirStats() {
    const sizes = new Map(); let bytes = 0;
    let files = [];
    try { files = await fsp.readdir(CACHE_DIR); } catch (e) {}
    await Promise.all(files.map(async (f) => {
        if (!f.endsWith('.jpg')) return;
        try { const st = await fsp.stat(path.join(CACHE_DIR, f)); sizes.set(f, st.size); bytes += st.size; } catch (e) {}
    }));
    return { sizes, bytes };
}

// delete the least recently used files until the folder is <= target bytes
async function trimTo(targetBytes) {
    const files = [];
    let total = 0;
    let names = [];
    try { names = await fsp.readdir(CACHE_DIR); } catch (e) {}
    for (const f of names) {
        if (!f.endsWith('.jpg')) continue;
        try { const st = await fsp.stat(path.join(CACHE_DIR, f)); files.push({ f, size: st.size, t: st.mtimeMs }); total += st.size; } catch (e) {}
    }
    const before = total, count0 = files.length;
    if (total > targetBytes) {
        files.sort((a, b) => a.t - b.t); // oldest first
        let removed = 0;
        for (const x of files) {
            if (total <= targetBytes) break;
            try { await fsp.unlink(path.join(CACHE_DIR, x.f)); total -= x.size; removed++; } catch (e) {}
        }
        return { removed, freedBytes: before - total, remaining: count0 - removed };
    }
    return { removed: 0, freedBytes: 0, remaining: count0 };
}

let cleanupTimer = null;
function scheduleCleanup(now) {
    if (cleanupTimer && !now) return;
    clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(async () => {
        cleanupTimer = null;
        try { const d = await dirStats(); if (d.bytes > maxBytes) await trimTo(Math.floor(maxBytes * 0.9)); } catch (e) {}
    }, now ? 0 : 3000);
    if (cleanupTimer.unref) cleanupTimer.unref();
}

// ---- which images belong to which exam -----------------------------------------------------------------------------
let index = null; // { at, examMap: Map(examId -> Set(file)), all: Set(file), rawByFile: Map(file -> raw) }
async function buildIndex(force) {
    if (!force && index && Date.now() - index.at < 60000) return index;
    const rows = await Question.find({ $or: [{ original_image_url: { $exists: true, $nin: [null, ''] } }, { 'extra_images.0': { $exists: true } }] }, { year_exam: 1, original_image_url: 1, extra_images: 1 }).lean();
    const examMap = new Map(), all = new Set(), rawByFile = new Map();
    for (const r of rows) {
        for (const raw of [r.original_image_url, ...(Array.isArray(r.extra_images) ? r.extra_images : [])]) {
            const f = raw ? filenameFor(raw) : null;
            if (!f) continue;
            const ex = r.year_exam || '(no exam)';
            if (!examMap.has(ex)) examMap.set(ex, new Set());
            examMap.get(ex).add(f);
            all.add(f);
            if (!rawByFile.has(f)) rawByFile.set(f, raw);
        }
    }
    index = { at: Date.now(), examMap, all, rawByFile };
    return index;
}

async function status(forceIndex) {
    const [dir, idx] = await Promise.all([dirStats(), buildIndex(forceIndex)]);
    const perExam = [];
    for (const [examId, files] of idx.examMap) {
        let cached = 0, bytes = 0;
        files.forEach(f => { const s = dir.sizes.get(f); if (s) { cached++; bytes += s; } });
        perExam.push({ examId, totalImages: files.size, cachedImages: cached, bytes });
    }
    perExam.sort((a, b) => String(a.examId).localeCompare(String(b.examId)));
    let cachedImages = 0;
    idx.all.forEach(f => { if (dir.sizes.has(f)) cachedImages++; });

    let disk = null;
    try {
        const s = await fsp.statfs(CACHE_DIR);
        disk = { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
    } catch (e) { /* older Node / unsupported filesystem */ }

    return {
        totalImages: idx.all.size, cachedImages, remainingImages: idx.all.size - cachedImages,
        files: dir.sizes.size, bytes: dir.bytes, maxBytes, disk, counters: { ...counters }, perExam
    };
}

async function clearImages(examIds /* null = everything */) {
    let targets;
    if (!examIds) {
        let names = []; try { names = await fsp.readdir(CACHE_DIR); } catch (e) {}
        targets = names.filter(f => f.endsWith('.jpg') || f.includes('.tmp-'));
    } else {
        const idx = await buildIndex(true);
        const set = new Set();
        examIds.forEach(id => { const s = idx.examMap.get(id); if (s) s.forEach(f => set.add(f)); });
        targets = [...set];
    }
    let removed = 0, freed = 0;
    for (const f of targets) {
        try { const st = await fsp.stat(path.join(CACHE_DIR, f)); await fsp.unlink(path.join(CACHE_DIR, f)); removed++; freed += st.size; } catch (e) {}
    }
    return { removed, freedBytes: freed };
}

// ---- background pre-cache -----------------------------------------------------------------------------------------
const job = { running: false, scope: '', total: 0, done: 0, failed: 0, bytes: 0, stop: false, message: '', startedAt: 0, finishedAt: 0 };
const jobStatus = () => ({ ...job });
const stopJob = () => { job.stop = true; };

async function startPrecache(examIds /* null = all exams */) {
    if (job.running) throw new Error('A pre-cache is already running.');
    const idx = await buildIndex(true);
    const wanted = new Set();
    const exams = examIds ? examIds : [...idx.examMap.keys()];
    exams.forEach(id => { const s = idx.examMap.get(id); if (s) s.forEach(f => wanted.add(f)); });

    const dir = await dirStats();
    const todo = [...wanted].filter(f => !dir.sizes.has(f));
    Object.assign(job, {
        running: true, scope: examIds ? (examIds.length === 1 ? examIds[0] : examIds.length + ' exams') : 'ALL exams',
        total: todo.length, done: 0, failed: 0, bytes: 0, stop: false, message: '', startedAt: Date.now(), finishedAt: 0
    });
    if (!todo.length) { job.running = false; job.message = 'Everything is already cached.'; job.finishedAt = Date.now(); return; }

    let current = dir.bytes;
    let next = 0;
    const worker = async () => {
        while (!job.stop) {
            if (current >= maxBytes) { job.message = 'Size limit reached - raise the limit or clear some images.'; job.stop = true; break; }
            const i = next++; if (i >= todo.length) break;
            try {
                const r = await ensureImage(idx.rawByFile.get(todo[i]));
                if (r) { job.bytes += r.size; current += r.size; } else job.failed++;
            } catch (e) { job.failed++; }
            job.done++;
            await sleep(120); // stay friendly to Telegram
        }
    };
    Promise.all([worker(), worker(), worker()]).then(() => {
        job.running = false; job.finishedAt = Date.now();
        if (!job.message) job.message = job.stop ? 'Stopped.' : (job.failed ? `Done, ${job.failed} image(s) were not found on any bot.` : 'Done.');
        index = null; // counts changed
    });
}

module.exports = {
    CACHE_DIR, ensureImage, filenameFor, parseFileIds, status, clearImages, trimTo, startPrecache, stopJob, jobStatus,
    getMaxBytes, setMaxMb, loadSettings, scheduleCleanup, counters, dirStats
};
