const mongoose = require('mongoose');
require('dotenv').config();
const Question = require('./models/Question');

async function run() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to MongoDB.");
        
        const q = await Question.findOne();
        if (!q) {
            console.log("No questions found.");
            process.exit(0);
        }
        
        console.log("Testing with year_exam:", q.year_exam);
        let questions = await Question.find({ year_exam: q.year_exam }).lean();
        console.log("Found", questions.length, "questions. Sorting...");
        
        questions.sort((a, b) => (a.qnum || 0) - (b.qnum || 0));
        console.log("Sort done.");
        
        const payloadStr = JSON.stringify({ success: true, count: questions.length, data: questions });
        console.log("Payload size:", (payloadStr.length / 1024 / 1024).toFixed(2), "MB");
        
    } catch (e) {
        console.error("Test failed:", e);
    } finally {
        process.exit(0);
    }
}
run();
