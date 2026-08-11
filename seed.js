require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Question = require('./models/Question'); 

async function seedDB() {
    try {
        const mongoURI = process.env.MONGO_URI;
        if (!mongoURI) {
            console.error("No MONGO_URI in .env");
            process.exit(1);
        }

        await mongoose.connect(mongoURI);
        console.log("Connected to MongoDB for Seeding...");

        const dataPath = path.join(__dirname, 'FINAL_ENRICHED_MPSC_QUESTIONS.json');
        const rawData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        
        let questions = [];
        for (const examKey in rawData) {
            const arr = rawData[examKey];
            if (Array.isArray(arr)) {
                arr.forEach(q => {
                    q._examKey = examKey;
                    questions.push(q);
                });
            }
        }
        
        const mappingPath = path.join(__dirname, 'image_mapping.json');
        let imageMapping = {};
        if (fs.existsSync(mappingPath)) {
            imageMapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        }

        console.log(`Loaded ${questions.length} questions. Starting insert...`);
        await Question.deleteMany({});
        console.log("Cleared existing questions from DB.");

        const bulkOps = [];
        let missingImagesCount = 0;

        for (const q of questions) {
            let extractedExam = q._examKey;
            
            let finalImage = null; 
            if (q._originalFilePath && imageMapping[q._originalFilePath]) {
                finalImage = imageMapping[q._originalFilePath];
            } else if (q._originalFilePath) {
                missingImagesCount++;
            }

            const doc = {
                qnum: q.qnum || q.q_num,
                text: q.text || q.original_marathi || 'N/A',
                text_eng: q.text_eng || q.translated_english || '',
                options: q.options || [],
                options_eng: q.options_eng || [],
                has_diagram_or_passage: q.has_diagram_or_passage || false,
                final_answer_key: q.final_answer_key || q.answer_key || '1',
                exam_set: q.exam_set || '',
                toppers_explanation_marathi: q.toppers_explanation_marathi || q.explanation || '',
                correct_answer_option: q.correct_answer_option || q.answer_key || '1',
                subject: q.subject || extractedExam,
                topic: q.topic || 'General',
                sub_topic: q.sub_topic || '',
                original_image_url: finalImage,
                year_exam: q._examKey
            };

            bulkOps.push(doc);
        }

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
