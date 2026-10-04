const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Razorpay = require('razorpay');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const os = require('os');
const axios = require('axios');

const CACHE_DIR = path.join(os.tmpdir(), 'mpscpyq_images');
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Models
const Question = require('../models/Question');
const User = require('../models/User');
const Progress = require('../models/Progress');

// Middleware & Services
const { authMiddleware, requireSubscription, isSessionActive } = require('../middleware/auth');
const smtpService = require('../utils/smtpService');
const { PLANS, applyPayment } = require('../utils/payments');
const examCatalog = require('../utils/examCatalog');
const ExamGroup = require('../models/ExamGroup');
const ExamHidden = require('../models/ExamHidden');
const { broadcast } = require('../utils/userEvents');
const jwtLib = require('jsonwebtoken');
const { fixQuestionWithAI, chatAboutQuestion } = require('../utils/aiService');
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
router.post('/admin/clear-cache', (req, res) => {
    cachedHierarchy = null;
    lastCacheTime = 0;
    preloadHierarchy(); // Start preloading again in background
    res.json({ success: true });
});

// Admin: Fetch Telegram Image as Base64 (Using Cache)
async function fetchTelegramImageBase64(rawFileId) {
    if (!rawFileId) return null;
    
    let fileIdsObj = {};
    if (typeof rawFileId === 'object') {
        fileIdsObj = rawFileId;
    } else {
        try {
            const decoded = decodeURIComponent(rawFileId);
            fileIdsObj = JSON.parse(decoded);
        } catch (e) {
            fileIdsObj = { "0": rawFileId };
        }
    }

    const allFileIds = Object.values(fileIdsObj);
    if (allFileIds.length === 0 || !allFileIds[0]) return null;

    // Check Cache First
    const firstAvailableId = allFileIds[0];
    const safeFilename = firstAvailableId.replace(/[^a-zA-Z0-9-_]/g, '') + '.jpg';
    const cachePath = path.join(CACHE_DIR, safeFilename);

    if (fs.existsSync(cachePath)) {
        try {
            const fileData = fs.readFileSync(cachePath);
            return Buffer.from(fileData).toString('base64');
        } catch (e) {
            console.error("Failed to read from cache", e);
        }
    }

    // Not in cache, fetch from Telegram
    const tokensStr = process.env.TELEGRAM_BOT_TOKENS;
    if (!tokensStr) return null;
    const tokens = tokensStr.split(',').map(t => t.replace(/['"]/g, '').trim()).filter(Boolean);
    
    for (const token of tokens) {
        for (const fId of allFileIds) {
            if (!fId) continue;
            try {
                const fileRes = await axios.get(`https://api.telegram.org/bot${token}/getFile?file_id=${fId}`);
                if (!fileRes.data.ok) continue;

                const filePath = fileRes.data.result.file_path;
                const imgUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
                
                const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer' });
                
                // Save to cache for future
                try {
                    fs.writeFileSync(cachePath, imgRes.data);
                } catch(e) {}
                
                return Buffer.from(imgRes.data).toString('base64');
            } catch (err) {
                continue;
            }
        }
    }
    return null;
}

// Expose fetchImageForAI to global so jobManager can use it
global.fetchImageForAI = fetchTelegramImageBase64;

const { createJob, addClientToJob, retryQuestion } = require('../utils/jobManager');
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
        const subjects = (await Question.distinct('subject')).filter(valid)
            .sort((a, b) => a.localeCompare(b));
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
        const subjects = (await Question.distinct('subject'))
            .filter(s => typeof s === 'string' && s.trim() && s !== 'null')
            .sort((a, b) => a.localeCompare(b));
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
            const questions = await Question.find({ subject }).lean();
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

router.post('/question-chat', authMiddleware, async (req, res) => {
    try {
        const { questionId, message, history } = req.body || {};
        if (typeof questionId !== 'string' || !/^[a-f0-9]{24}$/i.test(questionId)) {
            return res.status(400).json({ success: false, message: 'Invalid question.' });
        }
        if (typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ success: false, message: 'Please type a question.' });
        }

        const user = await User.findById(req.user.id);
        if (!user) return res.status(401).json({ success: false, message: 'User not found' });

        const question = await Question.findById(questionId).lean();
        if (!question) return res.status(404).json({ success: false, message: 'Question not found.' });

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

        let imageBase64 = null;
        if (question.original_image_url) {
            try { imageBase64 = await fetchTelegramImageBase64(question.original_image_url); } catch (e) { imageBase64 = null; }
        }

        const reply = await chatAboutQuestion(question, imageBase64, history, message);
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, reply });
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

// Admin: Fix Question with AI
router.post('/admin/fix-question', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user || !user.isAdmin) {
            return res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' });
        }

        const { questionId } = req.body;
        const question = await Question.findById(questionId);
        if (!question) {
            return res.status(404).json({ success: false, message: 'Question not found.' });
        }

        let imageBase64 = null;
        if (question.original_image_url) {
            imageBase64 = await fetchTelegramImageBase64(question.original_image_url);
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

        let data = cachedHierarchy
            .filter(e => isAdmin || !hidden.has(e._id))
            .map(e => (hidden.has(e._id) ? { ...e, hidden: true } : e));

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

        let query = {};

        if (year_exam === 'Passage Comprehension') {
            query = {
                $or: [
                    { passage_marathi: { $exists: true, $nin: [null, "null"] } },
                    { passage_english: { $exists: true, $nin: [null, "null"] } },
                    { passage_text: { $exists: true, $nin: [null, "null"] } }
                ]
            };
            if (hidden.size) query.year_exam = { $nin: [...hidden] };
        } else if (year_exam) {
            query.year_exam = year_exam;
        } else if (yearExams && yearExams.length) {
            // subject-wise inside a group / tab: only that group's papers (minus hidden ones)
            query.year_exam = { $in: yearExams.filter(x => !hidden.has(x)) };
        } else if (hidden.size) {
            // subject-wise over all papers: never include a hidden paper
            query.year_exam = { $nin: [...hidden] };
        }
        if (subject) query.subject = subject;

        let questions = await Question.find(query).lean();

        // Sort in memory to avoid MongoDB 32MB sort limit
        questions.sort((a, b) => (a.qnum || 0) - (b.qnum || 0));

        if (limit) {
            questions = questions.slice(0, parseInt(limit));
        }

        res.json({ success: true, data: questions });
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

// 3. Create Payment Order (Requires Auth to identify user)
router.post('/payment/create-order', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { planId } = req.body;
        
        const plan = PLANS[planId];
        const price = plan && plan.price;
        if (!price) {
            return res.status(400).json({ success: false, message: 'Invalid Plan' });
        }

        const options = {
            amount: price * 100,
            currency: 'INR',
            receipt: `receipt_order_${Date.now()}`,
            notes: {
                userId: userId,
                planId: planId
            }
        };

        const order = await razorpay.orders.create(options);
        res.json({ success: true, order, key_id: process.env.RAZORPAY_KEY_ID });
    } catch (error) {
        console.error('Razorpay Error:', error);
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
            source: 'verify'
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
                        source: 'webhook'
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

const submitAnswerLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    limit: 60, // Limit each IP to 60 answer submissions per windowMs
    message: { success: false, message: 'Too many answers submitted. Please slow down.' }
});

// 5. Progress Tracking (Protected & Validated)
router.post('/progress/save', authMiddleware, submitAnswerLimiter, async (req, res) => {
    try {
        const { questionId, section, selectedOption } = req.body;
        const userId = req.user.id;
        
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
        
        let progress = await Progress.findOne({ userId });
        if (!progress) {
            progress = new Progress({ userId, totalSolved: 0, totalCorrect: 0, sectionWise: new Map(), answers: new Map() });
        }
        
        // Check if already answered to prevent double counting
        const existingAnswer = progress.answers.get(questionId);
        const safeSection = section.replace(/\./g, '_dot_');
        
        if (!existingAnswer) {
            progress.totalSolved += 1;
            if (isCorrect) progress.totalCorrect += 1;

            let secStats = progress.sectionWise.get(safeSection) || { solved: 0, correct: 0 };
            secStats.solved += 1;
            if (isCorrect) secStats.correct += 1;
            progress.sectionWise.set(safeSection, secStats);
        }

        // Save detailed answer
        if (!existingAnswer) {
            progress.answers.set(questionId, { selected: selectedOption, isCorrect, isCancelled, section });
            progress.lastSolvedQuestion = questionId;
            await progress.save();
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
        const progress = await Progress.findOne({ userId });
        
        if (!progress) {
            return res.json({ success: true, data: { totalSolved: 0, totalCorrect: 0, sectionWise: {}, answers: {} } });
        }

        // Self-heal: re-check saved answers against the current (maybe AI-fixed) answer keys
        try { await reconcileUserProgress(progress); } catch (e) { console.error('reconcile failed:', e); }
        
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
// 5. IMAGE PROXY API
// -------------------------------------

const MAX_CACHE_SIZE = 900 * 1024 * 1024; // 900 MB
const TARGET_CACHE_SIZE = 700 * 1024 * 1024; // 700 MB

async function cleanupCache() {
    try {
        const files = await fsPromises.readdir(CACHE_DIR);
        let totalSize = 0;
        const fileStats = [];

        for (const file of files) {
            const filePath = path.join(CACHE_DIR, file);
            const stats = await fsPromises.stat(filePath);
            totalSize += stats.size;
            fileStats.push({ filePath, mtime: stats.mtime.getTime(), size: stats.size });
        }

        if (totalSize > MAX_CACHE_SIZE) {
            console.log(`Cache size (${(totalSize / 1024 / 1024).toFixed(2)} MB) exceeded limit. Cleaning up...`);
            // Sort by oldest first (LRU approximation based on modified/access time)
            fileStats.sort((a, b) => a.mtime - b.mtime);

            while (totalSize > TARGET_CACHE_SIZE && fileStats.length > 0) {
                const oldest = fileStats.shift();
                await fsPromises.unlink(oldest.filePath);
                totalSize -= oldest.size;
            }
            console.log(`Cache cleanup done. New size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
        }
    } catch (err) {
        console.error("Cache cleanup error:", err.message);
    }
}

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
        const tokensStr = process.env.TELEGRAM_BOT_TOKENS;
        if (!tokensStr) return res.status(500).send('No bot tokens configured');
        
        const tokens = tokensStr.split(',').map(t => t.replace(/['"]/g, '').trim()).filter(Boolean);
        
        let fileIdsObj = {};
        try {
            // Attempt to decode and parse JSON (from new Redundancy DB)
            const decoded = decodeURIComponent(rawFileId);
            fileIdsObj = JSON.parse(decoded);
        } catch (e) {
            // Fallback for single string backwards compatibility
            fileIdsObj = { "0": rawFileId };
        }

        // We will try the first available fileId to use as the cache filename
        const firstAvailableId = Object.values(fileIdsObj)[0];
        if (!firstAvailableId) return res.status(404).send('Invalid file metadata');

        // Sanitize filename
        const safeFilename = firstAvailableId.replace(/[^a-zA-Z0-9-_]/g, '') + '.jpg';
        const cachePath = path.join(CACHE_DIR, safeFilename);
        trackQuestionImage(req.query.q, safeFilename);

        // 1. Check Cache
        if (fs.existsSync(cachePath)) {
            // Update modified time for LRU
            const now = new Date();
            try { fs.utimesSync(cachePath, now, now); } catch (e) {} // ignore if fails
            res.setHeader('Cache-Control', 'private, max-age=86400');
            return res.sendFile(cachePath);
        }

        // 2. Not in Cache - Try fetching from Telegram Bots
        const allFileIds = Object.values(fileIdsObj);
        let success = false;
        
        for (const token of tokens) {
            if (success) break;
            
            for (const fId of allFileIds) {
                if (!fId) continue;
                try {
                    const fileRes = await axios.get(`https://api.telegram.org/bot${token}/getFile?file_id=${fId}`);
                    if (!fileRes.data.ok) continue;

                    const filePath = fileRes.data.result.file_path;
                    const imgUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
                    
                    const imgRes = await axios.get(imgUrl, { responseType: 'stream' });
                    
                    const writer = fs.createWriteStream(cachePath);
                    imgRes.data.pipe(writer);
                    
                    res.setHeader('Cache-Control', 'private, max-age=86400');
                    if (imgRes.headers['content-type']) {
                        res.setHeader('Content-Type', imgRes.headers['content-type']);
                    }
                    
                    imgRes.data.pipe(res);

                    writer.on('finish', () => {
                        cleanupCache();
                    });

                    success = true;
                    break; // Successfully served, break out of inner loop
                } catch (err) {
                    console.error(`Failed fetching ${fId} with token ${token.substring(0, 5)}...:`, err.message);
                    continue; // Try next fileId
                }
            }
        }
        
        if (success) return;

        // If all bots failed
        res.status(404).send('Image not available on any bot.');

    } catch (err) {
        console.error('Image Proxy Error:', err.message);
        res.status(500).send('Error fetching image');
    }
});

module.exports = {
    router,
    preloadHierarchy
};
