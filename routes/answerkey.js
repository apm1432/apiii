/**
 * routes/answerkey.js   (mounted at /api/admin/answer-key, admin only)
 * ──────────────────────────────────────────────────────────────────────────
 *  GET  /exams            exams (year_exam) + how many questions already have an official answer
 *  GET  /                 recent uploads
 *  POST /upload           multipart: pdf (+ examId)  -> starts a background job, returns { id }
 *  GET  /:id              job status / result (poll this while status === 'processing')
 *  POST /check            { examId } -> how many questions of the exam really carry the official answer/image (DB + served copy)
 *  POST /:id/rescan       re-read the saved page images with the AI and merge (verifies answers that two readings agree on)
 *  POST /:id/compare      { examId, set, overrides, acceptSingle }  -> match % between the site's final answers and the official key
 *  POST /:id/save         { examId, set, overrides, acceptSingle, skipUnresolved } -> writes official answer + key page image into every question
 *  POST /apply-final      { examId, mode:'official-all' | 'choices', choices:{questionId:'1'..'4'|'#'} } -> writes the FINAL answer (correct_answer_option)
 *  POST /recalc-students  { examId } -> re-judge students' saved answers for the questions this tool changed
 *  POST /undo-final       { examId } -> restores the final answers this tool changed
 *  DELETE /:id            forget an upload (Telegram messages are not deleted)
 * ──────────────────────────────────────────────────────────────────────────
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const AnswerKey = require('../models/AnswerKey');
const Question = require('../models/Question');
const User = require('../models/User');
const { authMiddleware } = require('../middleware/auth');
const svc = require('../utils/answerKeyService');
const dataCache = require('../utils/dataCache');
const { recalcProgressForQuestion } = require('../utils/progressSync');

const UPLOAD_DIR = path.join(os.tmpdir(), 'answerkey_uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}

const upload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        const ok = /pdf/i.test(file.mimetype || '') || /\.pdf$/i.test(file.originalname || '');
        cb(ok ? null : new Error('Only a PDF file can be uploaded.'), ok);
    }
});

const uploadLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many uploads, wait a minute.' } });

const okId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
const okExam = (v) => typeof v === 'string' && v.trim() && v.length <= 300;
const okSet = (v) => typeof v === 'string' && /^[A-D]$/.test(v);

async function adminOnly(req, res, next) {
    try {
        const user = await User.findById(req.user.id).select('isAdmin').lean();
        if (!user || !user.isAdmin) return res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' });
        next();
    } catch (e) { res.status(500).json({ success: false, message: 'Server Error' }); }
}
router.use(authMiddleware, adminOnly);

// ── what the admin sees (no huge blobs) ─────────────────────────────────────────────
function view(k) {
    const sets = k.sets || {};
    const v = k.verification || {};
    return {
        id: String(k._id), fileName: k.fileName, examId: k.examId || '', status: k.status, progress: k.progress || '', error: k.error || '',
        pageCount: k.pageCount || 0,
        sets: Object.keys(sets).sort().map(s => ({ name: s, answers: Object.keys(sets[s] || {}).length })),
        verification: { engines: v.engines || [], notes: v.notes || [], perSet: v.perSet || {}, unverified: v.unverified || [], verifiedAt: v.verifiedAt || null },
        images: (k.images || []).map(i => ({ page: i.page, ref: i.ref, messageId: i.messageId, chatId: i.chatId })),
        pdf: k.pdf ? { messageId: k.pdf.messageId, chatId: k.pdf.chatId } : null,
        rescan: k.rescan ? { status: k.rescan.status, progress: k.rescan.progress || '', error: k.rescan.error || '', summary: k.rescan.summary || null, at: k.rescan.at || null } : null,
        applied: k.appliedAt ? { set: k.appliedSet, examId: k.appliedExam, at: k.appliedAt, count: k.appliedCount } : null,
        createdAt: k.createdAt
    };
}

// ── exams list ──────────────────────────────────────────────────────────────────────
router.get('/exams', async (req, res) => {
    try {
        const rows = await Question.aggregate([
            { $match: { year_exam: { $nin: [null, ''] } } },
            { $group: { _id: '$year_exam', count: { $sum: 1 }, withOfficial: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $toString: { $ifNull: ['$official_answer_key_answers', ''] } } }, 0] }, 1, 0] } } } },
            { $sort: { _id: 1 } }
        ]);
        res.json({ success: true, exams: rows.map(r => ({ examId: r._id, count: r.count, withOfficial: r.withOfficial })), aiVerify: await svc.aiAvailable() });
    } catch (err) { console.error('answer-key exams:', err); res.status(500).json({ success: false, message: 'Server Error' }); }
});

router.get('/', async (req, res) => {
    try {
        const list = await AnswerKey.find({}, 'fileName examId status progress pageCount appliedAt appliedSet appliedExam createdAt').sort({ createdAt: -1 }).limit(15).lean();
        res.json({ success: true, keys: list.map(k => ({ id: String(k._id), fileName: k.fileName, examId: k.examId || '', status: k.status, pageCount: k.pageCount || 0, applied: k.appliedAt ? `${k.appliedExam} · Set ${k.appliedSet}` : '', createdAt: k.createdAt })) });
    } catch (err) { res.status(500).json({ success: false, message: 'Server Error' }); }
});

// ── upload + background processing ──────────────────────────────────────────────────
const running = new Set();

async function processKey(id, pdfPath, workDir, label) {
    const setProgress = (m) => AnswerKey.updateOne({ _id: id }, { $set: { progress: String(m).slice(0, 200) } }).catch(() => {});
    try {
        const r = await svc.extractVerified(pdfPath, workDir, setProgress);
        const images = await svc.uploadPages(r.images, label, setProgress);
        await setProgress('Uploading the original PDF to Telegram…');
        let pdf = null;
        try {
            const u = await svc.uploadFile(await fsp.readFile(pdfPath), 'official_answer_key.pdf', 'application/pdf', `Official Answer Key (PDF) | ${label || ''}`);
            pdf = { ref: u.ref, messageId: u.messageId, chatId: u.chatId };
        } catch (e) { console.warn('answer-key: original PDF not uploaded:', e.message); }
        await AnswerKey.updateOne({ _id: id }, { $set: { status: 'ready', progress: 'Done', error: '', pageCount: r.pageCount, sets: r.sets, pages: r.pages, verification: r.verification, images, pdf } });
    } catch (err) {
        console.error('answer-key job failed:', err.message);
        await AnswerKey.updateOne({ _id: id }, { $set: { status: 'failed', error: String(err.message || err).slice(0, 500), progress: '' } }).catch(() => {});
    } finally {
        running.delete(String(id));
        fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
        fsp.rm(pdfPath, { force: true }).catch(() => {});
    }
}

router.post('/upload', uploadLimiter, (req, res) => {
    upload.single('pdf')(req, res, async (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message || 'Upload failed.' });
        if (!req.file) return res.status(400).json({ success: false, message: 'Choose a PDF file.' });
        try {
            const head = Buffer.alloc(5);
            const fh = await fsp.open(req.file.path, 'r');
            await fh.read(head, 0, 5, 0); await fh.close();
            if (head.toString('latin1') !== '%PDF-') { await fsp.rm(req.file.path, { force: true }); return res.status(400).json({ success: false, message: 'This is not a valid PDF file.' }); }

            const examId = okExam(req.body && req.body.examId) ? String(req.body.examId).trim() : '';
            const name = String(req.file.originalname || 'answer_key.pdf').slice(0, 200);
            const doc = await AnswerKey.create({ fileName: name, examId, status: 'processing', progress: 'Starting…' });
            const id = String(doc._id);
            running.add(id);
            const workDir = path.join(os.tmpdir(), 'answerkey_' + id);
            processKey(doc._id, req.file.path, workDir, examId || name); // runs in the background
            res.json({ success: true, id });
        } catch (e) {
            console.error('answer-key upload:', e);
            fsp.rm(req.file.path, { force: true }).catch(() => {});
            res.status(500).json({ success: false, message: 'Server Error' });
        }
    });
});

router.get('/:id', async (req, res) => {
    try {
        if (!okId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id.' });
        const k = await AnswerKey.findById(req.params.id).lean();
        if (!k) return res.status(404).json({ success: false, message: 'Not found.' });
        // a job that was running when the server restarted can never finish
        if (k.status === 'processing' && !running.has(String(k._id)) && Date.now() - new Date(k.updatedAt).getTime() > 3 * 60 * 1000) {
            await AnswerKey.updateOne({ _id: k._id }, { $set: { status: 'failed', error: 'Processing was interrupted (server restarted). Upload the PDF again.' } });
            k.status = 'failed'; k.error = 'Processing was interrupted (server restarted). Upload the PDF again.';
        }
        if (k.rescan && k.rescan.status === 'running' && !running.has('rescan:' + String(k._id)) && Date.now() - new Date(k.rescan.updatedAt || 0).getTime() > 3 * 60 * 1000) {
            k.rescan = { status: 'failed', progress: '', error: 'The AI re-scan was interrupted (server restarted). Press Re-scan again.', at: new Date(), updatedAt: new Date() };
            await AnswerKey.updateOne({ _id: k._id }, { $set: { rescan: k.rescan } });
        }
        res.json({ success: true, key: view(k) });
    } catch (err) { console.error('answer-key get:', err); res.status(500).json({ success: false, message: 'Server Error' }); }
});

router.delete('/:id', async (req, res) => {
    try {
        if (!okId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id.' });
        await AnswerKey.deleteOne({ _id: req.params.id });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: 'Server Error' }); }
});

// ── effective answers = verified answers of the set + the admin's confirmed values ──
function effective(key, set, overrides, acceptSingle) {
    const base = Object.assign({}, (key.sets && key.sets[set]) || {});
    const pages = Object.assign({}, (key.pages && key.pages[set]) || {});
    const unverified = ((key.verification && key.verification.unverified) || []).filter(u => u.set === set);
    const unresolved = [];
    const ov = (overrides && typeof overrides === 'object') ? overrides : {};
    for (const [qRaw, valRaw] of Object.entries(ov)) {
        const q = parseInt(qRaw, 10), a = svc.normAnswer(valRaw);
        if (!(q >= 1 && q <= 300) || !a) continue;
        base[q] = a;
        const u = unverified.find(x => x.q === q);
        if (u && u.page && !pages[q]) pages[q] = u.page;
    }
    for (const u of unverified) {
        if (base[u.q]) continue;
        // read by only ONE pass (the other found nothing): the admin may accept it. A real conflict (two different values) never is.
        const readings = [...new Set([u.a, u.b, ...(u.r || [])].filter(Boolean))];
        const single = readings.length === 1 ? readings[0] : null;
        if (acceptSingle && single) { base[u.q] = single; if (u.page && !pages[u.q]) pages[u.q] = u.page; continue; }
        unresolved.push(u.q);
    }
    return { answers: base, pages, unresolved };
}

async function loadExamQuestions(examId) {
    return Question.find({ year_exam: examId }).select('_id qnum correct_answer_option final_answer_key ai_answer_option answer_source official_answer_key_answers original_image_url extra_images text text_eng options options_eng final_answer_prev final_answer_prev_source final_answer_changed_at').lean();
}

// ── FINAL answer writer (correct_answer_option = what the site marks as correct) ─────────────────
const okFinal = (v) => /^[1-4]$/.test(String(v)) || String(v) === '#';
const isMulti = (v) => String(v || '').includes('/');
// 'official answer' of a question -> a single value the site can use ('1'..'4' or '#'), or null (several accepted answers / none)
const singleOf = (off) => { const a = String(off || '').trim(); return (/^[1-4]$/.test(a) || a === '#') ? a : null; };

// Re-judge every student's saved answer of these questions against the CURRENT final answer (isCorrect / totalCorrect / sectionWise).
// Atomic per user (utils/progressSync). Returns { questions, users }.
async function recalcStudents(ids) {
    const qs = await Question.find({ _id: { $in: ids } }).select('_id correct_answer_option final_answer_key answer_key').lean();
    let users = 0, i = 0;
    const worker = async () => {
        while (i < qs.length) {
            const q = qs[i++];
            try { users += await recalcProgressForQuestion(q); } catch (e) { console.error('answer-key recalc failed for', String(q._id), e.message); }
        }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return { questions: qs.length, users };
}
// wait for the recalculation, but never longer than 20 s (it keeps running in the background if it is slower)
async function recalcWithin(ids, ms = 20000) {
    if (!ids.length) return { questions: 0, users: 0, pending: false };
    const p = recalcStudents(ids);
    const r = await Promise.race([p, new Promise(res => setTimeout(() => res(null), ms))]);
    if (r) return Object.assign({ pending: false }, r);
    p.catch(() => {});
    return { questions: ids.length, users: 0, pending: true };
}

async function writeFinals(examId, changes) {
    // changes: [{ id, value, source }]
    const out = { changed: 0, same: 0, notFound: 0 };
    if (!changes.length) return out;
    const docs = await Question.find({ _id: { $in: changes.map(c => c.id) }, year_exam: examId }).select('_id correct_answer_option final_answer_key ai_answer_option answer_source final_answer_prev final_answer_prev_source').lean();
    const byId = new Map(docs.map(d => [String(d._id), d]));
    const ops = []; const changedIds = [];
    for (const c of changes) {
        const d = byId.get(String(c.id));
        if (!d) { out.notFound++; continue; }
        const old = svc.finalOf(d);
        if (old === c.value) { out.same++; continue; }
        const set = { correct_answer_option: c.value, answer_source: c.source, final_answer_changed_at: new Date() };
        if (d.final_answer_prev === undefined || d.final_answer_prev === null) { set.final_answer_prev = old; set.final_answer_prev_source = d.answer_source || ''; }
        if (!d.ai_answer_option && /^[1-4]$/.test(old)) set.ai_answer_option = old;    // the explanation was written for that option
        ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: set } } });
        changedIds.push(d._id);
    }
    for (let i = 0; i < ops.length; i += 500) await Question.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    out.changed = ops.length;
    if (out.changed) {
        try { await dataCache.invalidateExam(examId); } catch (e) { console.warn('answer-key: cache invalidate failed:', e.message); }
        try { dataCache.notifyDataChanged(); } catch (e) {}
        out.recalc = await recalcWithin(changedIds);      // students' scores follow the new final answers
    }
    return out;
}

function checkBody(req, res) {
    const { examId, set } = req.body || {};
    if (!okId(req.params.id)) { res.status(400).json({ success: false, message: 'Invalid id.' }); return null; }
    if (!okExam(examId)) { res.status(400).json({ success: false, message: 'Select an exam.' }); return null; }
    if (!okSet(set)) { res.status(400).json({ success: false, message: 'Select a set (A / B / C / D).' }); return null; }
    return { examId: String(examId).trim(), set };
}

// What is REALLY stored / served for an exam right now (DB + the cached copy students receive)
async function examCheck(examId) {
    const has = (q) => String(q.official_answer_key_answers || '').trim() !== '';
    const hasImg = (q) => !!(q.official_answer_key && (typeof q.official_answer_key !== 'object' || Object.keys(q.official_answer_key).length));
    const total = await Question.countDocuments({ year_exam: examId });
    const inDbAnswer = await Question.countDocuments({ year_exam: examId, official_answer_key_answers: { $nin: [null, ''] } });
    const inDbImage = await Question.countDocuments({ year_exam: examId, official_answer_key: { $exists: true, $nin: [null, ''] } });
    let servedAnswer = 0, servedImage = 0, servedTotal = 0;
    try {
        const served = await dataCache.getExam(examId);      // exactly what POST /api/questions sends to students
        servedTotal = served.length;
        for (const q of served) { if (has(q)) servedAnswer++; if (hasImg(q)) servedImage++; }
    } catch (e) { console.warn('answer-key check: served copy unreadable:', e.message); }
    return { examId, total, inDbAnswer, inDbImage, servedTotal, servedAnswer, servedImage };
}

router.post('/check', async (req, res) => {
    try {
        const examId = req.body && req.body.examId;
        if (!okExam(examId)) return res.status(400).json({ success: false, message: 'Select an exam.' });
        res.json({ success: true, check: await examCheck(String(examId).trim()) });
    } catch (err) { console.error('answer-key check:', err); res.status(500).json({ success: false, message: 'Server Error' }); }
});

// ── Re-scan by AI (background job; the admin UI polls GET /:id and reads key.rescan) ─────────────
async function rescanJob(id, key) {
    const idStr = String(id);
    const setProg = (m) => AnswerKey.updateOne({ _id: id }, { $set: { 'rescan.progress': String(m).slice(0, 200), 'rescan.updatedAt': new Date() } }).catch(() => {});
    const workDir = path.join(os.tmpdir(), 'answerkey_rescan_' + idStr);
    try {
        const r = await svc.rescanByAi(key, workDir, setProg, 1);
        await AnswerKey.updateOne({ _id: id }, { $set: {
            sets: r.sets, pages: r.pages, verification: r.verification,
            rescan: { status: 'done', progress: '', error: '', summary: r.stats, at: new Date(), updatedAt: new Date() }
        } });
    } catch (err) {
        console.error('answer-key rescan failed:', err.message);
        await AnswerKey.updateOne({ _id: id }, { $set: { rescan: { status: 'failed', progress: '', error: String(err.message || err).slice(0, 500), at: new Date(), updatedAt: new Date() } } }).catch(() => {});
    } finally {
        running.delete('rescan:' + idStr);
        fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}

router.post('/:id/rescan', async (req, res) => {
    try {
        if (!okId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id.' });
        const key = await AnswerKey.findById(req.params.id).lean();
        if (!key || !['ready', 'applied'].includes(key.status)) return res.status(404).json({ success: false, message: 'Answer key is not ready.' });
        if (!key.images || !key.images.length) return res.status(400).json({ success: false, message: 'This key has no saved page images to re-scan.' });
        if (running.has('rescan:' + String(key._id))) return res.status(409).json({ success: false, message: 'A re-scan is already running.' });
        if (!(await svc.aiAvailable())) return res.status(400).json({ success: false, message: 'No AI provider is configured (AI Settings → Fix list / GEMINI_API_KEYS).' });
        running.add('rescan:' + String(key._id));
        await AnswerKey.updateOne({ _id: key._id }, { $set: { rescan: { status: 'running', progress: 'Starting…', error: '', summary: null, at: null, updatedAt: new Date() } } });
        rescanJob(key._id, key);          // background
        res.json({ success: true });
    } catch (err) { console.error('answer-key rescan:', err); res.status(500).json({ success: false, message: 'Server Error' }); }
});


// each wrong question: id, question image(s), options, the AI answer, what is stored, whether the official key allows one answer only
function enrichMismatches(result, questions) {
    const byNum = new Map();
    for (const q of questions) { const n = Number(q.qnum); if (n > 0 && !byNum.has(n)) byNum.set(n, q); }
    const clip = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
    result.mismatches = result.mismatches.map(m => {
        const q = byNum.get(m.q) || {};
        const imgs = [q.original_image_url, ...(Array.isArray(q.extra_images) ? q.extra_images : [])].filter(x => x && (typeof x !== 'object' || Object.keys(x).length)).slice(0, 4);
        return Object.assign({}, m, {
            id: q._id ? String(q._id) : '',
            single: singleOf(m.official),
            ai: q.ai_answer_option || '',
            source: q.answer_source || '',
            changed: !!q.final_answer_changed_at,
            images: imgs,
            text: imgs.length ? '' : clip(q.text || q.text_eng, 400),
            options: (q.options && q.options.length ? q.options : (q.options_eng || [])).slice(0, 4).map(o => clip(o, 160))
        });
    });
    result.multiOfficial = result.mismatches.filter(m => !m.single).length;
}

router.post('/:id/compare', async (req, res) => {
    try {
        const b = checkBody(req, res); if (!b) return;
        const key = await AnswerKey.findById(req.params.id).lean();
        if (!key || !['ready', 'applied'].includes(key.status)) return res.status(404).json({ success: false, message: 'Answer key is not ready.' });
        if (!key.sets || !key.sets[b.set]) return res.status(400).json({ success: false, message: `Set ${b.set} is not in this key.` });
        const eff = effective(key, b.set, req.body.overrides, !!req.body.acceptSingle);
        const questions = await loadExamQuestions(b.examId);
        if (!questions.length) return res.status(404).json({ success: false, message: 'This exam has no questions.' });
        const result = svc.compare(eff.answers, questions);
        enrichMismatches(result, questions);
        res.json({ success: true, set: b.set, examId: b.examId, unresolved: eff.unresolved, result });
    } catch (err) { console.error('answer-key compare:', err); res.status(500).json({ success: false, message: 'Server Error' }); }
});

router.post('/:id/save', async (req, res) => {
    try {
        const b = checkBody(req, res); if (!b) return;
        const key = await AnswerKey.findById(req.params.id);
        if (!key || !['ready', 'applied'].includes(key.status)) return res.status(404).json({ success: false, message: 'Answer key is not ready.' });
        if (!key.sets || !key.sets[b.set]) return res.status(400).json({ success: false, message: `Set ${b.set} is not in this key.` });
        if (!key.images || !key.images.length) return res.status(400).json({ success: false, message: 'This key has no uploaded page images.' });

        const eff = effective(key, b.set, req.body.overrides, !!req.body.acceptSingle);
        if (eff.unresolved.length && !req.body.skipUnresolved) {
            return res.status(409).json({ success: false, code: 'UNRESOLVED', unresolved: eff.unresolved, message: `${eff.unresolved.length} answer(s) could not be verified by both readings (Q ${eff.unresolved.slice(0, 15).join(', ')}${eff.unresolved.length > 15 ? '…' : ''}). Confirm them, or tick "skip unverified".` });
        }

        const questions = await loadExamQuestions(b.examId);
        if (!questions.length) return res.status(404).json({ success: false, message: 'This exam has no questions.' });

        const imgOf = (page) => key.images.find(i => i.page === page) || key.images[0];
        const ops = [];
        for (const q of questions) {
            const n = Number(q.qnum);
            const ans = eff.answers[n];
            if (!ans) continue;
            const im = imgOf(eff.pages[n]);
            ops.push({
                updateOne: {
                    filter: { _id: q._id },
                    update: { $set: {
                        official_answer_key_answers: ans,
                        official_answer_key: im.ref,
                        answer_key_image_url: im.ref,
                        answer_key_images: [im.ref],
                        official_answer_key_msg_id: im.messageId,
                        official_answer_key_set: b.set
                    } }
                }
            });
        }
        if (!ops.length) return res.status(400).json({ success: false, message: 'No question number of this exam matches the key.' });

        let updated = 0;
        for (let i = 0; i < ops.length; i += 500) {
            const r = await Question.bulkWrite(ops.slice(i, i + 500), { ordered: false });
            updated += (r.matchedCount !== undefined ? r.matchedCount : r.nMatched) || 0;
        }

        key.status = 'applied'; key.appliedSet = b.set; key.appliedExam = b.examId; key.appliedAt = new Date(); key.appliedCount = updated; key.examId = b.examId;
        await key.save();
        try { await dataCache.invalidateExam(b.examId); } catch (e) { console.warn('answer-key: cache invalidate failed:', e.message); }   // students get the new data at once
        try { dataCache.notifyDataChanged(); } catch (e) {}   // the dashboard's "Answer key available" badge is rebuilt

        // optional: ALSO make the official key the FINAL answer (only questions that have an official answer)
        let finals = null;
        if (req.body.replaceFinal) {
            const changes = [], multi = [];
            for (const q of questions) {
                const n = Number(q.qnum), off = eff.answers[n];
                if (!off) continue;
                const v = singleOf(off);
                if (v) changes.push({ id: String(q._id), value: v, source: 'official' }); else multi.push(n);
            }
            finals = await writeFinals(b.examId, changes);
            finals.multi = multi.sort((x, y) => x - y);
        }

        const fresh = finals && finals.changed ? await loadExamQuestions(b.examId) : questions;
        const result = svc.compare(eff.answers, fresh);
        enrichMismatches(result, fresh);
        let check = null;
        try { check = await examCheck(b.examId); } catch (e) { console.warn('answer-key: read-back failed:', e.message); }
        res.json({ success: true, updated, skipped: eff.unresolved.length, set: b.set, examId: b.examId, result, check, finals });
    } catch (err) { console.error('answer-key save:', err); res.status(500).json({ success: false, message: 'Server Error' }); }
});

// ── FINAL answers ────────────────────────────────────────────────────────────────────────────
// mode 'official-all': every question of the exam that has an official answer SAVED (official_answer_key_answers) gets it as its final answer
// mode 'choices'     : { questionId: '1'..'4' | '#' } chosen by the admin one by one (e.g. in the compare list)
router.post('/apply-final', async (req, res) => {
    try {
        const { examId, mode } = req.body || {};
        if (!okExam(examId)) return res.status(400).json({ success: false, message: 'Select an exam.' });
        const exam = String(examId).trim();
        const changes = []; const multi = [];
        if (mode === 'official-all') {
            const qs = await Question.find({ year_exam: exam, official_answer_key_answers: { $nin: [null, ''] } }).select('_id qnum official_answer_key_answers').lean();
            if (!qs.length) return res.status(400).json({ success: false, message: 'This exam has no saved official answers. Upload + Save the official answer key first.' });
            for (const q of qs) {
                const v = singleOf(q.official_answer_key_answers);
                if (v) changes.push({ id: String(q._id), value: v, source: 'official' }); else multi.push(Number(q.qnum));
            }
        } else if (mode === 'choices') {
            const ch = (req.body.choices && typeof req.body.choices === 'object') ? req.body.choices : {};
            for (const [id, v] of Object.entries(ch)) {
                if (!okId(id)) continue;
                if (!okFinal(v)) return res.status(400).json({ success: false, message: 'Final answer must be 1, 2, 3, 4 or # (cancelled).' });
                changes.push({ id, value: String(v), source: 'admin' });
            }
            if (!changes.length) return res.status(400).json({ success: false, message: 'Nothing to change.' });
        } else return res.status(400).json({ success: false, message: 'Invalid mode.' });

        const r = await writeFinals(exam, changes);
        res.json({ success: true, examId: exam, changed: r.changed, same: r.same, notFound: r.notFound, recalc: r.recalc || null, multi: multi.sort((a, b) => a - b) });
    } catch (err) { console.error('answer-key apply-final:', err); res.status(500).json({ success: false, message: 'Server Error' }); }
});

// re-judge the students' saved answers of every question whose final answer this tool changed (also fixes older changes)
router.post('/recalc-students', async (req, res) => {
    try {
        const examId = req.body && req.body.examId;
        if (!okExam(examId)) return res.status(400).json({ success: false, message: 'Select an exam.' });
        const qs = await Question.find({ year_exam: String(examId).trim(), final_answer_changed_at: { $exists: true, $ne: null } }).select('_id').lean();
        if (!qs.length) return res.status(400).json({ success: false, message: 'No final answer changed by this tool in this exam.' });
        res.json({ success: true, recalc: await recalcWithin(qs.map(q => q._id), 25000) });
    } catch (err) { console.error('answer-key recalc-students:', err); res.status(500).json({ success: false, message: 'Server Error' }); }
});

// restore the final answers this tool changed (back to what they were before the FIRST change)
router.post('/undo-final', async (req, res) => {
    try {
        const examId = req.body && req.body.examId;
        if (!okExam(examId)) return res.status(400).json({ success: false, message: 'Select an exam.' });
        const exam = String(examId).trim();
        const qs = await Question.find({ year_exam: exam, final_answer_changed_at: { $exists: true, $ne: null } }).select('_id final_answer_prev final_answer_prev_source').lean();
        if (!qs.length) return res.status(400).json({ success: false, message: 'No final answer changed by this tool in this exam.' });
        const ops = qs.map(q => ({ updateOne: { filter: { _id: q._id }, update: {
            $set: { correct_answer_option: q.final_answer_prev || '', answer_source: q.final_answer_prev_source || '' },
            $unset: { final_answer_prev: '', final_answer_prev_source: '', final_answer_changed_at: '' }
        } } }));
        for (let i = 0; i < ops.length; i += 500) await Question.bulkWrite(ops.slice(i, i + 500), { ordered: false });
        try { await dataCache.invalidateExam(exam); } catch (e) {}
        try { dataCache.notifyDataChanged(); } catch (e) {}
        const recalc = await recalcWithin(qs.map(q => q._id));
        res.json({ success: true, restored: qs.length, recalc });
    } catch (err) { console.error('answer-key undo-final:', err); res.status(500).json({ success: false, message: 'Server Error' }); }
});

module.exports = router;
