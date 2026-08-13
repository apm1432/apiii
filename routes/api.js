const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Razorpay = require('razorpay');

// Models
const Question = require('../models/Question');
const User = require('../models/User');
const Progress = require('../models/Progress');

// Middleware & Services
const { authMiddleware, requireSubscription } = require('../middleware/auth');
const smtpService = require('../utils/smtpService');

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
            },
            { $sort: { "_id": -1 } }
        ]);
        
        cachedHierarchy = hierarchy;
        lastCacheTime = Date.now();
        console.log("✅ Hierarchy preloaded successfully!");
    } catch (err) {
        console.error("❌ Failed to preload hierarchy:", err);
    }
}

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
            },
            { $sort: { "_id": -1 } }
        ]);
        
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
        const freePaperName = "Maharashtra Subordinate Services Non-Gazetted, Group-b Preliminar 2020";
        const isFree = (year_exam === freePaperName);
        
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

// 5. Progress Tracking (Protected)
router.post('/progress/save', authMiddleware, async (req, res) => {
    try {
        const { questionId, isCorrect, section, selectedOption } = req.body;
        const userId = req.user.id;
        
        let progress = await Progress.findOne({ userId });
        if (!progress) {
            progress = new Progress({ userId, totalSolved: 0, totalCorrect: 0, sectionWise: new Map(), answers: new Map() });
        }
        
        // Check if already answered to prevent double counting
        const existingAnswer = progress.answers.get(questionId);
        
        if (!existingAnswer) {
            progress.totalSolved += 1;
            if (isCorrect) progress.totalCorrect += 1;

            let secStats = progress.sectionWise.get(section) || { solved: 0, correct: 0 };
            secStats.solved += 1;
            if (isCorrect) secStats.correct += 1;
            progress.sectionWise.set(section, secStats);
        } else {
            // If they are answering again, update correct counts if it changed (though usually UI prevents this)
            if (!existingAnswer.isCorrect && isCorrect) {
                progress.totalCorrect += 1;
                let secStats = progress.sectionWise.get(section);
                if (secStats) { secStats.correct += 1; progress.sectionWise.set(section, secStats); }
            } else if (existingAnswer.isCorrect && !isCorrect) {
                progress.totalCorrect -= 1;
                let secStats = progress.sectionWise.get(section);
                if (secStats) { secStats.correct -= 1; progress.sectionWise.set(section, secStats); }
            }
        }

        // Save detailed answer
        progress.answers.set(questionId, { selected: selectedOption, isCorrect, section });

        progress.lastSolvedQuestion = questionId;

        await progress.save();
        res.json({ success: true, progress });
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
        
        if (!progress) return res.json({ success: true, data: { totalSolved: 0, totalCorrect: 0, sectionWise: {} } });
        
        res.json({ success: true, data: progress });
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
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const axios = require('axios');

const CACHE_DIR = path.join(__dirname, '..', 'cache', 'images');
const MAX_CACHE_SIZE = 900 * 1024 * 1024; // 900 MB
const TARGET_CACHE_SIZE = 700 * 1024 * 1024; // 700 MB

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

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
