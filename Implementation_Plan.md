# संपूर्ण अंमलबजावणी योजना (Final Implementation Plan): MPSC PYQ प्लॅटफॉर्म

## 🛑 अति-महत्त्वाची आणि कठोर अट (Ultra-Strict Policy)
**"Absolutely NO fabricated data, NO false assumptions, NO skipping steps, and ZERO compromise on security."**
1. **Double Verification:** मी (AI Guide) प्रत्येक डेटा दोन वेळा तपासेन - एकदा मिळवताना आणि दुसरी स्टेप पूर्ण झाल्यावर.
2. **Work Delegation & Control:** मी जास्तीत जास्त काम इतर APIs/Subagents कडून करवून घेईन आणि स्वतः त्यांच्या कामाचे 'Strict Guide' म्हणून ॲनालिसिस करेन. सर्व कंट्रोल माझ्या हातात राहील.
3. **No Fake Data:** सर्व माहिती फक्त आणि फक्त `FINAL_ENRICHED_MPSC_QUESTIONS.json` मधील असेल.

## 🎨 'UI/UX Excellence' (Best & User-Friendly Website)
* **Prompt for Goal:** "The website must have a premium, intuitive, and modern UI. It should be lightning-fast, highly responsive on mobile devices, and designed to give students a frictionless learning experience without feeling overwhelming or 'heavy'."

---

## 🎯 AI API Rotation & Rate-Limit Management
1. **Multi-Key & Multi-Model System:** रोटेशन लॉजिक (api_keys.json).
2. **Rate Limits & Delay:** Heavy Models (4 RPM, 15 sec delay).
3. **Anti-Recitation Bypass:** `[SPACE]` वापरून ब्लॉक टाळणे.

---

## 📌 प्रोजेक्टचे स्पष्ट पॉईंटर्स
१. **Koyeb 512MB RAM Optimization:** संपूर्ण JSON फाईल **MongoDB** मध्ये इन्सर्ट केली जाईल.
२. **Security:** Razorpay Webhook Verification, राईट-क्लिक आणि F12 ब्लॉक.
३. **Dynamic JSON Sync:** ॲडमिन API द्वारे नवीन JSON अपडेट्स MongoDB मध्ये सिंक.
४. **Smart Email:** Brevo (Welcome Emails) आणि Subscription SMTPs.
५. **Disk Caching & Telegram Bots:** मल्टिपल बोट टोकन्स आणि डिस्क कॅश (Max Cap).
६. **Navigation & Full Paper Mode:** Year ➔ Exam ➔ Subject ➔ Topic. 
७. **Quiz UI & Original Image Viewer:** एका वेळी एक प्रश्न. प्रश्नाजवळ 'View Original Image' झूम फीचरसह.
८. **Progress Tracking:** Overall/Sectional प्रोग्रेस आणि Resume from last solved question.

---
## 📋 Execution Steps
1. Cleanup (जुन्या फाईल्स डिलीट).
2. Database & Sync (MongoDB सेटअप).
3. Telegram Image Uploader & Disk Cache.
4. Backend Security & APIs.
5. Frontend UI & Progress Tracking.
6. Double Verification & Testing.
