const mongoose = require('mongoose');

const progressSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  totalSolved: {
    type: Number,
    default: 0
  },
  totalCorrect: {
    type: Number,
    default: 0
  },
  sectionWise: {
    type: Map,
    of: {
      solved: Number,
      correct: Number
    },
    default: {}
  },
  lastSolvedQuestion: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Question'
  },
  answers: {
    type: Map,
    of: Object,
    default: {}
  }
}, { timestamps: true });

module.exports = mongoose.model('Progress', progressSchema);
