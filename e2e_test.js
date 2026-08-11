const axios = require('axios');
const mongoose = require('mongoose');
const User = require('./models/User');
require('dotenv').config();

async function runTest() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        
        console.log("1. Registering user...");
        const email = `testuser_${Date.now()}@test.com`;
        const reg = await axios.post('http://localhost:3000/api/auth/register', { email, password: 'password123' });
        console.log("Reg result:", reg.data);

        console.log("2. Logging in...");
        const login = await axios.post('http://localhost:3000/api/auth/login', { email, password: 'password123' });
        console.log("Login result:", login.data.success);
        const token = login.data.token;
        const userDoc = await User.findOne({ email });
        const userId = userDoc._id;

        console.log("3. Forcing subscription (simulating webhook)...");
        await User.findByIdAndUpdate(userId, { 
            isSubscribed: true, 
            subscriptionExpiry: new Date(Date.now() + 86400000) 
        });
        
        console.log("4. Fetching Dashboard Hierarchy...");
        const dash = await axios.get('http://localhost:3000/api/exams/hierarchy');
        console.log("Hierarchy length:", dash.data.data.length);
        const firstExam = dash.data.data[0];
        const yearExam = firstExam._id;
        const subject = firstExam.exams[0].subject;
        console.log("Selected Exam:", yearExam, subject);

        console.log("5. Fetching Questions...");
        const qRes = await axios.post('http://localhost:3000/api/questions', {
            year_exam: yearExam,
            subject: subject
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log("Questions fetched:", qRes.data.count);
        if (qRes.data.count > 0) {
            console.log("First question preview:", qRes.data.data[0].text.substring(0, 50));
        }

        console.log("6. Saving Progress...");
        const pRes = await axios.post('http://localhost:3000/api/progress/save', {
            questionId: qRes.data.data[0]._id,
            isCorrect: true,
            section: subject
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log("Progress saved:", pRes.data.success);

        console.log("✅ ALL TESTS PASSED LIKE A REAL USER!");
        process.exit(0);
    } catch (err) {
        console.error("Test Failed!", err.response ? err.response.data : err.message);
        process.exit(1);
    }
}

runTest();
