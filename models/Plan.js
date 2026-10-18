const mongoose = require('mongoose');

// A subscription plan that students can buy. Fully managed by the admin from the website
// (Dashboard -> "💰 Plans & Pricing"). No price or plan is hard-coded any more.
const planSchema = new mongoose.Schema({
  planId:        { type: String, required: true, unique: true, match: /^[a-z0-9_-]{2,40}$/ }, // never changes after creation
  name:          { type: String, required: true, trim: true, maxlength: 60 },
  description:   { type: String, default: '', trim: true, maxlength: 200 },
  price:         { type: Number, required: true, min: 1, max: 100000 },      // rupees (what the student pays)
  originalPrice: { type: Number, default: null, min: 0, max: 1000000 },      // optional "was ₹X" (shown struck through)
  durationValue: { type: Number, required: true, min: 1, max: 3650 },
  durationUnit:  { type: String, required: true, enum: ['days', 'months', 'years'] },
  badge:         { type: String, default: '', trim: true, maxlength: 30 },   // e.g. "Best Value"
  sortOrder:     { type: Number, default: 0 },
  active:        { type: Boolean, default: true },                           // inactive = hidden from students, cannot be bought
  updatedBy:     { type: String, default: '' },
  createdAt:     { type: Date, default: Date.now },
  updatedAt:     { type: Date, default: Date.now }
});

module.exports = mongoose.model('Plan', planSchema);
