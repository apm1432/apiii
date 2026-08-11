const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { JWT_SECRET } = require('../middleware/auth');
const { assignSmtpToUser, sendEmail } = require('../utils/smtpService');

// REGISTER
router.post('/register', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password are required' });
        }

        // Check if user exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'User already exists' });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({
            email,
            password: hashedPassword
        });

        await newUser.save();

        // Send Welcome Email
        try {
            const smtpUser = assignSmtpToUser();
            const subject = "Welcome to MPSC PYQ Tracker!";
            const html = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
                    <h2 style="color: #2563eb; text-align: center;">Welcome to MPSC PYQ Tracker</h2>
                    <p>Hello,</p>
                    <p>Thank you for registering on <strong>MPSC PYQ Tracker</strong>. You have taken the first step towards a structured and focused preparation!</p>
                    <div style="background-color: #f3f4f6; padding: 15px; border-radius: 5px; margin: 20px 0;">
                        <p style="margin: 0;"><strong>Your Login Credentials:</strong></p>
                        <p style="margin: 5px 0 0 0;"><strong>User ID (Email):</strong> ${email}</p>
                        <p style="margin: 5px 0 0 0;"><strong>Password:</strong> ${password}</p>
                    </div>
                    <p>Log in to access thousands of previous year questions with detailed explanations.</p>
                    <div style="text-align: center; margin-top: 20px;">
                        <a href="https://apiii-apm1432.koyeb.app" style="background-color: #2563eb; color: white; text-decoration: none; padding: 10px 20px; border-radius: 5px; font-weight: bold;">Login Now</a>
                    </div>
                    <p style="margin-top: 20px; font-size: 12px; color: #777;">If you did not create this account, please ignore this email.</p>
                </div>
            `;
            const text = "Welcome to MPSC PYQ Tracker! Thank you for registering.";
            
            // Fire and forget (don't block registration response)
            sendEmail(smtpUser, email, subject, text, html).catch(err => {
                console.error("Failed to send welcome email:", err.message);
            });
        } catch (emailErr) {
            console.error("Email setup failed:", emailErr);
        }

        res.json({ success: true, message: 'Registration successful! Please login.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error during registration' });
    }
});

// LOGIN
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password are required' });
        }

        // Check user
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid credentials' });
        }

        // Validate password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Invalid credentials' });
        }

        // Generate JWT
        const token = jwt.sign(
            { id: user._id, email: user.email, isSubscribed: user.isSubscribed },
            JWT_SECRET,
            { expiresIn: '7d' } // Token valid for 7 days
        );

        res.json({ 
            success: true, 
            message: 'Login successful',
            token,
            user: { 
                email: user.email, 
                isSubscribed: user.isSubscribed,
                subscriptionPlan: user.subscriptionPlan,
                subscriptionExpiry: user.subscriptionExpiry
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error during login' });
    }
});

module.exports = router;
