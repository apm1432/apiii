require('dotenv').config();
const mongoose = require('mongoose');

async function testConnection() {
  try {
    console.log('Testing MongoDB Connection with provided URI...');
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000
    });
    console.log('✅ Connection Successful! Verified.');
  } catch (error) {
    console.error('❌ Connection Failed:', error.message);
  } finally {
    await mongoose.connection.close();
  }
}

testConnection();
