const mongoose = require('mongoose');

// One uploaded official answer-key PDF (admin tool: "Official Answer Key").
//  sets   : { A: { "1": "2", "2": "1/3", "3": "#" }, B: {...} }   answers use the site format: '1'..'4', '1/3', '#'
//  pages  : { A: { "1": 2 } }   page of the PDF where that answer was read (-> which page image a question shows)
//  images : the PDF pages rendered as JPEG and uploaded to the Telegram channel. `ref` is the same {botIdx: fileId}
//           object the site already uses for question images, `messageId` is the Telegram message id.
const answerKeySchema = new mongoose.Schema({
  fileName: { type: String },
  examId: { type: String, index: true },          // exam (year_exam) the admin picked at upload time (may be changed later)
  status: { type: String, enum: ['processing', 'ready', 'failed', 'applied'], default: 'processing' },
  progress: { type: String, default: '' },
  error: { type: String },
  pageCount: { type: Number, default: 0 },
  sets: { type: mongoose.Schema.Types.Mixed, default: {} },
  pages: { type: mongoose.Schema.Types.Mixed, default: {} },
  verification: { type: mongoose.Schema.Types.Mixed },   // { engines:[...], perSet:{...}, conflicts:[...], onlyOne:[...] }
  images: [{ _id: false, page: Number, ref: mongoose.Schema.Types.Mixed, messageId: Number, chatId: String }],
  pdf: { _id: false, ref: mongoose.Schema.Types.Mixed, messageId: Number, chatId: String },
  appliedSet: { type: String },
  appliedExam: { type: String },
  appliedAt: { type: Date },
  appliedCount: { type: Number }
}, { timestamps: true });

module.exports = mongoose.model('AnswerKey', answerKeySchema);
