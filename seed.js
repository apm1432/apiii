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
        if (Array.isArray(rawData)) {
            questions = rawData;
        } else {
            for (const key in rawData) {
                if (Array.isArray(rawData[key])) {
                    let unifiedName = key;
                    const firstQ = rawData[key].find(q => q.official_exam_name);
                    if (firstQ) {
                        let baseName = firstQ.official_exam_name.replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
                        if (firstQ.exam_date) baseName += ` (${firstQ.exam_date.trim()})`;
                        
                        let paperMatch = key.match(/paper[- _]*no\.?[- _]*[iv\d]+|paper[- _]*[iv\d]+/i);
                        if (paperMatch) {
                            if (!baseName.toLowerCase().includes('paper')) {
                                baseName += ` - ${paperMatch[0]}`;
                            }
                        }
                        unifiedName = baseName;
                    }

                    const arr = rawData[key].map(q => {
                        q.year_exam = unifiedName;
                        q.official_exam_name = unifiedName;
                        return q;
                    });
                    questions = questions.concat(arr);
                }
            }
        }
        
        const mappingPath = path.join(__dirname, 'image_mapping.json');
        let imageMapping = {};
        if (fs.existsSync(mappingPath)) {
            imageMapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        }

        // Deduplicate questions by exam name and qnum
        const uniqueQuestionsMap = new Map();
        for (const q of questions) {
            const parsedQnum = q.qnum || q.q_num || 0;
            const examName = q.official_exam_name || 'Unknown Exam';
            const uniqueKey = `${examName}_${parsedQnum}`;
            
            if (!uniqueQuestionsMap.has(uniqueKey)) {
                uniqueQuestionsMap.set(uniqueKey, q);
            }
        }
        questions = Array.from(uniqueQuestionsMap.values());

        console.log(`Loaded ${questions.length} unique questions. Starting insert...`);
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
                original_image_url: q.original_image_url || finalImage || null,
                official_exam_name: q.official_exam_name || 'Unknown Exam',
                exam_date: q.exam_date || '',
                year_exam: q.year_exam || 'Unknown Exam',
                diagram_description: q.diagram_description || null,
                options_explanation: Array.isArray(q.options_explanation) 
                    ? q.options_explanation.map(opt => typeof opt === 'object' ? (opt.explanation || JSON.stringify(opt)) : String(opt))
                    : (typeof q.options_explanation === 'object' && q.options_explanation !== null 
                        ? Object.values(q.options_explanation).map(opt => String(opt))
                        : (typeof q.options_explanation === 'string' ? [q.options_explanation] : [])),
                passage_text: q.passage_text || q.passage_marathi || null
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
