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
        
        cachedHierarchy = hierarchy;
        lastCacheTime = Date.now();
        
        res.json({ success: true, data: hierarchy });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load exam hierarchy' });
    }
});

// 2. Fetch Questions by Filter (Protected & Requires Subscription)
router.post('/questions', authMiddleware, requireSubscription, async (req, res) => {
    try {
        const { year_exam, subject, limit } = req.body;
        let query = {};
        
        if (year_exam) query.year_exam = year_exam;
        if (subject) query.subject = subject;

        let questions = await Question.find(query).lean();
        
        // Sort in memory to avoid MongoDB 32MB sort limit
        questions.sort((a, b) => (a.qnum || 0) - (b.qnum || 0));
        
        if (limit) {
            questions = questions.slice(0, parseInt(limit));
        }
        res.json({ success: true, count: questions.length, data: questions });
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
            '1_day': 12,
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
            if (planId === '1_day') {
                expiry.setDate(expiry.getDate() + 1);
            } else if (planId === '2_years') {
                expiry.setFullYear(expiry.getFullYear() + 2);
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

// 5. Progress Tracking (Protected & Requires Subscription)
router.post('/progress/save', authMiddleware, requireSubscription, async (req, res) => {
    try {
        const { questionId, isCorrect, section } = req.body;
        const userId = req.user.id;
        
        let progress = await Progress.findOne({ userId });
        if (!progress) {
            progress = new Progress({ userId, totalSolved: 0, totalCorrect: 0, sectionWise: new Map() });
        }
        
        progress.totalSolved += 1;
        if (isCorrect) progress.totalCorrect += 1;

        let secStats = progress.sectionWise.get(section) || { solved: 0, correct: 0 };
        secStats.solved += 1;
        if (isCorrect) secStats.correct += 1;
        progress.sectionWise.set(section, secStats);

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
        } else {
            // Reset ALL
            progress.totalSolved = 0;
            progress.totalCorrect = 0;
            progress.sectionWise = new Map();
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
const axios = require('axios');

router.get('/image/:fileId', async (req, res) => {
    try {
        const fileId = req.params.fileId;
        const tokensStr = process.env.TELEGRAM_BOT_TOKENS;
        if (!tokensStr) return res.status(500).send('No bot tokens configured');
        
        // Try with the first bot token
        const token = tokensStr.split(',')[0].trim();
        
        // 1. Get file path from Telegram API
        const fileRes = await axios.get(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
        if (!fileRes.data.ok) {
            return res.status(404).send('Image metadata not found');
        }
        
        const filePath = fileRes.data.result.file_path;
        
        // 2. Fetch the actual image data
        const imgUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
        const imgRes = await axios.get(imgUrl, { responseType: 'stream' });
        
        // Set basic headers if needed (axios usually proxies content-type well)
        if (imgRes.headers['content-type']) {
            res.setHeader('Content-Type', imgRes.headers['content-type']);
        }
        
        // 3. Pipe to client
        imgRes.data.pipe(res);
    } catch (err) {
        console.error('Image Proxy Error:', err.message);
        res.status(500).send('Error fetching image');
    }
});

module.exports = {
    router,
    preloadHierarchy
};
