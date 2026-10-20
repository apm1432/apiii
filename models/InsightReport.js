const mongoose = require('mongoose');

// The last AI coach report of a student (so opening the tab again costs no AI quota).
const insightReportSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  sig:      { type: String },                  // fingerprint of the stats the report was written for
  report:   { type: mongoose.Schema.Types.Mixed },
  provider: { type: String },
  byScope:  { type: mongoose.Schema.Types.Mixed },   // reports of the exam groups: { 'g:<group id>': { sig, report, provider, createdAt } } (the fields above = scope "all")
  makeCount: { type: Number, default: 0 },     // reports made today (daily limit)
  makeDay:   { type: String },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

module.exports = mongoose.model('InsightReport', insightReportSchema);
