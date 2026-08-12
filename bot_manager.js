require('dotenv').config();
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const readline = require('readline');
const axios = require('axios');
const Question = require('./models/Question');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const tokensStr = process.env.TELEGRAM_BOT_TOKENS || '';
const channelId = process.env.TELEGRAM_CHANNEL_ID;
const mongoURI = process.env.MONGODB_URI;

const tokens = tokensStr.split(',').map(t => t.trim()).filter(Boolean);

let bots = [];
if (tokens.length > 0) {
    bots = tokens.map(token => new TelegramBot(token, { polling: false }));
}

async function connectDB() {
    if (mongoose.connection.readyState === 0) {
        console.log("Connecting to MongoDB...");
        await mongoose.connect(mongoURI);
        console.log("✅ MongoDB Connected.");
    }
}

async function uploadToBot(botIndex, originalPath, year_exam, qnum, buffer = null) {
    const bot = bots[botIndex];
    const caption = `Exam: ${year_exam || 'Unknown'}\nQuestion: ${qnum || 'N/A'}`;
    
    let retries = 3;
    while (retries > 0) {
        try {
            const dataToUpload = buffer ? buffer : originalPath;
            // if buffer is used, we must provide fileOptions for TelegramBot
            const fileOptions = buffer ? { filename: 'image.jpg', contentType: 'image/jpeg' } : undefined;
            
            const msg = await bot.sendPhoto(channelId, dataToUpload, { caption }, fileOptions);
            
            if (msg.photo && msg.photo.length > 0) {
                return { file_id: msg.photo[msg.photo.length - 1].file_id, message_id: msg.message_id };
            } else if (msg.document) {
                return { file_id: msg.document.file_id, message_id: msg.message_id };
            }
        } catch (err) {
            if (err.response && err.response.statusCode === 429) {
                const retryAfter = err.response.body.parameters.retry_after || 5;
                console.log(`Rate limited (Bot ${botIndex}). Sleeping ${retryAfter}s...`);
                await sleep(retryAfter * 1000);
            } else {
                console.error(`Upload error (Bot ${botIndex}):`, err.message);
                retries--;
                await sleep(2000);
            }
        }
    }
    return null;
}

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
        console.error(`Download error for fileId ${fileId}:`, err.message);
        return null;
    }
}

async function importJson() {
    rl.question('Enter JSON file path (default: FINAL_ENRICHED_MPSC_QUESTIONS.json): ', async (ans) => {
        const jsonPath = ans.trim() || 'FINAL_ENRICHED_MPSC_QUESTIONS.json';
        const absolutePath = path.resolve(jsonPath);
        
        if (!fs.existsSync(absolutePath)) {
            console.log(`❌ File not found: ${absolutePath}`);
            return showMenu();
        }

        console.log(`Loading ${absolutePath}...`);
        const rawData = JSON.parse(await fsPromises.readFile(absolutePath, 'utf8'));
        
        let questions = [];
        for (const key in rawData) {
            if (Array.isArray(rawData[key])) {
                const arr = rawData[key].map(q => {
                    q.year_exam = key;
                    return q;
                });
                questions = questions.concat(arr);
            }
        }
        console.log(`Found ${questions.length} total questions.`);

        const mappingPath = path.join(__dirname, 'image_mapping.json');
        let mapping = {};
        if (fs.existsSync(mappingPath)) {
            mapping = JSON.parse(await fsPromises.readFile(mappingPath, 'utf8'));
        }

        let uploaded = 0;
        let synced = 0;

        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            const localPath = q._originalFilePath;
            
            let fileIdsObj = {};

            if (localPath && typeof localPath === 'string' && (path.isAbsolute(localPath) || /^[a-zA-Z]:\\/.test(localPath))) {
                if (fs.existsSync(localPath)) {
                    // Check mapping
                    if (mapping[localPath] && typeof mapping[localPath] === 'object') {
                        fileIdsObj = mapping[localPath];
                    }

                    let newlyUploaded = false;
                    for (let b = 0; b < bots.length; b++) {
                        if (!fileIdsObj[b.toString()]) {
                            console.log(`[${i+1}/${questions.length}] Uploading via Bot ${b}: ${localPath}`);
                            const uploadRes = await uploadToBot(b, localPath, q.year_exam, q.qnum);
                            if (uploadRes && uploadRes.file_id) {
                                fileIdsObj[b.toString()] = uploadRes.file_id;
                                q.telegram_msg_id = uploadRes.message_id;
                                newlyUploaded = true;
                                uploaded++;
                            }
                        }
                    }

                    if (newlyUploaded) {
                        mapping[localPath] = fileIdsObj;
                        if (uploaded % 10 === 0) {
                            await fsPromises.writeFile(mappingPath, JSON.stringify(mapping, null, 2));
                        }
                    }
                }
            }

            // Sync to MongoDB
            const qData = { ...q };
            delete qData._originalFilePath;
            if (Object.keys(fileIdsObj).length > 0) {
                qData.original_image_url = fileIdsObj; // Save object directly using Mixed schema
            } else if (mapping[localPath]) {
                qData.original_image_url = mapping[localPath];
            } else {
                 qData.original_image_url = null; // force null if no image exists to clear old data
            }
            
            // Generate deterministic ID or query by properties
            const query = { 
                year_exam: q.year_exam, 
                subject: q.subject, 
                qnum: q.qnum 
            };
            
            await Question.findOneAndUpdate(query, qData, { upsert: true, returnDocument: 'after' });
            synced++;
            
            process.stdout.write(`\rProgress: ${synced}/${questions.length} synced to DB. `);
        }
        
        await fsPromises.writeFile(mappingPath, JSON.stringify(mapping, null, 2));
        console.log(`\n✅ Import Complete! Uploaded ${uploaded} new files. Synced ${synced} docs.`);
        showMenu();
    });
}

async function addBotResync() {
    console.log("Scanning database for questions with missing bot file_ids...");
    const questions = await Question.find({ original_image_url: { $ne: null } });
    
    let updated = 0;
    
    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        let fileIdsObj = q.original_image_url;
        
        if (typeof fileIdsObj === 'string') {
            // Backward compatibility
            try { fileIdsObj = JSON.parse(fileIdsObj); } 
            catch(e) { fileIdsObj = { "0": fileIdsObj }; }
        }
        
        if (!fileIdsObj || typeof fileIdsObj !== 'object') continue;

        let needsUpdate = false;
        let bufferCache = null; // Download once per question if multiple bots are missing

        for (let b = 0; b < bots.length; b++) {
            if (!fileIdsObj[b.toString()]) {
                needsUpdate = true;
                
                // We need to upload to Bot 'b'. But we don't have local path.
                // We will download from one of the existing bots.
                const existingBotIndices = Object.keys(fileIdsObj);
                if (existingBotIndices.length === 0) continue; // broken record
                
                let sourceFileId = null;
                let sourceBotIndex = null;
                
                if (!bufferCache) {
                    for (const existingIdx of existingBotIndices) {
                        sourceBotIndex = existingIdx;
                        sourceFileId = fileIdsObj[sourceBotIndex];
                        if (sourceFileId.includes('/api/image/')) {
                            sourceFileId = sourceFileId.replace('/api/image/', '');
                        }
                        
                        console.log(`Downloading missing image from Bot ${sourceBotIndex}...`);
                        bufferCache = await downloadFromTelegram(sourceFileId, sourceBotIndex);
                        if (bufferCache) break; // successfully downloaded
                    }
                }
                
                if (bufferCache) {
                    console.log(`[Q: ${q.year_exam} / ${q.qnum}] Uploading via Bot ${b}...`);
                    const newRes = await uploadToBot(b, null, q.year_exam, q.qnum, bufferCache);
                    if (newRes && newRes.file_id) {
                        fileIdsObj[b.toString()] = newRes.file_id;
                        if (!q.telegram_msg_id) q.telegram_msg_id = newRes.message_id;
                    }
                }
            }
        }
        
        if (needsUpdate) {
            q.original_image_url = fileIdsObj;
            q.markModified('original_image_url'); // Important for Mixed types
            await q.save();
            updated++;
            console.log(`✅ Database updated for Q: ${q.year_exam} / ${q.qnum}`);
        }
    }
    
    console.log(`\n✅ Resync Complete! Updated ${updated} questions.`);
    showMenu();
}

function showMenu() {
    console.log("\n==================================");
    console.log(" 🤖 MPSC PYQ Bot Manager CLI");
    console.log("==================================");
    console.log(`Active Bots: ${bots.length}`);
    console.log("[1] Import JSON & Auto-Sync (Initial Upload)");
    console.log("[2] Add New Bot & Server Mirroring (Resync)");
    console.log("[3] Exit");
    console.log("==================================");
    rl.question('Select an option: ', (ans) => {
        if (ans === '1') importJson();
        else if (ans === '2') addBotResync();
        else if (ans === '3') {
            console.log("Goodbye!");
            process.exit(0);
        } else {
            console.log("Invalid option.");
            showMenu();
        }
    });
}

(async () => {
    if (!tokensStr || !channelId || !mongoURI) {
        console.error("❌ Missing environment variables (.env). Ensure TELEGRAM_BOT_TOKENS, TELEGRAM_CHANNEL_ID, MONGODB_URI are set.");
        process.exit(1);
    }
    await connectDB();
    showMenu();
})();
