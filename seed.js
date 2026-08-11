require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Question = require('./models/Question'); // Adjust path if needed

async function seedDB() {
    try {
        const mongoURI = process.env.MONGO_URI;
        if (!mongoURI) {
            console.error("No MONGO_URI in .env");
            process.exit(1);
        }

        await mongoose.connect(mongoURI, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        console.log("Connected to MongoDB for Seeding...");

        // Load Questions
        const dataPath = path.join(__dirname, 'FINAL_ENRICHED_MPSC_QUESTIONS.json');
        const questions = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        
        // Load Image Mapping if available (from Telegram upload)
        const mappingPath = path.join(__dirname, 'image_mapping.json');
        let imageMapping = {};
        if (fs.existsSync(mappingPath)) {
            imageMapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        }

        console.log(`Loaded ${questions.length} questions. Starting insert...`);

        // Clear existing questions? Optional, but good for a fresh seed.
        await Question.deleteMany({});
        console.log("Cleared existing questions from DB.");

        const bulkOps = [];
        let missingImagesCount = 0;

        for (const q of questions) {
            // Apply Telegram image URL if mapping exists
            let finalImage = q.question_image || null; // Could be local path
            if (q._originalFilePath && imageMapping[q._originalFilePath]) {
                const fileId = imageMapping[q._originalFilePath];
                // For a web app, a direct Telegram file_id isn't directly routable via HTTP without a bot proxy.
                // However, if the user requested to save images with detail in ctg channel,
                // and the bot uploads them, we store the fileId.
                // Or maybe they just wanted the fileId stored. Let's store it.
                finalImage = `tg://resolve?domain=YOUR_CHANNEL&post=${fileId}`; // Or just the fileId
                // Let's store just the fileId or the original URL based on what they had.
                finalImage = fileId;
            } else if (q._originalFilePath) {
                missingImagesCount++;
            }

            // Fallbacks for missing fields based on model schema
            const doc = {
                year: q.year || 'Unknown',
                examName: q.exam_name || 'MPSC',
                subject: q.subject || 'General Studies',
                topic: q.topic || 'General',
                subTopic: q.sub_topic || '',
                originalMarathi: q.original_marathi || '',
                translatedEnglish: q.translated_english || '',
                questionImage: finalImage,
                option1: q.option_1 || 'A',
                option2: q.option_2 || 'B',
                option3: q.option_3 || 'C',
                option4: q.option_4 || 'D',
                answerKey: q.answer_key || '1',
                explanation: q.explanation || ''
            };

            // Using insertMany for speed instead of bulkWrite if it's simpler
            bulkOps.push(doc);
        }

        // Insert in chunks of 1000 to avoid out of memory
        const chunkSize = 1000;
        let inserted = 0;
        for (let i = 0; i < bulkOps.length; i += chunkSize) {
            const chunk = bulkOps.slice(i, i + chunkSize);
            await Question.insertMany(chunk);
            inserted += chunk.length;
            console.log(`Inserted ${inserted}/${bulkOps.length} questions...`);
        }

        console.log(`Seed Complete! Total Inserted: ${inserted}. Missing images mapping: ${missingImagesCount}`);
        process.exit(0);

    } catch (err) {
        console.error("Seeding Error:", err);
        process.exit(1);
    }
}

seedDB();
