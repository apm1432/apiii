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
    type: String, // FingerprintJS visitorId
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
