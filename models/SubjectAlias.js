const mongoose = require('mongoose');

// An admin decision "these subject names are the SAME subject".
// `from` = a subject name exactly as stored on questions (any spelling), `to` = the name it must be shown as.
// Nothing on the questions is rewritten: the website maps names while reading, so a merge can always be undone.
const subjectAliasSchema = new mongoose.Schema({
  from:      { type: String, required: true, trim: true, maxlength: 200 },
  key:       { type: String, required: true, unique: true },   // normalised `from` (case / spaces / punctuation removed) - one rule per spelling
  to:        { type: String, required: true, trim: true, maxlength: 200 },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

module.exports = mongoose.model('SubjectAlias', subjectAliasSchema);
