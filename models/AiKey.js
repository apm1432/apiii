const mongoose = require('mongoose');

const aiKeySchema = new mongoose.Schema({
    key: { type: String, required: true },
    model: { type: String, required: true },
    lastUsed: { type: Number, default: 0 },
    cooldownUntil: { type: Number, default: 0 },
    rpmDelayMs: { type: Number, default: 0 },
    status: { type: String, default: 'Success' },
    isAvailable: { type: Boolean, default: true }
});

aiKeySchema.index({ key: 1, model: 1 }, { unique: true });

module.exports = mongoose.model('AiKey', aiKeySchema);
