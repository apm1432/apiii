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
  assignedSmtp: {
    type: String, // The SMTP connection string assigned to this user
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('User', userSchema);
