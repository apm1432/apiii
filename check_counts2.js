require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Question = require('./models/Question');

async function checkCounts() {
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    
    console.log("=== JSON COUNTS ===");
    const rawData = JSON.parse(fs.readFileSync(path.join(__dirname, 'FINAL_ENRICHED_MPSC_QUESTIONS.json'), 'utf8'));
    let jsonCounts = {};
    let totalJson = 0;
    for (const key in rawData) {
        if (Array.isArray(rawData[key])) {
            jsonCounts[key] = rawData[key].length;
            totalJson += rawData[key].length;
        }
    }
    console.log(jsonCounts);
    console.log("Total JSON Questions:", totalJson);
    
    console.log("\n=== DB COUNTS ===");
    const dbCounts = await Question.aggregate([
        { $group: { _id: "$year_exam", count: { $sum: 1 } } }
    ]);
    let totalDb = 0;
    dbCounts.forEach(c => {
        console.log(`${c._id}: ${c.count}`);
        totalDb += c.count;
    });
    console.log("Total DB Questions:", totalDb);
    
    process.exit(0);
}
checkCounts();
