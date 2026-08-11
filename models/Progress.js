const mongoose = require('mongoose');

const progressSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  questionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Question',
    required: true
  },
  isCorrect: {
    type: Boolean,
    required: true
  },
  attemptedAt: {
    type: Date,
    default: Date.now
  },
  section: {
    type: String, // Tracks where the user solved it from (e.g. "Year", "Subject", "Full Paper")
  }
});

// Create index for fast querying per user
progressSchema.index({ userId: 1, questionId: 1 }, { unique: true });

module.exports = mongoose.model('Progress', progressSchema);
