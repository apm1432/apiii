require('dotenv').config();
const mongoose = require('mongoose');
const Question = require('./models/Question');

mongoose.connect(process.env.MONGO_URI).then(async () => {
    const q = await Question.findOne({});
    console.log("Qnum:", q.qnum);
    console.log("Options explanation:", q.options_explanation);
    process.exit(0);
});
