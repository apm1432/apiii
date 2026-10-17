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
  original_image_backup: { type: mongoose.Schema.Types.Mixed }, // the image the question had before an admin replaced it (for "reset")
  extra_images: { type: [mongoose.Schema.Types.Mixed], default: undefined }, // more page images of the same question (admin added)
  telegram_msg_id: { type: Number }, // Optional Message ID from Telegram
  year_exam: { type: String, index: true }, // e.g., "2018 group b pre" or official name + date
  official_exam_name: { type: String, index: true },
  exam_date: { type: String },
  diagram_description: { type: String },
  options_explanation: [{ type: String }],
  passage_marathi: { type: String },
  passage_english: { type: String },
  passage_text: { type: String },
  // ---- official answer key (written by auto_exam.py) ----
  official_answer_key: { type: mongoose.Schema.Types.Mixed },      // image ref {botIdx: fileId} of the official answer-key page for this question ('' = none)
  official_answer_key_answers: { type: String },                   // answer according to the official key: '1'..'4', '1/3' (more than one accepted) or '#' (cancelled)
  answer_key_image_url: { type: mongoose.Schema.Types.Mixed },     // same page as official_answer_key
  answer_key_images: { type: [mongoose.Schema.Types.Mixed], default: undefined }, // every page of the official key
  ai_answer_option: { type: String },                              // the AI's own answer (kept when the official key overrides it)
  answer_source: { type: String },                                 // 'official' | 'ai' = where correct_answer_option (the answer shown on the site) came from
  explanation_answer: { type: String },                            // option the explanation was written for
  answer_flags: { type: mongoose.Schema.Types.Mixed },
  is_ai_fixed: { type: Boolean, default: false },
  ai_fixed_at: { type: Date }
});

module.exports = mongoose.model('Question', questionSchema);
