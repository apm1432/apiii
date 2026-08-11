require('dotenv').config();
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

// Utility to sleep
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    const tokensStr = process.env.TELEGRAM_BOT_TOKENS;
    const channelId = process.env.TELEGRAM_CHANNEL_ID;

    if (!tokensStr || !channelId) {
        console.error("Missing TELEGRAM_BOT_TOKENS or TELEGRAM_CHANNEL_ID in .env");
        process.exit(1);
    }

    // Parse comma-separated tokens
    const tokens = tokensStr.split(',').map(t => t.trim()).filter(Boolean);
    if (tokens.length === 0) {
        console.error("No valid tokens found in TELEGRAM_BOT_TOKENS.");
        process.exit(1);
    }

    console.log(`Initialized with ${tokens.length} bot(s) for Round-Robin uploads.`);
    
    // Initialize bot instances (polling false since we only send messages)
    const bots = tokens.map(token => new TelegramBot(token, { polling: false }));
    let currentBotIndex = 0;

    // Round-robin selector
    function getNextBot() {
        const bot = bots[currentBotIndex];
        currentBotIndex = (currentBotIndex + 1) % bots.length;
        return bot;
    }

    const inputDataPath = path.join(__dirname, 'FINAL_ENRICHED_MPSC_QUESTIONS.json');
    const mappingPath = path.join(__dirname, 'image_mapping.json');

    if (!fs.existsSync(inputDataPath)) {
        console.error(`Input file not found: ${inputDataPath}`);
        process.exit(1);
    }

    let questions = [];
    try {
        const data = await fsPromises.readFile(inputDataPath, 'utf8');
        questions = JSON.parse(data);
    } catch (err) {
        console.error(`Error reading or parsing ${inputDataPath}:`, err.message);
        process.exit(1);
    }

    let mapping = {};
    if (fs.existsSync(mappingPath)) {
        try {
            const mappingData = await fsPromises.readFile(mappingPath, 'utf8');
            mapping = JSON.parse(mappingData);
        } catch (err) {
            console.log("Could not parse existing mapping, starting fresh.");
        }
    }

    console.log(`Loaded ${questions.length} questions. Starting upload process...`);

    let uploadCount = 0;

    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const originalPath = q._originalFilePath;

        // Check if originalPath exists and is likely a local file
        // Handles windows drive letters and absolute paths
        if (originalPath && typeof originalPath === 'string') {
            const isLocal = path.isAbsolute(originalPath) || /^[a-zA-Z]:\\/.test(originalPath);
            
            if (isLocal && fs.existsSync(originalPath)) {
                if (mapping[originalPath]) {
                    // Already uploaded
                    continue;
                }

                console.log(`[${i + 1}/${questions.length}] Uploading: ${originalPath}`);
                const bot = getNextBot();

                try {
                    // Send photo. If it's a very large image, telegram might treat it as a document.
                    // We can simply pass the file path.
                    const msg = await bot.sendPhoto(channelId, originalPath);
                    
                    if (msg.photo && msg.photo.length > 0) {
                        // The last item in the array is the highest resolution
                        const fileId = msg.photo[msg.photo.length - 1].file_id;
                        mapping[originalPath] = fileId;
                        uploadCount++;

                        console.log(`  -> Success! File ID: ${fileId}`);
                        
                        // Save mapping periodically to not lose progress on failure
                        if (uploadCount % 10 === 0) {
                            await fsPromises.writeFile(mappingPath, JSON.stringify(mapping, null, 2));
                        }
                    } else if (msg.document) {
                        const fileId = msg.document.file_id;
                        mapping[originalPath] = fileId;
                        uploadCount++;
                        console.log(`  -> Success (as document)! File ID: ${fileId}`);
                    }

                    // A tiny sleep to avoid overwhelming telegram servers
                    await sleep(1000); 

                } catch (err) {
                    console.error(`  -> Error uploading with bot ending in ...${bot.token.slice(-4)}:`, err.message);
                    
                    // Basic retry-after handling if rate limited
                    if (err.response && err.response.statusCode === 429) {
                        const retryAfter = err.response.body.parameters.retry_after || 5;
                        console.log(`  -> Rate limited. Sleeping for ${retryAfter} seconds...`);
                        await sleep(retryAfter * 1000);
                        // Decrease index to try again next loop? We'll just continue to next image to avoid getting stuck,
                        // user can re-run to pick up failed ones.
                    }
                }
            }
        }
    }

    // Final save of mapping
    await fsPromises.writeFile(mappingPath, JSON.stringify(mapping, null, 2));
    console.log(`Upload process completed. Total new uploads this session: ${uploadCount}`);
}

main().catch(err => console.error("Fatal error:", err));
