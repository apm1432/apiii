const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema({
  qnum: { type: Number },
  text: { type: String, required: true },
  text_eng: { type: String },
  options: [{ type: String }],
  options_eng: [{ type: String }],
  has_diagram_or_passage: { type: Boolean, default: false },
  final_answer_key: { type: String },
  exam_set: { type: String },
  toppers_explanation_marathi: { type: String },
  correct_answer_option: { type: String },
  subject: { type: String, index: true },
  topic: { type: String, index: true },
  sub_topic: { type: String },
  original_image_url: { type: String }, // Telegram Image URL
  year_exam: { type: String, index: true }, // e.g., "2018 group b pre"
  passage_marathi: { type: String },
  passage_english: { type: String }
});

module.exports = mongoose.model('Question', questionSchema);
