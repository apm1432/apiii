require('dotenv').config();
const { sendEmail } = require('./utils/smtpService');
const mongoose = require('mongoose');
const User = require('./models/User');

async function test() {
    await mongoose.connect(process.env.MONGO_URI);
    const user = await User.findOne({ email: 'sarthak.k1809@gmail.com' });
    if (!user) {
        console.log('User not found');
        return;
    }
    console.log('User SMTP:', user.smtp_user);
    try {
        await sendEmail(user.smtp_user, user.email, 'Test', 'Test', '<h1>Test</h1>');
        console.log('Email sent!');
    } catch(e) {
        console.error('Email failed:', e);
    }
    process.exit();
}
test();
