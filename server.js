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

// Basic security headers on every response (no extra package needed).
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');                       // the site cannot be put inside another site's iframe (clickjacking)
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
});

// CORS: the website is served from this same server, so it needs no CORS at all. If you have another site / app that calls
// this API, list it in the CORS_ORIGINS environment variable (comma separated). Not set = same behaviour as before (open).
const corsList = String(process.env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
app.use(cors(corsList.length ? { origin: corsList } : undefined));
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
    // first start after the plans feature: create the two old plans (₹50 / ₹100) so nothing changes for students
    require('./utils/payments').seedDefaultPlans();
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
// Static files: scripts / styles are versioned (?v=NN), so the phone may keep them for 30 days (repeat visits load instantly,
// even on a slow connection). index.html and anything without ?v= is re-checked every time (cheap 304 answer).
app.use((req, res, next) => {
    if (req.query && req.query.v && /\.(js|css)$/.test(req.path)) res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    next();
});
app.use(express.static('public', { etag: true, lastModified: true }));

// API Routes
const apiModule = require('./routes/api');
app.use('/api', apiModule.router);

const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

// Admin: subscription plans & pricing (add / edit price / duration / hide / delete)
app.use('/api/admin/plans', require('./routes/plans'));

// Admin: official answer key (PDF -> verified answers + page images on Telegram -> questions)
app.use('/api/admin/answer-key', require('./routes/answerkey'));

// Admin: add a NEW exam from PDFs (question paper + official answer key) -> review -> publish
app.use('/api/admin/exam-import', require('./routes/examimport'));

// Unknown /api URL -> JSON 404 ; bad JSON body / any crash -> short JSON error (never a stack trace)
app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Not found' }));
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err && (err.status || err.statusCode);
    if (status && status >= 400 && status < 500) return res.status(status).json({ success: false, message: status === 413 ? 'Request too large' : 'Bad request' });
    console.error('Unhandled error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
});

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
