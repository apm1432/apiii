const Payment = require('../models/Payment');
const User = require('../models/User');
const Plan = require('../models/Plan');
const { notifyUser } = require('./userEvents');

// Plans live in the database (admin edits them on the website). These two are only
//  (a) inserted ONCE when the plans collection is empty (so the site keeps working after this update), and
//  (b) a last-resort fallback for an old order that was created before plans moved to the database.
const DEFAULT_PLANS = [
    { planId: '1_month', name: '1 Month Access',  description: 'Full access to all MPSC PYQ papers.',   price: 50,  durationValue: 30, durationUnit: 'days',  sortOrder: 1 },
    { planId: '2_years', name: '2 Years Access',  description: 'Best Value! Uninterrupted access.',     price: 100, durationValue: 2,  durationUnit: 'years', sortOrder: 2, badge: 'Best Value' }
];

const fail = (message, code) => Object.assign(new Error(message), { code });
const toPaise = (rupees) => Math.round(Number(rupees) * 100);

async function seedDefaultPlans() {
    try {
        if ((await Plan.estimatedDocumentCount()) === 0) {
            await Plan.insertMany(DEFAULT_PLANS, { ordered: false });
            console.log('✅ Default subscription plans created (edit them from the admin panel).');
        }
    } catch (e) { console.error('seedDefaultPlans:', e.message); }
}

const publicPlan = (p) => ({
    planId: p.planId,
    name: p.name,
    description: p.description || '',
    price: p.price,
    originalPrice: p.originalPrice || null,
    durationValue: p.durationValue,
    durationUnit: p.durationUnit,
    badge: p.badge || ''
});

async function listActivePlans() {
    const rows = await Plan.find({ active: true }).sort({ sortOrder: 1, price: 1, createdAt: 1 }).lean();
    return rows.map(publicPlan);
}

async function getActivePlan(planId) {
    if (typeof planId !== 'string' || !/^[a-z0-9_-]{2,40}$/.test(planId)) return null;
    return Plan.findOne({ planId, active: true }).lean();
}

const UNITS = new Set(['days', 'months', 'years']);

// The facts we store on the Razorpay ORDER at creation time. Later (verify / webhook) the user gets exactly
// what was shown when they paid - even if the admin changed the price or deleted the plan in between.
function snapshotNotes(plan) {
    return {
        planId: plan.planId,
        planName: String(plan.name).slice(0, 60),
        pricePaise: String(toPaise(plan.price)),
        durationValue: String(plan.durationValue),
        durationUnit: plan.durationUnit
    };
}

function snapshotFromNotes(notes) {
    if (!notes) return null;
    const pricePaise = Number(notes.pricePaise), durationValue = Number(notes.durationValue);
    if (!Number.isInteger(pricePaise) || pricePaise < 100) return null;
    if (!Number.isInteger(durationValue) || durationValue < 1 || durationValue > 3650) return null;
    if (!UNITS.has(notes.durationUnit)) return null;
    return { pricePaise, durationValue, durationUnit: notes.durationUnit };
}

// adds days / months / years; "31 Jan + 1 month" becomes 28/29 Feb (not 3 Mar)
function addDuration(base, { durationValue, durationUnit }) {
    const d = new Date(base);
    if (durationUnit === 'days') { d.setDate(d.getDate() + durationValue); return d; }
    const day = d.getDate();
    d.setDate(1);
    if (durationUnit === 'months') d.setMonth(d.getMonth() + durationValue);
    else d.setFullYear(d.getFullYear() + durationValue);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return d;
}

async function resolvePlan(planId, snapshot) {
    if (snapshot) return snapshot;                                   // order created by the new code
    const p = await Plan.findOne({ planId }).lean();                  // order created by the OLD code (only planId in notes)
    if (p) return { pricePaise: toPaise(p.price), durationValue: p.durationValue, durationUnit: p.durationUnit };
    const d = DEFAULT_PLANS.find(x => x.planId === planId);
    if (d) return { pricePaise: toPaise(d.price), durationValue: d.durationValue, durationUnit: d.durationUnit };
    return null;
}

/**
 * Gives the user the plan they paid for - exactly once per paymentId.
 * Used by BOTH the browser verification and the Razorpay webhook (whichever arrives first wins;
 * the second one is a harmless no-op).
 *  - plan + user come from the Razorpay ORDER (server side), never from the browser
 *  - the paid amount must match the price that was on the order
 *  - days that are still left are kept (new expiry = later of "now" and the current expiry, plus the plan)
 */
async function applyPayment({ paymentId, orderId, userId, planId, amountPaise, source, notes }) {
    if (!paymentId || !userId) throw fail('Missing payment details', 'BAD_INPUT');
    const plan = await resolvePlan(planId, snapshotFromNotes(notes));
    if (!plan) throw fail('Unknown plan', 'BAD_PLAN');
    if (Number(amountPaise) !== plan.pricePaise) throw fail('Paid amount does not match the plan', 'BAD_AMOUNT');

    try {
        await Payment.create({ paymentId, orderId, userId, planId, amountPaise: Number(amountPaise), source, applied: false });
    } catch (e) {
        if (!e || e.code !== 11000) throw e; // 11000 = already registered by the other path
    }

    // atomic claim: only ONE caller can flip applied false -> true
    const claimed = await Payment.findOneAndUpdate(
        { paymentId, userId, applied: false },
        { applied: true, appliedAt: new Date() }
    );
    if (!claimed) {
        const user = await User.findById(userId);
        return { alreadyApplied: true, user };
    }

    try {
        const user = await User.findById(userId);
        if (!user) throw fail('User not found', 'NO_USER');
        const now = new Date();
        const stillActive = user.isSubscribed && user.subscriptionExpiry && new Date(user.subscriptionExpiry) > now;
        const expiry = addDuration(stillActive ? user.subscriptionExpiry : now, plan);

        user.isSubscribed = true;
        user.subscriptionPlan = planId;
        user.subscriptionExpiry = expiry;
        await user.save();

        notifyUser(user._id); // other tabs / devices of the user get the "Welcome" message instantly
        return { alreadyApplied: false, user };
    } catch (e) {
        // not applied -> allow a retry (browser or webhook)
        await Payment.updateOne({ paymentId }, { applied: false }).catch(() => {});
        throw e;
    }
}

module.exports = { applyPayment, seedDefaultPlans, listActivePlans, getActivePlan, snapshotNotes, addDuration, publicPlan, toPaise };
