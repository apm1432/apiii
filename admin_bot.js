const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const axios = require('axios');
const User = require('./models/User');
const Question = require('./models/Question');
const { sendEmail } = require('./utils/smtpService');

let bot = null;
let tokens = [];

// Track state for dynamic input
// e.g. { '123456': { action: 'awaiting_months', userId: 'user_mongo_id' } }
const adminState = {};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startAdminBot() {
    const tokensStr = process.env.TELEGRAM_BOT_TOKENS;
    if (!tokensStr) {
        console.log("No TELEGRAM_BOT_TOKENS found. Admin Bot cannot start.");
        return;
    }

    tokens = tokensStr.split(',').map(t => t.replace(/['"]/g, '').trim()).filter(Boolean);
    const token = tokens[0];
    
    bot = new TelegramBot(token, { polling: true });
    console.log("🤖 Interactive Telegram Admin Bot is running...");

    // Set Menu Commands
    bot.setMyCommands([
        { command: 'start', description: 'Open Admin Menu' },
        { command: 'menu', description: 'Open Admin Menu' }
    ]);

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text || '';
        const rawAdminId = process.env.ADMIN_TG_ID || '';
        const adminId = rawAdminId.replace(/['"]/g, '').trim();

        if (!adminId || chatId.toString() !== adminId) {
            if (text.startsWith('/')) {
                bot.sendMessage(chatId, `❌ Unauthorized.\nYour Telegram ID is: \`${chatId}\`\nAdd this to \`ADMIN_TG_ID\` in your .env file to use this bot.`, { parse_mode: 'Markdown' });
            }
            return;
        }

        // Handle Awaiting State (e.g. asking for months)
        if (adminState[chatId]) {
            const state = adminState[chatId];
            if (state.action === 'awaiting_months') {
                const months = parseInt(text);
                if (isNaN(months) || months <= 0) {
                    bot.sendMessage(chatId, "❌ Invalid number. Please enter a valid number of months (e.g. 1, 3, 6, 12).");
                    return;
                }
                
                // Process Subscription
                const user = await User.findById(state.userId);
                if (user) {
                    const expiry = new Date();
                    expiry.setMonth(expiry.getMonth() + months);
                    user.isSubscribed = true;
                    user.subscriptionExpiry = expiry;
                    await user.save();
                    
                    bot.sendMessage(chatId, `✅ **Success!**\nUser ${user.email} is now subscribed for **${months} Months** (until ${expiry.toLocaleDateString()}).`, { parse_mode: 'Markdown' });
                    sendUserProfile(chatId, user._id);

                    // Send Email to User
                    try {
                        const emailHtml = `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 10px;">
                            <h2 style="color: #2563eb; text-align: center;">Subscription Activated! 🎉</h2>
                            <p>Hello,</p>
                            <p>Great news! Your premium subscription has been successfully activated for <strong>${months} months</strong>.</p>
                            <p>Your subscription is valid until: <strong>${expiry.toLocaleDateString()}</strong></p>
                            <p>You now have full access to all premium features, including detailed topper explanations and ad-free browsing.</p>
                            <br>
                            <p>Thank you for your support!</p>
                            <p style="color: #6b7280; font-size: 0.9em;">- The MPSC PYQ Team</p>
                        </div>
                        `;
                        await sendEmail(user.smtp_user, user.email, "Premium Subscription Activated! 🎉", "Your subscription is now active.", emailHtml);
                    } catch (e) {
                        console.error("Failed to send subscription email:", e.message);
                    }
                }
                delete adminState[chatId]; // Clear state
                return;
            }
        }

        if (text.startsWith('/start') || text.startsWith('/menu')) {
            sendMainMenu(chatId);
        }
    });

    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const data = query.data;
        const rawAdminId = process.env.ADMIN_TG_ID || '';
        const adminId = rawAdminId.replace(/['"]/g, '').trim();

        if (!adminId || chatId.toString() !== adminId) return;
        
        // Acknowledge callback
        bot.answerCallbackQuery(query.id);

        try {
            if (data === 'main_menu') {
                sendMainMenu(chatId, query.message.message_id);
            }
            else if (data.startsWith('list_users_')) {
                const page = parseInt(data.split('_')[2]) || 1;
                sendUsersList(chatId, page, query.message.message_id);
            }
            else if (data.startsWith('user_profile_')) {
                const userId = data.split('user_profile_')[1];
                sendUserProfile(chatId, userId, query.message.message_id);
            }
            else if (data.startsWith('unlock_user_')) {
                const userId = data.split('unlock_user_')[1];
                await User.findByIdAndUpdate(userId, { deviceId: null });
                bot.sendMessage(chatId, `✅ Device lock cleared!`);
                sendUserProfile(chatId, userId, query.message.message_id);
            }
            else if (data.startsWith('revoke_user_')) {
                const userId = data.split('revoke_user_')[1];
                const user = await User.findByIdAndUpdate(userId, { isSubscribed: false, subscriptionExpiry: null });
                bot.sendMessage(chatId, `✅ Premium Revoked!`);
                sendUserProfile(chatId, userId, query.message.message_id);

                if (user) {
                    try {
                        const emailHtml = `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 10px;">
                            <h2 style="color: #ef4444; text-align: center;">Subscription Expired / Revoked</h2>
                            <p>Hello,</p>
                            <p>Your premium subscription to MPSC PYQ has ended or been revoked by the admin.</p>
                            <p>If you believe this is a mistake or wish to renew your subscription, please contact support.</p>
                            <br>
                            <p>- The MPSC PYQ Team</p>
                        </div>
                        `;
                        await sendEmail(user.smtp_user, user.email, "Subscription Expired", "Your premium subscription has ended.", emailHtml);
                    } catch (e) {
                        console.error("Failed to send revoke email:", e.message);
                    }
                }
            }
            else if (data.startsWith('give_prem_')) {
                const userId = data.split('give_prem_')[1];
                adminState[chatId] = { action: 'awaiting_months', userId: userId };
                bot.sendMessage(chatId, `🕒 Please type the number of **MONTHS** for this subscription (e.g., \`1\`, \`3\`, \`6\`):`, { parse_mode: 'Markdown' });
            }
            else if (data === 'resync_bots') {
                bot.sendMessage(chatId, "🔄 Starting Cloud Resync (Mirroring)... Please wait.");
                runCloudResync(chatId);
            }
            else if (data === 'stats') {
                const totalUsers = await User.countDocuments();
                const premiumUsers = await User.countDocuments({ isSubscribed: true });
                bot.sendMessage(chatId, `📊 **System Stats**\n\nTotal Users: ${totalUsers}\nPremium Users: ${premiumUsers}`, { parse_mode: 'Markdown' });
            }
        } catch (err) {
            console.error("Callback Error:", err);
            bot.sendMessage(chatId, `⚠️ Error: ${err.message}`);
        }
    });
}

function sendMainMenu(chatId, messageId = null) {
    const text = `🛡 **MPSC PYQ Admin Dashboard**\n\nSelect an option below:`;
    const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "👥 All Users List", callback_data: "list_users_1" }],
                [{ text: "🔄 Cloud Resync (Mirroring)", callback_data: "resync_bots" }],
                [{ text: "📊 System Stats", callback_data: "stats" }]
            ]
        }
    };

    if (messageId) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
    } else {
        bot.sendMessage(chatId, text, opts);
    }
}

async function sendUsersList(chatId, page, messageId) {
    const limit = 15;
    const skip = (page - 1) * limit;
    const totalUsers = await User.countDocuments();
    const totalPages = Math.ceil(totalUsers / limit) || 1;

    const users = await User.find().sort({ _id: -1 }).skip(skip).limit(limit);

    let text = `👥 **Users List (Page ${page}/${totalPages})**\n\n`;
    const inline_keyboard = [];

    users.forEach(u => {
        const icon = u.isSubscribed ? '💎' : '👤';
        inline_keyboard.push([{ text: `${icon} ${u.email}`, callback_data: `user_profile_${u._id}` }]);
    });

    const navButtons = [];
    if (page > 1) navButtons.push({ text: "⬅️ Prev", callback_data: `list_users_${page - 1}` });
    if (page < totalPages) navButtons.push({ text: "Next ➡️", callback_data: `list_users_${page + 1}` });
    
    if (navButtons.length > 0) inline_keyboard.push(navButtons);
    inline_keyboard.push([{ text: "🔙 Back to Menu", callback_data: "main_menu" }]);

    bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard }
    });
}

async function sendUserProfile(chatId, userId, messageId = null) {
    const user = await User.findById(userId);
    if (!user) return bot.sendMessage(chatId, "❌ User not found.");

    const expiry = user.subscriptionExpiry ? new Date(user.subscriptionExpiry).toLocaleDateString() : 'N/A';
    const text = `👤 **Profile:** ${user.email}\n` +
                 `💎 **Premium:** ${user.isSubscribed ? 'Yes ✅' : 'No ❌'}\n` +
                 `📅 **Expiry:** ${expiry}\n` +
                 `📱 **Locked Device:** ${user.deviceId ? 'Yes 🔒' : 'No 🔓'}`;

    const inline_keyboard = [];
    
    if (user.isSubscribed) {
        inline_keyboard.push([{ text: "🔴 Revoke Premium", callback_data: `revoke_user_${user._id}` }]);
    } else {
        inline_keyboard.push([{ text: "🟢 Give Premium", callback_data: `give_prem_${user._id}` }]);
    }

    if (user.deviceId) {
        inline_keyboard.push([{ text: "🔓 Unlock Device", callback_data: `unlock_user_${user._id}` }]);
    }
    
    inline_keyboard.push([{ text: "🔙 Back to List", callback_data: "list_users_1" }]);

    const opts = {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard }
    };

    if (messageId) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
    } else {
        bot.sendMessage(chatId, text, opts);
    }
}

// ==========================================
// RESYNC LOGIC
// ==========================================
async function downloadFromTelegram(fileId, botIndex) {
    try {
        const token = tokens[botIndex];
        const fileRes = await axios.get(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
        if (!fileRes.data.ok) return null;
        const filePath = fileRes.data.result.file_path;
        const imgUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
        
        const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer' });
        return Buffer.from(imgRes.data, 'binary');
    } catch (err) {
        return null;
    }
}

async function uploadToBotResync(botIndex, year_exam, qnum, buffer) {
    const b = new TelegramBot(tokens[botIndex], { polling: false });
    const caption = `Exam: ${year_exam || 'Unknown'}\nQuestion: ${qnum || 'N/A'}`;
    const fileOptions = { filename: 'image.jpg', contentType: 'image/jpeg' };
    
    let retries = 3;
    while (retries > 0) {
        try {
            const msg = await b.sendPhoto(process.env.TELEGRAM_CHANNEL_ID, buffer, { caption }, fileOptions);
            if (msg.photo && msg.photo.length > 0) {
                return { file_id: msg.photo[msg.photo.length - 1].file_id, message_id: msg.message_id };
            }
        } catch (err) {
            if (err.response && err.response.statusCode === 429) {
                const retryAfter = err.response.body.parameters.retry_after || 5;
                await sleep(retryAfter * 1000);
            } else {
                retries--;
                await sleep(2000);
            }
        }
    }
    return null;
}

async function runCloudResync(chatId) {
    try {
        const questions = await Question.find({ original_image_url: { $ne: null } });
        let updated = 0;
        let checked = 0;

        let progressMsg = await bot.sendMessage(chatId, `🔄 Scanning ${questions.length} questions...`);

        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            let fileIdsObj = q.original_image_url;
            
            if (typeof fileIdsObj === 'string') {
                try { fileIdsObj = JSON.parse(fileIdsObj); } 
                catch(e) { fileIdsObj = { "0": fileIdsObj }; }
            }
            
            if (!fileIdsObj || typeof fileIdsObj !== 'object') {
                checked++;
                continue;
            }

            let needsUpdate = false;
            let bufferCache = null;

            for (let b = 0; b < tokens.length; b++) {
                if (!fileIdsObj[b.toString()]) {
                    needsUpdate = true;
                    
                    const existingBotIndices = Object.keys(fileIdsObj);
                    if (existingBotIndices.length === 0) continue;
                    
                    let sourceFileId = null;
                    let sourceBotIndex = null;
                    
                    if (!bufferCache) {
                        for (const existingIdx of existingBotIndices) {
                            sourceBotIndex = existingIdx;
                            sourceFileId = fileIdsObj[sourceBotIndex];
                            if (sourceFileId.includes('/api/image/')) {
                                sourceFileId = sourceFileId.replace('/api/image/', '');
                            }
                            bufferCache = await downloadFromTelegram(sourceFileId, sourceBotIndex);
                            if (bufferCache) break;
                        }
                    }
                    
                    if (bufferCache) {
                        const newRes = await uploadToBotResync(b, q.year_exam, q.qnum, bufferCache);
                        if (newRes && newRes.file_id) {
                            fileIdsObj[b.toString()] = newRes.file_id;
                            if (!q.telegram_msg_id) q.telegram_msg_id = newRes.message_id;
                        }
                    }
                }
            }
            
            if (needsUpdate) {
                q.original_image_url = fileIdsObj;
                q.markModified('original_image_url');
                await q.save();
                updated++;
            }

            checked++;

            // Update Progress every 5 checked items to avoid rate limit (bot edit limit)
            if (checked % 5 === 0) {
                try {
                    await bot.editMessageText(
                        `🔄 **Resync Progress:**\nChecked: ${checked} / ${questions.length}\nUpdated: ${updated}`,
                        { chat_id: chatId, message_id: progressMsg.message_id, parse_mode: 'Markdown' }
                    );
                } catch (e) {
                    // Ignore "message is not modified" error
                }
            }
        }
        
        bot.sendMessage(chatId, `✅ **Resync Complete!**\nTotal Checked: ${checked}\nTotal Updated: ${updated}`, { parse_mode: 'Markdown' });

    } catch (err) {
        console.error(err);
        bot.sendMessage(chatId, `❌ Resync Error: ${err.message}`);
    }
}

module.exports = { startAdminBot };
