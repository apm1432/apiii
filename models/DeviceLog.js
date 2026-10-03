const mongoose = require('mongoose');

// One row per successful registration: which device / browser cookie / IP created which account.
// Used (silently) to detect repeat registrations from the same device.
const deviceLogSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  deviceId: { type: String, default: null, index: true },
  cookieId: { type: String, default: null, index: true },
  ip:       { type: String, default: null, index: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('DeviceLog', deviceLogSchema);
