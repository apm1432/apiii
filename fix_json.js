const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, 'FINAL_ENRICHED_MPSC_QUESTIONS.json');
let rawData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// If it's an object with exam keys
if (!Array.isArray(rawData)) {
    for (const key in rawData) {
        rawData[key].forEach(q => {
            if (q.official_exam_name) {
                let n = q.official_exam_name;
                
                n = n.replace('राज्य सेवा[**(पूर्व) परीक्षा २०२१', 'राज्य सेवा (पूर्व) परीक्षा २०२१');
                n = n.replace('महाराष्ट्र राजपत्रित नागरी सेवा[संयुक्त पूर्व परीक्षा - २०२५, पेपर क्र. १', 'महाराष्ट्र राजपत्रित नागरी सेवा संयुक्त पूर्व परीक्षा - २०२५, पेपर क्र. १');
                n = n.replace('महाराष्ट्र राजपत्रित नागरी सेवा संयुक्त पूर्व परीक्षा[-,SPACE]२०२५, पेपर क्र[.,SPACE]१', 'महाराष्ट्र राजपत्रित नागरी सेवा संयुक्त पूर्व परीक्षा - २०२५, पेपर क्र. १');
                n = n.replace('महाराष्ट्र दुय्यम सेवा अराजपत्रित, गट-ब पूर्व परीक्षा[*-२०१८', 'महाराष्ट्र दुय्यम सेवा अराजपत्रित, गट-ब पूर्व परीक्षा - २०१८');
                n = n.replace('महाराष्ट्र दुय्यम सेवा अराजपत्रित, गट-ब पूर्व परीक्षा[–] २०१८', 'महाराष्ट्र दुय्यम सेवा अराजपत्रित, गट-ब पूर्व परीक्षा - २०१८');
                n = n.replace('महाराष्ट्र दुय्यम सेवा[राजपत्रित, गट-ब पूर्व परीक्षा - २०१८', 'महाराष्ट्र दुय्यम सेवा अराजपत्रित, गट-ब पूर्व परीक्षा - २०१८');
                n = n.replace('महाराष्ट्र दुय्यम सेवा अराजपत्रित, गट-ब पूर्व परीक्षा - २०१', 'महाराष्ट्र दुय्यम सेवा अराजपत्रित, गट-ब पूर्व परीक्षा - २०१८');
                n = n.replace('महाराष्ट्र दुय्यम सेवा, गट-ब (अराजपत्रित) संयुक्त (पूर्व) परीक्षा - २०२०', 'महाराष्ट्र दुय्यम सेवा, गट-ब (अराजपत्रित) संयुक्त पूर्व परीक्षा - २०२०');
                // The issue where string ends with २०१ instead of २०१८ because 8 was missing.
                if (n === 'महाराष्ट्र दुय्यम सेवा अराजपत्रित, गट-ब पूर्व परीक्षा - २०१') {
                    n = 'महाराष्ट्र दुय्यम सेवा अराजपत्रित, गट-ब पूर्व परीक्षा - २०१८';
                }
                
                q.official_exam_name = n;
            }
        });
    }
}

fs.writeFileSync(dataPath, JSON.stringify(rawData, null, 2), 'utf8');
console.log('JSON exam names fixed successfully!');
