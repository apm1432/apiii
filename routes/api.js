const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Razorpay = require('razorpay');

// Models
const Question = require('../models/Question');
const User = require('../models/User');
const Progress = require('../models/Progress');

// Services
const smtpService = require('../utils/smtpService');

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// -------------------------------------
// 1. DATA API (Fetch Questions)
// -------------------------------------
router.get('/questions', async (req, res) => {
    try {
        const { year, exam, subject, limit = 50 } = req.query;
        let query = {};
        
        if (year) query.year = year;
        if (exam) query.examName = exam;
        if (subject) query.subject = subject;

        const questions = await Question.find(query).limit(parseInt(limit));
        res.json({ success: true, count: questions.length, data: questions });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

// -------------------------------------
// 2. PAYMENT API (Order Creation)
// -------------------------------------
router.post('/payment/create-order', async (req, res) => {
    try {
        const { planId, userId } = req.body; // In production, verify user from JWT
        
        // Security: ALWAYS decide price on backend to prevent price manipulation
        const planPrices = {
            'basic': 99,
            'premium': 299,
            'lifetime': 999
        };
        
        const price = planPrices[planId];
        if (!price) {
            return res.status(400).json({ success: false, message: 'Invalid Plan' });
        }

        const options = {
            amount: price * 100, // Amount in paise
            currency: 'INR',
            receipt: `receipt_order_${Date.now()}`
        };

        const order = await razorpay.orders.create(options);
        res.json({ success: true, order });
    } catch (error) {
        console.error('Razorpay Error:', error);
        res.status(500).json({ success: false, message: 'Order Creation Failed' });
    }
});

// -------------------------------------
// 3. PAYMENT API (Webhook Verification)
// -------------------------------------
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
            // body is already parsed by express.json()
            const event = req.body;
            
            if (event.event === 'payment.captured') {
                // Payment was successful! Grant access to user in DB.
                const paymentData = event.payload.payment.entity;
                console.log(`Payment Captured! Amount: ${paymentData.amount / 100}`);
                
                // Assign a permanent SMTP to this user
                const assignedSmtp = smtpService.assignSmtpToUser();
                
                // TODO: Update User DB Subscription and assignedSmtp
                // const user = await User.findById(paymentData.notes.userId);
                // user.isPremium = true;
                // user.assignedSmtp = assignedSmtp;
                // await user.save();
                
                console.log(`Assigned SMTP [${assignedSmtp}] to user.`);
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

// Save question attempt
router.post('/progress/save', async (req, res) => {
    try {
        const { userId, questionId, isCorrect, section } = req.body;
        // In real app, userId comes from Auth middleware
        
        let progress = await Progress.findOne({ userId });
        if (!progress) {
            progress = new Progress({ userId, totalSolved: 0, totalCorrect: 0, sectionWise: new Map() });
        }

        // Logic to prevent duplicate counting can be added here
        
        progress.totalSolved += 1;
        if (isCorrect) progress.totalCorrect += 1;

        // Section logic
        let secStats = progress.sectionWise.get(section) || { solved: 0, correct: 0 };
        secStats.solved += 1;
        if (isCorrect) secStats.correct += 1;
        progress.sectionWise.set(section, secStats);

        // Update last solved for resume
        progress.lastSolvedQuestion = questionId;

        await progress.save();
        res.json({ success: true, progress });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to save progress' });
    }
});

// Get dashboard stats
router.get('/progress/dashboard', async (req, res) => {
    try {
        const { userId } = req.query;
        const progress = await Progress.findOne({ userId });
        
        if (!progress) return res.json({ success: true, data: { totalSolved: 0, totalCorrect: 0, sectionWise: {} } });
        
        res.json({ success: true, data: progress });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch dashboard' });
    }
});

// Reset progress (Overall or Specific section)
router.post('/progress/reset', async (req, res) => {
    try {
        const { userId, section } = req.body;
        const progress = await Progress.findOne({ userId });
        if (!progress) return res.json({ success: true, message: 'Nothing to reset' });

        if (section) {
            // Reset specific section
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

module.exports = router;
