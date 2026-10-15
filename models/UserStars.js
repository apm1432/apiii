const mongoose = require('mongoose');

// One document per user: the questions the student starred for revision, in the order they were starred,
// plus the answers of the separate "Starred Questions" attempt.
// These answers are NOT the same as Progress.answers - resetting / answering here never touches the real exam progress.
const userStarsSchema = new mongoose.Schema({
    userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    ids:     [{ type: String }],                                   // Question _id (24 hex), oldest star first
    answers: { type: Map, of: Object, default: {} }                // questionId -> { selected, isCorrect, isCancelled, section }
}, { timestamps: true });

module.exports = mongoose.model('UserStars', userStarsSchema);
