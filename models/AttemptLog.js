const mongoose = require('mongoose');

// Append-only history: ONE row for every answer a student gives (exam practice 'exam', starred attempt 'star',
// revision session 'revise'). Progress.answers keeps only the CURRENT answer of a question (and is wiped by "Reset"),
// so this log is what makes real trends possible: accuracy per week, streaks, "was wrong -> now right".
// It is never read by the normal exam screens, so it cannot change how practice behaves.
const attemptLogSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  qid:       { type: String, required: true },
  exam:      { type: String },                 // Question.year_exam
  subject:   { type: String },
  topic:     { type: String },
  selected:  { type: Number },
  isCorrect: { type: Boolean, default: false },
  src:       { type: String, default: 'exam' }, // 'exam' | 'star' | 'revise'
  at:        { type: Date, default: Date.now }
}, { versionKey: false });

attemptLogSchema.index({ userId: 1, at: -1 });
attemptLogSchema.index({ userId: 1, qid: 1 });

module.exports = mongoose.model('AttemptLog', attemptLogSchema);
