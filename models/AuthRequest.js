const mongoose = require('mongoose');

// Short-lived requests that are completed from the Telegram bot (/start <token>):
//  - reset   : forgot password via Telegram (new password already chosen on the website)
//  - recover : "get my old User ID" for someone who tries to register again from the same device
// Auto-deleted 15 minutes after creation.
const authRequestSchema = new mongoose.Schema({
  type:            { type: String, enum: ['reset', 'recover'], required: true },
  tgToken:         { type: String, required: true, unique: true },
  userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  newPasswordHash: { type: String, default: null },
  // reset only: must be true before a Telegram account can be LINKED to an email-registered user
  emailVerified:   { type: Boolean, default: false },
  otpHash:         { type: String, default: null },
  otpExpiry:       { type: Date, default: null },
  otpAttempts:     { type: Number, default: 0 },
  otpSentAt:       { type: Date, default: null },
  status:          { type: String, enum: ['pending', 'done', 'failed'], default: 'pending' },
  failReason:      { type: String, default: null },
  createdAt:       { type: Date, default: Date.now, expires: 15 * 60 }
});

module.exports = mongoose.model('AuthRequest', authRequestSchema);
