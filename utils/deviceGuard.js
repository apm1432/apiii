// Hidden abuse check: detects repeated registrations from the same device.
// Signals: deviceId (localStorage, sent by the page), cookieId (httpOnly cookie), IP (weak signal -
// many mobile users share one IP, so it only matters at a high count).
const crypto = require('crypto');
const DeviceLog = require('../models/DeviceLog');
const User = require('../models/User');

const COOKIE = 'mpsc_did';
// 3rd registration attempt from one device (2 earlier accounts) => both verifications compulsory
const BOTH_AFTER = parseInt(process.env.BOTH_VERIFY_AFTER || '2', 10);
// Same IP, many accounts in 24h (NAT-friendly threshold) => both verifications compulsory
const IP_BOTH_AFTER = parseInt(process.env.IP_BOTH_VERIFY_AFTER || '5', 10);

function getCookie(req, name) {
    const h = req.headers.cookie || '';
    for (const part of h.split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) {
            try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return null; }
        }
    }
    return null;
}

function ensureCookieId(req, res) {
    let id = getCookie(req, COOKIE);
    if (!id || !/^[a-f0-9]{32}$/.test(id)) id = crypto.randomBytes(16).toString('hex');
    res.cookie(COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: !!req.secure, maxAge: 400 * 24 * 60 * 60 * 1000 });
    return id;
}

const cleanDeviceId = (d) => (typeof d === 'string' && d.length >= 8 && d.length <= 100) ? d : null;

async function assess({ deviceId, cookieId, ip }) {
    const ors = [];
    if (deviceId) ors.push({ deviceId });
    if (cookieId) ors.push({ cookieId });
    const prior = ors.length ? await DeviceLog.countDocuments({ $or: ors }) : 0;
    const ipToday = ip ? await DeviceLog.countDocuments({ ip, createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }) : 0;
    return {
        prior, ipToday,
        requireBoth: prior >= BOTH_AFTER || ipToday >= IP_BOTH_AFTER,
        hasOldAccount: prior >= 1
    };
}

// Emails of accounts previously created from this device / cookie (never from IP alone)
async function oldAccountEmails({ deviceId, cookieId }) {
    const ors = [];
    if (deviceId) ors.push({ deviceId });
    if (cookieId) ors.push({ cookieId });
    if (!ors.length) return [];
    const logs = await DeviceLog.find({ $or: ors }).select('userId').limit(10).lean();
    const ids = [...new Set(logs.map(l => String(l.userId)))];
    if (!ids.length) return [];
    const users = await User.find({ _id: { $in: ids } }).select('email').lean();
    return users.map(u => u.email);
}

const maskEmail = (e) => e.replace(/^(.{2}).*(@.*)$/, '$1***$2');

module.exports = { ensureCookieId, getCookie, cleanDeviceId, assess, oldAccountEmails, maskEmail };
