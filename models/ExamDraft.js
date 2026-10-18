const mongoose = require('mongoose');

// A NEW exam paper that is being imported from PDFs (admin tool: "Add New Exam").
// Nothing here is visible to students. It becomes real Question documents only when the admin presses "Publish".
//  status    : processing -> review -> published   (or failed)
//  meta      : read from the first page of the question paper (all editable in the review screen)
//  pages     : every page of the question paper as an image on Telegram  { page, ref:{botIdx:fileId}, messageId, chatId }
//  questions : one object per question (see utils/examImport.js)  - editable / re-scannable one by one
//  key       : the verified official answer key  { sets, pages, verification, images, pdf, pageCount }
const examDraftSchema = new mongoose.Schema({
  status:   { type: String, enum: ['processing', 'review', 'published', 'failed'], default: 'processing' },
  progress: { type: String, default: '' },
  error:    { type: String },
  fileName: { type: String },
  keyFileName: { type: String },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },       // { officialName, examDate, examCode, paperName, paperSet, yearExam }
  pageCount: { type: Number, default: 0 },
  pages: { type: [mongoose.Schema.Types.Mixed], default: [] },
  questions: { type: [mongoose.Schema.Types.Mixed], default: [] },
  notes: { type: [String], default: [] },                          // plain-language warnings (missing numbers, failed pages ...)
  key: { type: mongoose.Schema.Types.Mixed },
  keySet: { type: String, default: '' },
  keyOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },  // { "12": "3" }  admin-confirmed official answers
  publishedExam: { type: String },
  publishedAt: { type: Date }
}, { timestamps: true, minimize: false });

module.exports = mongoose.model('ExamDraft', examDraftSchema);
