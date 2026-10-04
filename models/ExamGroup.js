const mongoose = require('mongoose');

// An admin-made group of exam papers (e.g. "MPSC Group A"). It becomes a tab on the dashboard.
// `exams` holds the paper names exactly as stored in Question.year_exam. A paper may be in several groups.
const examGroupSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true, maxlength: 60 },
  exams:     [{ type: String }],
  order:     { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ExamGroup', examGroupSchema);
