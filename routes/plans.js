// Admin: subscription plans & pricing (add / edit price / change duration / hide / delete).
// Everything here needs a logged-in ADMIN. Students only ever read the public GET /api/plans.
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const User = require('../models/User');
const Plan = require('../models/Plan');
const { authMiddleware } = require('../middleware/auth');
const { broadcast } = require('../utils/userEvents');

const limiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many requests. Please slow down.' } });

async function adminOnly(req, res, next) {
    try {
        const user = await User.findById(req.user.id).select('isAdmin email').lean();
        if (!user || !user.isAdmin) return res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' });
        req.adminEmail = user.email;
        next();
    } catch (e) { res.status(500).json({ success: false, message: 'Server Error' }); }
}
router.use(authMiddleware, adminOnly, limiter);

// strip control characters, collapse spaces, cut to length
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// Turns the admin's form into a safe plan object, or returns { error }.
function parsePlan(body, partial) {
    const b = body || {};
    const out = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);

    for (const k of ['name', 'description', 'badge']) {
        if (has(k) && b[k] != null && typeof b[k] !== 'string') return { error: 'Invalid ' + k + '.' };
    }
    if (!partial || has('name')) {
        out.name = clean(b.name, 60);
        if (out.name.length < 2) return { error: 'Plan name is required (at least 2 characters).' };
    }
    if (!partial || has('description')) out.description = clean(b.description, 200);
    if (!partial || has('badge')) out.badge = clean(b.badge, 30);

    if (!partial || has('price')) {
        const price = Number(b.price);
        if (!Number.isFinite(price) || price < 1 || price > 100000) return { error: 'Price must be between ₹1 and ₹1,00,000.' };
        out.price = Math.round(price * 100) / 100;
    }
    if (has('originalPrice')) {
        if (b.originalPrice === '' || b.originalPrice === null) out.originalPrice = null;
        else {
            const op = Number(b.originalPrice);
            if (!Number.isFinite(op) || op < 0 || op > 1000000) return { error: 'Original price is not valid.' };
            out.originalPrice = op > 0 ? Math.round(op * 100) / 100 : null;
        }
    }
    if (!partial || has('durationValue')) {
        const v = Number(b.durationValue);
        if (!Number.isInteger(v) || v < 1 || v > 3650) return { error: 'Duration must be a whole number between 1 and 3650.' };
        out.durationValue = v;
    }
    if (!partial || has('durationUnit')) {
        if (!['days', 'months', 'years'].includes(b.durationUnit)) return { error: 'Duration unit must be days, months or years.' };
        out.durationUnit = b.durationUnit;
    }
    if (has('sortOrder')) {
        const s = Number(b.sortOrder);
        if (!Number.isFinite(s) || Math.abs(s) > 100000) return { error: 'Order is not valid.' };
        out.sortOrder = Math.round(s);
    }
    if (has('active')) out.active = b.active === true || b.active === 'true';
    return { value: out };
}

// the final state must still contain at least one purchasable plan
async function wouldLeaveNoActive(exceptPlanId) {
    return (await Plan.countDocuments({ active: true, planId: { $ne: exceptPlanId } })) === 0;
}

router.get('/', async (req, res) => {
    try {
        const plans = await Plan.find({}).sort({ sortOrder: 1, price: 1, createdAt: 1 }).lean();
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, plans });
    } catch (e) { res.status(500).json({ success: false, message: 'Server Error' }); }
});

router.post('/', async (req, res) => {
    try {
        const p = parsePlan(req.body, false);
        if (p.error) return res.status(400).json({ success: false, message: p.error });
        if ((await Plan.estimatedDocumentCount()) >= 30) return res.status(400).json({ success: false, message: 'Maximum 30 plans allowed.' });
        const last = await Plan.findOne({}).sort({ sortOrder: -1 }).select('sortOrder').lean();
        const plan = await Plan.create({
            active: true,
            sortOrder: (last ? last.sortOrder : 0) + 1,
            ...p.value,
            planId: 'plan_' + crypto.randomBytes(5).toString('hex'),
            updatedBy: req.adminEmail
        });
        console.log(`[plans] ${req.adminEmail} created ${plan.planId} (${plan.name}, ₹${plan.price})`);
        broadcast('plans');
        res.json({ success: true, plan });
    } catch (e) {
        console.error('plans create:', e);
        res.status(500).json({ success: false, message: 'Could not create the plan.' });
    }
});

router.put('/:planId', async (req, res) => {
    try {
        const planId = String(req.params.planId);
        const p = parsePlan(req.body, true);
        if (p.error) return res.status(400).json({ success: false, message: p.error });
        if (p.value.active === false && (await wouldLeaveNoActive(planId))) {
            return res.status(400).json({ success: false, message: 'At least one plan must stay active, otherwise students cannot pay.' });
        }
        const before = await Plan.findOne({ planId }).lean();
        if (!before) return res.status(404).json({ success: false, message: 'Plan not found.' });
        const plan = await Plan.findOneAndUpdate({ planId }, { $set: { ...p.value, updatedBy: req.adminEmail, updatedAt: new Date() } }, { new: true, runValidators: true });
        console.log(`[plans] ${req.adminEmail} updated ${planId}: ₹${before.price} -> ₹${plan.price}, active ${before.active} -> ${plan.active}`);
        broadcast('plans');
        res.json({ success: true, plan });
    } catch (e) {
        console.error('plans update:', e);
        res.status(500).json({ success: false, message: 'Could not update the plan.' });
    }
});

router.delete('/:planId', async (req, res) => {
    try {
        const planId = String(req.params.planId);
        const plan = await Plan.findOne({ planId }).lean();
        if (!plan) return res.status(404).json({ success: false, message: 'Plan not found.' });
        if (plan.active && (await wouldLeaveNoActive(planId))) {
            return res.status(400).json({ success: false, message: 'This is the only active plan. Add another plan first, then delete this one.' });
        }
        await Plan.deleteOne({ planId });
        console.log(`[plans] ${req.adminEmail} deleted ${planId} (${plan.name})`);
        broadcast('plans');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not delete the plan.' }); }
});

module.exports = router;
