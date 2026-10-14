const mongoose = require('mongoose');

// One document per user: the student's own notes, in the order they added them.
const userNotesSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    notes: [{
        _id: false,
        id: { type: String, required: true },      // created by the browser (makes retries idempotent)
        text: { type: String, required: true },
        src: { type: String, default: '' },        // small tag, e.g. "Q12"
        ts: { type: Number, default: 0 }
    }]
}, { timestamps: true });

module.exports = mongoose.model('UserNotes', userNotesSchema);
