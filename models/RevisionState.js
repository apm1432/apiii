const mongoose = require('mongoose');

// Spaced-repetition state of ONE wrong question of ONE student (Leitner boxes).
// box 0 = just got it wrong / failed again, higher box = remembered for longer. nextDue = when it should come back.
// This is separate from Progress, so revising never changes the real exam progress.
const revisionStateSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  qid:      { type: String, required: true },
  box:      { type: Number, default: 0 },
  nextDue:  { type: Date, default: Date.now },
  seen:     { type: Number, default: 0 },
  lastResult: { type: Boolean, default: false },
  mastered: { type: Boolean, default: false },  // answered right in the top box -> leaves the queue
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });

revisionStateSchema.index({ userId: 1, qid: 1 }, { unique: true });
revisionStateSchema.index({ userId: 1, nextDue: 1 });

module.exports = mongoose.model('RevisionState', revisionStateSchema);
