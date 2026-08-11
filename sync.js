require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Question = require('./models/Question');

async function syncData() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected.');

    console.log('Reading JSON file...');
    const jsonPath = path.join(__dirname, 'FINAL_ENRICHED_MPSC_QUESTIONS.json');
    const rawData = fs.readFileSync(jsonPath, 'utf8');
    const examsData = JSON.parse(rawData);
    
    console.log('Clearing old questions (if any) to prevent duplicates...');
    await Question.deleteMany({});
    
    const questionsToInsert = [];
    
    // Parse through the JSON structure: { "Exam Name": [ {q1}, {q2} ] }
    for (const [examName, questions] of Object.entries(examsData)) {
      for (const q of questions) {
        questionsToInsert.push({
          qnum: q.qnum,
          text: q.text,
          text_eng: q.text_eng,
          options: q.options,
          options_eng: q.options_eng,
          has_diagram_or_passage: q.has_diagram_or_passage,
          final_answer_key: q.final_answer_key,
          exam_set: q.exam_set,
          toppers_explanation_marathi: q.toppers_explanation_marathi,
          correct_answer_option: q.correct_answer_option,
          subject: q.subject,
          topic: q.topic,
          sub_topic: q.sub_topic,
          year_exam: examName // Add the exam name context
        });
      }
    }

    console.log(`Inserting ${questionsToInsert.length} questions into MongoDB...`);
    // Insert in batches of 1000 to prevent RAM spikes
    const batchSize = 1000;
    for (let i = 0; i < questionsToInsert.length; i += batchSize) {
      const batch = questionsToInsert.slice(i, i + batchSize);
      await Question.insertMany(batch);
      console.log(`Inserted ${i + batch.length} / ${questionsToInsert.length}`);
    }

    console.log('✅ Data Sync Completed Successfully!');
  } catch (error) {
    console.error('❌ Error syncing data:', error);
  } finally {
    mongoose.connection.close();
  }
}

syncData();
