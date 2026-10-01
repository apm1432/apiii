require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Razorpay = require('razorpay');
const { startAdminBot, stopAdminBot } = require('./admin_bot');

const app = express();
const PORT = process.env.PORT || 8000;

// Koyeb edge -> nginx -> Node: 2 proxy hops. Needed so express-rate-limit
// reads the real client IP from X-Forwarded-For (fixes ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
// Override with TRUST_PROXY env if the number of hops changes.
app.set('trust proxy', parseInt(process.env.TRUST_PROXY || '2', 10));

process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));

// Security Middleware: Hide Express X-Powered-By Header
app.disable('x-powered-by');

app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Database Connection
mongoose.connect(process.env.MONGO_URI)
.then(() => {
    console.log('✅ MongoDB Connected Successfully!');
    // Start Telegram Admin Bot
    startAdminBot();
    // Preload heavy aggregations into memory immediately on startup
    const apiModule = require('./routes/api');
    if(apiModule.preloadHierarchy) {
        apiModule.preloadHierarchy();
    }
})
.catch(err => console.error('❌ MongoDB Connection Error:', err));

// Serve Static Frontend UI
app.use(express.static('public'));

// API Routes
const apiModule = require('./routes/api');
app.use('/api', apiModule.router);

const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

const server = app.listen(PORT, () => {
  console.log(`🚀 Secure Server running on port ${PORT}`);
});

// Release the Telegram polling slot on redeploy so the new instance doesn't get 409 Conflict
async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  try { await stopAdminBot(); } catch (e) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
