const mongoose = require('mongoose');
const Progress = require('./models/Progress');
const User = require('./models/User');
const Question = require('./models/Question');
require('dotenv').config();

async function run() {
    await mongoose.connect(process.env.MONGO_URI);
    try {
        const user = await User.findOne();
        const question = await Question.findOne();
        const section = "Test Section";
        
        let progress = await Progress.findOne({ userId: user._id });
        if (!progress) {
            progress = new Progress({ userId: user._id, totalSolved: 0, totalCorrect: 0, sectionWise: new Map() });
        }
        
        progress.totalSolved += 1;
        progress.totalCorrect += 1;

        let secStats = progress.sectionWise.get(section) || { solved: 0, correct: 0 };
        secStats.solved += 1;
        secStats.correct += 1;
        progress.sectionWise.set(section, secStats);

        progress.lastSolvedQuestion = question._id;

        await progress.save();
        console.log("SUCCESS!");
    } catch (e) {
        console.error("ERROR:", e);
    }
    process.exit(0);
}
run();
