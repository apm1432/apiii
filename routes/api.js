const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Razorpay = require('razorpay');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const os = require('os');
const axios = require('axios');

const imageStore = require('../utils/imageStore');
const dataCache = require('../utils/dataCache');
const CACHE_DIR = imageStore.CACHE_DIR; // os.tmpdir()/mpscpyq_images

// Models
const Question = require('../models/Question');
const User = require('../models/User');
const Progress = require('../models/Progress');
const UserNotes = require('../models/UserNotes');
const UserStars = require('../models/UserStars');
const notesSvc = require('../utils/notesService');

// Middleware & Services
const { authMiddleware, requireSubscription, isSessionActive } = require('../middleware/auth');
const smtpService = require('../utils/smtpService');
const { applyPayment, listActivePlans, getActivePlan, snapshotNotes, toPaise } = require('../utils/payments');
const examCatalog = require('../utils/examCatalog');
const ExamGroup = require('../models/ExamGroup');
const SubjectAlias = require('../models/SubjectAlias');
const subjectNames = require('../utils/subjects');
const ExamHidden = require('../models/ExamHidden');
const { broadcast } = require('../utils/userEvents');
const jwtLib = require('jsonwebtoken');
const { fixQuestionWithAI, chatAboutQuestionEx, getGeminiInfo, testGemini } = require('../utils/aiService');
const chatProviders = require('../utils/chatProviders');
const { buildPaperText, buildSubjectText, extractYear: examYear, MODES } = require('../utils/paperExport');

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// -------------------------------------
// 1. DATA API
// -------------------------------------

let cachedHierarchy = null;
let lastCacheTime = 0;

function extractYear(str) {
    const marathiToEnglish = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };
    const engStr = (str || '').replace(/[०-९]/g, m => marathiToEnglish[m]);
    const match = engStr.match(/\b(19\d{2}|20\d{2})\b/);
    if (match) return parseInt(match[1], 10);
    return 0;
}

let cachedPassageByExam = {}; // year_exam -> number of passage questions

// Builds the FULL exam list (hidden papers included). Hiding is applied per request, so an admin
// change is instant and never needs this cache to be rebuilt.
async function buildHierarchyBase() {
    const hierarchy = await Question.aggregate([
        { $group: { _id: { year_exam: "$year_exam", subject: "$subject" }, count: { $sum: 1 } } },
        { $group: { _id: "$_id.year_exam", exams: { $push: { subject: "$_id.subject", count: "$count" } } } }
    ]);
    hierarchy.sort((a, b) => extractYear(b._id) - extractYear(a._id));

    const passages = await Question.aggregate([
        { $match: { $or: [
            { passage_marathi: { $exists: true, $nin: [null, "null"] } },
            { passage_english: { $exists: true, $nin: [null, "null"] } },
            { passage_text: { $exists: true, $nin: [null, "null"] } }
        ] } },
        { $group: { _id: "$year_exam", count: { $sum: 1 } } }
    ]);
    const byExam = {};
    passages.forEach(p => { byExam[String(p._id)] = p.count; });

    // how many questions of each paper have an official answer key (answer and/or key image) -> "Answer key available" badge.
    // If this query ever fails the exam list still works (the badge is just not shown).
    try {
        const keyed = await Question.aggregate([
            { $match: { $or: [
                { official_answer_key_answers: { $exists: true, $nin: [null, ''] } },
                { official_answer_key: { $exists: true, $nin: [null, ''] } }
            ] } },
            { $group: { _id: '$year_exam', n: { $sum: 1 } } }
        ]);
        const keyedBy = {};
        keyed.forEach(k => { keyedBy[String(k._id)] = k.n; });
        hierarchy.forEach(h => { h.keyed = keyedBy[String(h._id)] || 0; });
    } catch (e) { console.error('hierarchy: answer-key counts unavailable:', e.message); }

    cachedHierarchy = hierarchy;
    cachedPassageByExam = byExam;
    lastCacheTime = Date.now();
    return hierarchy;
}

async function preloadHierarchy() {
    try {
        console.log("⏳ Preloading exam hierarchy into server memory...");
        await buildHierarchyBase();
        console.log("✅ Hierarchy preloaded successfully!");
        await imageStore.loadSettings();
        // new / changed papers noticed by the data cache -> refresh the exam list too
        dataCache.onDataChanged(() => { cachedHierarchy = null; lastCacheTime = 0; buildHierarchyBase().catch(() => {}); try { require('../utils/examMeta').invalidate(); subjectNames.invalidate(); } catch (e) {} });
        // load every paper into the disk cache in the background, so the FIRST student is fast too
        if (process.env.WARM_DATA_ON_START !== '0') {
            dataCache.warm(cachedHierarchy.map(e => e._id), false).catch(() => {});
        }
    } catch (err) {
        console.error("❌ Failed to preload hierarchy:", err);
    }
}

// The two papers that are free for trial users = the 2 newest papers that are NOT hidden.
function freeExamIds(hiddenSet) {
    if (!cachedHierarchy || !cachedHierarchy.length) return [];
    return [...cachedHierarchy]
        .filter(e => !hiddenSet.has(e._id))
        .sort((x, y) => (extractYear(y._id || '') - extractYear(x._id || '')) || (x._id || '').localeCompare(y._id || ''))
        .slice(0, 2)
        .map(e => e._id);
}

// Is this request from a logged-in admin? (the hierarchy route is public, so we read the token ourselves)
async function isAdminRequest(req) {
    try {
        const h = req.header('Authorization');
        if (!h || !h.startsWith('Bearer ')) return false;
        const decoded = jwtLib.verify(h.split(' ')[1], require('../middleware/auth').JWT_SECRET);
        if (!(await isSessionActive(decoded))) return false;
        const u = await User.findById(decoded.id).select('isAdmin').lean();
        return !!(u && u.isAdmin);
    } catch (e) { return false; }
}

// Admin: Clear Cache (Called by bot_manager.js after sync)
// Needs EITHER a logged-in admin token OR the shared secret header (x-admin-secret = ADMIN_API_SECRET env) used by add_exam.py.
// It used to be open to the whole internet, so anyone could keep wiping the server cache (cheap denial of service).
router.post('/admin/clear-cache', async (req, res) => {
    let allowed = await isAdminRequest(req);
    if (!allowed) {
        const secret = process.env.ADMIN_API_SECRET;
        const sent = String(req.headers['x-admin-secret'] || '');
        if (secret && sent) {
            const a = Buffer.from(sent), b = Buffer.from(secret);
            allowed = a.length === b.length && crypto.timingSafeEqual(a, b);
        }
    }
    if (!allowed) return res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' });
    cachedHierarchy = null;
    lastCacheTime = 0;
    await dataCache.invalidateAll().catch(() => {}); // question data on disk is rebuilt from the database
    preloadHierarchy(); // Start preloading again in background
    res.json({ success: true });
});


// A client asked for a question id the database does not know: its copy of the exam is OLD (the paper was re-imported,
// so every question got a new _id). Drop the server data cache so the next load is fresh, and tell the client to reload.
const STALE_MSG = 'हा प्रश्न update झाला आहे. कृपया paper बंद करून पुन्हा उघडा (page refresh करा).';
function questionGone(res) {
    dataCache.invalidateAll().catch(() => {});
    return res.status(404).json({ success: false, code: 'STALE_QUESTION', message: STALE_MSG });
}

// Admin / AI: Telegram image as Base64 (disk cache first, Telegram only when the file is not on disk yet)
async function fetchTelegramImageBase64(rawFileId) {
    if (!rawFileId) return null;
    const r = await imageStore.ensureImage(rawFileId);
    if (!r) return null;
    try { return (await fsPromises.readFile(r.full)).toString('base64'); } catch (e) { return null; }
}

// All page images of a question (main image + the extra pages an admin added) for the AI. null = no image.
async function fetchQuestionImages(question) {
    const raws = [question.original_image_url, ...(Array.isArray(question.extra_images) ? question.extra_images : [])].filter(Boolean).slice(0, 4);
    const out = [];
    const seen = new Set();
    for (const raw of raws) {
        const f = imageStore.filenameFor(raw);
        if (!f || seen.has(f)) continue;
        seen.add(f);
        try { const b = await fetchTelegramImageBase64(raw); if (b) out.push(b); } catch (e) {}
    }
    if (!out.length) return null;
    return out.length === 1 ? out[0] : out;
}

// Expose fetchImageForAI to global so jobManager can use it
global.fetchImageForAI = fetchTelegramImageBase64;
global.fetchQuestionImagesForAI = fetchQuestionImages;

const { createJob, addClientToJob, retryQuestion, stopJob, resumeJob, retryAllFailed } = require('../utils/jobManager');
const { reconcileUserProgress } = require('../utils/progressSync');

// Admin: Start Background Job for Fixing Paper
router.post('/admin/fix-paper-bg', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user || !user.isAdmin) {
            return res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' });
        }

        const { questionIds } = req.body;
        if (!Array.isArray(questionIds) || questionIds.length === 0) {
            return res.status(400).json({ success: false, message: 'No questions provided.' });
        }

        // Generate a random job ID
        const jobId = Math.random().toString(36).substring(2, 15);
        createJob(jobId, questionIds);

        res.json({ success: true, jobId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// Admin: Stream Job Status (SSE)
router.get('/admin/fix-stream/:jobId', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user || !user.isAdmin) {
            return res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' });
        }
        
        const { jobId } = req.params;
        
        res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // Flush headers to establish SSE connection
    res.flushHeaders();

    const added = addClientToJob(jobId, res);
    if (!added) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Job not found' })}\n\n`);
        res.end();
    }
    } catch (err) {
        res.status(500).end();
    }
});

// Admin: all available papers (exams, newest first) and all subjects, for the download dropdowns
router.get('/admin/download-options', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user || !user.isAdmin) return res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' });
        const valid = v => typeof v === 'string' && v.trim() && v !== 'null';
        const exams = (await Question.distinct('year_exam')).filter(valid)
            .sort((a, b) => (examYear(b) - examYear(a)) || a.localeCompare(b));
        let subjects = (await Question.distinct('subject')).filter(valid);
        try { const r = await subjectNames.getResolver(); subjects = [...new Set(subjects.map(r.canon))]; } catch (e) { /* stored names */ }
        subjects.sort((a, b) => a.localeCompare(b));
        res.json({ success: true, exams, subjects });
    } catch (err) {
        console.error('download-options error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// Admin: list of all subjects (kept for compatibility)
router.get('/admin/subjects', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user || !user.isAdmin) return res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' });
        let subjects = (await Question.distinct('subject')).filter(s => typeof s === 'string' && s.trim() && s !== 'null');
        try { const r = await subjectNames.getResolver(); subjects = [...new Set(subjects.map(r.canon))]; } catch (e) { /* stored names */ }
        subjects.sort((a, b) => a.localeCompare(b));
        res.json({ success: true, data: subjects });
    } catch (err) {
        console.error('subjects error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// Admin: Download a .txt file
// body: { scope: 'paper' | 'subject', year_exam (scope=paper), subject (scope=subject), mode: 'questions' | 'answers' | 'full' }
//  - paper   : one complete exam paper
//  - subject : one subject from ALL exams, year-wise newest -> oldest
router.post('/admin/download-paper', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user || !user.isAdmin) return res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' });

        const scope = req.body.scope === 'subject' ? 'subject' : 'paper';
        const mode = MODES.includes(req.body.mode) ? req.body.mode : 'questions';
        let text;

        if (scope === 'subject') {
            const subject = typeof req.body.subject === 'string' ? req.body.subject.trim() : '';
            if (!subject) return res.status(400).json({ success: false, message: 'subject is required' });
            // every stored spelling of this subject
            let spellings = [subject];
            try { const r = await subjectNames.getResolver(); const all = r.rawsOf(r.canon(subject)); if (all.length) spellings = all; } catch (e) { /* only the given name */ }
            const noName = subject === subjectNames.UNCLASSIFIED ? [{ subject: null }, { subject: { $exists: false } }, { subject: '' }] : [];
            const questions = await Question.find({ $or: [{ subject: { $in: spellings } }, ...noName] }).lean();
            if (!questions.length) return res.status(404).json({ success: false, message: 'No questions found for this subject.' });
            text = buildSubjectText(questions, { subject, mode });
        } else {
            const year_exam = req.body.year_exam;
            if (!year_exam) return res.status(400).json({ success: false, message: 'year_exam is required' });

            let query;
            if (year_exam === 'Passage Comprehension') {
                query = { $or: [
                    { passage_marathi: { $exists: true, $nin: [null, "null"] } },
                    { passage_english: { $exists: true, $nin: [null, "null"] } },
                    { passage_text: { $exists: true, $nin: [null, "null"] } }
                ] };
            } else {
                query = { year_exam };
            }
            const questions = await Question.find(query).lean();
            if (!questions.length) return res.status(404).json({ success: false, message: 'No questions found for this exam.' });
            questions.sort((a, b) => (a.qnum || 0) - (b.qnum || 0));
            text = buildPaperText(questions, { title: year_exam, mode });
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(text);
    } catch (err) {
        console.error('download-paper error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// Admin: STOP the running AI Fix job (nothing new is sent to the AI; finished fixes stay)
router.post('/admin/fix-stop', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user || !user.isAdmin) return res.status(403).json({ success: false, message: 'Forbidden.' });
        const ok = stopJob(req.body && req.body.jobId);
        res.status(ok ? 200 : 400).json({ success: ok, message: ok ? undefined : 'Job not found' });
    } catch (err) { res.status(500).json({ success: false }); }
});

// Admin: continue the questions that were still waiting when the job was stopped
router.post('/admin/fix-resume', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user || !user.isAdmin) return res.status(403).json({ success: false, message: 'Forbidden.' });
        const ok = resumeJob(req.body && req.body.jobId);
        res.status(ok ? 200 : 400).json({ success: ok, message: ok ? undefined : 'Job not found' });
    } catch (err) { res.status(500).json({ success: false }); }
});

// Admin: put ALL failed questions of the job back in the queue
router.post('/admin/fix-retry-failed', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user || !user.isAdmin) return res.status(403).json({ success: false, message: 'Forbidden.' });
        const n = retryAllFailed(req.body && req.body.jobId);
        res.json({ success: true, retried: n });
    } catch (err) { res.status(500).json({ success: false }); }
});

// Admin: Retry a failed question in a job
router.post('/admin/fix-retry', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user || !user.isAdmin) return res.status(403).json({ success: false, message: 'Forbidden.' });

        const { jobId, questionId } = req.body;
        const retried = retryQuestion(jobId, questionId);
        
        if (retried) {
            res.json({ success: true });
        } else {
            res.status(400).json({ success: false, message: 'Job or question not found' });
        }
    } catch (err) {
        res.status(500).json({ success: false });
    }
});


// -------------------------------------
// Student "Ask AI" chat for ONE question (stateless: nothing is saved)
// -------------------------------------
const chatLimits = new Map(); // userId -> [timestamps]
const CHAT_PER_10MIN = 15, CHAT_PER_DAY = 80;
function chatRateOk(userId) {
    const now = Date.now();
    const arr = (chatLimits.get(userId) || []).filter(t => now - t < 24 * 3600 * 1000);
    const last10 = arr.filter(t => now - t < 10 * 60 * 1000).length;
    if (last10 >= CHAT_PER_10MIN || arr.length >= CHAT_PER_DAY) { chatLimits.set(userId, arr); return false; }
    arr.push(now); chatLimits.set(userId, arr); return true;
}
setInterval(() => { // drop old entries so the map does not grow forever
    const now = Date.now();
    for (const [k, v] of chatLimits) { const f = v.filter(t => now - t < 24 * 3600 * 1000); if (f.length) chatLimits.set(k, f); else chatLimits.delete(k); }
}, 3600 * 1000).unref();

// Obvious technical / coding requests (not GK like "what is ISRO"). The AI prompt also enforces the scope; this just saves quota.
function looksTechnicalRequest(msg) {
    const t = String(msg || '');
    if (/```/.test(t)) return true;
    if (/\b(write|create|make|build|generate|debug|fix|refactor|optimi[sz]e|convert|implement)\b[^.?\n]{0,40}\b(code|program|script|function|class|query|app|application|website|webpage|api|bot|algorithm|software)\b/i.test(t)) return true;
    if (/(कोड|प्रोग्राम)\s*(लिहा|लिही|बनवा|तयार करा|दुरुस्त)/.test(t)) return true;
    if (/\b(python|javascript|typescript|java|c\+\+|html|css|sql|mongodb|react|node\.?js|django|flask|docker|kubernetes|git(hub)?|linux)\b[^.?\n]{0,30}\b(code|program|script|error|bug|install|setup|configure|command|tutorial)\b/i.test(t)) return true;
    return false;
}

router.post('/question-chat', authMiddleware, async (req, res) => {
    try {
        const { questionId, message, history, withImage } = req.body || {};
        if (typeof questionId !== 'string' || !/^[a-f0-9]{24}$/i.test(questionId)) {
            return res.status(400).json({ success: false, message: 'Invalid question.' });
        }
        if (typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ success: false, message: 'Please type a question.' });
        }

        const user = await User.findById(req.user.id);
        if (!user) return res.status(401).json({ success: false, message: 'User not found' });

        const question = await Question.findById(questionId).lean();
        if (!question) return questionGone(res);

        // hidden papers do not exist for normal users
        const { hidden } = await examCatalog.getCatalog();
        if (hidden.has(question.year_exam) && !user.isAdmin) {
            return res.status(404).json({ success: false, message: 'Question not found.' });
        }

        // Same access rule as /questions: subscribed users, or the free-trial papers
        const subscribed = user.isSubscribed && user.subscriptionExpiry && new Date() <= user.subscriptionExpiry;
        let isFreeExam = false;
        if (!subscribed && user.hasUsedFreeTrial) {
            isFreeExam = freeExamIds(hidden).includes(question.year_exam);
        }
        if (!subscribed && !isFreeExam) {
            return res.status(403).json({ success: false, message: 'Subscription required.' });
        }

        if (!chatRateOk(String(req.user.id))) {
            return res.status(429).json({ success: false, message: 'Too many questions. Please wait a few minutes and try again.' });
        }

        // cheap guard: obvious coding / technical-task requests are refused here, before any AI quota is spent
        if (looksTechnicalRequest(message)) {
            return res.json({ success: true, reply: 'मी फक्त MPSC / स्पर्धा परीक्षेच्या अभ्यासाशी संबंधित प्रश्नांची उत्तरे देऊ शकतो. Technical / coding प्रश्नांची उत्तरे इथे मिळणार नाहीत. कृपया अभ्यासाचा एखादा प्रश्न विचारा.' });
        }

        // The question image is sent ONLY when the student switched "send question image" ON (default: OFF).
        let imageBase64 = null;
        if (withImage === true && question.original_image_url) {
            try { imageBase64 = await fetchQuestionImages(question); } catch (e) { imageBase64 = null; }
        }

        const out = await chatAboutQuestionEx(question, imageBase64, history, message);
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, reply: out.text, ...(user.isAdmin ? { via: out.provider } : {}) });
    } catch (err) {
        console.error('question-chat error:', err.message);
        res.status(500).json({ success: false, message: err.message || 'AI error' });
    }
});


// -------------------------------------
// Admin: exam groups + hide / unhide exam papers
// -------------------------------------
async function adminOnly(req, res) {
    const user = await User.findById(req.user.id);
    if (!user || !user.isAdmin) { res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' }); return null; }
    return user;
}
const cleanExamList = (list) => (Array.isArray(list) ? list : [])
    .filter(x => typeof x === 'string' && x.trim() && x.length <= 300 && x !== 'Passage Comprehension')
    .slice(0, 500);
const catalogChanged = () => { examCatalog.invalidate(); try { broadcast('catalog'); } catch (e) {} };

// hide / unhide papers: { examIds: [...], hidden: true|false }
router.post('/admin/exams/visibility', authMiddleware, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const ids = cleanExamList(req.body.examIds);
        if (!ids.length) return res.status(400).json({ success: false, message: 'Select at least one exam.' });
        if (req.body.hidden === true) {
            await ExamHidden.bulkWrite(ids.map(examId => ({ updateOne: { filter: { examId }, update: { $setOnInsert: { examId, hiddenAt: new Date() } }, upsert: true } })));
        } else {
            await ExamHidden.deleteMany({ examId: { $in: ids } });
        }
        catalogChanged();
        res.json({ success: true });
    } catch (err) {
        console.error('exam visibility error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// PERMANENTLY delete ONE exam paper: { examId, confirm: true }
// Removes only that paper: its questions (with their explanations, answer keys, dates, image references),
// its "hidden" flag and its name inside exam groups. Nothing belonging to other papers is touched.
router.post('/admin/exams/delete', authMiddleware, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const examId = typeof req.body.examId === 'string' ? req.body.examId : '';
        if (!examId.trim() || examId.length > 300 || examId === 'Passage Comprehension') {
            return res.status(400).json({ success: false, message: 'Invalid exam.' });
        }
        if (req.body.confirm !== true) {
            return res.status(400).json({ success: false, message: 'Confirmation required.' });
        }
        const qr = await Question.deleteMany({ year_exam: examId });
        await ExamHidden.deleteMany({ examId });
        await ExamGroup.updateMany({ exams: examId }, { $pull: { exams: examId } });
        await dataCache.invalidateExam(examId).catch(() => {});
        try { await buildHierarchyBase(); } catch (e) { cachedHierarchy = null; lastCacheTime = 0; }
        try { require('../utils/examMeta').invalidate(); subjectNames.invalidate(); } catch (e) {}
        catalogChanged();
        res.json({ success: true, deletedQuestions: qr.deletedCount || 0 });
    } catch (err) {
        console.error('exam delete error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// create a group: { name, exams?: [...] }
router.post('/admin/exam-groups', authMiddleware, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const name = String(req.body.name || '').trim().slice(0, 60);
        if (!name) return res.status(400).json({ success: false, message: 'Group name is required.' });
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const dup = await ExamGroup.findOne({ name: new RegExp('^' + esc + '$', 'i') });
        if (dup) return res.status(400).json({ success: false, message: 'A group with this name already exists.' });
        const count = await ExamGroup.countDocuments();
        const g = await ExamGroup.create({ name, exams: cleanExamList(req.body.exams), order: count });
        catalogChanged();
        res.json({ success: true, group: { _id: String(g._id), name: g.name, exams: g.exams } });
    } catch (err) {
        console.error('create group error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// edit a group: { name?, addExams?: [...], removeExams?: [...], exams?: [...] (replace all) }
router.put('/admin/exam-groups/:id', authMiddleware, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid group.' });
        const g = await ExamGroup.findById(req.params.id);
        if (!g) return res.status(404).json({ success: false, message: 'Group not found.' });

        if (typeof req.body.name === 'string') {
            const name = req.body.name.trim().slice(0, 60);
            if (!name) return res.status(400).json({ success: false, message: 'Group name is required.' });
            g.name = name;
        }
        if (Array.isArray(req.body.exams)) g.exams = cleanExamList(req.body.exams);
        const add = cleanExamList(req.body.addExams);
        if (add.length) g.exams = [...new Set([...g.exams, ...add])];
        const rem = new Set(cleanExamList(req.body.removeExams));
        if (rem.size) g.exams = g.exams.filter(x => !rem.has(x));
        await g.save();
        catalogChanged();
        res.json({ success: true, group: { _id: String(g._id), name: g.name, exams: g.exams } });
    } catch (err) {
        console.error('edit group error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

router.delete('/admin/exam-groups/:id', authMiddleware, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid group.' });
        await ExamGroup.deleteOne({ _id: req.params.id });
        catalogChanged();
        res.json({ success: true });
    } catch (err) {
        console.error('delete group error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});


// -------------------------------------
// Admin: ONE name for ONE subject. Spellings that the rules can not know are joined here ("Indian Polity" = "Polity").
// Questions are never rewritten - names are mapped while reading, so every merge can be split again.
//   GET  /admin/subject-groups        every subject (with all its spellings + counts) and merge suggestions
//   POST /admin/subject-groups/merge  { names: [shown names to join], into: 'name to show' }   (one name + a new `into` = rename)
//   POST /admin/subject-groups/split  { stored: 'one stored spelling' }                         (undo an admin merge for it)
// -------------------------------------
const subjectLimiter = require('express-rate-limit')({ windowMs: 60 * 1000, limit: 40, message: { success: false, message: 'Too many requests. Please slow down.' } });
function subjectsChanged() {
    subjectNames.invalidate();
    try { require('../utils/examMeta').invalidate(); } catch (e) {}
    try { dataCache.clearResponses(); } catch (e) {}
    catalogChanged();
}

router.get('/admin/subject-groups', authMiddleware, subjectLimiter, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const r = await subjectNames.getResolver(true);
        const list = r.list();
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, subjects: list, suggestions: subjectNames.suggest(list), unclassified: subjectNames.UNCLASSIFIED });
    } catch (err) {
        console.error('subject groups error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

router.post('/admin/subject-groups/merge', authMiddleware, subjectLimiter, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const names = (Array.isArray(req.body.names) ? req.body.names : []).filter(x => typeof x === 'string' && x.trim()).slice(0, 60);
        const into = typeof req.body.into === 'string' ? req.body.into.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
        if (!names.length || !into) return res.status(400).json({ success: false, message: 'Choose the subjects and the name to show.' });
        if (names.includes(subjectNames.UNCLASSIFIED) || subjectNames.subjKey(into) === 'unclassified') return res.status(400).json({ success: false, message: '"Unclassified" (questions without a subject) can not be merged.' });
        const r = await subjectNames.getResolver(true);
        const ops = []; const seen = new Set();
        names.forEach(n => r.rawsOf(n).forEach(raw => {
            const key = subjectNames.subjKey(raw);
            if (!key || key === 'unclassified' || seen.has(key)) return;
            seen.add(key);
            ops.push({ updateOne: { filter: { key }, update: { $set: { from: String(raw).slice(0, 200), key, to: into, createdAt: new Date() } }, upsert: true } });
        }));
        if (!ops.length) return res.status(400).json({ success: false, message: 'Those subjects were not found.' });
        await SubjectAlias.bulkWrite(ops);
        subjectsChanged();
        res.json({ success: true, merged: ops.length });
    } catch (err) {
        console.error('subject merge error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

router.post('/admin/subject-groups/split', authMiddleware, subjectLimiter, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const stored = typeof req.body.stored === 'string' ? req.body.stored : '';
        const r = await SubjectAlias.deleteOne({ key: subjectNames.subjKey(stored) });
        if (!r.deletedCount) return res.status(404).json({ success: false, message: 'This spelling was not merged by an admin (it is joined automatically: same name, or the English-Marathi pair).' });
        subjectsChanged();
        res.json({ success: true });
    } catch (err) {
        console.error('subject split error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// -------------------------------------
// Admin: AI Chat settings (which AI answers the "Ask AI" chat, in which order). Saved in the database.
// -------------------------------------
const chatAdminLimiter = require('express-rate-limit')({
    windowMs: 60 * 1000,
    limit: 40,
    message: { success: false, message: 'Too many requests. Please slow down.' }
});

router.get('/admin/chat-ai', authMiddleware, chatAdminLimiter, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const scope = chatProviders.scopeOk(req.query.scope);
        const [config, gemini] = await Promise.all([chatProviders.getConfig(scope, true), getGeminiInfo()]);
        const view = chatProviders.publicView(config);
        view.providers.forEach(p => { p.health = chatProviders.healthView(scope, p.id); });
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, scope, ...view, gemini });
    } catch (err) {
        console.error('chat-ai get error:', err);
        res.status(500).json({ success: false, message: 'Could not load the settings.' });
    }
});

router.put('/admin/chat-ai', authMiddleware, chatAdminLimiter, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const gemini = await getGeminiInfo();
        const scope = chatProviders.scopeOk(req.body && req.body.scope);
        const r = await chatProviders.saveConfig(scope, req.body, gemini.models);
        if (r.error) return res.status(r.status).json({ success: false, message: r.error });
        const view = chatProviders.publicView(r.config);
        view.providers.forEach(p => { p.health = chatProviders.healthView(scope, p.id); });
        res.json({ success: true, scope, ...view, gemini });
    } catch (err) {
        console.error('chat-ai save error:', err);
        res.status(500).json({ success: false, message: 'Could not save (database problem). Nothing was changed.' });
    }
});

// copy the OpenAI-compatible endpoints (and their saved keys) from one list to the other: { from:'chat'|'fix', to:'chat'|'fix' }
router.post('/admin/chat-ai/copy', authMiddleware, chatAdminLimiter, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const b = req.body || {};
        if (!chatProviders.SCOPES.includes(b.from) || !chatProviders.SCOPES.includes(b.to)) return res.status(400).json({ success: false, message: 'Unknown list.' });
        const r = await chatProviders.copyEndpoints(b.from, b.to);
        if (r.error) return res.status(r.status).json({ success: false, message: r.error });
        res.json({ success: true, copied: r.copied });
    } catch (err) {
        console.error('chat-ai copy error:', err);
        res.status(500).json({ success: false, message: 'Could not copy (database problem). Nothing was changed.' });
    }
});

// list the models of an endpoint: { id } (use the saved key) or { baseUrl, apiKey }
router.post('/admin/chat-ai/models', authMiddleware, chatAdminLimiter, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const b = req.body || {};
        let apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
        if (!apiKey && typeof b.id === 'string') apiKey = await chatProviders.storedKeyOf(chatProviders.scopeOk(b.scope), b.id);
        if (!apiKey) return res.status(400).json({ success: false, message: 'Enter the API key first.' });
        try {
            const models = await chatProviders.listModels(b.baseUrl, apiKey);
            res.json({ success: true, models });
        } catch (e) {
            res.json({ success: false, message: e.message || 'Could not load the model list. You can still type the model name.' });
        }
    } catch (err) {
        console.error('chat-ai models error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// one tiny test question: { type:'gemini', model } or { type:'openai', id?, baseUrl, apiKey?, model }
router.post('/admin/chat-ai/test', authMiddleware, chatAdminLimiter, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const b = req.body || {};
        if (b.type === 'gemini') {
            const info = await getGeminiInfo();
            const model = typeof b.model === 'string' ? b.model.trim() : '';
            if (model && !info.models.includes(model)) return res.json({ success: false, message: 'This model is not in the server model list.' });
            try {
                const r = await testGemini(model);
                return res.json({ success: true, ms: r.ms, reply: r.text });
            } catch (e) {
                return res.json({ success: false, message: e.message || 'Gemini test failed.' });
            }
        }
        if (b.type !== 'openai') return res.status(400).json({ success: false, message: 'Unknown type.' });
        const n = chatProviders.normalizeBaseUrl(b.baseUrl);
        if (n.error) return res.json({ success: false, message: n.error });
        const model = typeof b.model === 'string' ? b.model.trim() : '';
        if (!model) return res.json({ success: false, message: 'Choose or type a model first.' });
        let apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
        if (!apiKey && typeof b.id === 'string') apiKey = await chatProviders.storedKeyOf(chatProviders.scopeOk(b.scope), b.id);
        if (!apiKey) return res.json({ success: false, message: 'Enter the API key first.' });
        const t0 = Date.now();
        try {
            const meta = {};
            const text = await chatProviders.callOpenAI(
                { baseUrl: n.value, apiKey, model, search: typeof b.search === 'string' ? b.search : 'auto', searchJson: typeof b.searchJson === 'string' ? b.searchJson : '' },
                { system: 'You are a connection test.', history: [], message: 'Reply with the single word: OK', images: [] },
                { timeoutMs: 40000, maxTokens: 30, meta }
            );
            const testP = { name: 'test', baseUrl: n.value, apiKey, model, search: typeof b.search === 'string' ? b.search : 'auto' };
            let probeNote = '';
            if (meta.searchMode === 'none' && testP.search === 'auto' && process.env.WEB_SEARCH !== '0') {
                // custom URL: really try to find out whether it has a built-in web search (takes up to ~1 minute)
                const d = await chatProviders.detectSearch(testP, { force: true, budgetMs: 50000 });
                if (d.state === 'found') { meta.searchMode = d.mode; meta.searchUsed = true; }
                else probeNote = ' ' + d.note;
            }
            const searchInfo = meta.searchMode === 'none'
                ? 'Web search: no built-in search found - Gemini search facts will be used instead.' + probeNote
                : (meta.searchUsed ? `Web search: accepted (${meta.searchMode}).` : `Web search: NOT supported - ${meta.searchNote || 'answered without it'}`);
            res.json({ success: true, ms: Date.now() - t0, reply: text.slice(0, 80), searchInfo });
        } catch (e) {
            res.json({ success: false, message: e.message || 'Test failed.' });
        }
    } catch (err) {
        console.error('chat-ai test error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});


// -------------------------------------
// Admin: server cache (question data + Telegram images on the server disk)
// -------------------------------------
const examList = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length <= 300).slice(0, 1000) : null);

router.get('/admin/cache/status', authMiddleware, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const [images, data] = await Promise.all([imageStore.status(req.query.refresh === '1'), dataCache.stats()]);
        const totalExams = (cachedHierarchy || []).length;
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, images, data: { ...data, totalExams }, examList: (cachedHierarchy || []).map(e => e._id).filter(Boolean), imageJob: imageStore.jobStatus(), dataJob: dataCache.warmStatus() });
    } catch (err) {
        console.error('cache status error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// light polling endpoint (progress bars)
router.get('/admin/cache/job', authMiddleware, async (req, res) => {
    if (!(await adminOnly(req, res))) return;
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, imageJob: imageStore.jobStatus(), dataJob: dataCache.warmStatus() });
});

router.post('/admin/cache/images/precache', authMiddleware, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const ids = req.body.all ? null : examList(req.body.examIds);
        if (!req.body.all && (!ids || !ids.length)) return res.status(400).json({ success: false, message: 'Choose an exam or "all".' });
        await imageStore.startPrecache(ids);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

router.post('/admin/cache/images/stop', authMiddleware, async (req, res) => {
    if (!(await adminOnly(req, res))) return;
    imageStore.stopJob(); dataCache.stopWarm();
    res.json({ success: true });
});

router.post('/admin/cache/images/clear', authMiddleware, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const ids = req.body.all ? null : examList(req.body.examIds);
        if (!req.body.all && (!ids || !ids.length)) return res.status(400).json({ success: false, message: 'Choose an exam or "all".' });
        res.json({ success: true, ...(await imageStore.clearImages(ids)) });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// reduce the image folder to <= maxMb (oldest-used images are deleted first)
router.post('/admin/cache/images/trim', authMiddleware, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const mb = Number(req.body.maxMb);
        if (!(mb >= 0)) return res.status(400).json({ success: false, message: 'Enter a size in MB.' });
        res.json({ success: true, ...(await imageStore.trimTo(Math.round(mb * 1024 * 1024))) });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

router.post('/admin/cache/settings', authMiddleware, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const v = await imageStore.setMaxMb(req.body.maxImageMb);
        res.json({ success: true, maxImageMb: v });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

router.post('/admin/cache/data/warm', authMiddleware, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        let ids = req.body.all ? (cachedHierarchy || []).map(e => e._id) : examList(req.body.examIds);
        if (!ids || !ids.length) return res.status(400).json({ success: false, message: 'Choose an exam or "all".' });
        await dataCache.warm(ids, !!req.body.refresh);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

router.post('/admin/cache/data/clear', authMiddleware, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        if (req.body.all) await dataCache.invalidateAll();
        else { const ids = examList(req.body.examIds) || []; for (const id of ids) await dataCache.invalidateExam(id); }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});


// -------------------------------------
// Admin: change which page image a question shows
//   use       -> the main image becomes the image of another question
//   add       -> the image of another question is added as an EXTRA image (question continues on another page)
//   removeMain  -> no main image any more (first extra, if any, becomes the main one)
//   removeExtra / reset
// -------------------------------------
const imgKey = (raw) => imageStore.filenameFor(raw) || JSON.stringify(raw);
const imgView = (q) => ({ _id: String(q._id), original_image_url: q.original_image_url || null, extra_images: q.extra_images || [], customized: !!q.original_image_backup || !!(q.extra_images && q.extra_images.length) });

router.post('/admin/question-image', authMiddleware, async (req, res) => {
    try {
        if (!(await adminOnly(req, res))) return;
        const { questionId, action } = req.body || {};
        const okId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
        if (!okId(questionId)) return res.status(400).json({ success: false, message: 'Invalid question.' });
        const q = await Question.findById(questionId);
        if (!q) return questionGone(res);

        if (action === 'reset') {
            if (q.original_image_backup) q.original_image_url = q.original_image_backup;
            q.original_image_backup = undefined;
            q.extra_images = undefined;
        } else if (action === 'removeMain') {
            // take the main image away; if the question has extra pages, the first extra page becomes the main image
            if (!q.original_image_url) return res.status(400).json({ success: false, message: 'This question has no main image.' });
            if (!q.original_image_backup) q.original_image_backup = q.original_image_url;
            if (Array.isArray(q.extra_images) && q.extra_images.length) {
                q.original_image_url = q.extra_images[0];
                q.extra_images = q.extra_images.slice(1);
                if (!q.extra_images.length) q.extra_images = undefined;
                q.markModified('extra_images');
            } else {
                q.original_image_url = undefined;
            }
        } else if (action === 'removeExtra') {
            const i = Number(req.body.index);
            if (!Array.isArray(q.extra_images) || !(i >= 0 && i < q.extra_images.length)) return res.status(400).json({ success: false, message: 'No such extra image.' });
            q.extra_images.splice(i, 1);
            if (!q.extra_images.length) q.extra_images = undefined;
            q.markModified('extra_images');
        } else if (action === 'use' || action === 'add') {
            // find the question whose image we copy: by id, or by (exam, question number)
            let src = null;
            if (okId(req.body.sourceQuestionId)) src = await Question.findById(req.body.sourceQuestionId).lean();
            else if (Number(req.body.sourceQnum) > 0) {
                src = await Question.findOne({ year_exam: String(req.body.sourceExam || q.year_exam), qnum: Number(req.body.sourceQnum), original_image_url: { $exists: true, $nin: [null, ''] } }).lean();
            }
            if (!src || !src.original_image_url) return res.status(404).json({ success: false, message: 'That question has no image (or was not found).' });

            if (action === 'use') {
                if (!q.original_image_backup && q.original_image_url) q.original_image_backup = q.original_image_url; // remember the first original
                q.original_image_url = src.original_image_url;
                // an extra that is now identical to the main image is pointless
                if (Array.isArray(q.extra_images)) {
                    q.extra_images = q.extra_images.filter(x => imgKey(x) !== imgKey(src.original_image_url));
                    if (!q.extra_images.length) q.extra_images = undefined;
                    q.markModified('extra_images');
                }
            } else {
                const key = imgKey(src.original_image_url);
                if (imgKey(q.original_image_url) === key || (q.extra_images || []).some(x => imgKey(x) === key)) {
                    return res.status(400).json({ success: false, message: 'This question already shows that image.' });
                }
                if ((q.extra_images || []).length >= 5) return res.status(400).json({ success: false, message: 'At most 5 extra images.' });
                q.extra_images = [...(q.extra_images || []), src.original_image_url];
                q.markModified('extra_images');
            }
        } else {
            return res.status(400).json({ success: false, message: 'Unknown action.' });
        }

        q.markModified('original_image_url');
        await q.save();
        dataCache.invalidateExam(q.year_exam).catch(() => {}); // students must see the new image at once
        res.json({ success: true, question: imgView(q) });
    } catch (err) {
        console.error('question-image error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// Admin: Fix Question with AI
router.post('/admin/fix-question', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user || !user.isAdmin) {
            return res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' });
        }

        const { questionId } = req.body;
        const question = await Question.findById(questionId);
        if (!question) return questionGone(res);

        let imageBase64 = null;
        if (question.original_image_url) {
            imageBase64 = await fetchQuestionImages(question);
        }

        const fixedData = await fixQuestionWithAI(question, imageBase64);

        if (fixedData) {
            // Apply fixes (fixedData is already validated + independently re-verified in aiService)
            if (fixedData.fixed_text) question.text = fixedData.fixed_text;
            if (fixedData.fixed_text_eng) question.text_eng = fixedData.fixed_text_eng;
            if (Array.isArray(fixedData.fixed_options) && fixedData.fixed_options.length >= 2) question.options = fixedData.fixed_options;
            if (Array.isArray(fixedData.fixed_options_eng) && fixedData.fixed_options_eng.length) question.options_eng = fixedData.fixed_options_eng;
            if (fixedData.correct_answer_option) {
                if (fixedData.correct_answer_option === "#") {
                    question.correct_answer_option = "#";
                } else {
                    question.correct_answer_option = parseInt(fixedData.correct_answer_option);
                }
            }
            if (fixedData.fixed_explanation) question.toppers_explanation_marathi = fixedData.fixed_explanation;
            if (fixedData.fixed_options_explanation && fixedData.fixed_options_explanation.length > 0) question.options_explanation = fixedData.fixed_options_explanation;
            question.is_ai_fixed = true;
            question.ai_fixed_at = new Date();

            await question.save();
            dataCache.invalidateExam(question.year_exam).catch(() => {});
            return res.json({ success: true, message: 'Question fixed and saved.', question });
        } else {
            return res.status(500).json({ success: false, message: 'AI returned empty result.' });
        }

    } catch (err) {
        console.error("AI Fix Error:", err.message);
        res.status(500).json({ success: false, message: `AI Fix Failed: ${err.message}` });
    }
});

// 1. Fetch Hierarchy (For Dashboard Selection)
// Normal users get only the papers that are NOT hidden. Admins get everything, hidden ones flagged `hidden: true`.
router.get('/exams/hierarchy', async (req, res) => {
    try {
        if (!cachedHierarchy || Date.now() - lastCacheTime >= 3600000) await buildHierarchyBase(); // 1 hour cache

        const isAdmin = await isAdminRequest(req);
        const { hidden, groups } = await examCatalog.getCatalog();

        // one name per subject: "Economics" / "Economics (अर्थशास्त्र)" / "अर्थशास्त्र" are ONE card (utils/subjects.js)
        let canon = null;
        try { canon = (await subjectNames.getResolver()).canon; } catch (e) { console.error('subject names unavailable:', e.message); }
        const oneName = (e) => {
            if (!canon) return e;
            const m = new Map();
            (e.exams || []).forEach(x => { const n = canon(x.subject); m.set(n, (m.get(n) || 0) + x.count); });
            return { ...e, exams: [...m.entries()].map(([subject, count]) => ({ subject, count })) };
        };

        let data = cachedHierarchy
            .filter(e => isAdmin || !hidden.has(e._id))
            .map(e => oneName(hidden.has(e._id) ? { ...e, hidden: true } : e));

        // passage practice = passages of the papers that are visible
        let passageCount = 0;
        Object.entries(cachedPassageByExam).forEach(([exam, n]) => { if (!hidden.has(exam)) passageCount += n; });
        if (passageCount > 0) {
            data = [{ _id: 'Passage Comprehension', exams: [{ subject: 'All Passages', count: passageCount }] }, ...data];
        }

        const visibleIds = new Set(data.map(e => e._id));
        const outGroups = groups
            .map(g => ({ _id: g._id, name: g.name, exams: g.exams.filter(x => visibleIds.has(x)) }))
            .filter(g => isAdmin || g.exams.length > 0);

        res.set('Cache-Control', 'no-store');
        res.json({ success: true, data, groups: outGroups });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load exam hierarchy' });
    }
});

// 2. Fetch Questions by Filter (Protected - Subscription check inside)
router.post('/questions', authMiddleware, async (req, res) => {
    try {
        const { year_exam, subject, limit } = req.body;
        // optional: only these papers (the dashboard tab / group the student is in). Hidden papers are always removed.
        const yearExams = Array.isArray(req.body.year_exams)
            ? req.body.year_exams.filter(x => typeof x === 'string' && x.length <= 300).slice(0, 300)
            : null;

        // --- Security & Free Bypass Check ---
        const user = await User.findById(req.user.id);
        const isAdmin = !!(user && user.isAdmin);
        const { hidden } = await examCatalog.getCatalog();

        // a hidden paper does not exist for normal users
        if (year_exam && year_exam !== 'Passage Comprehension' && hidden.has(year_exam) && !isAdmin) {
            return res.status(404).json({ success: false, code: 'EXAM_HIDDEN', message: 'This exam is not available right now.' });
        }

        const freeTests = freeExamIds(hidden);
        const isFree = freeTests.includes(year_exam) && user && user.hasUsedFreeTrial;

        if (!isFree) {
            if (!user || !user.isSubscribed || !user.subscriptionExpiry || new Date() > user.subscriptionExpiry) {
                return res.status(403).json({ success: false, message: 'Subscription required or expired' });
            }
        }
        // ------------------------------------

        // Which papers? (hidden papers are always excluded)
        if (!cachedHierarchy) await buildHierarchyBase();
        const visibleIds = () => cachedHierarchy.map(e => e._id).filter(id => !hidden.has(id));
        let examIds, passageOnly = false;
        if (year_exam === 'Passage Comprehension') { passageOnly = true; examIds = visibleIds(); }
        else if (year_exam) examIds = [year_exam];
        else if (yearExams && yearExams.length) examIds = yearExams.filter(x => !hidden.has(x));
        else examIds = visibleIds();

        // Served from the server disk cache: the database is read once per paper, not once per student
        await dataCache.checkFreshness();
        let resolver = null;
        try { resolver = await subjectNames.getResolver(); } catch (e) { /* subjects stay as stored */ }
        const buf = await dataCache.responseFor({ examIds, subject: subject || null, passageOnly, limit: limit ? parseInt(limit) : 0, canon: resolver ? resolver.canon : null, canonVersion: resolver ? resolver.version : '' });

        res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-cache', 'Vary': 'Accept-Encoding' });
        if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
            res.set('Content-Encoding', 'gzip');
            return res.send(buf);
        }
        return res.send(await require('util').promisify(require('zlib').gunzip)(buf));
    } catch (err) {
        console.error("API /questions Error:", err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

// -------------------------------------
// 2. PAYMENT API (Order Creation)
// -------------------------------------

router.post('/payment/free-trial', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (user.hasUsedFreeTrial) {
            return res.status(400).json({ success: false, message: 'You have already claimed your free trial.' });
        }

        // Instead of subscribing them fully, just flag that they claimed the 2-free-test offer
        user.subscriptionPlan = '2_free_tests';
        user.hasUsedFreeTrial = true;

        await user.save();

        res.json({
            success: true,
            message: 'First 2 Tests unlocked successfully!',
            user: {
                email: user.email,
                isSubscribed: user.isSubscribed,
                subscriptionPlan: user.subscriptionPlan,
                subscriptionExpiry: user.subscriptionExpiry,
                hasUsedFreeTrial: user.hasUsedFreeTrial
            }
        });

    } catch (err) {
        console.error('Free Trial Error:', err);
        res.status(500).json({ success: false, message: 'Failed to activate free trial' });
    }
});
// -------------------------------------

// 2.5 Public price list (students see ONLY active plans; the admin edits them in the admin panel)
router.get('/plans', async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, plans: await listActivePlans() });
    } catch (e) {
        console.error('plans list:', e);
        res.status(500).json({ success: false, message: 'Could not load plans.' });
    }
});

// 3. Create Payment Order (Requires Auth to identify user)
router.post('/payment/create-order', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const planId = req.body && req.body.planId;

        // price + duration are read from the DATABASE here - the browser only says WHICH plan
        const plan = await getActivePlan(planId);
        if (!plan) {
            return res.status(400).json({ success: false, message: 'This plan is no longer available. Please reload the page and choose again.' });
        }

        const options = {
            amount: toPaise(plan.price),
            currency: 'INR',
            receipt: `rcpt_${Date.now()}`,
            // the plan as it was when the student paid: a later price change or deletion can never break this order
            notes: { userId: String(userId), ...snapshotNotes(plan) }
        };

        const order = await razorpay.orders.create(options);
        res.json({ success: true, order, key_id: process.env.RAZORPAY_KEY_ID, plan: { planId: plan.planId, name: plan.name } });
    } catch (error) {
        console.error('Razorpay Error:', error && (error.error || error.message || error));
        res.status(500).json({ success: false, message: 'Order Creation Failed' });
    }
});


// -------------------------------------
// 3.5 PAYMENT API (Frontend Verification)
// -------------------------------------
router.post('/payment/verify-payment', authMiddleware, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        const userId = req.user.id;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, message: 'Missing payment parameters' });
        }

        const generatedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + "|" + razorpay_payment_id).digest('hex');
        const a1 = Buffer.from(generatedSignature), b1 = Buffer.from(String(razorpay_signature));
        if (a1.length !== b1.length || !crypto.timingSafeEqual(a1, b1)) {
            return res.status(400).json({ success: false, message: 'Invalid signature' });
        }

        // The PLAN and the OWNER come from the Razorpay order that WE created - never from the browser.
        let order;
        try {
            order = await razorpay.orders.fetch(razorpay_order_id);
        } catch (e) {
            console.error('verify-payment: could not fetch order:', e && e.message);
            return res.status(503).json({ success: false, message: 'Payment received. Activation is taking a moment - your plan will be activated automatically within a minute. Do not pay again.' });
        }
        const notes = (order && order.notes) || {};
        if (String(notes.userId) !== String(userId)) {
            return res.status(403).json({ success: false, message: 'This payment belongs to another account.' });
        }

        const result = await applyPayment({
            paymentId: razorpay_payment_id,
            orderId: razorpay_order_id,
            userId,
            planId: notes.planId,
            amountPaise: order.amount,
            source: 'verify',
            notes
        });

        const u = result.user;
        res.json({
            success: true,
            message: 'Payment verified successfully!',
            user: {
                email: u.email,
                isSubscribed: u.isSubscribed,
                subscriptionPlan: u.subscriptionPlan,
                subscriptionExpiry: u.subscriptionExpiry,
                hasUsedFreeTrial: u.hasUsedFreeTrial,
                isAdmin: !!u.isAdmin
            }
        });
    } catch (err) {
        console.error('Verify Payment Error:', err);
        res.status(500).json({ success: false, message: 'Payment received but activation hit an error. It will be activated automatically within a minute. Do not pay again.' });
    }
});

// -------------------------------------
// 3. PAYMENT API (Webhook Verification)
// -------------------------------------

// 4. Webhook for Payment Verification (Unprotected, called by Razorpay).
// This is the safety net: it activates the plan even if the user closed the tab / lost network right after paying.
router.post('/payment/webhook', async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
        // Webhook is OPTIONAL. Without a secret it stays switched off (never a guessable default secret,
        // anyone could forge a "payment" with that). Payments are still activated by the browser verification.
        return res.status(200).send('Webhook disabled');
    }
    const signature = String(req.headers['x-razorpay-signature'] || '');
    if (!req.rawBody) return res.status(400).send('Missing raw body');

    try {
        const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
        const x = Buffer.from(expected), y = Buffer.from(signature);
        if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) {
            return res.status(400).send('Invalid signature');
        }

        const event = req.body;
        if (event.event === 'payment.captured') {
            const pay = event.payload && event.payload.payment && event.payload.payment.entity;
            if (pay && pay.order_id) {
                // plan + user are stored on the ORDER (not copied to the payment), so read the order
                const order = await razorpay.orders.fetch(pay.order_id);
                const notes = (order && order.notes) || {};
                if (notes.userId && notes.planId) {
                    const r = await applyPayment({
                        paymentId: pay.id,
                        orderId: pay.order_id,
                        userId: notes.userId,
                        planId: notes.planId,
                        amountPaise: pay.amount,
                        source: 'webhook',
                        notes
                    });
                    console.log(`Payment ${pay.id}: ${r.alreadyApplied ? 'already applied' : 'applied'} (${notes.planId}) for user ${notes.userId}`);
                }
            }
        }
        res.status(200).send('Webhook verified');
    } catch (err) {
        console.error('Webhook Error:', err);
        res.status(500).send('Webhook Server Error'); // 5xx -> Razorpay retries later
    }
});

// -------------------------------------
// 4. PROGRESS TRACKING API
// -------------------------------------

const rateLimit = require('express-rate-limit');
// Questions that share the SAME original image with the given questions (other subject / uncategorised).
// Used by Paper Mode so a user can attempt every question printed on an image.
router.post('/questions/siblings', authMiddleware, async (req, res) => {
    try {
        const ids = Array.isArray(req.body.questionIds) ? req.body.questionIds.slice(0, 600) : [];
        if (!ids.length || !ids.every(i => /^[a-f0-9]{24}$/i.test(String(i)))) {
            return res.json({ success: true, data: [] });
        }

        const user = await User.findById(req.user.id);
        const subscribed = user && user.isSubscribed && user.subscriptionExpiry && new Date() <= user.subscriptionExpiry;

        const base = await Question.find({ _id: { $in: ids } }, 'year_exam original_image_url telegram_msg_id').lean();

        // same access rule as /questions: subscribers, or the free tests (hidden papers never, except for admins)
        const { hidden } = await examCatalog.getCatalog();
        const isAdminUser = !!(user && user.isAdmin);
        let allowedYears = new Set();
        if (subscribed) {
            base.forEach(q => { if (isAdminUser || !hidden.has(q.year_exam)) allowedYears.add(q.year_exam); });
        } else if (user && user.hasUsedFreeTrial) {
            const free = freeExamIds(hidden);
            base.forEach(q => { if (free.includes(q.year_exam)) allowedYears.add(q.year_exam); });
        }
        if (!allowedYears.size) return res.json({ success: true, data: [] });

        const conds = [];
        base.forEach(q => {
            if (!allowedYears.has(q.year_exam)) return;
            let o = q.original_image_url;
            if (typeof o === 'string' && o.trim().startsWith('{')) { try { o = JSON.parse(o); } catch (e) {} }
            if (o && typeof o === 'object') {
                Object.entries(o).forEach(([k, v]) => { if (v && /^\d+$/.test(k)) conds.push({ [`original_image_url.${k}`]: v }); });
            } else if (typeof o === 'string' && o) {
                conds.push({ original_image_url: o });
            }
            if (q.telegram_msg_id) conds.push({ telegram_msg_id: q.telegram_msg_id });
        });
        if (!conds.length) return res.json({ success: true, data: [] });

        const found = await Question.find({
            year_exam: { $in: [...allowedYears] },
            _id: { $nin: ids },
            $or: conds
        }).lean();

        res.json({ success: true, data: found });
    } catch (err) {
        console.error('siblings error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// Limit per LOGGED-IN USER, not per IP: a whole class on one college / hostel Wi-Fi shares one IP, and with an
// IP limit the answers of the 61st student in that minute were rejected (429) and never reached the database.
const submitAnswerLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    limit: 120,          // answers per user per minute (a person cannot tap faster than this)
    keyGenerator: (req) => 'u:' + String((req.user && req.user.id) || 'anon'),
    validate: { keyGeneratorIpFallback: false, ip: false },
    message: { success: false, message: 'Too many answers submitted. Please slow down.' }
});

// 5. Progress Tracking (Protected & Validated)
// The answer is written with ONE atomic MongoDB update ($set + $inc, "first answer wins" guard).
// The old code did: load the whole progress document -> change it in memory -> save(). Two answers of the same user
// arriving together (fast taps, Paper Mode, 2 tabs, the dashboard self-heal) both started from the same old copy,
// so one answer / one counter increment was overwritten and the progress "went missing" now and then.
async function recordAnswerAtomic(userId, questionId, answer, isCorrect, safeSection, questionOid) {
    const mongoose = require('mongoose');
    const col = Progress.collection;
    const uid = new mongoose.Types.ObjectId(String(userId));
    const aKey = `answers.${questionId}`;
    const filter = { userId: uid, [aKey]: { $exists: false } };
    const now = new Date();
    const update = {
        $set: { [aKey]: answer, lastSolvedQuestion: questionOid, updatedAt: now },
        $inc: {
            totalSolved: 1,
            totalCorrect: isCorrect ? 1 : 0,
            [`sectionWise.${safeSection}.solved`]: 1,
            [`sectionWise.${safeSection}.correct`]: isCorrect ? 1 : 0
        },
        $setOnInsert: { createdAt: now }
    };
    for (let i = 0; i < 4; i++) {
        const r = await col.updateOne(filter, update);                 // document exists and this question is not answered yet
        if (r.matchedCount) return 'saved';
        const ex = await col.findOne({ userId: uid }, { projection: { [aKey]: 1 } });
        if (ex) {
            if (ex.answers && ex.answers[questionId]) return 'already';  // first answer wins (also a harmless double tap / retry)
            continue;
        }
        try {                                                           // first answer of a new user: create the document
            await col.updateOne(filter, update, { upsert: true });
            return 'saved';
        } catch (e) {
            if (e && e.code === 11000) continue;                        // created at the same moment by another request -> retry
            throw e;
        }
    }
    throw new Error('Could not record the answer (too many concurrent writes)');
}

router.post('/progress/save', authMiddleware, submitAnswerLimiter, async (req, res) => {
    try {
        const { questionId, section, selectedOption } = req.body || {};
        const userId = req.user.id;

        if (!/^[a-f0-9]{24}$/i.test(String(questionId || '')) || !Number.isInteger(selectedOption) || selectedOption < 0 || selectedOption > 20) {
            return res.status(400).json({ success: false, message: 'Invalid answer' });
        }

        // 1. Fetch real question
        const question = await Question.findById(questionId).lean();
        if (!question) {
            return res.status(404).json({ success: false, message: 'Question not found' });
        }

        const correctStr = String(question.correct_answer_option || question.final_answer_key || question.answer_key).trim();
        let isCancelled = false;
        let isCorrect = false;
        let correctOptIndex = -1;

        if (correctStr === "#") {
            isCancelled = true;
        } else {
            correctOptIndex = parseInt(correctStr) - 1;
            isCorrect = (selectedOption === correctOptIndex);
        }

        // the section can be missing (old clients / passage questions): never fail because of that
        const sectionName = String(section || question.year_exam || 'Unknown');
        const safeSection = (sectionName.replace(/\./g, '_dot_').replace(/^\$/, '_') || 'Unknown');

        const saved = await recordAnswerAtomic(userId, String(question._id), { selected: selectedOption, isCorrect, isCancelled, section: sectionName, at: new Date() }, isCorrect, safeSection, question._id);
        // history for the Progress / trend tabs (best effort: a failure here must never fail the answer)
        if (saved === 'saved' && !isCancelled) {
            require('../models/AttemptLog').create({ userId, qid: String(question._id), exam: question.year_exam, subject: question.subject, topic: question.topic, selected: selectedOption, isCorrect, src: 'exam' })
                .catch(e => console.error('attempt log failed:', e.message));
        }

        res.json({
            success: true,
            isCorrect,
            isCancelled,
            correctOptionIndex: correctOptIndex,
            explanation: question.toppers_explanation_marathi,
            optionsExplanation: question.options_explanation
        });
    } catch (err) {
        console.error("Progress save error:", err);
        res.status(500).json({ success: false, message: 'Failed to save progress' });
    }
});

// 6. Get Dashboard Progress (Protected)
router.get('/progress/dashboard', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        let progress = await Progress.findOne({ userId });
        
        if (!progress) {
            return res.json({ success: true, data: { totalSolved: 0, totalCorrect: 0, sectionWise: {}, answers: {} } });
        }

        // Self-heal: re-check saved answers against the current (maybe AI-fixed) answer keys
        try {
            if (await reconcileUserProgress(progress)) progress = (await Progress.findOne({ userId })) || progress;   // fixes are atomic -> read the fresh copy
        } catch (e) { console.error('reconcile failed:', e); }
        
        const unescapedSectionWise = {};
        for (const [key, val] of progress.sectionWise.entries()) {
            unescapedSectionWise[key.replace(/_dot_/g, '.')] = val;
        }

        res.json({ success: true, data: {
            totalSolved: progress.totalSolved,
            totalCorrect: progress.totalCorrect,
            sectionWise: unescapedSectionWise,
            answers: Object.fromEntries(progress.answers)
        }});
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch dashboard' });
    }
});

// 7. Reset Progress (Protected)
router.post('/progress/reset', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { section } = req.body;
        const progress = await Progress.findOne({ userId });
        if (!progress) return res.json({ success: true, message: 'Nothing to reset' });

        if (section) {
            const secStats = progress.sectionWise.get(section);
            if (secStats) {
                progress.totalSolved -= secStats.solved;
                progress.totalCorrect -= secStats.correct;
                progress.sectionWise.delete(section);
            }
            // Remove all answers for this section
            if (progress.answers) {
                for (const [qId, ansData] of progress.answers.entries()) {
                    if (ansData.section === section) {
                        progress.answers.delete(qId);
                    }
                }
            }
        } else {
            // Reset ALL
            progress.totalSolved = 0;
            progress.totalCorrect = 0;
            progress.sectionWise = new Map();
            progress.answers = new Map();
            progress.lastSolvedQuestion = null;
        }

        await progress.save();
        res.json({ success: true, message: 'Progress reset successfully', data: progress });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to reset progress' });
    }
});


// -------------------------------------
// STARRED QUESTIONS (every student: star a question -> it appears in a separate "Starred Questions" exam card)
// - the star list and the answers of that separate attempt live in UserStars, NOT in Progress,
//   so starring / answering / resetting here never changes the progress of the real exam papers
// - unstar = the question leaves the starred exam (its starred answer is dropped); the real paper is never touched
// -------------------------------------
const MAX_STARS = 1000;
const OID_RE = /^[a-f0-9]{24}$/i;
const starLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 150,
    message: { success: false, message: 'Too many requests. Please slow down.' }
});

// same access rule as /questions: paid access (or the 2 free papers after the free trial); hidden papers only for admins
async function starAccess(userId) {
    const user = await User.findById(userId);
    const { hidden } = await examCatalog.getCatalog();
    const isAdminUser = !!(user && user.isAdmin);
    const subscribed = !!(user && user.isSubscribed && user.subscriptionExpiry && new Date() <= user.subscriptionExpiry);
    const free = new Set(user && user.hasUsedFreeTrial ? freeExamIds(hidden) : []);
    const visible = (q) => isAdminUser || !hidden.has(q.year_exam);
    const canSee = (q) => visible(q) && (subscribed || free.has(q.year_exam));
    return { user, subscribed, visible, canSee };
}

// judge a saved answer against the CURRENT key (an AI fix may have changed it)
function judgeStarAnswer(q, selected) {
    const correctStr = String(q.correct_answer_option || q.final_answer_key || q.answer_key).trim();
    if (correctStr === '#') return { isCancelled: true, isCorrect: false, correctOptIndex: -1 };
    const idx = parseInt(correctStr) - 1;
    return { isCancelled: false, isCorrect: selected === idx, correctOptIndex: idx };
}

function starAnswersFor(doc, questions) {
    const out = {};
    const saved = doc && doc.answers ? (doc.answers instanceof Map ? Object.fromEntries(doc.answers) : doc.answers) : {};
    questions.forEach(q => {
        const a = saved[String(q._id)];
        if (a && typeof a.selected === 'number') {
            const j = judgeStarAnswer(q, a.selected);
            out[String(q._id)] = { selected: a.selected, isCorrect: j.isCorrect, isCancelled: j.isCancelled, section: q.year_exam };
        }
    });
    return out;
}

// the ids + answers (light: no question text) - used for the star buttons and the dashboard card
router.get('/stars', authMiddleware, starLimiter, async (req, res) => {
    try {
        const doc = await UserStars.findOne({ userId: req.user.id }).lean();
        const ids = (doc && doc.ids) || [];
        if (!ids.length) return res.json({ success: true, ids: [], answers: {} });

        const acc = await starAccess(req.user.id);
        const found = await Question.find({ _id: { $in: ids } }, 'year_exam correct_answer_option final_answer_key answer_key').lean();
        const byId = new Map(found.map(q => [String(q._id), q]));
        const valid = ids.filter(id => byId.has(id) && acc.visible(byId.get(id)));
        const gone = ids.filter(id => !byId.has(id));
        if (gone.length) UserStars.updateOne({ userId: req.user.id }, { $pull: { ids: { $in: gone } } }).catch(() => {});

        res.set('Cache-Control', 'no-store');
        res.json({ success: true, ids: valid, answers: starAnswersFor(doc, valid.map(id => byId.get(id))) });
    } catch (err) {
        console.error('stars list error:', err);
        res.status(500).json({ success: false, message: 'Failed to load starred questions' });
    }
});

// star / unstar one question
router.post('/stars/toggle', authMiddleware, starLimiter, async (req, res) => {
    try {
        const qid = String((req.body && req.body.questionId) || '');
        if (!OID_RE.test(qid)) return res.status(400).json({ success: false, message: 'Invalid question' });
        const q = await Question.findById(qid, 'year_exam').lean();
        if (!q) return res.status(404).json({ success: false, message: 'Question not found' });
        const acc = await starAccess(req.user.id);
        if (!acc.canSee(q)) return res.status(403).json({ success: false, message: 'Subscription required or expired' });

        const doc = await UserStars.findOne({ userId: req.user.id }, 'ids').lean();
        const has = !!(doc && doc.ids && doc.ids.includes(qid));
        const want = typeof req.body.starred === 'boolean' ? req.body.starred : !has;

        if (want) {
            if (!has && doc && doc.ids.length >= MAX_STARS) {
                return res.status(400).json({ success: false, message: `You can star at most ${MAX_STARS} questions. Unstar some first.` });
            }
            await UserStars.updateOne({ userId: req.user.id }, { $addToSet: { ids: qid } }, { upsert: true });
        } else if (doc) {
            await UserStars.updateOne({ userId: req.user.id }, { $pull: { ids: qid }, $unset: { [`answers.${qid}`]: '' } });
        }
        const after = await UserStars.findOne({ userId: req.user.id }, 'ids').lean();
        res.json({ success: true, starred: want, count: after ? after.ids.length : 0 });
    } catch (err) {
        console.error('stars toggle error:', err);
        res.status(500).json({ success: false, message: 'Failed to update star' });
    }
});

// the starred exam: the full questions (with explanation), in the order they were starred, + the saved answers of this attempt
router.post('/stars/questions', authMiddleware, starLimiter, async (req, res) => {
    try {
        const doc = await UserStars.findOne({ userId: req.user.id }).lean();
        const ids = (doc && doc.ids) || [];
        if (!ids.length) return res.json({ success: true, data: [], answers: {} });

        const acc = await starAccess(req.user.id);
        const found = await Question.find({ _id: { $in: ids } }).lean();
        const byId = new Map(found.map(q => [String(q._id), q]));
        const list = ids.map(id => byId.get(id)).filter(q => q && acc.canSee(q));
        if (!list.length && !acc.subscribed) {
            return res.status(403).json({ success: false, message: 'Subscription required or expired' });
        }
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, data: list, answers: starAnswersFor(doc, list) });
    } catch (err) {
        console.error('stars questions error:', err);
        res.status(500).json({ success: false, message: 'Failed to load starred questions' });
    }
});

// answer a starred question (saved in the star attempt only, never in the exam progress)
router.post('/stars/answer', authMiddleware, starLimiter, async (req, res) => {
    try {
        const qid = String((req.body && req.body.questionId) || '');
        const selected = req.body && req.body.selectedOption;
        if (!OID_RE.test(qid) || !Number.isInteger(selected) || selected < 0 || selected > 20) {
            return res.status(400).json({ success: false, message: 'Invalid answer' });
        }
        const mine = await UserStars.findOne({ userId: req.user.id, ids: qid }, '_id').lean();
        if (!mine) return res.status(404).json({ success: false, message: 'This question is not starred' });
        const q = await Question.findById(qid).lean();
        if (!q) return res.status(404).json({ success: false, message: 'Question not found' });
        const acc = await starAccess(req.user.id);
        if (!acc.canSee(q)) return res.status(403).json({ success: false, message: 'Subscription required or expired' });

        const j = judgeStarAnswer(q, selected);
        // first answer wins (same rule as the exam progress); the filter makes a double tap harmless
        const stRes = await UserStars.updateOne(
            { userId: req.user.id, ids: qid, [`answers.${qid}`]: { $exists: false } },
            { $set: { [`answers.${qid}`]: { selected, isCorrect: j.isCorrect, isCancelled: j.isCancelled, section: q.year_exam } } }
        );
        if (stRes && stRes.modifiedCount && !j.isCancelled) {
            require('../models/AttemptLog').create({ userId: req.user.id, qid, exam: q.year_exam, subject: q.subject, topic: q.topic, selected, isCorrect: j.isCorrect, src: 'star' })
                .catch(e => console.error('attempt log failed:', e.message));
        }
        res.json({
            success: true, isCorrect: j.isCorrect, isCancelled: j.isCancelled, correctOptionIndex: j.correctOptIndex,
            explanation: q.toppers_explanation_marathi, optionsExplanation: q.options_explanation
        });
    } catch (err) {
        console.error('stars answer error:', err);
        res.status(500).json({ success: false, message: 'Failed to save answer' });
    }
});

// "Reset Progress" of the starred exam: clears only the starred attempt, the stars stay
router.post('/stars/reset', authMiddleware, starLimiter, async (req, res) => {
    try {
        await UserStars.updateOne({ userId: req.user.id }, { $set: { answers: {} } });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to reset' });
    }
});

// -------------------------------------
// 5. IMAGE PROXY API
// -------------------------------------

// ---- Image cache index: questionId -> cached filename (so an OLD image is deleted when a question gets a NEW file id)
const IMG_INDEX_FILE = path.join(os.tmpdir(), 'mpscpyq_image_index.json');
let imgIndex = {};
try { imgIndex = JSON.parse(fs.readFileSync(IMG_INDEX_FILE, 'utf8')) || {}; } catch (e) { imgIndex = {}; }
let imgIndexTimer = null;
function saveImgIndexSoon() {
    if (imgIndexTimer) return;
    imgIndexTimer = setTimeout(() => {
        imgIndexTimer = null;
        fsPromises.writeFile(IMG_INDEX_FILE, JSON.stringify(imgIndex)).catch(() => {});
    }, 5000);
}
// same filename -> nothing happens (cache is used). New filename -> remember it and delete the old cached file
function trackQuestionImage(qId, newFilename) {
    if (!qId || !/^[a-f0-9]{24}$/i.test(qId)) return;
    const prev = imgIndex[qId];
    if (prev === newFilename) return;
    imgIndex[qId] = newFilename;
    saveImgIndexSoon();
    if (prev && !Object.values(imgIndex).includes(prev)) {   // no other question uses the old image
        fsPromises.unlink(path.join(CACHE_DIR, prev)).catch(() => {});
    }
}

// -------------------------------------
// NOTES (the student's own notes, saved on the server so they show on every login)
// -------------------------------------
const notesLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    message: { success: false, message: 'Too many note requests. Please slow down.' }
});

router.get('/notes', authMiddleware, notesLimiter, async (req, res) => {
    try {
        const doc = await UserNotes.findOne({ userId: req.user.id }).select('notes').lean();
        res.json({ success: true, notes: doc ? doc.notes : [] });
    } catch (err) {
        console.error('notes get error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// add ONE note at the end. Idempotent: the same id is never stored twice (safe to retry).
router.post('/notes/add', authMiddleware, notesLimiter, async (req, res) => {
    try {
        const note = notesSvc.cleanNote(req.body);
        if (!note) return res.status(400).json({ success: false, message: 'Invalid note.' });
        const userId = req.user.id;
        const cur = await UserNotes.findOne({ userId }).select('notes.id').lean();
        if (cur && cur.notes.some(n => n.id === note.id)) return res.json({ success: true, duplicate: true });
        if (cur && cur.notes.length >= notesSvc.MAX_NOTES) return res.status(400).json({ success: false, message: 'Notes are full (' + notesSvc.MAX_NOTES + ').' });
        try {
            await UserNotes.updateOne({ userId, 'notes.id': { $ne: note.id } }, { $push: { notes: note } }, { upsert: true });
        } catch (e) {
            if (!(e && e.code === 11000)) throw e;   // 11000 = a parallel request already created the document / note
        }
        res.json({ success: true });
    } catch (err) {
        console.error('notes add error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

router.post('/notes/reorder', authMiddleware, notesLimiter, async (req, res) => {
    try {
        const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter(notesSvc.isValidId).slice(0, notesSvc.MAX_NOTES) : null;
        if (!ids) return res.status(400).json({ success: false, message: 'ids required.' });
        const userId = req.user.id;
        const doc = await UserNotes.findOne({ userId }).select('notes').lean();
        if (!doc) return res.json({ success: true });
        await UserNotes.updateOne({ userId }, { $set: { notes: notesSvc.reorderNotes(doc.notes, ids) } });
        res.json({ success: true });
    } catch (err) {
        console.error('notes reorder error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// edit the text of ONE note (position stays the same). Safe to retry: it just sets the text.
router.post('/notes/edit', authMiddleware, notesLimiter, async (req, res) => {
    try {
        const id = req.body && req.body.id;
        if (!notesSvc.isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid id.' });
        const text = notesSvc.cleanText(req.body.text);
        if (!text) return res.status(400).json({ success: false, message: 'Note cannot be empty.' });
        await UserNotes.updateOne({ userId: req.user.id, 'notes.id': id }, { $set: { 'notes.$.text': text } });
        res.json({ success: true });
    } catch (err) {
        console.error('notes edit error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

router.post('/notes/clear', authMiddleware, notesLimiter, async (req, res) => {
    try {
        await UserNotes.updateOne({ userId: req.user.id }, { $set: { notes: [] } });
        res.json({ success: true });
    } catch (err) {
        console.error('notes clear error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

router.delete('/notes/:id', authMiddleware, notesLimiter, async (req, res) => {
    try {
        if (!notesSvc.isValidId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id.' });
        await UserNotes.updateOne({ userId: req.user.id }, { $pull: { notes: { id: req.params.id } } });
        res.json({ success: true });
    } catch (err) {
        console.error('notes delete error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

router.get('/image/:fileId', async (req, res) => {
    try {
        let token = req.query.token;
        if (!token && req.headers.authorization) {
            token = req.headers.authorization.split(' ')[1];
        }
        if (!token) return res.status(401).send('Unauthorized. Token missing.');

        const jwt = require('jsonwebtoken');
        const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_mpsc_portal_123';
        let decodedImgToken;
        try {
            decodedImgToken = jwt.verify(token, JWT_SECRET);
        } catch (err) {
            return res.status(401).send('Unauthorized. Invalid token.');
        }
        if (!(await isSessionActive(decodedImgToken))) {
            return res.status(401).send('Session expired. Please login again.');
        }

        const rawFileId = req.params.fileId;
        if (!process.env.TELEGRAM_BOT_TOKENS) return res.status(500).send('No bot tokens configured');

        const fname = imageStore.filenameFor(rawFileId);
        if (!fname) return res.status(404).send('Invalid file metadata');
        trackQuestionImage(req.query.q, fname);

        // disk first; Telegram only the very first time (de-duplicated, atomic write)
        const img = await imageStore.ensureImage(rawFileId);
        if (!img) return res.status(404).send('Image not available on any bot.');

        // a Telegram file never changes -> let the browser keep it for 30 days
        res.setHeader('Cache-Control', 'private, max-age=2592000, immutable');
        res.setHeader('Content-Type', 'image/jpeg');
        return res.sendFile(img.full);
    } catch (err) {
        console.error('Image Proxy Error:', err.message);
        if (!res.headersSent) res.status(500).send('Error fetching image');
    }
});

module.exports = {
    router,
    preloadHierarchy,
    freeExamIds
};
