const mongoose = require('mongoose');

// One document per Razorpay payment. The unique paymentId makes every payment apply EXACTLY ONCE,
// no matter how many times the browser (verify) or Razorpay (webhook retries) report it.
const paymentSchema = new mongoose.Schema({
  paymentId:   { type: String, required: true, unique: true },
  orderId:     { type: String, index: true },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  planId:      { type: String, required: true },
  amountPaise: { type: Number, required: true },
  source:      { type: String, default: 'verify' }, // 'verify' (browser) or 'webhook'
  applied:     { type: Boolean, default: false },
  appliedAt:   { type: Date, default: null },
  createdAt:   { type: Date, default: Date.now }
});

module.exports = mongoose.model('Payment', paymentSchema);
