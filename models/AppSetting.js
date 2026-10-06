const mongoose = require('mongoose');

// Tiny key/value store for admin settings that must survive restarts (e.g. the image cache size limit).
const appSettingSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed }
});

module.exports = mongoose.model('AppSetting', appSettingSchema);
