const jwt = require('jsonwebtoken');
const User = require('../models/User'); // ADDED THIS

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_mpsc_portal_123';

// ---- Single active session -------------------------------------------------
// Every login creates a new sessionId (stored in DB + inside the JWT). Only the
// newest sessionId is valid, so an older login is rejected on its next request.
// Cache = userId -> active sessionId (this app runs as ONE node process).
const sessionCache = new Map();

function setActiveSession(userId, sid) {
    sessionCache.set(String(userId), sid);
}

async function isSessionActive(decoded) {
    if (!decoded || !decoded.id || !decoded.sid) return false; // old tokens without sid -> must login again
    const uid = String(decoded.id);
    let active = sessionCache.get(uid);
    if (active === undefined) {
        const u = await User.findById(uid).select('sessionId').lean();
        if (!u) return false;
        active = u.sessionId || null;
        if (active) sessionCache.set(uid, active);
    }
    return active === decoded.sid;
}

const SESSION_EXPIRED_RESPONSE = {
    success: false,
    code: 'SESSION_EXPIRED',
    message: 'तुमचे खाते दुसऱ्या ठिकाणी login झाले आहे. कृपया पुन्हा login करा. (Logged in elsewhere)'
};

const authMiddleware = async (req, res, next) => {
    let token = null;
    const authHeader = req.header('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    } else if (req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ success: false, message: 'Access Denied. No token provided.' });
    }

    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return res.status(400).json({ success: false, message: 'Invalid or Expired Token.' });
    }

    try {
        if (!(await isSessionActive(decoded))) {
            return res.status(401).json(SESSION_EXPIRED_RESPONSE);
        }
    } catch (err) {
        console.error('Session check error:', err);
        return res.status(500).json({ success: false, message: 'Internal auth error' });
    }

    req.user = decoded; // { id, email, isSubscribed, sid }
    next();
};

const requireSubscription = async (req, res, next) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(401).json({ success: false, message: 'User not found' });
        }
        
        // Check if subscribed and not expired
        if (!user.isSubscribed || (user.subscriptionExpiry && user.subscriptionExpiry < new Date())) {
            // Auto-revoke if expired
            if (user.isSubscribed && user.subscriptionExpiry < new Date()) {
                user.isSubscribed = false;
                await user.save();
            }
            return res.status(403).json({ 
                success: false, 
                message: 'Subscription Required or Expired', 
                code: 'SUBSCRIPTION_REQUIRED' 
            });
        }
        next();
    } catch (err) {
        console.error("Auth Middleware Error:", err);
        return res.status(500).json({ success: false, message: 'Internal auth error' });
    }
};

module.exports = {
    authMiddleware,
    setActiveSession,
    isSessionActive,
    requireSubscription,
    JWT_SECRET
};
