const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String, // In a real app, this should be hashed
    required: true
  },
  emailNormalized: {
    type: String, // gmail with dots/+alias removed - used only to block duplicate signups
    unique: true,
    sparse: true
  },
  telegramId: {
    type: String, // Telegram account that verified this user (one account = one registration)
    unique: true,
    sparse: true
  },
  subscriptionPlan: {
    type: String,
    default: null
  },
  isSubscribed: {
    type: Boolean,
    default: false
  },
  isAdmin: {
    type: Boolean,
    default: false
  },
  subscriptionExpiry: {
    type: Date,
    default: null
  },
  assignedSmtp: {
    type: String, // The SMTP connection string assigned to this user
    default: null
  },
  hasUsedFreeTrial: {
    type: Boolean,
    default: false
  },
  deviceId: {
    type: String, // browser id the account is bound to (used only when deviceLockEnabled)
    default: null
  },
  deviceLockEnabled: {
    type: Boolean, // set ONLY by admin (Telegram bot). false = user may login from any browser
    default: false
  },
  sessionId: {
    type: String, // id of the one active login session; a new login replaces it
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  resetOtp: {
    type: String,
    default: null
  },
  resetOtpExpiry: {
    type: Date,
    default: null
  }
});

module.exports = mongoose.model('User', userSchema);
