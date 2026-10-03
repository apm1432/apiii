const mongoose = require('mongoose');

// Holds a registration until the email OTP / Telegram verification succeeds.
// Auto-deleted by MongoDB 15 minutes after creation (TTL index).
const pendingSchema = new mongoose.Schema({
  email:           { type: String, required: true },
  emailNormalized: { type: String, required: true, index: true },
  passwordHash:    { type: String, required: true }, // bcrypt hash, never plain text
  deviceId:        { type: String, default: null },
  // 16 char token: used as the Telegram deep-link payload AND as the browser's session key
  tgToken:         { type: String, required: true, unique: true },
  otpHash:         { type: String, default: null },
  otpExpiry:       { type: Date, default: null },
  otpAttempts:     { type: Number, default: 0 },
  otpSentAt:       { type: Date, default: null },
  status:          { type: String, enum: ['pending', 'done', 'failed'], default: 'pending' },
  failReason:      { type: String, default: null },
  createdAt:       { type: Date, default: Date.now, expires: 15 * 60 }
});

module.exports = mongoose.model('PendingRegistration', pendingSchema);
