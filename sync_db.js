const mongoose = require('mongoose');
const fs = require('fs');
require('dotenv').config();

const Question = require('./models/Question'); // Adjust path if needed

async function syncDb() {
    try {
        console.log("Connecting to MongoDB...");
        await mongoose.connect(process.env.MONGO_URI);
        
        console.log("Reading JSON file...");
        const rawData = fs.readFileSync('FINAL_ENRICHED_MPSC_QUESTIONS.json', 'utf8');
        const parsed = JSON.parse(rawData);
        
        console.log("Reading image mapping...");
        let imageMapping = {};
        if (fs.existsSync('image_mapping.json')) {
            imageMapping = JSON.parse(fs.readFileSync('image_mapping.json', 'utf8'));
        }

        let data = [];
        if (!Array.isArray(parsed)) {
            // It's a dictionary of { exam_set: [questions] }
            for (const [examName, questions] of Object.entries(parsed)) {
                for (const q of questions) {
                    q.year_exam = examName;
                    if (q._originalFilePath) {
                        const fileId = imageMapping[q._originalFilePath];
                        if (fileId) {
                            q.original_image_url = `/api/image/${fileId}`;
                        } else {
                            q.original_image_url = q._originalFilePath;
                        }
                    }
                    data.push(q);
                }
            }
        } else {
            data = parsed;
        }
        
        console.log(`Found ${data.length} questions in JSON.`);
        
        console.log("Clearing old questions collection...");
        await Question.deleteMany({});
        
        console.log("Inserting new questions...");
        // Use insertMany for bulk insert
        const result = await Question.insertMany(data, { ordered: false });
        console.log(`Successfully inserted ${result.length} questions!`);
        
    } catch (err) {
        console.error("Error during sync:", err);
    } finally {
        mongoose.connection.close();
        console.log("Done.");
        process.exit(0);
    }
}

syncDb();
