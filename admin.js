require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');
const fs = require('fs');
const crypto = require('crypto');
const User = require('./models/User');
const Question = require('./models/Question');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

function generateStableObjectId(year_exam, text_eng) {
    // Generate a consistent 24 character hex string based on exam and question text
    const hash = crypto.createHash('md5').update((year_exam || '') + (text_eng || '')).digest('hex');
    return hash.substring(0, 24);
}

async function main() {
    console.log("\n=========================================");
    console.log("   MPSC PYQ ADMIN CONTROL PANEL");
    console.log("=========================================\n");

    const pwd = await askQuestion("Enter Admin Password: ");
    if (pwd !== '1181') {
        console.log("❌ Access Denied.");
        process.exit(1);
    }

    console.log("Connecting to Database...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Database Connected!\n");

    while (true) {
        console.log("\n--- Admin Menu ---");
        console.log("1. View Available Users");
        console.log("2. Remove Device Lock for a User");
        console.log("3. Update Questions JSON");
        console.log("4. Exit");
        
        const choice = await askQuestion("\nSelect an option (1-4): ");
        
        if (choice === '1') {
            const users = await User.find({}, 'email deviceId createdAt');
            if (users.length === 0) {
                console.log("No users found.");
            } else {
                console.table(users.map(u => ({
                    Email: u.email,
                    DeviceLocked: u.deviceId ? 'Yes (Locked)' : 'No',
                    Joined: u.createdAt.toDateString()
                })));
            }
        } else if (choice === '2') {
            const email = await askQuestion("Enter user's email to unlock: ");
            const user = await User.findOne({ email });
            if (user) {
                user.deviceId = null;
                await user.save();
                console.log(`✅ Unlocked device for ${email}. They can now login from a new device.`);
            } else {
                console.log("❌ User not found.");
            }
        } else if (choice === '3') {
            console.log("\n[WARNING] Updating JSON will replace all existing questions.");
            console.log("Because we use stable IDs, user progress will NOT be lost for existing questions.");
            const jsonPath = await askQuestion("Enter full path to new JSON file (e.g., C:\\path\\to\\file.json): ");
            
            // Remove quotes if user dragged and dropped file into CMD
            const cleanPath = jsonPath.replace(/^"|"$/g, '');

            if (fs.existsSync(cleanPath)) {
                try {
                    console.log("Reading JSON file...");
                    const rawData = fs.readFileSync(cleanPath, 'utf8');
                    const parsed = JSON.parse(rawData);
                    
                    console.log("Reading image mapping...");
                    let imageMapping = {};
                    if (fs.existsSync('image_mapping.json')) {
                        imageMapping = JSON.parse(fs.readFileSync('image_mapping.json', 'utf8'));
                    }

                    let data = [];
                    if (!Array.isArray(parsed)) {
                        for (const [examName, questions] of Object.entries(parsed)) {
                            for (const q of questions) {
                                q.year_exam = examName;
                                if (q._originalFilePath) {
                                    const fileId = imageMapping[q._originalFilePath];
                                    if (fileId) {
                                        q.original_image_url = `/api/image/${fileId}`;
                                    } else {
                                        q.original_image_url = q._originalFilePath;
                                    }
                                }
                                // GENERATE STABLE ID
                                q._id = generateStableObjectId(q.year_exam, q.text_eng);
                                data.push(q);
                            }
                        }
                    } else {
                        for (const q of parsed) {
                            q._id = generateStableObjectId(q.year_exam, q.text_eng);
                            data.push(q);
                        }
                    }
                    
                    console.log(`Found ${data.length} questions in JSON.`);
                    console.log("Clearing old questions collection...");
                    await Question.deleteMany({});
                    
                    console.log("Inserting new questions...");
                    const result = await Question.insertMany(data, { ordered: false });
                    console.log(`✅ Successfully inserted ${result.length} questions!`);
                    console.log("Note: You may need to restart the main server (Node.js) for the cache to clear and changes to appear immediately on the website.");
                } catch (err) {
                    console.error("❌ Error during JSON update:", err);
                }
            } else {
                console.log("❌ File not found at the specified path.");
            }
        } else if (choice === '4') {
            console.log("Exiting...");
            mongoose.connection.close();
            process.exit(0);
        } else {
            console.log("Invalid choice. Try again.");
        }
    }
}

main();
