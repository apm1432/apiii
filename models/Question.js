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
  original_image_url: { type: mongoose.Schema.Types.Mixed }, // Map of Token Index -> File ID
  telegram_msg_id: { type: Number }, // Optional Message ID from Telegram
  year_exam: { type: String, index: true }, // e.g., "2018 group b pre" or official name + date
  official_exam_name: { type: String, index: true },
  exam_date: { type: String },
  diagram_description: { type: String },
  options_explanation: [{ type: String }],
  passage_marathi: { type: String },
  passage_english: { type: String },
  passage_text: { type: String },
  is_ai_fixed: { type: Boolean, default: false },
  ai_fixed_at: { type: Date }
});

module.exports = mongoose.model('Question', questionSchema);
