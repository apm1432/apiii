const Payment = require('../models/Payment');
const User = require('../models/User');
const { notifyUser } = require('./userEvents');

// Single source of truth for the plans (price in rupees + duration)
const PLANS = {
    '1_month': { price: 50, days: 30 },
    '2_years': { price: 100, years: 2 }
};

const fail = (message, code) => Object.assign(new Error(message), { code });

function addDuration(base, plan) {
    const d = new Date(base);
    if (plan.days) d.setDate(d.getDate() + plan.days);
    if (plan.years) d.setFullYear(d.getFullYear() + plan.years);
    return d;
}

/**
 * Gives the user the plan they paid for - exactly once per paymentId.
 * Used by BOTH the browser verification and the Razorpay webhook (whichever arrives first wins;
 * the second one is a harmless no-op).
 *  - plan + user come from the Razorpay ORDER (server side), never from the browser
 *  - the paid amount must match the plan price
 *  - days that are still left are kept (new expiry = later of "now" and the current expiry, plus the plan)
 */
async function applyPayment({ paymentId, orderId, userId, planId, amountPaise, source }) {
    const plan = PLANS[planId];
    if (!plan) throw fail('Unknown plan', 'BAD_PLAN');
    if (Number(amountPaise) !== plan.price * 100) throw fail('Paid amount does not match the plan', 'BAD_AMOUNT');
    if (!paymentId || !userId) throw fail('Missing payment details', 'BAD_INPUT');

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

module.exports = { PLANS, applyPayment };
