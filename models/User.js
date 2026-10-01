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
    type: String, // FingerprintJS visitorId (used only when browserLocked = true)
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
  },

  // ── Admin-controlled browser/device lock ──
  browserLocked: {
    type: Boolean,
    default: false   // Only lock when admin explicitly enables it
  },

  // ── Single-device session enforcement ──
  // Incremented on logout or forced-logout; tokens carrying old version become invalid
  tokenVersion: {
    type: Number,
    default: 0
  },
  // The deviceId of the currently active session (null = no active session)
  activeDeviceId: {
    type: String,
    default: null
  },

  // ── Admin-controlled access limit ──
  maxDevices: {
    type: Number,
    default: 1   // Default: only 1 device at a time
  }
});

module.exports = mongoose.model('User', userSchema);
