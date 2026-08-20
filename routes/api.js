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
const { authMiddleware, requireSubscription } = require('../middleware/auth');
const smtpService = require('../utils/smtpService');
const { fixQuestionWithAI } = require('../utils/aiService');

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

async function preloadHierarchy() {
    try {
        console.log("⏳ Preloading exam hierarchy into server memory...");
        const hierarchy = await require('../models/Question').aggregate([
            {
                $group: {
                    _id: {
                        year_exam: "$year_exam",
                        subject: "$subject"
                    },
                    count: { $sum: 1 }
                }
            },
            {
                $group: {
                    _id: "$_id.year_exam",
                    exams: {
                        $push: {
                            subject: "$_id.subject",
                            count: "$count"
                        }
                    }
                }
            }
        ]);
        
        hierarchy.sort((a, b) => extractYear(b._id) - extractYear(a._id));
        
        cachedHierarchy = hierarchy;
        lastCacheTime = Date.now();
        console.log("✅ Hierarchy preloaded successfully!");
    } catch (err) {
        console.error("❌ Failed to preload hierarchy:", err);
    }
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
            // Apply fixes
            if (fixedData.fixed_text) question.text = fixedData.fixed_text;
            if (fixedData.fixed_options && fixedData.fixed_options.length === 4) question.options = fixedData.fixed_options;
            if (fixedData.correct_answer_option) {
                if (fixedData.correct_answer_option === "#") {
                    question.correct_answer_option = "#";
                } else {
                    question.correct_answer_option = parseInt(fixedData.correct_answer_option);
                }
            }
            if (fixedData.fixed_explanation) question.toppers_explanation_marathi = fixedData.fixed_explanation;
            if (fixedData.fixed_options_explanation && fixedData.fixed_options_explanation.length > 0) question.options_explanation = fixedData.fixed_options_explanation;
            
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
router.get('/exams/hierarchy', async (req, res) => {
    try {
        if (cachedHierarchy && (Date.now() - lastCacheTime < 3600000)) { // 1 hour cache
            return res.json({ success: true, data: cachedHierarchy });
        }

        const hierarchy = await Question.aggregate([
            {
                $group: {
                    _id: {
                        year_exam: "$year_exam",
                        subject: "$subject"
                    },
                    count: { $sum: 1 }
                }
            },
            {
                $group: {
                    _id: "$_id.year_exam",
                    exams: {
                        $push: {
                            subject: "$_id.subject",
                            count: "$count"
                        }
                    }
                }
            }
        ]);
        
        hierarchy.sort((a, b) => extractYear(b._id) - extractYear(a._id));
        
        const passageCount = await Question.countDocuments({
            $or: [
                { passage_marathi: { $exists: true, $nin: [null, "null"] } },
                { passage_english: { $exists: true, $nin: [null, "null"] } }
            ]
        });
        
        if (passageCount > 0) {
            hierarchy.unshift({
                _id: 'Passage Comprehension',
                exams: [{ subject: 'All Passages', count: passageCount }]
            });
        }
        
        cachedHierarchy = hierarchy;
        lastCacheTime = Date.now();
        
        res.json({ success: true, data: hierarchy });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load exam hierarchy' });
    }
});

// 2. Fetch Questions by Filter (Protected - Subscription check inside)
router.post('/questions', authMiddleware, async (req, res) => {
    try {
        const { year_exam, subject, limit } = req.body;
        
        // --- Security & Free Bypass Check ---
        const user = await User.findById(req.user.id);
        
        // Dynamically get the first 2 tests from hierarchy
        let freeTests = [];
        if (cachedHierarchy && cachedHierarchy.length > 0) {
            let exams = [...cachedHierarchy];
            // Sort by year descending (same as frontend)
            exams.sort((a, b) => {
                const idA = a._id || '';
                const idB = b._id || '';
                const yearA = idA.match(/\d{4}/) ? parseInt(idA.match(/\d{4}/)[0]) : 0;
                const yearB = idB.match(/\d{4}/) ? parseInt(idB.match(/\d{4}/)[0]) : 0;
                if (yearA !== yearB) return yearB - yearA; 
                return idA.localeCompare(idB);
            });
            freeTests = exams.slice(0, 2).map(e => e._id);
        }

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
                    { passage_english: { $exists: true, $nin: [null, "null"] } }
                ]
            };
        } else if (year_exam) {
            query.year_exam = year_exam;
        }
        if (subject) query.subject = subject;

        const progress = await Progress.findOne({ userId: req.user.id });
        const answeredMap = progress ? progress.answers : new Map();

        let questions = await Question.find(query).lean();
        
        // Sort in memory to avoid MongoDB 32MB sort limit
        questions.sort((a, b) => (a.qnum || 0) - (b.qnum || 0));
        
        if (limit) {
            questions = questions.slice(0, parseInt(limit));
        }

        // STRIP SENSITIVE DATA
        questions = questions.map(q => {
            if (!answeredMap.has(q._id.toString())) {
                delete q.final_answer_key;
                delete q.correct_answer_option;
                delete q.answer_key;
                delete q.toppers_explanation_marathi;
                delete q.options_explanation;
            }
            return q;
        });

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
        
        const planPrices = {
            '1_month': 50,
            '2_years': 100
        };
        
        const price = planPrices[planId];
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
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planId } = req.body;
        const userId = req.user.id;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, message: 'Missing payment parameters' });
        }

        const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
        hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
        const generatedSignature = hmac.digest('hex');

        if (generatedSignature === razorpay_signature) {
            // Update User Subscription
            let expiry = new Date();
            if (planId === '1_month') {
                expiry.setDate(expiry.getDate() + 30); // 30 days access
            } else if (planId === '2_years') {
                expiry.setFullYear(expiry.getFullYear() + 2); // 2 years access
            }

            const updatedUser = await User.findByIdAndUpdate(userId, { 
                isSubscribed: true,
                subscriptionPlan: planId,
                subscriptionExpiry: expiry
            }, { new: true });

            res.json({ 
                success: true, 
                message: 'Payment verified successfully!',
                user: {
                    email: updatedUser.email,
                    isSubscribed: updatedUser.isSubscribed,
                    subscriptionPlan: updatedUser.subscriptionPlan,
                    subscriptionExpiry: updatedUser.subscriptionExpiry
                }
            });
        } else {
            res.status(400).json({ success: false, message: 'Invalid signature' });
        }
    } catch (err) {
        console.error('Verify Payment Error:', err);
        res.status(500).json({ success: false, message: 'Server error during verification' });
    }
});

// -------------------------------------
// 3. PAYMENT API (Webhook Verification)
// -------------------------------------

// 4. Webhook for Payment Verification (Unprotected, called by Razorpay)
router.post('/payment/webhook', (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || 'YOUR_WEBHOOK_SECRET';
    const signature = req.headers['x-razorpay-signature'];

    if (!req.rawBody) {
        return res.status(400).send('Missing raw body');
    }

    try {
        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(req.rawBody)
            .digest('hex');

        if (expectedSignature === signature) {
            const event = req.body;
            
            if (event.event === 'payment.captured') {
                const paymentData = event.payload.payment.entity;
                console.log(`Payment Captured! Amount: ${paymentData.amount / 100}`);
                const assignedSmtp = smtpService.assignSmtpToUser();
                console.log(`Assigned SMTP [${assignedSmtp}] to user.`);

                // Update User Subscription
                const userId = paymentData.notes.userId;
                const planId = paymentData.notes.planId;
                
                if (userId) {
                    let expiry = new Date();
                    if (planId === '1_day') {
                        expiry.setDate(expiry.getDate() + 1);
                    } else if (planId === '2_years') {
                        expiry.setFullYear(expiry.getFullYear() + 2);
                    }
                    
                    User.findByIdAndUpdate(userId, { 
                        isSubscribed: true, 
                        subscriptionExpiry: expiry,
                        assignedSmtp: assignedSmtp 
                    }).exec();
                    console.log(`User ${userId} upgraded to ${planId}. Expiry: ${expiry}`);
                }
            }
            
            res.status(200).send('Webhook verified');
        } else {
            res.status(400).send('Invalid signature');
        }
    } catch (err) {
        console.error('Webhook Error:', err);
        res.status(500).send('Webhook Server Error');
    }
});

// -------------------------------------
// 4. PROGRESS TRACKING API
// -------------------------------------

const rateLimit = require('express-rate-limit');
const submitAnswerLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60, // Limit each IP to 60 answer submissions per windowMs
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
            progress.answers.set(questionId, { selected: selectedOption, isCorrect, section });
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

router.get('/image/:fileId', async (req, res) => {
    try {
        let token = req.query.token;
        if (!token && req.headers.authorization) {
            token = req.headers.authorization.split(' ')[1];
        }
        if (!token) return res.status(401).send('Unauthorized. Token missing.');
        
        const jwt = require('jsonwebtoken');
        const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_mpsc_portal_123';
        try {
            jwt.verify(token, JWT_SECRET);
        } catch (err) {
            return res.status(401).send('Unauthorized. Invalid token.');
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

        // 1. Check Cache
        if (fs.existsSync(cachePath)) {
            // Update modified time for LRU
            const now = new Date();
            try { fs.utimesSync(cachePath, now, now); } catch (e) {} // ignore if fails
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
