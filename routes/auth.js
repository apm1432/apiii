const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const crypto = require('crypto');
const { JWT_SECRET, authMiddleware, setActiveSession } = require('../middleware/auth');
const { assignSmtpToUser, sendEmail } = require('../utils/smtpService');
const rateLimit = require('express-rate-limit');
const PendingRegistration = require('../models/PendingRegistration');
const { parseGmail, normalizeGmail } = require('../utils/gmail');
const { newToken, isValidToken, sha256, withTimeout, completeRegistration, TRIAL_HOURS } = require('../utils/registration');
const { getBotUsername } = require('../admin_bot');

const SITE_URL = process.env.SITE_URL || 'https://apiii-apm1432.koyeb.app';
const OTP_VALID_MIN = 10;
const OTP_RESEND_SEC = 60;
const OTP_MAX_ATTEMPTS = 5;

const startLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, limit: 10,
    message: { success: false, message: 'Too many registration attempts. Please try again after an hour.' }
});
const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 30,
    message: { success: false, message: 'Too many attempts. Please try again later.' }
});

function tgLinkFor(token) {
    const bot = getBotUsername();
    return bot ? `https://t.me/${bot}?start=${token}` : null;
}

async function sendOtpEmail(to, otp) {
    const smtpUser = assignSmtpToUser();
    const subject = 'MPSC PYQ Tracker - Verification OTP';
    const text = `Your verification OTP is: ${otp}. It is valid for ${OTP_VALID_MIN} minutes.`;
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
            <h2 style="color: #2563eb; text-align: center;">Verify your email</h2>
            <p>Use this OTP to complete your registration:</p>
            <div style="text-align: center; margin: 20px 0;">
                <h1 style="color: #2563eb; letter-spacing: 5px;">${otp}</h1>
            </div>
            <p>Valid for ${OTP_VALID_MIN} minutes. If you didn't request this, ignore this email.</p>
        </div>`;
    // 12s cap so a dead SMTP never hangs the page - we fall back to Telegram instead
    await withTimeout(sendEmail(smtpUser, to, subject, text, html), 12000, 'SMTP');
}

// REGISTER STEP 1 - validate, store pending registration, send OTP or return Telegram link
router.post('/register/start', startLimiter, async (req, res) => {
    try {
        const { email, password, deviceId } = req.body || {};
        const method = req.body && req.body.method === 'telegram' ? 'telegram' : 'email';

        const g = parseGmail(email);
        if (!g.ok) return res.status(400).json({ success: false, message: g.message });
        if (typeof password !== 'string' || password.length < 6 || password.length > 100) {
            return res.status(400).json({ success: false, message: 'Password किमान 6 अक्षरांचा हवा (min 6 characters)' });
        }

        const exists = await User.exists({ $or: [{ email: g.email }, { emailNormalized: g.normalized }] });
        if (exists) return res.status(400).json({ success: false, message: 'User already exists' });

        // email resend cool-down for the same address
        const prev = await PendingRegistration.findOne({ emailNormalized: g.normalized, status: 'pending' });
        if (prev && prev.otpSentAt && Date.now() - prev.otpSentAt.getTime() < OTP_RESEND_SEC * 1000 && method === 'email') {
            return res.status(429).json({ success: false, message: `कृपया ${OTP_RESEND_SEC} सेकंद थांबा आणि पुन्हा प्रयत्न करा.` });
        }
        await PendingRegistration.deleteMany({ emailNormalized: g.normalized });

        const tgToken = newToken();
        const pending = new PendingRegistration({
            email: g.email,
            emailNormalized: g.normalized,
            passwordHash: await bcrypt.hash(password, 10),
            deviceId: deviceId || null,
            tgToken
        });

        const tgLink = tgLinkFor(tgToken);

        if (method === 'telegram') {
            if (!tgLink) return res.status(503).json({ success: false, message: 'Telegram bot सध्या उपलब्ध नाही. Email OTP वापरा.' });
            await pending.save();
            return res.json({ success: true, method: 'telegram', tgToken, tgLink });
        }

        // email OTP
        const otp = String(crypto.randomInt(100000, 1000000));
        pending.otpHash = sha256(otp);
        pending.otpExpiry = new Date(Date.now() + OTP_VALID_MIN * 60 * 1000);
        pending.otpSentAt = new Date();
        await pending.save();

        try {
            await sendOtpEmail(g.email, otp);
            return res.json({ success: true, method: 'email', tgToken, tgLink, message: 'OTP तुमच्या Gmail वर पाठवला आहे.' });
        } catch (mailErr) {
            console.error('Registration OTP email failed:', mailErr.message);
            // SMTP problem must never block the user -> switch to Telegram verification
            if (tgLink) {
                return res.json({
                    success: true, method: 'telegram', smtpFailed: true, tgToken, tgLink,
                    message: 'Email पाठवता आला नाही. कृपया Telegram ने verify करा.'
                });
            }
            await PendingRegistration.deleteOne({ tgToken });
            return res.status(503).json({ success: false, message: 'Verification सध्या उपलब्ध नाही. थोड्या वेळाने प्रयत्न करा.' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error during registration' });
    }
});

// REGISTER STEP 2 (email path) - verify OTP
router.post('/register/verify-otp', otpLimiter, async (req, res) => {
    try {
        const { tgToken, otp } = req.body || {};
        if (!isValidToken(tgToken) || !/^\d{6}$/.test(String(otp || ''))) {
            return res.status(400).json({ success: false, message: 'Invalid OTP' });
        }
        const pending = await PendingRegistration.findOne({ tgToken, status: 'pending' });
        if (!pending || !pending.otpHash) {
            return res.status(400).json({ success: false, expired: true, message: 'Session संपले. कृपया पुन्हा Register करा.' });
        }
        if (pending.otpAttempts >= OTP_MAX_ATTEMPTS) {
            await PendingRegistration.deleteOne({ _id: pending._id });
            return res.status(429).json({ success: false, expired: true, message: 'खूप चुकीचे प्रयत्न. कृपया पुन्हा Register करा.' });
        }
        if (new Date() > pending.otpExpiry) {
            return res.status(400).json({ success: false, message: 'OTP expire झाला. "Resend OTP" दाबा.' });
        }
        const a = Buffer.from(sha256(otp)), b = Buffer.from(pending.otpHash);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            await PendingRegistration.updateOne({ _id: pending._id }, { $inc: { otpAttempts: 1 } });
            return res.status(400).json({ success: false, message: 'चुकीचा OTP' });
        }

        const r = await completeRegistration(tgToken);
        if (!r.ok) {
            const msg = r.code === 'EMAIL_USED' ? 'User already exists' : 'Session संपले. कृपया पुन्हा Register करा.';
            return res.status(400).json({ success: false, expired: true, message: msg });
        }
        sendWelcomeEmail(r.user.email);
        res.json({ success: true, message: `Registration successful! ${TRIAL_HOURS} तास सर्व tests free. कृपया Login करा.`, email: r.user.email });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error during verification' });
    }
});

// Resend OTP
router.post('/register/resend-otp', otpLimiter, async (req, res) => {
    try {
        const { tgToken } = req.body || {};
        if (!isValidToken(tgToken)) return res.status(400).json({ success: false, message: 'Invalid request' });
        const pending = await PendingRegistration.findOne({ tgToken, status: 'pending' });
        if (!pending) return res.status(400).json({ success: false, expired: true, message: 'Session संपले. कृपया पुन्हा Register करा.' });

        if (pending.otpSentAt && Date.now() - pending.otpSentAt.getTime() < OTP_RESEND_SEC * 1000) {
            return res.status(429).json({ success: false, message: `कृपया ${OTP_RESEND_SEC} सेकंद थांबा.` });
        }
        const otp = String(crypto.randomInt(100000, 1000000));
        pending.otpHash = sha256(otp);
        pending.otpExpiry = new Date(Date.now() + OTP_VALID_MIN * 60 * 1000);
        pending.otpSentAt = new Date();
        pending.otpAttempts = 0;
        await pending.save();
        try {
            await sendOtpEmail(pending.email, otp);
            res.json({ success: true, message: 'नवीन OTP पाठवला आहे.' });
        } catch (mailErr) {
            console.error('Resend OTP failed:', mailErr.message);
            res.json({ success: false, smtpFailed: true, tgLink: tgLinkFor(tgToken), message: 'Email पाठवता आला नाही. Telegram ने verify करा.' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Browser polls this while the user verifies in Telegram
router.get('/register/status/:tgToken', otpLimiter, async (req, res) => {
    try {
        const { tgToken } = req.params;
        if (!isValidToken(tgToken)) return res.json({ success: true, status: 'expired' });
        const p = await PendingRegistration.findOne({ tgToken }).select('status failReason email').lean();
        if (!p) return res.json({ success: true, status: 'expired' });
        res.json({ success: true, status: p.status, reason: p.failReason || null, email: p.status === 'done' ? p.email : undefined });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

function sendWelcomeEmail(email) {
    try {
        const smtpUser = assignSmtpToUser();
        const subject = "Welcome to MPSC PYQ Tracker!";
        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
                <h2 style="color: #2563eb; text-align: center;">Welcome to MPSC PYQ Tracker</h2>
                <p>Thank you for registering! You now have <strong>${TRIAL_HOURS} hours of free access to all tests</strong>.</p>
                <div style="background-color: #f3f4f6; padding: 15px; border-radius: 5px; margin: 20px 0;">
                    <p style="margin: 0;"><strong>User ID (Email):</strong> ${email}</p>
                    <p style="margin: 5px 0 0 0;">Use the password you chose while registering.</p>
                </div>
                <div style="text-align: center; margin-top: 20px;">
                    <a href="${SITE_URL}" style="background-color: #2563eb; color: white; text-decoration: none; padding: 10px 20px; border-radius: 5px; font-weight: bold;">Login Now</a>
                </div>
            </div>`;
        sendEmail(smtpUser, email, subject, "Welcome to MPSC PYQ Tracker! Thank you for registering.", html)
            .catch(err => console.error("Failed to send welcome email:", err.message));
    } catch (e) { console.error("Email setup failed:", e.message); }
}

// Direct registration is disabled - verification is mandatory
router.post('/register', (req, res) => {
    res.status(410).json({ success: false, message: 'कृपया नवीन Register form वापरा (verification आवश्यक).' });
});

// LOGIN
router.post('/login', async (req, res) => {
    try {
        const { email, password, deviceId } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password are required' });
        }

        // Check user (exact match for old accounts, lower-case / normalised gmail for new ones)
        const em = String(email).trim().toLowerCase();
        const norm = normalizeGmail(em);
        const lookups = [{ email }, { email: em }];
        if (norm) lookups.push({ emailNormalized: norm });
        const user = await User.findOne({ $or: lookups });
        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid credentials' });
        }

        // Validate password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Invalid credentials' });
        }

        // Device Lock: applies ONLY when the admin has locked this user.
        // Otherwise the user may login from any browser/device.
        if (user.deviceLockEnabled) {
            if (!deviceId) {
                return res.status(403).json({ success: false, message: 'Device could not be identified. Please try again.' });
            }
            if (!user.deviceId) {
                user.deviceId = deviceId; // first login after admin locked -> bind this browser
            } else if (user.deviceId !== deviceId) {
                return res.status(403).json({ success: false, message: 'Account is locked to another device. Please contact admin to unlock.' });
            }
        }

        // Single active session: this login replaces any older session (older one is logged out automatically)
        const sid = crypto.randomBytes(16).toString('hex');
        user.sessionId = sid;
        await user.save();
        setActiveSession(user._id, sid);

        // Generate JWT
        const token = jwt.sign(
            { id: user._id, email: user.email, isSubscribed: user.isSubscribed, isAdmin: user.isAdmin, sid },
            JWT_SECRET,
            { expiresIn: '7d' } // Token valid for 7 days
        );

        res.json({ 
            success: true, 
            message: 'Login successful',
            token,
            user: { 
                email: user.email, 
                isSubscribed: user.isSubscribed,
                subscriptionPlan: user.subscriptionPlan,
                subscriptionExpiry: user.subscriptionExpiry,
                hasUsedFreeTrial: user.hasUsedFreeTrial,
                isAdmin: user.isAdmin
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error during login' });
    }
});

// SESSION CHECK - used by the browser to find out quickly if it was logged out by a newer login
router.get('/session', authMiddleware, (req, res) => {
    res.json({ success: true });
});

// FORGOT PASSWORD - Request OTP
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ success: false, message: 'User not found' });

        // Generate 6 digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.resetOtp = otp;
        user.resetOtpExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 mins expiry
        await user.save();

        // Send Email
        try {
            const smtpUser = assignSmtpToUser();
            const subject = "MPSC PYQ Tracker - Password Reset OTP";
            const text = `Your OTP for password reset is: ${otp}. It is valid for 15 minutes.`;
            const html = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
                    <h2 style="color: #2563eb; text-align: center;">Password Reset Request</h2>
                    <p>Hello,</p>
                    <p>We received a request to reset your password. Use the OTP below to complete the process:</p>
                    <div style="text-align: center; margin: 20px 0;">
                        <h1 style="color: #2563eb; letter-spacing: 5px;">${otp}</h1>
                    </div>
                    <p>This OTP is valid for 15 minutes.</p>
                    <p style="color: #777; font-size: 12px;">If you didn't request this, you can safely ignore this email.</p>
                </div>
            `;
            await sendEmail(smtpUser, email, subject, text, html);
            res.json({ success: true, message: 'OTP sent to your email.' });
        } catch (emailErr) {
            console.error("Email setup/sending failed:", emailErr.message);
            // Revert OTP since email failed
            user.resetOtp = null;
            user.resetOtpExpiry = null;
            await user.save();
            return res.status(500).json({ success: false, message: 'Failed to send OTP email. Please check server SMTP configuration.' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error during forgot password' });
    }
});

// VERIFY OTP & RESET PASSWORD
router.post('/verify-reset-password', async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;
        if (!email || !otp || !newPassword) return res.status(400).json({ success: false, message: 'Missing required fields' });

        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ success: false, message: 'User not found' });

        if (!user.resetOtp || user.resetOtp !== otp) {
            return res.status(400).json({ success: false, message: 'Invalid OTP' });
        }

        if (new Date() > user.resetOtpExpiry) {
            return res.status(400).json({ success: false, message: 'OTP has expired' });
        }

        // Hash new password
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        user.resetOtp = null;
        user.resetOtpExpiry = null;
        await user.save();

        res.json({ success: true, message: 'Password reset successfully. You can now login.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error during password reset' });
    }
});

module.exports = router;
