const crypto = require('crypto');
const PendingRegistration = require('../models/PendingRegistration');
const User = require('../models/User');
const DeviceLog = require('../models/DeviceLog');

const TRIAL_HOURS = 24;

// 1 prefix char + 15 random chars = 16 chars of [A-Za-z0-9_-]  (valid Telegram /start payload, limit is 64)
// prefix tells the bot what the token is for: r = registration, p = password reset, v = recover old account
function newToken(prefix = 'r') {
    return prefix + crypto.randomBytes(12).toString('base64url').slice(0, 15);
}

const isValidToken = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{15,20}$/.test(t);

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function withTimeout(promise, ms, label = 'operation') {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * Atomically claims a pending registration and creates the user with 1 day full access.
 * Used by BOTH the email-OTP route and the Telegram bot.
 * Returns { ok:true, user } or { ok:false, code:'EXPIRED'|'TG_USED'|'EMAIL_USED' }
 */
async function completeRegistration(tgToken, { telegramId, via = 'email' } = {}) {
    // Telegram can only finish a repeat-registrant's signup after the email OTP step is done;
    // the email path can never finish it (Telegram is still required).
    const filter = { tgToken, status: 'pending' };
    if (via === 'telegram') filter.$or = [{ requireBoth: { $ne: true } }, { emailVerified: true }];
    else filter.requireBoth = { $ne: true };

    const pending = await PendingRegistration.findOneAndUpdate(filter, { status: 'done' }, { new: false });
    if (!pending) {
        const p = await PendingRegistration.findOne({ tgToken, status: 'pending' }).select('requireBoth emailVerified').lean();
        if (p && p.requireBoth && !p.emailVerified && via === 'telegram') return { ok: false, code: 'NEED_EMAIL' };
        return { ok: false, code: 'EXPIRED' };
    }

    const expiry = new Date(Date.now() + TRIAL_HOURS * 60 * 60 * 1000);
    try {
        const user = await User.create({
            email: pending.email,
            emailNormalized: pending.emailNormalized,
            password: pending.passwordHash,
            deviceId: pending.deviceId || null,
            isSubscribed: true,
            subscriptionPlan: '1_day_trial',
            subscriptionExpiry: expiry,
            telegramId: telegramId ? String(telegramId) : undefined
        });
        DeviceLog.create({ userId: user._id, deviceId: pending.deviceId, cookieId: pending.cookieId, ip: pending.ip })
            .catch(e => console.error('DeviceLog error:', e.message));
        return { ok: true, user };
    } catch (err) {
        if (err && err.code === 11000) {
            const key = Object.keys(err.keyPattern || err.keyValue || {})[0] || '';
            const code = key === 'telegramId' ? 'TG_USED' : 'EMAIL_USED';
            await PendingRegistration.updateOne({ _id: pending._id }, { status: 'failed', failReason: code });
            return { ok: false, code };
        }
        // unexpected error -> let the user retry with the same token
        await PendingRegistration.updateOne({ _id: pending._id }, { status: 'pending' });
        throw err;
    }
}

module.exports = { TRIAL_HOURS, newToken, isValidToken, sha256, withTimeout, completeRegistration };
