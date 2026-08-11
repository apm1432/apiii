const mongoose = require('mongoose');
require('dotenv').config();
const Question = require('./models/Question');

async function run() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const q = await Question.findOne();
        console.log("Keys:", Object.keys(q._doc));
        console.log("Text:", q.text);
        if (q.text_eng) console.log("Text Eng:", q.text_eng);
        console.log("Options:", q.options);
        if (q.options_eng) console.log("Options Eng:", q.options_eng);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
run();
