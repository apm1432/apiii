const jwt = require('jsonwebtoken');
const User = require('../models/User'); // ADDED THIS

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_mpsc_portal_123';

const authMiddleware = (req, res, next) => {
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

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // { id, email, isSubscribed }
        next();
    } catch (err) {
        return res.status(400).json({ success: false, message: 'Invalid or Expired Token.' });
    }
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
    requireSubscription,
    JWT_SECRET
};
