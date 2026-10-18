/**
 * routes/examimport.js   (mounted at /api/admin/exam-import, admin only)
 * ──────────────────────────────────────────────────────────────────────────
 *  GET    /                         recent drafts
 *  POST   /upload                   multipart: qpdf (question paper) + keypdf (official answer key, optional) -> { id }
 *  GET    /:id                      status while processing / the full review data when ready
 *  PATCH  /:id/meta                 { officialName, examDate, examCode, paperName, paperSet, yearExam, keySet }
 *  PUT    /:id/overrides            { overrides: { "12": "3" } }  confirmed official answers (unverified / conflicting key answers)
 *  PATCH  /:id/question/:qnum       edit one question
 *  POST   /:id/question/:qnum/rescan   { mode: 'image' | 'text' }   re-do ONLY this question
 *  POST   /:id/question/:qnum/image    multipart: image  -> the admin's own image for this question (null to remove: DELETE)
 *  DELETE /:id/question/:qnum       remove one question from the draft
 *  POST   /:id/publish              { confirm:true, groupIds:[...] }  -> real Question documents + exam groups
 *  DELETE /:id                      discard the draft
 * Nothing reaches the Questions collection before /publish.
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

const ExamDraft = require('../models/ExamDraft');
const ExamGroup = require('../models/ExamGroup');
const AnswerKey = require('../models/AnswerKey');
const Question = require('../models/Question');
const User = require('../models/User');
const { authMiddleware } = require('../middleware/auth');
const svc = require('../utils/answerKeyService');
const imp = require('../utils/examImport');
const dataCache = require('../utils/dataCache');
const examCatalog = require('../utils/examCatalog');
const { broadcast } = require('../utils/userEvents');

const UPLOAD_DIR = path.join(os.tmpdir(), 'examimport_uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}

const isPdf = (f) => /pdf/i.test(f.mimetype || '') || /\.pdf$/i.test(f.originalname || '');
const uploadPdfs = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 40 * 1024 * 1024, files: 2 },
    fileFilter: (req, file, cb) => cb(isPdf(file) ? null : new Error('Only PDF files can be uploaded.'), isPdf(file))
}).fields([{ name: 'qpdf', maxCount: 1 }, { name: 'keypdf', maxCount: 1 }]);
const uploadImage = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(/^image\/(jpeg|png|webp)$/i.test(file.mimetype || '') ? null : new Error('Only a JPG / PNG / WEBP image can be uploaded.'), /^image\//i.test(file.mimetype || ''))
}).single('image');

const limiter = rateLimit({ windowMs: 60 * 1000, limit: 6, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many uploads, wait a minute.' } });

const okId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);

async function adminOnly(req, res, next) {
    try {
        const user = await User.findById(req.user.id).select('isAdmin').lean();
        if (!user || !user.isAdmin) return res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' });
        next();
    } catch (e) { res.status(500).json({ success: false, message: 'Server Error' }); }
}
router.use(authMiddleware, adminOnly);

const fail = (res, err, where) => { console.error('exam-import ' + where + ':', err && err.message ? err.message : err); res.status(500).json({ success: false, message: (err && err.message) || 'Server Error' }); };
const rmFiles = (files) => (files || []).forEach(f => f && f.path && fsp.rm(f.path, { force: true }).catch(() => {}));

// ── what the official key says for each question number ─────────────────────────────
function officialMap(d) {
    const out = {};   // qnum -> { value, state }
    const key = d.key;
    const set = d.keySet;
    const ov = d.keyOverrides || {};
    const sets = (key && key.sets && set && key.sets[set]) || {};
    const unver = ((key && key.verification && key.verification.unverified) || []).filter(u => u.set === set);
    for (const [q, a] of Object.entries(sets)) out[q] = { value: a, state: 'verified' };
    for (const u of unver) if (!out[u.q]) out[u.q] = { value: '', state: 'unverified', a: u.a || null, b: u.b || null, page: u.page || null };
    for (const [q, a] of Object.entries(ov)) { const v = svcNorm(a); if (v) out[q] = { value: v, state: 'confirmed' }; }
    return out;
}
const svcNorm = (a) => svc.normAnswer(a);
const matches = (official, ai) => !!official && !!ai && String(official).split('/').includes(String(ai));

function decorate(d) {
    const om = officialMap(d);
    return d.questions.map(q => {
        const o = om[q.qnum] || null;
        const official = o && o.value ? o.value : '';
        const finalAns = q.admin_answer || official || q.ai_answer || '';
        const aiFirst = q.ai_answer_original || q.ai_answer;      // what the AI first said (before an explanation was rebuilt for the official answer)
        let match = 'none';
        if (official && aiFirst) match = matches(official, aiFirst) ? 'match' : 'mismatch';
        // the AI's own answer and an independent blind check disagree (and nothing official decides it)
        const blindDiff = !official && !q.admin_answer && !!q.blind_answer && !!q.ai_answer && q.blind_answer !== q.ai_answer;
        // the AI AND the blind check both say the same thing, but the official key says something else -> maybe the key was misread
        const keyDoubt = !!official && official !== '#' && !q.admin_answer && !!q.blind_answer && !!aiFirst && q.blind_answer === aiFirst && !matches(official, q.blind_answer);
        // an explanation that was written for another option than the one that will be shown
        const expl = q.explanation_answer || q.ai_answer;
        const explOk = !finalAns || finalAns === '#' || !expl || String(finalAns).split('/').includes(String(expl));
        return { ...q, official, officialState: o ? o.state : 'none', officialA: o && o.a || null, officialB: o && o.b || null, final: finalAns, match, blindDiff, keyDoubt, explanationMismatch: !explOk };
    });
}

function summary(d, qs) {
    const c = { total: qs.length, withKey: 0, match: 0, mismatch: 0, noOfficial: 0, verifyDiff: 0, explanationMismatch: 0, unresolvedKey: 0, blindDiff: 0, keyDoubt: 0, autoFixed: 0, fixOk: 0, fixFailed: 0 };
    for (const q of qs) {
        if (q.official) c.withKey++; else c.noOfficial++;
        if (q.match === 'match') c.match++;
        if (q.match === 'mismatch') c.mismatch++;
        if (q.verify && (q.verify.state === 'diff' || q.verify.state === 'missing')) c.verifyDiff++;
        if (q.explanationMismatch) c.explanationMismatch++;
        if (q.blindDiff) c.blindDiff++;
        if (q.keyDoubt) c.keyDoubt++;
        if (q.auto_fixed) c.autoFixed++;
        if (q.fix && q.fix.state === 'verified') c.fixOk++;
        if (q.fix && q.fix.state === 'failed') c.fixFailed++;
        if (q.officialState === 'unverified') c.unresolvedKey++;
    }
    return c;
}

function view(d, full) {
    const base = { id: String(d._id), status: d.status, progress: d.progress || '', error: d.error || '', fileName: d.fileName, keyFileName: d.keyFileName, createdAt: d.createdAt, publishedExam: d.publishedExam || '' };
    if (!full || d.status !== 'review') return base;
    const qs = decorate(d);
    const key = d.key ? {
        sets: Object.keys(d.key.sets || {}).sort().map(s => ({ name: s, answers: Object.keys(d.key.sets[s] || {}).length })),
        perSet: (d.key.verification && d.key.verification.perSet) || {},
        engines: (d.key.verification && d.key.verification.engines) || [],
        pageCount: d.key.pageCount || 0,
        images: (d.key.images || []).map(i => ({ page: i.page, ref: i.ref }))
    } : null;
    return {
        ...base, meta: d.meta || {}, notes: d.notes || [], pageCount: d.pageCount,
        pages: (d.pages || []).map(p => ({ page: p.page, ref: p.ref })),
        keySet: d.keySet || '', key, overrides: d.keyOverrides || {},
        questions: qs, summary: summary(d, qs),
        nameTaken: false
    };
}

async function load(req, res, { needReview = true } = {}) {
    if (!okId(req.params.id)) { res.status(400).json({ success: false, message: 'Invalid id.' }); return null; }
    const d = await ExamDraft.findById(req.params.id);
    if (!d) { res.status(404).json({ success: false, message: 'Draft not found.' }); return null; }
    if (needReview && d.status !== 'review') { res.status(409).json({ success: false, message: 'This draft is not in the review stage (status: ' + d.status + ').' }); return null; }
    return d;
}
const qIndex = (d, n) => d.questions.findIndex(q => q.qnum === Number(n));

// ── list ────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const list = await ExamDraft.find({ status: { $in: ['processing', 'review', 'failed'] } }, 'fileName status progress meta createdAt').sort({ createdAt: -1 }).limit(15).lean();
        res.json({ success: true, drafts: list.map(d => ({ id: String(d._id), fileName: d.fileName, status: d.status, name: (d.meta && d.meta.yearExam) || '', createdAt: d.createdAt })), ai: await svc.aiAvailable(), providers: await require('../utils/visionAI').describe() });
    } catch (e) { fail(res, e, 'list'); }
});

// ── upload ──────────────────────────────────────────────────────────────────────────
router.post('/upload', limiter, (req, res) => {
    uploadPdfs(req, res, async (err) => {
        const files = req.files || {};
        const q = (files.qpdf || [])[0], k = (files.keypdf || [])[0];
        const cleanAll = () => rmFiles([q, k]);
        if (err) { cleanAll(); return res.status(400).json({ success: false, message: err.message || 'Upload failed.' }); }
        if (!q) { cleanAll(); return res.status(400).json({ success: false, message: 'Choose the question paper PDF.' }); }
        if (!(await svc.aiAvailable())) { cleanAll(); return res.status(400).json({ success: false, message: 'No AI is configured - set GEMINI_API_KEYS or add a custom endpoint in 🤖 AI Settings (Fix AI).' }); }
        try {
            for (const f of [q, k].filter(Boolean)) {
                const head = Buffer.alloc(5); const fh = await fsp.open(f.path, 'r'); await fh.read(head, 0, 5, 0); await fh.close();
                if (head.toString('latin1') !== '%PDF-') { cleanAll(); return res.status(400).json({ success: false, message: 'One of the files is not a valid PDF.' }); }
            }
            const doc = await ExamDraft.create({ status: 'processing', progress: 'Starting…', fileName: String(q.originalname || 'question_paper.pdf').slice(0, 200), keyFileName: k ? String(k.originalname || '').slice(0, 200) : '' });
            imp.start(doc._id, q.path, k ? k.path : null);
            res.json({ success: true, id: String(doc._id) });
        } catch (e) { cleanAll(); fail(res, e, 'upload'); }
    });
});

router.get('/:id', async (req, res) => {
    try {
        const d = await load(req, res, { needReview: false }); if (!d) return;
        if (d.status === 'processing' && !imp.isRunning(d._id) && Date.now() - new Date(d.updatedAt).getTime() > 3 * 60 * 1000) {
            d.status = 'failed'; d.error = 'Processing was interrupted (the server restarted). Upload the PDFs again.'; d.progress = '';
            await d.save();
        }
        res.json({ success: true, draft: view(d.toObject(), true) });
    } catch (e) { fail(res, e, 'get'); }
});

// ── meta + key set ──────────────────────────────────────────────────────────────────
router.patch('/:id/meta', async (req, res) => {
    try {
        const d = await load(req, res); if (!d) return;
        const b = req.body || {};
        const meta = { ...(d.meta || {}) };
        for (const f of ['officialName', 'examDate', 'examCode', 'paperName', 'paperSet', 'yearExam']) {
            if (typeof b[f] === 'string') meta[f] = b[f].trim().slice(0, 300);
        }
        if (!b.yearExam && (b.officialName !== undefined || b.examDate !== undefined || b.paperName !== undefined)) meta.yearExam = imp.nameFrom(meta);
        if (!meta.yearExam) return res.status(400).json({ success: false, message: 'The exam name cannot be empty.' });
        d.meta = meta; d.markModified('meta');
        if (typeof b.keySet === 'string' && (b.keySet === '' || (d.key && d.key.sets && d.key.sets[b.keySet]))) d.keySet = b.keySet;
        await d.save();
        res.json({ success: true, draft: view(d.toObject(), true) });
    } catch (e) { fail(res, e, 'meta'); }
});

router.put('/:id/overrides', async (req, res) => {
    try {
        const d = await load(req, res); if (!d) return;
        const ov = {};
        for (const [q, a] of Object.entries((req.body && req.body.overrides) || {})) {
            const n = parseInt(q, 10), v = svcNorm(a);
            if (n >= 1 && n <= 400 && v) ov[n] = v;
        }
        d.keyOverrides = ov; d.markModified('keyOverrides');
        await d.save();
        res.json({ success: true, draft: view(d.toObject(), true) });
    } catch (e) { fail(res, e, 'overrides'); }
});

// ── one question ────────────────────────────────────────────────────────────────────
const EDIT_FIELDS = ['text', 'text_eng', 'toppers_explanation_marathi', 'passage_text', 'subject', 'topic', 'sub_topic', 'diagram_description'];
router.patch('/:id/question/:qnum', async (req, res) => {
    try {
        const d = await load(req, res); if (!d) return;
        const i = qIndex(d, req.params.qnum);
        if (i < 0) return res.status(404).json({ success: false, message: 'No such question.' });
        const q = { ...d.questions[i] }, b = req.body || {};
        for (const f of EDIT_FIELDS) if (typeof b[f] === 'string') q[f] = b[f];
        for (const f of ['options', 'options_eng', 'options_explanation']) if (Array.isArray(b[f])) q[f] = b[f].map(x => String(x)).slice(0, 8);
        if (typeof b.has_diagram_or_passage === 'boolean') q.has_diagram_or_passage = b.has_diagram_or_passage;
        if (b.admin_answer !== undefined) q.admin_answer = (b.admin_answer === '' || b.admin_answer === null) ? '' : (svcNorm(b.admin_answer) || q.admin_answer);
        if (b.ai_answer !== undefined) { const v = svcNorm(b.ai_answer); if (v) q.ai_answer = v; }
        if (b.page !== undefined) {
            const p = parseInt(b.page, 10);
            if (!(d.pages || []).some(x => x.page === p)) return res.status(400).json({ success: false, message: 'No such page.' });
            q.page = p; q.imageRef = null;
            const pg = d.pages.find(x => x.page === p); q.telegram_msg_id = pg ? pg.messageId : null;
        }
        q.edited = true;
        d.questions[i] = q; d.markModified('questions');
        await d.save();
        const qs = decorate(d.toObject());
        res.json({ success: true, question: qs[i], summary: summary(d, qs) });
    } catch (e) { fail(res, e, 'question edit'); }
});

// Re-scan = the website's Fix AI (several AI calls + live web facts + an independent blind check), so it can take a few minutes.
// It runs in the background; the screen asks /rescan-status until it is done.
const rescans = new Map();   // "draftId:qnum" -> { state: 'running'|'done'|'error', message, at }
router.post('/:id/question/:qnum/rescan', async (req, res) => {
    try {
        const d = await load(req, res); if (!d) return;
        const i = qIndex(d, req.params.qnum);
        if (i < 0) return res.status(404).json({ success: false, message: 'No such question.' });
        const k = req.params.id + ':' + req.params.qnum;
        if (rescans.get(k) && rescans.get(k).state === 'running') return res.json({ success: true, started: false, message: 'Already running.' });
        const mode = req.body && req.body.mode === 'text' ? 'text' : 'image';
        const dec = decorate(d.toObject())[i];
        const official = dec.admin_answer || dec.official || '';
        const snapshot = d.toObject();
        const qnum = Number(req.params.qnum);
        rescans.set(k, { state: 'running', at: Date.now() });
        res.json({ success: true, started: true });
        (async () => {
            try {
                const out = await imp.rescanQuestion(snapshot, snapshot.questions[i], { mode, official: official && !String(official).includes('/') ? official : '' });
                out.edited = false;
                // re-load: the admin may have changed other questions while this ran
                const fresh = await ExamDraft.findById(req.params.id);
                const j = fresh ? qIndex(fresh, qnum) : -1;
                if (j < 0) throw new Error('The question is no longer in the draft.');
                fresh.questions[j] = out; fresh.markModified('questions');
                await fresh.save();
                rescans.set(k, { state: 'done', at: Date.now() });
            } catch (e) {
                console.error('exam-import rescan:', e.message);
                rescans.set(k, { state: 'error', message: String(e.message || e).slice(0, 400), at: Date.now() });
            }
        })();
    } catch (e) { fail(res, e, 'rescan'); }
});

router.get('/:id/question/:qnum/rescan-status', async (req, res) => {
    try {
        const k = req.params.id + ':' + req.params.qnum;
        const st = rescans.get(k) || { state: 'none' };
        if (st.state === 'running' && Date.now() - st.at > 20 * 60 * 1000) { rescans.set(k, { state: 'error', message: 'Timed out.', at: Date.now() }); return res.json({ success: true, state: 'error', message: 'Timed out.' }); }
        if (st.state === 'none' || st.state === 'running') return res.json({ success: true, state: st.state });
        rescans.delete(k);
        if (st.state === 'error') return res.json({ success: true, state: 'error', message: st.message });
        const d = await load(req, res); if (!d) return;
        const i = qIndex(d, req.params.qnum);
        const qs = decorate(d.toObject());
        res.json({ success: true, state: 'done', question: qs[i], summary: summary(d, qs) });
    } catch (e) { fail(res, e, 'rescan status'); }
});

router.post('/:id/question/:qnum/image', limiter, (req, res) => {
    uploadImage(req, res, async (err) => {
        const f = req.file;
        try {
            if (err) return res.status(400).json({ success: false, message: err.message || 'Upload failed.' });
            if (!f) return res.status(400).json({ success: false, message: 'Choose an image.' });
            const d = await load(req, res); if (!d) return;
            const i = qIndex(d, req.params.qnum);
            if (i < 0) return res.status(404).json({ success: false, message: 'No such question.' });
            const u = await svc.uploadFile(await fsp.readFile(f.path), `question_${req.params.qnum}.jpg`, 'image/jpeg', `Question ${req.params.qnum} | ${(d.meta && d.meta.yearExam) || ''} | admin image`);
            const q = { ...d.questions[i], imageRef: u.ref, telegram_msg_id: u.messageId, edited: true };
            d.questions[i] = q; d.markModified('questions');
            await d.save();
            const qs = decorate(d.toObject());
            res.json({ success: true, question: qs[i], summary: summary(d, qs) });
        } catch (e) { fail(res, e, 'question image'); }
        finally { rmFiles([f]); }
    });
});

router.delete('/:id/question/:qnum/image', async (req, res) => {
    try {
        const d = await load(req, res); if (!d) return;
        const i = qIndex(d, req.params.qnum);
        if (i < 0) return res.status(404).json({ success: false, message: 'No such question.' });
        const q = { ...d.questions[i], imageRef: null };
        const pg = d.pages.find(x => x.page === q.page); q.telegram_msg_id = pg ? pg.messageId : null;
        d.questions[i] = q; d.markModified('questions');
        await d.save();
        const qs = decorate(d.toObject());
        res.json({ success: true, question: qs[i], summary: summary(d, qs) });
    } catch (e) { fail(res, e, 'question image remove'); }
});

router.delete('/:id/question/:qnum', async (req, res) => {
    try {
        const d = await load(req, res); if (!d) return;
        const i = qIndex(d, req.params.qnum);
        if (i < 0) return res.status(404).json({ success: false, message: 'No such question.' });
        d.questions.splice(i, 1); d.markModified('questions');
        await d.save();
        res.json({ success: true, draft: view(d.toObject(), true) });
    } catch (e) { fail(res, e, 'question delete'); }
});

// ── publish ─────────────────────────────────────────────────────────────────────────
router.post('/:id/publish', async (req, res) => {
    try {
        const d = await load(req, res); if (!d) return;
        if (!req.body || req.body.confirm !== true) return res.status(400).json({ success: false, message: 'Confirmation required.' });
        const yearExam = String((d.meta && d.meta.yearExam) || '').trim();
        if (!yearExam) return res.status(400).json({ success: false, message: 'Give the exam a name first.' });
        if (yearExam === 'Passage Comprehension') return res.status(400).json({ success: false, message: 'This name is reserved.' });
        if (!d.questions.length) return res.status(400).json({ success: false, message: 'There are no questions to publish.' });
        if (await Question.exists({ year_exam: yearExam })) return res.status(409).json({ success: false, code: 'NAME_TAKEN', message: `An exam named "${yearExam}" already exists. Change the name (for example add the paper / set) and publish again.` });

        const qs = decorate(d.toObject());
        const key = d.key, set = d.keySet;
        const keyImg = (page) => (key && key.images || []).find(i => i.page === page) || (key && key.images && key.images[0]) || null;
        const meta = d.meta || {};
        const docs = qs.map(q => {
            const useOfficial = !q.admin_answer && q.official && q.officialState !== 'unverified';
            const finalAns = q.admin_answer || (useOfficial ? q.official : q.ai_answer) || '';
            const pg = (d.pages || []).find(p => p.page === q.page);
            const doc = {
                qnum: q.qnum, text: q.text || q.text_eng || 'N/A', text_eng: q.text_eng || '',
                options: q.options || [], options_eng: q.options_eng || [],
                has_diagram_or_passage: !!q.has_diagram_or_passage,
                final_answer_key: finalAns, correct_answer_option: finalAns,
                exam_set: meta.paperSet || '', paper_code: meta.examCode || meta.paperSet || '',
                toppers_explanation_marathi: q.toppers_explanation_marathi || '',
                subject: q.subject || 'General', topic: q.topic || 'General', sub_topic: q.sub_topic || '',
                original_image_url: q.imageRef || (pg && pg.ref) || null,
                official_exam_name: yearExam, year_exam: yearExam, exam_date: meta.examDate || '',
                diagram_description: q.diagram_description || null,
                options_explanation: q.options_explanation || [],
                passage_text: q.passage_text || null,
                page_no: q.page, telegram_msg_id: q.telegram_msg_id || (pg && pg.messageId) || undefined,
                is_ai_fixed: !!(q.fix && q.fix.state === 'verified'), ai_fixed_at: (q.fix && q.fix.state === 'verified') ? new Date() : undefined,
                ai_answer_option: q.ai_answer_original || q.ai_answer || '',
                explanation_answer: q.explanation_answer || q.ai_answer || '',
                answer_source: useOfficial ? 'official' : 'ai'
            };
            if (useOfficial && key) {
                const im = keyImg(key.pages && key.pages[set] && key.pages[set][q.qnum]);
                doc.official_answer_key_answers = q.official;
                doc.official_answer_key_set = set;
                if (im) {
                    doc.official_answer_key = im.ref; doc.answer_key_image_url = im.ref; doc.answer_key_images = [im.ref]; doc.official_answer_key_msg_id = im.messageId;
                }
            }
            return doc;
        });

        // claim the name atomically-ish: re-check right before the insert
        if (await Question.exists({ year_exam: yearExam })) return res.status(409).json({ success: false, code: 'NAME_TAKEN', message: 'An exam with this name was just created.' });
        await Question.insertMany(docs, { ordered: false });

        // folders (groups) the admin picked
        const groupIds = (Array.isArray(req.body.groupIds) ? req.body.groupIds : []).filter(okId);
        if (groupIds.length) await ExamGroup.updateMany({ _id: { $in: groupIds } }, { $addToSet: { exams: yearExam } });

        // keep the official key record, like the Answer Key tool does
        if (key) {
            try {
                await AnswerKey.create({ fileName: d.keyFileName || 'answer_key.pdf', examId: yearExam, status: 'applied', pageCount: key.pageCount || 0, sets: key.sets, pages: key.pages, verification: key.verification, images: key.images, pdf: key.pdf, appliedSet: set, appliedExam: yearExam, appliedAt: new Date(), appliedCount: docs.filter(x => x.official_answer_key_answers).length });
            } catch (e) { console.warn('exam-import: AnswerKey record not saved:', e.message); }
        }

        d.status = 'published'; d.publishedExam = yearExam; d.publishedAt = new Date(); d.progress = '';
        d.questions = []; d.markModified('questions');   // the draft body is no longer needed
        await d.save();
        imp.cleanup(d._id);

        try { await dataCache.invalidateExam(yearExam); } catch (e) {}
        try { dataCache.notifyDataChanged(); } catch (e) {}
        try { examCatalog.invalidate(); broadcast('catalog'); } catch (e) {}
        res.json({ success: true, examId: yearExam, published: docs.length, groups: groupIds.length });
    } catch (e) { fail(res, e, 'publish'); }
});

router.delete('/:id', async (req, res) => {
    try {
        if (!okId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id.' });
        const d = await ExamDraft.findById(req.params.id).select('status').lean();
        if (d && d.status === 'processing' && imp.isRunning(req.params.id)) return res.status(409).json({ success: false, message: 'Wait until processing finishes.' });
        await ExamDraft.deleteOne({ _id: req.params.id });
        imp.cleanup(req.params.id);
        res.json({ success: true });
    } catch (e) { fail(res, e, 'discard'); }
});

module.exports = router;
