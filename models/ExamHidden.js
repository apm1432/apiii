const mongoose = require('mongoose');

// One document per exam paper that the admin hid from the website.
const examHiddenSchema = new mongoose.Schema({
  examId:   { type: String, required: true, unique: true }, // Question.year_exam
  hiddenAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ExamHidden', examHiddenSchema);
