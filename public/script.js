// ====== UI LOGIC ======

// State
let token = localStorage.getItem('jwtToken');
let currentUser = JSON.parse(localStorage.getItem('currentUser')) || null; // { email, isSubscribed }
let userAnswers = JSON.parse(localStorage.getItem('mpsc_user_answers')) || {};

document.addEventListener('DOMContentLoaded', () => {
    // Check Auth State
    if (token) {
        // Assume valid for now, load dashboard
        if (currentUser) updateProfileUI();
        showSection('dashboard-section');
        loadDashboard();
    } else {
        showSection('auth-section');
    }
});

// View Switching (SPA)
function showSection(sectionId) {
    document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
    document.getElementById(sectionId).classList.add('active');
}

// ====== VIEW SWITCHING ======
function switchView(viewId) {
    document.querySelectorAll('.view-mode').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    window.scrollTo(0, 0);

    const floatingStats = document.getElementById('floating-stats');
    if (viewId === 'dashboard') {
        if (floatingStats) floatingStats.classList.add('hidden');
    }
}
// Mode Switching (Quiz / Full Paper)
function switchMode(mode) {
    const btnQuiz = document.getElementById('btn-quiz');
    const btnFull = document.getElementById('btn-full');
    const quizView = document.getElementById('quiz-view');
    const fullView = document.getElementById('full-view');

    const floatingStats = document.getElementById('floating-stats');
    if (mode === 'quiz') {
        btnQuiz.classList.add('btn-primary');
        btnQuiz.classList.remove('btn-outline');
        btnFull.classList.remove('btn-primary');
        btnFull.classList.add('btn-outline');
        quizView.style.display = 'block';
        fullView.style.display = 'none';
        if (floatingStats) floatingStats.classList.add('hidden');
    } else {
        btnFull.classList.add('btn-primary');
        btnFull.classList.remove('btn-outline');
        btnQuiz.classList.remove('btn-primary');
        btnQuiz.classList.add('btn-outline');
        quizView.style.display = 'none';
        fullView.style.display = 'block';
        if (floatingStats) floatingStats.classList.remove('hidden');
    }
}

// ====== DEVICE IDENTIFICATION ======
let currentDeviceId = localStorage.getItem('mpscpyq_device_id');
if (!currentDeviceId) {
    // Generate a robust UUID for this browser
    currentDeviceId = 'device_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
    localStorage.setItem('mpscpyq_device_id', currentDeviceId);
}

// ====== AUTHENTICATION ======
function toggleAuth(type) {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const tabs = document.querySelectorAll('.auth-tab');
    const msg = document.getElementById('auth-message');
    msg.innerText = '';

    tabs.forEach(t => t.classList.remove('active'));
    
    if (type === 'login') {
        loginForm.classList.remove('hidden');
        registerForm.classList.add('hidden');
        tabs[0].classList.add('active');
    } else {
        registerForm.classList.remove('hidden');
        loginForm.classList.add('hidden');
        tabs[1].classList.add('active');
    }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    const msg = document.getElementById('auth-message');
    msg.innerText = 'Logging in...';
    msg.style.color = 'var(--text-secondary)';

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, deviceId: currentDeviceId })
        });
        const data = await res.json();
        
        if (data.success) {
            localStorage.setItem('jwtToken', data.token);
            localStorage.setItem('currentUser', JSON.stringify(data.user));
            
            // Pre-cache progress from DB
            try {
                const progRes = await fetch('/api/progress/dashboard', {
                    headers: { 'Authorization': `Bearer ${data.token}` }
                });
                const progData = await progRes.json();
                if (progData.success && progData.data && progData.data.answers) {
                    localStorage.setItem('mpsc_user_answers', JSON.stringify(progData.data.answers));
                    userAnswers = progData.data.answers; // update live cache
                }
            } catch (e) {
                console.warn("Failed to fetch progress on login", e);
            }

            alert('Login successful!');
            window.location.reload();
        } else {
            msg.innerText = data.message || 'Invalid email or password.';
            msg.style.color = 'var(--error)';
        }
    } catch (err) {
        msg.innerText = 'Server error. Try again.';
        msg.style.color = 'var(--error)';
    }
});

document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('reg-email').value;
    const password = document.getElementById('reg-password').value;
    const msg = document.getElementById('auth-message');
    msg.innerText = 'Registering...';
    msg.style.color = 'var(--text-secondary)';

    try {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, deviceId: currentDeviceId })
        });
        const data = await res.json();
        
        if (data.success) {
            msg.innerText = 'Registration successful! Please login.';
            msg.style.color = 'var(--success)';
            setTimeout(() => {
                toggleAuth('login');
                const newMsg = document.getElementById('auth-message');
                newMsg.innerText = 'Registration successful! Please login.';
                newMsg.style.color = 'var(--success)';
            }, 1500);
        } else {
            msg.innerText = data.message || 'Registration failed.';
            msg.style.color = 'var(--error)';
        }
    } catch (err) {
        msg.innerText = 'Server error. Try again.';
        msg.style.color = 'var(--error)';
    }
});

function logout() {
    token = null;
    currentUser = null;
    localStorage.removeItem('jwtToken');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('activeAiJobId');
    if (window.activeAiEventSource) {
        window.activeAiEventSource.close();
        window.activeAiEventSource = null;
    }
    const panel = document.getElementById('ai-live-panel');
    if (panel) panel.style.display = 'none';
    showSection('auth-section');
}

// ====== PROFILE TOGGLE & UPDATE ======
window.updateProfileUI = function() {
    if (!currentUser) return;
    try {
        document.getElementById('profile-name').innerText = currentUser.email.split('@')[0];
        document.getElementById('modal-email').innerText = currentUser.email;
        
        if (currentUser.isSubscribed) {
            document.getElementById('modal-sub').innerText = currentUser.subscriptionPlan || "Premium";
            document.getElementById('modal-sub').style.color = "#10b981"; // green
            
            if (currentUser.subscriptionExpiry) {
                const expiryDate = new Date(currentUser.subscriptionExpiry).toLocaleDateString();
                document.getElementById('modal-expiry').innerText = expiryDate;
            } else {
                document.getElementById('modal-expiry').innerText = "Lifetime";
            }
        } else {
            document.getElementById('modal-sub').innerText = "Free (Not Subscribed)";
            document.getElementById('modal-sub').style.color = "var(--text-secondary)";
            document.getElementById('modal-expiry').innerText = "N/A";
        }

        // Hide free trial button if already used
        if (currentUser.hasUsedFreeTrial) {
            const trialContainer = document.getElementById('free-trial-container');
            if (trialContainer) trialContainer.style.display = 'none';
        }

    } catch (e) {
        console.warn("Profile UI elements not found:", e);
    }
}

window.toggleProfileModal = function() {
    const modal = document.getElementById('profile-modal');
    if (modal.style.display === 'flex') {
        modal.style.display = 'none';
        modal.classList.remove('show');
    } else {
        modal.style.display = 'flex';
        void modal.offsetWidth; 
        modal.classList.add('show');
    }
};


window.toggleJumpGrid = function() {
    const grid = document.getElementById('jump-grid-container');
    if (grid.style.display === 'none') {
        grid.style.display = 'block';
    } else {
        grid.style.display = 'none';
    }
};

// ====== FORGOT PASSWORD ======
function toggleForgotPasswordModal() {
    const modal = document.getElementById('forgot-password-modal');
    if (modal.classList.contains('show')) {
        modal.classList.remove('show');
        setTimeout(() => modal.style.display = 'none', 300);
    } else {
        modal.style.display = 'flex';
        void modal.offsetWidth; // trigger reflow
        modal.classList.add('show');
        document.getElementById('fp-step-1').classList.remove('hidden');
        document.getElementById('fp-step-2').classList.add('hidden');
        document.getElementById('fp-message').innerText = '';
    }
}

async function requestOtp() {
    const email = document.getElementById('fp-email').value;
    const msg = document.getElementById('fp-message');
    if (!email) { msg.innerText = 'Please enter your email.'; msg.style.color = 'red'; return; }
    
    msg.innerText = 'Sending OTP...'; msg.style.color = 'var(--text-color)';
    try {
        const res = await fetch('/api/auth/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (data.success) {
            msg.innerText = data.message;
            msg.style.color = 'green';
            document.getElementById('fp-step-1').classList.add('hidden');
            document.getElementById('fp-step-2').classList.remove('hidden');
        } else {
            msg.innerText = data.message || 'Error sending OTP.';
            msg.style.color = 'red';
        }
    } catch (e) {
        msg.innerText = 'Network error.'; msg.style.color = 'red';
    }
}

async function resetPasswordWithOtp() {
    const email = document.getElementById('fp-email').value;
    const otp = document.getElementById('fp-otp').value;
    const newPassword = document.getElementById('fp-new-password').value;
    const msg = document.getElementById('fp-message');
    
    if (!otp || !newPassword) { msg.innerText = 'Please fill all fields.'; msg.style.color = 'red'; return; }
    
    msg.innerText = 'Resetting password...'; msg.style.color = 'var(--text-color)';
    try {
        const res = await fetch('/api/auth/verify-reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, otp, newPassword })
        });
        const data = await res.json();
        if (data.success) {
            msg.innerText = 'Password reset successfully! You can now login.';
            msg.style.color = 'green';
            setTimeout(() => {
                toggleForgotPasswordModal();
            }, 3000);
        } else {
            msg.innerText = data.message || 'Error resetting password.';
            msg.style.color = 'red';
        }
    } catch (e) {
        msg.innerText = 'Network error.'; msg.style.color = 'red';
    }
}

// ====== DASHBOARD ======
async function loadDashboard() {
    const grid = document.getElementById('exam-grid');
    grid.innerHTML = '<p style="color:var(--text-secondary);">Loading exams...</p>';

    try {
        const res = await fetch('/api/exams/hierarchy', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        
        if (data.success) {
            // Fetch progress for this user to display attempted stats
            let progressSectionWise = {};
            try {
                const progRes = await fetch('/api/progress/dashboard', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const progData = await progRes.json();
                if (progData.success && progData.data) {
                    if (progData.data.sectionWise) {
                        progressSectionWise = progData.data.sectionWise;
                    }
                    if (progData.data.answers) {
                        localStorage.setItem('mpsc_user_answers', JSON.stringify(progData.data.answers));
                        userAnswers = progData.data.answers;
                    }
                }
            } catch (e) { console.warn("Failed to fetch dashboard progress stats"); }

            grid.innerHTML = '';
            
            // Global variable for current filter state
            if (typeof window.currentExamFilter === 'undefined') {
                window.currentExamFilter = 'all';
            }
            
            // Store fetched data globally for filtering
            window.allExamsData = data.data;
            window.progressSectionWise = progressSectionWise;
            
            renderExamGrid();
        } else {
            grid.innerHTML = '<p style="color:var(--error);">Failed to load dashboard.</p>';
        }
    } catch (err) {
        grid.innerHTML = '<p style="color:var(--error);">Failed to load dashboard.</p>';
    }
}

// Exam filtering and rendering
function filterExams(category, btnElement) {
    window.currentExamFilter = category;
    
    // Update active tab UI
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    if (btnElement) btnElement.classList.add('active');
    
    renderExamGrid();
}

window.dashboardMode = 'exam';

window.switchDashboardMode = function(mode) {
    window.dashboardMode = mode;
    document.getElementById('mode-exam-btn').classList.remove('active');
    document.getElementById('mode-subject-btn').classList.remove('active');
    document.getElementById('mode-' + mode + '-btn').classList.add('active');
    
    if (mode === 'subject') {
        document.getElementById('exam-tabs').style.display = 'none';
        renderSubjectGrid();
    } else {
        document.getElementById('exam-tabs').style.display = 'flex';
        renderExamGrid();
    }
}

function renderSubjectGrid() {
    const grid = document.getElementById('exam-grid');
    if (!grid || !window.allExamsData) return;
    grid.innerHTML = '';
    
    // Group by Subject
    const subjectMap = {};
    window.allExamsData.forEach(examGroup => {
        if (examGroup.exams) {
            examGroup.exams.forEach(ex => {
                if (!subjectMap[ex.subject]) subjectMap[ex.subject] = { count: 0, subject: ex.subject };
                subjectMap[ex.subject].count += ex.count;
            });
        }
    });
    
    const subjects = Object.values(subjectMap).sort((a, b) => b.count - a.count);
    
    if (subjects.length === 0) {
        grid.innerHTML = '<p style="color:var(--text-secondary);">No subjects found.</p>';
        return;
    }
    
    subjects.forEach(sub => {
        const card = document.createElement('div');
        card.className = 'exam-card';
        card.style.position = 'relative';
        
        card.innerHTML = `
            <h3 title="${sub.subject}">${sub.subject}</h3>
            <p>All Exams</p>
            <span class="meta">${sub.count} Total Questions</span>
        `;
        
        // Pass null for examId, and sub.subject for subject
        card.onclick = () => openTest(null, sub.subject);
        grid.appendChild(card);
    });
}

function renderExamGrid() {
    if (window.dashboardMode !== 'exam') return;
    const grid = document.getElementById('exam-grid');
    if (!grid || !window.allExamsData) return;
    
    grid.innerHTML = '';
    
    // Identify the first 2 tests for the '2 Free Tests' offer
    let freeTests = [];
    if (window.allExamsData && window.allExamsData.length > 0) {
        let examsForFree = [...window.allExamsData];
        const extractYear = (str) => {
            const marathiToEnglish = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };
            const engStr = (str || '').replace(/[०-९]/g, m => marathiToEnglish[m]);
            const match = engStr.match(/\b(19\d{2}|20\d{2})\b/);
            return match ? parseInt(match[1], 10) : 0;
        };
        examsForFree.sort((a, b) => {
            const idA = a._id || '';
            const idB = b._id || '';
            const yearA = extractYear(idA);
            const yearB = extractYear(idB);
            if (yearA !== yearB) return yearB - yearA; 
            return idA.localeCompare(idB);
        });
        freeTests = examsForFree.slice(0, 2).map(e => e._id);
    }
    
    // Process and sort exams
    let exams = [...window.allExamsData];
    
    // Sort by year (descending) extracted from name
    const extractYearMain = (str) => {
        const marathiToEnglish = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };
        const engStr = (str || '').replace(/[०-९]/g, m => marathiToEnglish[m]);
        const match = engStr.match(/\b(19\d{2}|20\d{2})\b/);
        return match ? parseInt(match[1], 10) : 0;
    };
    exams.sort((a, b) => {
        const idA = a._id || '';
        const idB = b._id || '';
        const yearA = extractYearMain(idA);
        const yearB = extractYearMain(idB);
        if (yearA !== yearB) return yearB - yearA; // Newest first
        return idA.localeCompare(idB);
    });
    
    // Filter based on selected tab
    const filter = window.currentExamFilter || 'all';
    if (filter === 'mains') {
        exams = exams.filter(e => /main|paper 1|paper 2|p\s?1|p\s?2|paper-1|paper-2/i.test(e._id));
    } else if (filter === 'prelims') {
        exams = exams.filter(e => !(/main|paper 1|paper 2|p\s?1|p\s?2|paper-1|paper-2/i.test(e._id)));
    }
    
    if (exams.length === 0) {
        grid.innerHTML = '<p style="color:var(--text-secondary);">No exams found in this category.</p>';
        return;
    }
    
    exams.forEach(yearGroup => {
        const yearExam = yearGroup._id;
        
        // Calculate total questions across all subjects
        const totalQuestions = yearGroup.exams.reduce((sum, exam) => sum + exam.count, 0);
        
        const stats = window.progressSectionWise[yearExam] || { solved: 0, correct: 0 };
        const isFree = freeTests.includes(yearExam) && currentUser && currentUser.hasUsedFreeTrial;
        
        const card = document.createElement('div');
        card.className = 'exam-card';
        card.style.position = 'relative';
        if (isFree) {
            card.style.border = '2px solid var(--accent)';
        }
        
        card.innerHTML = `
            ${isFree ? '<span style="position:absolute; top:-10px; right:10px; background:var(--accent); color:#fff; padding:2px 8px; border-radius:12px; font-size:0.75rem; font-weight:bold;">FREE</span>' : ''}
            <h3 title="${yearExam || 'Unknown Exam'}">${yearExam || 'Unknown Exam'}</h3>
            <p>${yearGroup.exams.length} Subjects Included</p>
            <span class="meta">${totalQuestions} Total Questions</span>
            <div style="margin-top: 10px; font-size: 0.9rem; color: var(--accent);">
                Attempted: ${stats.solved} / ${totalQuestions}
            </div>
            ${stats.solved > 0 ? `<button class="btn btn-outline" style="width: 100%; margin-top: 15px; font-size: 0.85rem; padding: 5px; border-color: var(--error); color: var(--error);" onclick="event.stopPropagation(); resetProgress('${yearExam}')">Reset Progress</button>` : ''}
        `;
        
        card.onclick = () => openTest(yearExam);
        grid.appendChild(card);
    });
}

// Reset Progress Function
async function resetProgress(examId) {
    if (!confirm(`Are you sure you want to reset all your progress for "${examId}"?`)) return;

    try {
        const userToken = localStorage.getItem('jwtToken');
        const res = await fetch('/api/progress/reset', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userToken}` 
            },
            body: JSON.stringify({ section: examId })
        });
        const data = await res.json();
        
        if (data.success) {
            // Also wipe from local cache
            if (userAnswers) {
                for (const qId in userAnswers) {
                    if (userAnswers[qId].section === examId) {
                        delete userAnswers[qId];
                    }
                }
                localStorage.setItem('mpsc_user_answers', JSON.stringify(userAnswers));
            }
            alert(`Progress for ${examId} has been reset.`);
            loadDashboard(); // Reload UI
        } else {
            alert('Failed to reset progress.');
        }
    } catch (err) {
        alert('Error resetting progress.');
    }
}

// ====== TEST LOGIC ======
let currentQuestions = [];
let currentQIndex = 0;

window.showGlobalLoader = function(text = "Loading...") {
    const loader = document.getElementById('global-loader');
    if (loader) {
        document.getElementById('global-loader-text').innerText = text;
        loader.style.display = 'flex';
    }
}

window.hideGlobalLoader = function() {
    const loader = document.getElementById('global-loader');
    if (loader) loader.style.display = 'none';
}

async function openTest(yearExam, subject = null) {
    showGlobalLoader("Loading Exam Paper...");
    // Attempt to load questions
    try {
        const bodyData = {};
        if (yearExam) bodyData.year_exam = yearExam;
        if (subject) bodyData.subject = subject;

        const res = await fetch('/api/questions', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify(bodyData)
        });
        
        const data = await res.json();
        
        if (res.status === 403 && data.code === 'SUBSCRIPTION_REQUIRED') {
            // User not subscribed
            showSection('payment-section');
            return;
        }

        if (data.success) {
            currentQuestions = data.data;
            if (currentQuestions.length === 0) {
                alert("No questions found for this selection.");
                return;
            }
            
            if (document.getElementById('test-title')) {
                document.getElementById('test-title').innerText = yearExam ? `${yearExam}` : `${subject} (All Exams)`;
            } else if (document.getElementById('crumb-year')) {
                document.getElementById('crumb-year').innerText = yearExam ? `${yearExam}` : `${subject} (All Exams)`;
                if (document.getElementById('crumb-exam')) document.getElementById('crumb-exam').innerText = '';
                if (document.getElementById('crumb-subject')) document.getElementById('crumb-subject').innerText = '';
            }
            
            // Render Filters
            renderSubjectFilters();
            
            // Initially show all
            filterQuestions(null, null);

            showSection('test-section');
            // Default to Full Paper Mode
            switchMode('full');

            // Admin features
            if (currentUser && currentUser.isAdmin) {
                const btnFixAll = document.getElementById('btn-ai-fix-all');
                if (btnFixAll) btnFixAll.classList.remove('hidden');
            } else {
                const btnFixAll = document.getElementById('btn-ai-fix-all');
                if (btnFixAll) btnFixAll.classList.add('hidden');
            }
        } else {
            if (data.message && data.message.includes('Subscription')) {
                showSection('payment-section');
            } else {
                alert(data.message || 'Error fetching questions.');
            }
        }
    } catch (err) {
        alert('Server error.');
    } finally {
        hideGlobalLoader();
    }
}

function renderQuizQuestion(index, questions = currentQuestions) {
    const qContainer = document.getElementById('quiz-question-container');
    const q = questions[index];
    if (!q) return;

    let html = `
        <div class="q-header">
            <span class="q-num">Question ${q.qnum || index + 1}</span>
            <span style="float: right; font-size: 0.85rem; color: var(--text-secondary); text-align: right;">
                ${q.official_exam_name || ''} <br>
                ${q.exam_date ? `(${q.exam_date})` : ''}
            </span>
        </div>
        <div class="q-text" style="clear: both; padding-top: 10px;">`;
        
        // Handle Passages
        if (q.passage_text && q.passage_text !== "null") {
            html += `<div style="margin-bottom: 20px; padding: 15px; background: var(--hover-color); border-radius: 8px; border-left: 4px solid var(--primary-color); font-size: 0.95rem; line-height: 1.6;"><strong>Passage:</strong><br><br>${q.passage_text.replace(/\n/g, '<br>')}</div>`;
        } else if (q.passage_marathi && q.passage_marathi !== "null") {
            html += `<div style="margin-bottom: 20px; padding: 15px; background: var(--hover-color); border-radius: 8px; border-left: 4px solid var(--primary-color); font-size: 0.95rem; line-height: 1.6;"><strong>Passage:</strong><br><br>${q.passage_marathi.replace(/\n/g, '<br>')}</div>`;
        }
        
        if (q.passage_english && q.passage_english !== "null") {
            html += `<div style="margin-bottom: 20px; padding: 15px; background: var(--hover-color); border-radius: 8px; border-left: 4px solid var(--primary-color); font-size: 0.95rem; line-height: 1.6;"><strong>Passage (English):</strong><br><br>${q.passage_english.replace(/\n/g, '<br>')}</div>`;
        }
        
        if (q.has_diagram_or_passage && (!q.passage_marathi || q.passage_marathi === "null") && (!q.passage_english || q.passage_english === "null") && (!q.passage_text || q.passage_text === "null")) {
            html += `<div style="margin-bottom: 20px; padding: 15px; background: var(--hover-color); border-radius: 8px; border-left: 4px solid #f59e0b; font-size: 0.95rem;">
                <strong>Note:</strong> This question contains a diagram. Please click "View Original Image" below to see it.
                ${q.diagram_description ? `<br><br><strong>Diagram Description:</strong> ${q.diagram_description}` : ''}
            </div>`;
        }

        html += `<h4>Q${q.qnum || index + 1}. ${q.text ? q.text.replace(/\n/g, '<br>') : ''}</h4>
            ${q.text_eng ? `<p style="${q.text ? 'color: var(--text-secondary); margin-top: 10px;' : ''}">${q.text_eng.replace(/\n/g, '<br>')}</p>` : ''}
            ${!q.text && !q.text_eng ? '<p>No text available</p>' : ''}
        </div>
    `;

    if (q.original_image_url) {
        const fileIdStr = typeof q.original_image_url === 'object' ? encodeURIComponent(JSON.stringify(q.original_image_url)) : q.original_image_url;
        html += `<button class="btn btn-secondary" style="margin-bottom: 15px; margin-right: 10px;" onclick="openImageModal('${fileIdStr}')">👁 View Original Image</button>`;
    }

    if (currentUser && currentUser.isAdmin) {
        html += `<button class="btn" id="btn-fix-${q._id}" style="margin-bottom: 15px; background: #8b5cf6; color: #fff;" onclick="fixQuestion('${q._id}')">🤖 AI Fix</button>`;
    }

    html += `<div class="options">`;
    const options = q.options && q.options.length > 0 ? q.options : [];
    const optionsEng = q.options_eng && q.options_eng.length > 0 ? q.options_eng : [];
    const maxLen = Math.max(options.length, optionsEng.length);
    const correctOptIndex = parseInt(q.correct_answer_option || q.final_answer_key || q.answer_key) - 1;

    for (let oIdx = 0; oIdx < maxLen; oIdx++) {
        const isCorrect = oIdx === correctOptIndex;
        const opt = options[oIdx] ? options[oIdx] : '';
        const optEng = optionsEng[oIdx] ? optionsEng[oIdx] : '';
        
        let optHtml = opt;
        if (opt && optEng) optHtml += `<br><small style="color: var(--text-secondary);">${optEng}</small>`;
        else if (optEng) optHtml += optEng;
        
        const answered = userAnswers[q._id];
        let extraClass = '';
        let onClickHtml = `onclick="selectOption(this, '${q._id}', 'quiz', ${index}, ${oIdx})"`;
        if (answered) {
            onClickHtml = ''; // disable click
            const correctStr = String(q.correct_answer_option || q.final_answer_key || q.answer_key).trim();
            if (correctStr === "#") {
                if (answered.selected === oIdx) {
                    extraClass = 'wrong';
                    optHtml += ' <span style="font-weight:bold; color:#f59e0b;">(Cancelled by MPSC)</span>';
                }
            } else {
                const correctOptIndex = parseInt(correctStr) - 1;
                const isActuallyCorrect = (oIdx === correctOptIndex);
                if (isActuallyCorrect) {
                    extraClass = 'correct';
                } else if (answered.selected === oIdx) {
                    extraClass = 'wrong';
                }
            }
        }
        
        html += `<div class="option ${extraClass}" ${onClickHtml}>${optHtml}</div>`;
    }
    html += `</div>`;
    
    // Construct Options Explanation HTML if available
    let optsExplHtml = '';
    if (q.options_explanation && q.options_explanation.length > 0) {
        optsExplHtml = `<div style="margin-top: 15px; padding-top: 15px; border-top: 1px dashed var(--border-color);">
            <strong>Options Breakdown:</strong>
            <ul style="margin-top: 10px; padding-left: 20px; font-size: 0.9rem; color: var(--text-secondary);">
                ${q.options_explanation.map(exp => `<li style="margin-bottom: 8px;">${exp.replace(/\n/g, '<br>')}</li>`).join('')}
            </ul>
        </div>`;
    }

    html += `
        <div id="explanation-quiz-${q._id}" class="explanation ${userAnswers[q._id] ? '' : 'hidden'}">
            <strong>Explanation:</strong> ${q.toppers_explanation_marathi ? q.toppers_explanation_marathi.replace(/\n/g, '<br>') : 'No explanation available.'}
            ${optsExplHtml}
        </div>
    `;

    qContainer.innerHTML = html;
    document.getElementById('quiz-progress-text').innerText = `${index + 1} / ${questions.length}`;
}

// ====== FILTER LOGIC ======
let activeSubject = null;
let activeTopic = null;

function renderSubjectFilters() {
    const subjectContainer = document.getElementById('subject-filters');
    const topicContainer = document.getElementById('topic-filters');
    if (!subjectContainer) return;
    subjectContainer.innerHTML = '';
    topicContainer.innerHTML = '';
    topicContainer.classList.add('hidden'); // Hide topics initially

    // Extract unique subjects
    const subjects = [...new Set(currentQuestions.map(q => q.subject).filter(Boolean))];
    
    // Add "All Subjects" button
    const btnAll = document.createElement('button');
    btnAll.className = 'filter-btn active';
    btnAll.innerText = 'All Subjects';
    btnAll.onclick = () => {
        document.querySelectorAll('#subject-filters .filter-btn').forEach(b => b.classList.remove('active'));
        btnAll.classList.add('active');
        activeSubject = null;
        topicContainer.classList.add('hidden');
        filterQuestions(null, null);
    };
    subjectContainer.appendChild(btnAll);

    // Add specific subjects
    subjects.forEach(sub => {
        const btn = document.createElement('button');
        btn.className = 'filter-btn';
        btn.innerText = sub;
        btn.onclick = () => {
            document.querySelectorAll('#subject-filters .filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeSubject = sub;
            renderTopicFilters(sub);
            filterQuestions(sub, null);
        };
        subjectContainer.appendChild(btn);
    });
}

function renderTopicFilters(subject) {
    const topicContainer = document.getElementById('topic-filters');
    if (!topicContainer) return;
    topicContainer.innerHTML = '';
    topicContainer.classList.remove('hidden');

    const topics = [...new Set(currentQuestions.filter(q => q.subject === subject).map(q => q.topic).filter(Boolean))];
    
    if (topics.length === 0) {
        topicContainer.classList.add('hidden');
        return;
    }

    const btnAll = document.createElement('button');
    btnAll.className = 'filter-btn active';
    btnAll.innerText = 'All Topics';
    btnAll.onclick = () => {
        document.querySelectorAll('#topic-filters .filter-btn').forEach(b => b.classList.remove('active'));
        btnAll.classList.add('active');
        activeTopic = null;
        filterQuestions(activeSubject, null);
    };
    topicContainer.appendChild(btnAll);

    topics.forEach(top => {
        const btn = document.createElement('button');
        btn.className = 'filter-btn';
        btn.innerText = top;
        btn.onclick = () => {
            document.querySelectorAll('#topic-filters .filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeTopic = top;
            filterQuestions(activeSubject, top);
        };
        topicContainer.appendChild(btn);
    });
}

function filterQuestions(subject, topic) {
    let filtered = currentQuestions;
    if (subject) filtered = filtered.filter(q => q.subject === subject);
    if (topic) filtered = filtered.filter(q => q.topic === topic);

    renderFullPaper(filtered);
    
    // For Quiz mode, reset index
    if (filtered.length > 0) {
        currentQIndex = 0;
        renderQuizQuestion(currentQIndex, filtered);
    } else {
        document.getElementById('quiz-view').innerHTML = '<p style="padding: 20px;">No questions found for this filter.</p>';
    }
}

// ====== RENDER FULL PAPER ======
function renderFullPaper(questions = currentQuestions) {
    const list = document.getElementById('full-questions-list');
    const jumpGrid = document.getElementById('jump-grid');
    list.innerHTML = '';
    jumpGrid.innerHTML = '';

    
    if (questions.length === 0) {
        list.innerHTML = '<p style="padding: 20px;">No questions found.</p>';
        return;
    }

    questions.forEach((q, idx) => {
        // Build list item
        const qDiv = document.createElement('div');
        qDiv.className = 'question-item glass-panel';
        qDiv.style.padding = '15px';
        qDiv.style.marginBottom = '15px';
        qDiv.style.borderRadius = 'var(--radius-lg)';
        qDiv.id = `full-q-${idx}`;

        let html = `
            <div style="font-size: 0.85rem; color: var(--text-secondary); text-align: right; margin-bottom: 10px; border-bottom: 1px solid var(--border-color); padding-bottom: 5px;">
                ${q.official_exam_name || ''} ${q.exam_date ? `(${q.exam_date})` : ''}
            </div>
        `;
        // Handle Passages
        if (q.passage_text && q.passage_text !== "null") {
            html += `<div style="margin-bottom: 20px; padding: 15px; background: var(--hover-color); border-radius: 8px; border-left: 4px solid var(--primary-color); font-size: 0.95rem; line-height: 1.6;"><strong>Passage:</strong><br><br>${q.passage_text.replace(/\n/g, '<br>')}</div>`;
        } else if (q.passage_marathi && q.passage_marathi !== "null") {
            html += `<div style="margin-bottom: 20px; padding: 15px; background: var(--hover-color); border-radius: 8px; border-left: 4px solid var(--primary-color); font-size: 0.95rem; line-height: 1.6;"><strong>Passage:</strong><br><br>${q.passage_marathi.replace(/\n/g, '<br>')}</div>`;
        }
        
        if (q.passage_english && q.passage_english !== "null") {
            html += `<div style="margin-bottom: 20px; padding: 15px; background: var(--hover-color); border-radius: 8px; border-left: 4px solid var(--primary-color); font-size: 0.95rem; line-height: 1.6;"><strong>Passage (English):</strong><br><br>${q.passage_english.replace(/\n/g, '<br>')}</div>`;
        }
        
        if (q.has_diagram_or_passage && (!q.passage_marathi || q.passage_marathi === "null") && (!q.passage_english || q.passage_english === "null") && (!q.passage_text || q.passage_text === "null")) {
            html += `<div style="margin-bottom: 20px; padding: 15px; background: var(--hover-color); border-radius: 8px; border-left: 4px solid #f59e0b; font-size: 0.95rem;">
                <strong>Note:</strong> This question contains a diagram. Please click "View Original Image" below to see it.
                ${q.diagram_description ? `<br><br><strong>Diagram Description:</strong> ${q.diagram_description}` : ''}
            </div>`;
        }

        html += `<h4>${q.qnum || idx + 1}. ${q.text ? q.text.replace(/\n/g, '<br>') : ''}</h4>
                 ${q.text_eng ? `<p style="color: var(--text-secondary); margin-bottom: 20px;">${q.text_eng.replace(/\n/g, '<br>')}</p>` : ''}`;
        if (!q.text && !q.text_eng) html += `<p>No text available</p>`;
        
        if (q.original_image_url) {
            const fileIdStr = typeof q.original_image_url === 'object' ? encodeURIComponent(JSON.stringify(q.original_image_url)) : q.original_image_url;
            html += `<button class="btn btn-secondary" style="margin-bottom: 15px; margin-right: 10px;" onclick="openImageModal('${fileIdStr}')">👁 View Original Image</button>`;
        }
        
        if (currentUser && currentUser.isAdmin) {
            html += `<button class="btn" id="btn-fix-full-${q._id}" style="margin-bottom: 15px; background: #8b5cf6; color: #fff;" onclick="fixQuestion('${q._id}', 'full')">🤖 AI Fix</button>`;
        }
        
        html += `<div class="options">`;
        const options = q.options && q.options.length > 0 ? q.options : [];
        const optionsEng = q.options_eng && q.options_eng.length > 0 ? q.options_eng : [];
        const maxLen = Math.max(options.length, optionsEng.length);
        const correctOptIndex = parseInt(q.correct_answer_option || q.final_answer_key || q.answer_key) - 1;

        for (let oIdx = 0; oIdx < maxLen; oIdx++) {
            const isCorrect = oIdx === correctOptIndex;
            const opt = options[oIdx] ? options[oIdx] : '';
            const optEng = optionsEng[oIdx] ? optionsEng[oIdx] : '';
            
            let optHtml = opt;
            if (opt && optEng) optHtml += `<br><small style="color: var(--text-secondary);">${optEng}</small>`;
            else if (optEng) optHtml += optEng;
            
            // Check if user already answered this
            const answered = userAnswers[q._id];
            let extraClass = '';
            let onClickHtml = `onclick="selectOption(this, '${q._id}', 'full', ${idx}, ${oIdx})"`;
            if (answered) {
                onClickHtml = ''; // disable click
                const correctStr = String(q.correct_answer_option || q.final_answer_key || q.answer_key).trim();
                if (correctStr === "#") {
                    if (answered.selected === oIdx) {
                        extraClass = 'wrong';
                        optHtml += ' <span style="font-weight:bold; color:#f59e0b;">(Cancelled by MPSC)</span>';
                    }
                } else {
                    const correctOptIndex = parseInt(correctStr) - 1;
                    const isActuallyCorrect = (oIdx === correctOptIndex);
                    if (isActuallyCorrect) {
                        extraClass = 'correct';
                    } else if (answered.selected === oIdx) {
                        extraClass = 'wrong';
                    }
                }
            }

            html += `<div class="option ${extraClass}" ${onClickHtml}>${optHtml}</div>`;
        }
        
        html += `</div>`;
        
        // Construct Options Explanation HTML if available
        let optsExplHtml = '';
        if (q.options_explanation && q.options_explanation.length > 0) {
            optsExplHtml = `<div style="margin-top: 15px; padding-top: 15px; border-top: 1px dashed var(--border-color);">
                <strong>Options Breakdown:</strong>
                <ul style="margin-top: 10px; padding-left: 20px; font-size: 0.9rem; color: var(--text-secondary);">
                    ${q.options_explanation.map(exp => `<li style="margin-bottom: 8px;">${exp.replace(/\n/g, '<br>')}</li>`).join('')}
                </ul>
            </div>`;
        }

        const showExpl = userAnswers[q._id] ? '' : 'hidden';
        html += `
            <div id="explanation-full-${q._id}" class="explanation ${showExpl}">
                <strong>Explanation:</strong> ${q.toppers_explanation_marathi ? q.toppers_explanation_marathi.replace(/\n/g, '<br>') : 'No explanation available.'}
                ${optsExplHtml}
            </div>
        `;
        qDiv.innerHTML = html;
        list.appendChild(qDiv);
    });

    let gridHtml = `
        <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px;">
    `;
    
    questions.forEach((q, idx) => {
        let btnColor = '';
        if (userAnswers[q._id]) {
            if (userAnswers[q._id].isCancelled) {
                btnColor = 'background: #f59e0b; color: white; border-color: transparent;'; // Orange
            } else {
                btnColor = userAnswers[q._id].isCorrect ? 'background: #10b981; color: white; border-color: transparent;' : 'background: #ef4444; color: white; border-color: transparent;';
            }
        }
        gridHtml += `<button id="grid-btn-${idx}" class="btn btn-outline grid-btn" style="${btnColor}" onclick="document.getElementById('full-q-${idx}').scrollIntoView({behavior: 'smooth', block: 'start'})">${q.qnum || idx + 1}</button>`;
    });
    
    gridHtml += `</div>`;
    jumpGrid.innerHTML = gridHtml;
    
    updateFloatingStats(questions);
}

function updateFloatingStats(questions) {
    let totalAttempted = 0;
    let totalCorrect = 0;
    
    questions.forEach(q => {
        if (userAnswers[q._id]) {
            totalAttempted++;
            if (userAnswers[q._id].isCorrect) totalCorrect++;
        }
    });
    
    const statAttempted = document.getElementById('stat-attempted');
    const statCorrect = document.getElementById('stat-correct');
    if (statAttempted) statAttempted.innerText = totalAttempted;
    if (statCorrect) statCorrect.innerText = totalCorrect;
}

function prevQuestion() {
    if (currentQIndex > 0) {
        currentQIndex--;
        renderQuizQuestion(currentQIndex);
    }
}

function nextQuestion() {
    if (currentQIndex < currentQuestions.length - 1) {
        currentQIndex++;
        renderQuizQuestion(currentQIndex);
    }
}

// Quiz Option Selection Logic (Updated for real data)
async function selectOption(el, questionId, mode, index = 0, optIndex = 0) {
    const parent = el.parentElement;
    if (parent.classList.contains('answered') || parent.classList.contains('loading')) return;
    
    parent.classList.add('loading');
    const originalHtml = el.innerHTML;
    el.innerHTML += ' <span style="font-size:0.8em; color:var(--text-secondary);">(Checking...)</span>';

    const sectionName = currentQuestions[mode === 'full' ? index : currentQIndex].year_exam;
    
    try {
        const res = await fetch('/api/progress/save', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({
                questionId: questionId,
                section: sectionName,
                selectedOption: optIndex
            })
        });
        const data = await res.json();
        
        parent.classList.remove('loading');
        el.innerHTML = originalHtml;

        if (!data.success) {
            alert(data.message || "Failed to submit answer.");
            return;
        }

        parent.classList.add('answered');
        const { isCorrect, isCancelled, correctOptionIndex, explanation, optionsExplanation } = data;

        if (isCancelled) {
            el.classList.add('wrong');
            el.style.background = '#f59e0b'; // orange for cancelled
            el.style.borderColor = '#f59e0b';
            el.innerHTML += ' <span style="font-weight:bold; color:#fff;">(Cancelled by MPSC)</span>';
        } else if (isCorrect) {
            el.classList.add('correct');
        } else {
            el.classList.add('wrong');
            if(correctOptionIndex >= 0 && correctOptionIndex < parent.children.length) {
                parent.children[correctOptionIndex].classList.add('correct');
            }
        }
        
        Array.from(parent.children).forEach(optDiv => {
            optDiv.onclick = null; // Disable clicks after answering
        });

        // Save to local cache
        userAnswers[questionId] = { selected: optIndex, isCorrect: isCorrect, isCancelled: isCancelled, section: sectionName };
        localStorage.setItem('mpsc_user_answers', JSON.stringify(userAnswers));

        // Update explanation HTML with backend data
        const explId = mode === 'full' ? `explanation-full-${questionId}` : `explanation-quiz-${questionId}`;
        const explanationDiv = document.getElementById(explId);
        if(explanationDiv) {
            let explHtml = `<strong>Explanation:</strong> ${explanation ? explanation.replace(/\n/g, '<br>') : 'No explanation available.'}`;
            if (optionsExplanation && optionsExplanation.length > 0) {
                explHtml += `<div style="margin-top: 15px; padding-top: 15px; border-top: 1px dashed var(--border-color);">
                    <strong>Options Breakdown:</strong>
                    <ul style="margin-top: 10px; padding-left: 20px; font-size: 0.9rem; color: var(--text-secondary);">
                        ${optionsExplanation.map(exp => `<li style="margin-bottom: 8px;">${exp.replace(/\n/g, '<br>')}</li>`).join('')}
                    </ul>
                </div>`;
            }
            explanationDiv.innerHTML = explHtml;
            explanationDiv.classList.remove('hidden');
        }

        // Update Jump Grid if in full mode
        if (mode === 'full') {
            const gridBtn = document.getElementById(`grid-btn-${index}`);
            if(gridBtn) {
                gridBtn.classList.remove('btn-outline');
                gridBtn.style.color = '#fff';
                gridBtn.style.borderColor = 'transparent';
                if (isCancelled) {
                    gridBtn.style.background = '#f59e0b'; // orange
                } else if (isCorrect) {
                    gridBtn.style.background = '#10b981'; // green
                } else {
                    gridBtn.style.background = '#ef4444'; // red
                }
            }
            // Update Stats UI
            updateFloatingStats(currentQuestions);
        }

    } catch (err) {
        parent.classList.remove('loading');
        el.innerHTML = originalHtml;
        console.error(err);
        alert("Network error.");
    }
}

// ====== PAYMENT & RAZORPAY ======
async function startFreeTrial() {
    if (!confirm("Are you sure you want to unlock your first 2 free tests now?")) return;
    
    try {
        const res = await fetch('/api/payment/free-trial', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            }
        });
        const data = await res.json();
        
        if (data.success) {
            localStorage.setItem('currentUser', JSON.stringify(data.user));
            alert("First 2 tests unlocked successfully! Enjoy premium access to these tests.");
            // Also explicitly update the global currentUser obj so UI updates immediately
            if(currentUser) currentUser.hasUsedFreeTrial = true;
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            window.location.reload();
        } else {
            alert(data.message || "Failed to activate free trial.");
        }
    } catch (err) {
        alert("Network error while activating free trial.");
    }
}

async function initiatePayment(planId) {
    try {
        const res = await fetch('/api/payment/create-order', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({ planId })
        });
        const data = await res.json();
        
        if (data.success) {
            const options = {
                key: data.key_id, // Dynamically fetched from backend
                amount: data.order.amount,
                currency: data.order.currency,
                name: "MPSC PYQ Portal",
                description: "Premium Lifetime Access",
                order_id: data.order.id,
                handler: async function (response) {
                    try {
                        const verifyRes = await fetch('/api/payment/verify-payment', {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${token}` 
                            },
                            body: JSON.stringify({
                                razorpay_payment_id: response.razorpay_payment_id,
                                razorpay_order_id: response.razorpay_order_id,
                                razorpay_signature: response.razorpay_signature,
                                planId: planId
                            })
                        });
                        const verifyData = await verifyRes.json();
                        if (verifyData.success) {
                            if (verifyData.user) {
                                localStorage.setItem('currentUser', JSON.stringify(verifyData.user));
                            }
                            alert("Payment Successful! Refreshing your account...");
                            window.location.reload();
                        } else {
                            alert("Payment verification failed: " + verifyData.message);
                        }
                    } catch (err) {
                        alert("Error during payment verification.");
                    }
                },
                prefill: {
                    email: currentUser ? currentUser.email : ''
                },
                theme: { color: "#3b82f6" }
            };
            const rzp = new Razorpay(options);
            rzp.on('payment.failed', function (response){
                alert("Payment Failed: " + response.error.description);
            });
            rzp.open();
        } else {
            alert("Order creation failed.");
        }
    } catch (err) {
        alert("Payment initiation failed.");
    }
}

// ====== MODAL ======
const modal = document.getElementById('image-modal');
const modalImg = document.getElementById('modal-img');
const closeBtn = document.querySelector('.close-modal');
let zoomLevel = 1;

window.openImageModal = function(src) {
    showGlobalLoader("Loading Image...");
    modal.style.display = 'flex';
    void modal.offsetWidth; 
    modal.classList.add('show');
    
    // Hide image until loaded
    modalImg.style.visibility = 'hidden';
    modalImg.onload = function() {
        modalImg.style.visibility = 'visible';
        hideGlobalLoader();
    };
    modalImg.onerror = function() {
        hideGlobalLoader();
        alert("Failed to load image.");
    };
    
    // If src doesn't start with /api/image/, it's likely a raw file ID
    if (!src.startsWith('/api/image/')) {
        src = '/api/image/' + src;
    }
    
    const userToken = localStorage.getItem('jwtToken');
    if (userToken) {
        src += `?token=${userToken}`;
    }
    modalImg.src = src;
    
    zoomLevel = 1;
    translateX = 0;
    translateY = 0;
    modalImg.style.transform = `translate(0px, 0px) scale(${zoomLevel})`;
    modalImg.style.cursor = 'zoom-in';
    modalImg.style.transformOrigin = `center center`;
    
    // Reset width changes from previous bug
    modalImg.style.width = '';
    modalImg.style.height = '';
    modalImg.style.maxWidth = '';
}

window.closeImageModal = function() {
    modal.classList.remove('show');
    setTimeout(() => {
        modal.style.display = "none";
    }, 300);
}

closeBtn.onclick = closeImageModal;

modal.onclick = function(e) {
    if (e.target === modal || e.target.classList.contains('modal-content-wrapper')) {
        closeImageModal();
    }
}

// Drag state for panning
let isDragging = false;
let startX, startY, translateX = 0, translateY = 0;

// Click to zoom (like before, but more zoom)
modalImg.addEventListener('click', (e) => {
    e.stopPropagation();
    if (zoomLevel === 1) {
        zoomLevel = 3; // Zoom in a lot
        const rect = modalImg.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        modalImg.style.transformOrigin = `${x}% ${y}%`;
    } else {
        zoomLevel = 1;
        translateX = 0;
        translateY = 0;
        modalImg.style.transformOrigin = `center center`;
    }
    modalImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${zoomLevel})`;
    modalImg.style.cursor = zoomLevel === 1 ? 'zoom-in' : 'grab';
});

// Wheel zoom
modalImg.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.deltaY < 0) {
        zoomLevel += 0.25;
    } else {
        zoomLevel -= 0.25;
    }
    zoomLevel = Math.min(Math.max(1, zoomLevel), 5); // limit between 1x and 5x
    if (zoomLevel === 1) {
        translateX = 0;
        translateY = 0;
        modalImg.style.transformOrigin = 'center center';
    }
    modalImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${zoomLevel})`;
});

// Panning
modalImg.addEventListener('mousedown', (e) => {
    if (zoomLevel > 1) {
        isDragging = true;
        startX = e.clientX - translateX;
        startY = e.clientY - translateY;
        modalImg.style.cursor = 'grabbing';
    }
});
window.addEventListener('mousemove', (e) => {
    if (isDragging) {
        translateX = e.clientX - startX;
        translateY = e.clientY - startY;
        modalImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${zoomLevel})`;
    }
});
window.addEventListener('mouseup', () => {
    isDragging = false;
    if (zoomLevel > 1) modalImg.style.cursor = 'grab';
});

// Mobile Pinch and Pan
let initialDistance = null;
let initialZoom = 1;

modalImg.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
        e.preventDefault();
        initialDistance = Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY);
        initialZoom = zoomLevel;
    } else if (e.touches.length === 1 && zoomLevel > 1) {
        isDragging = true;
        startX = e.touches[0].clientX - translateX;
        startY = e.touches[0].clientY - translateY;
    }
}, {passive: false});

modalImg.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && initialDistance !== null) {
        e.preventDefault();
        const currentDistance = Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY);
        zoomLevel = initialZoom * (currentDistance / initialDistance);
        zoomLevel = Math.min(Math.max(1, zoomLevel), 5);
        modalImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${zoomLevel})`;
    } else if (e.touches.length === 1 && isDragging) {
        e.preventDefault();
        translateX = e.touches[0].clientX - startX;
        translateY = e.touches[0].clientY - startY;
        modalImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${zoomLevel})`;
    }
}, {passive: false});

modalImg.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) initialDistance = null;
    if (e.touches.length === 0) isDragging = false;
});

window.zoomImage = function(amount) {
    zoomLevel += amount;
    zoomLevel = Math.min(Math.max(1, zoomLevel), 5);
    if (zoomLevel === 1) {
        translateX = 0;
        translateY = 0;
        modalImg.style.transformOrigin = 'center center';
    }
    modalImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${zoomLevel})`;
    modalImg.style.cursor = zoomLevel === 1 ? 'zoom-in' : 'grab';
}

window.panImage = function(dx, dy) {
    if (zoomLevel > 1) {
        translateX += dx;
        translateY += dy;
        modalImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${zoomLevel})`;
    }
}

// ====== AI FIX QUESTION LOGIC (ADMIN) ======
window.fixQuestion = async function(qId, mode = 'quiz') {
    const btn = document.getElementById(mode === 'full' ? `btn-fix-full-${qId}` : `btn-fix-${qId}`);
    if (btn) {
        btn.innerText = "⏳ Queued...";
        btn.disabled = true;
    }

    try {
        const res = await fetch('/api/admin/fix-paper-bg', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({ questionIds: [qId] })
        });
        const data = await res.json();
        
        if (data.success) {
            localStorage.setItem('activeAiJobId', data.jobId);
            connectAiLiveStream(data.jobId);
            return true;
        } else {
            btn.innerText = "❌ Failed";
            btn.style.background = "#ef4444";
            console.error("AI Fix failed:", data.message);
            alert(`AI Fix Failed: ${data.message}`);
            return false;
        }
    } catch (err) {
        btn.innerText = "❌ Error";
        btn.style.background = "#ef4444";
        console.error("Network error during AI Fix:", err);
        return false;
    }
};

window.fixAllQuestions = async function() {
    if (!confirm("Are you sure you want to run AI Fix on ALL questions currently displayed? This will take some time.")) return;
    
    const btnAll = document.getElementById('btn-ai-fix-all');
    if(btnAll) {
        btnAll.disabled = true;
    }
    
    // We only process the filtered questions currently displayed
    let questionsToFix = currentQuestions;
    if (activeSubject) questionsToFix = questionsToFix.filter(q => q.subject === activeSubject);
    if (activeTopic) questionsToFix = questionsToFix.filter(q => q.topic === activeTopic);

    const questionIds = questionsToFix.map(q => q._id);
    
    try {
        const res = await fetch('/api/admin/fix-paper-bg', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({ questionIds })
        });
        const data = await res.json();
        
        if (data.success) {
            localStorage.setItem('activeAiJobId', data.jobId);
            connectAiLiveStream(data.jobId);
        } else {
            alert("Failed to start background job.");
            if(btnAll) btnAll.disabled = false;
        }
    } catch (err) {
        console.error(err);
        alert("Network error.");
        if(btnAll) btnAll.disabled = false;
    }
};

window.connectAiLiveStream = function(jobId) {
    if (!jobId) return;
    
    const panel = document.getElementById('ai-live-panel');
    const content = document.getElementById('ai-live-content');
    if (panel) panel.style.display = 'flex';
    
    if (window.activeAiEventSource) {
        window.activeAiEventSource.close();
    }
    const es = new EventSource(`/api/admin/fix-stream/${jobId}?token=${token}`);
    window.activeAiEventSource = es;
    
    es.onmessage = function(event) {
        const data = JSON.parse(event.data);
        
        if (data.type === 'error') {
            content.innerHTML += `<br/><span style="color: #ef4444;">[System] Error: ${data.message}</span>`;
            es.close();
            localStorage.removeItem('activeAiJobId');
        } else if (data.type === 'init') {
            content.innerHTML += `<br/><span style="color: #64748b;">[Queue] Job attached. Processing...</span>`;
        } else if (data.type === 'chunk') {
            content.innerHTML += data.chunk;
            content.scrollTop = content.scrollHeight;
        } else if (data.type === 'question_start') {
            content.innerHTML = `<span style="color: #f59e0b;">[Queue] Starting Question ${data.index + 1}...</span><br/>`;
        } else if (data.type === 'question_done') {
            content.innerHTML += `<br/><span style="color: #10b981;">[Queue] Question ${data.index + 1} Fixed Successfully!</span>`;
            
            // Update local state and UI
            const qIndex = currentQuestions.findIndex(q => q._id === data.question._id);
            if (qIndex > -1) {
                currentQuestions[qIndex] = data.question;
            }
            const btn = document.getElementById(`btn-fix-full-${data.question._id}`) || document.getElementById(`btn-fix-${data.question._id}`);
            if (btn) {
                btn.innerText = "✅ Fixed!";
                btn.style.background = "#10b981";
            }
            setTimeout(() => {
                const quizView = document.getElementById('quiz-view');
                if (quizView && quizView.style.display !== 'none') {
                    renderQuizQuestion(qIndex, currentQuestions);
                } else {
                    renderFullPaper(currentQuestions);
                }
            }, 500);

        } else if (data.type === 'question_failed') {
            content.innerHTML += `<br/><span style="color: #ef4444;">[Queue] Question ${data.index + 1} Failed: ${data.error}</span><br/><button onclick="retryAiQuestion('${jobId}', '${data.id}')" style="background:#ef4444; color:white; border:none; padding:3px 8px; cursor:pointer; margin-top:5px; border-radius:3px;">Retry Question ${data.index + 1}</button>`;
        } else if (data.type === 'job_done') {
            content.innerHTML += `<br/><span style="color: #10b981; font-weight:bold;">[Queue] Paper completely fixed!</span>`;
            es.close();
            localStorage.removeItem('activeAiJobId');
            const btnAll = document.getElementById('btn-ai-fix-all');
            if(btnAll) {
                btnAll.innerText = '🤖 Fix Complete Paper';
                btnAll.disabled = false;
            }
        }
    };
    
    es.onerror = function() {
        content.innerHTML += `<br/><span style="color: #ef4444;">[System] Connection lost. Trying to reconnect...</span>`;
    };
};

window.retryAiQuestion = async function(jobId, questionId) {
    try {
        const res = await fetch('/api/admin/fix-retry', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({ jobId, questionId })
        });
        const data = await res.json();
        if (data.success) {
            const content = document.getElementById('ai-live-content');
            if (content) content.innerHTML += `<br/><span style="color: #f59e0b;">[Queue] Question added back to queue!</span>`;
        }
    } catch (e) {
        console.error(e);
    }
};

// Auto-connect if job was running
window.addEventListener('load', () => {
    const activeJobId = localStorage.getItem('activeAiJobId');
    if (activeJobId && document.getElementById('ai-live-panel')) {
        connectAiLiveStream(activeJobId);
    }
});


// ====== ULTRA-STRICT SECURITY LOGIC ======
document.addEventListener('contextmenu', event => event.preventDefault());
document.addEventListener('selectstart', event => event.preventDefault());

document.addEventListener('keydown', function(event) {
    if (event.key === 'F12' || event.keyCode === 123) {
        event.preventDefault();
        return false;
    }
    if (event.ctrlKey && event.shiftKey && ['I','J','C','i','j','c'].includes(event.key)) {
        event.preventDefault();
        return false;
    }
    if (event.ctrlKey && ['U','u','C','c'].includes(event.key)) {
        event.preventDefault();
        return false;
    }
});

function detectDevTools() {
    setInterval(function() {
        let startTime = performance.now();
        debugger; 
        let endTime = performance.now();
        if (endTime - startTime > 100) {
            triggerSecurityViolation();
        }
    }, 1000);
}

function triggerSecurityViolation() {
    document.body.innerHTML = `
        <div style="height: 100vh; display: flex; justify-content: center; align-items: center; background: #0f172a; color: #ef4444; font-family: sans-serif; flex-direction: column;">
            <h1 style="font-size: 2.5rem; margin-bottom: 20px;">SECURITY VIOLATION</h1>
            <p>Developer Tools access is strictly prohibited on this platform.</p>
        </div>
    `;
    while(true) {
        console.error("Security Violation. Access Denied.");
    }
}

detectDevTools();
