// ====== UI LOGIC ======

// State
let token = localStorage.getItem('jwtToken');
let currentUser = null; // { email, isSubscribed }

document.addEventListener('DOMContentLoaded', () => {
    // Check Auth State
    if (token) {
        // Assume valid for now, load dashboard
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

// Mode Switching (Quiz / Full Paper)
function switchMode(mode) {
    const btnQuiz = document.getElementById('btn-quiz');
    const btnFull = document.getElementById('btn-full');
    const quizView = document.getElementById('quiz-view');
    const fullView = document.getElementById('full-view');

    if (mode === 'quiz') {
        btnQuiz.classList.add('active');
        btnFull.classList.remove('active');
        quizView.classList.add('active');
        fullView.classList.remove('active');
    } else {
        btnFull.classList.add('active');
        btnQuiz.classList.remove('active');
        fullView.classList.add('active');
        quizView.classList.remove('active');
    }
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
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        
        if (data.success) {
            token = data.token;
            currentUser = data.user;
            localStorage.setItem('jwtToken', token);
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            showSection('dashboard-section');
            loadDashboard();
        } else {
            msg.innerText = data.message;
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
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        
        if (data.success) {
            msg.innerText = 'Registration successful! You can now login.';
            msg.style.color = 'var(--success)';
            toggleAuth('login');
        } else {
            msg.innerText = data.message;
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
    showSection('auth-section');
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
            grid.innerHTML = '';
            // data.data is grouped by Year
            data.data.forEach(yearGroup => {
                const year = yearGroup._id;
                yearGroup.exams.forEach(exam => {
                    const card = document.createElement('div');
                    card.className = 'exam-card';
                    card.innerHTML = `
                        <h3>${exam.exam_name} ${year}</h3>
                        <p>${exam.subject}</p>
                        <span class="meta">${exam.count} Questions</span>
                    `;
                    card.onclick = () => openTest(year, exam.exam_name, exam.subject);
                    grid.appendChild(card);
                });
            });
            if (data.data.length === 0) {
                grid.innerHTML = '<p style="color:var(--text-secondary);">No exams found in database.</p>';
            }
        } else {
            grid.innerHTML = '<p style="color:var(--error);">Failed to load dashboard.</p>';
        }
    } catch (err) {
        grid.innerHTML = '<p style="color:var(--error);">Failed to load dashboard.</p>';
    }
}

// ====== TEST LOGIC ======
let currentQuestions = [];
let currentQIndex = 0;

async function openTest(year, examName, subject) {
    // Attempt to load questions
    try {
        const res = await fetch('/api/questions', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({ year, exam_name: examName, subject })
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
            
            // Set breadcrumbs
            document.getElementById('crumb-year').innerText = year;
            document.getElementById('crumb-exam').innerText = examName;
            document.getElementById('crumb-subject').innerText = subject;

            showSection('test-section');
            
            // Init both modes
            currentQIndex = 0;
            renderQuizQuestion(currentQIndex);
            renderFullPaper();
            switchMode('quiz');
        } else {
            alert(data.message || 'Error fetching questions.');
        }
    } catch (err) {
        alert('Server error.');
    }
}

function renderQuizQuestion(index) {
    const qContainer = document.getElementById('quiz-question-container');
    const q = currentQuestions[index];
    if (!q) return;

    let html = `
        <div class="q-header">
            <span class="q-num">Question ${index + 1} of ${currentQuestions.length}</span>
        </div>
        <div class="q-text">
            ${q.original_marathi || 'No text available'}
        </div>
    `;

    if (q.question_image) {
        html += `<img src="${q.question_image}" style="max-width:100%; margin-bottom:15px; border-radius:8px; cursor:pointer;" onclick="openImageModal('${q.question_image}')">`;
    }

    html += `<div class="options">`;
    const options = [q.option_1, q.option_2, q.option_3, q.option_4].filter(Boolean);
    options.forEach((opt, idx) => {
        const isCorrect = (idx + 1) === parseInt(q.answer_key);
        html += `<div class="option" onclick="selectOption(this, ${isCorrect}, '${q._id}', 'quiz')">${opt}</div>`;
    });
    html += `</div>
        <div id="explanation-${q._id}" class="explanation hidden">
            <strong>Explanation:</strong> ${q.explanation || 'No explanation available.'}
        </div>
    `;

    qContainer.innerHTML = html;
    document.getElementById('quiz-progress-text').innerText = `${index + 1} / ${currentQuestions.length}`;
}

function renderFullPaper() {
    const list = document.getElementById('full-questions-list');
    const jumpGrid = document.getElementById('jump-grid');
    list.innerHTML = '';
    jumpGrid.innerHTML = '';

    currentQuestions.forEach((q, idx) => {
        // Build list item
        const qDiv = document.createElement('div');
        qDiv.className = 'question-item glass-panel';
        qDiv.style.padding = '15px';
        qDiv.style.marginBottom = '15px';
        qDiv.style.borderRadius = 'var(--radius-lg)';
        qDiv.id = `full-q-${idx}`;

        let html = `<h4>Q${idx + 1}. ${q.original_marathi || ''}</h4>`;
        if (q.question_image) {
            html += `<img src="${q.question_image}" style="max-width:100%; margin-bottom:10px; border-radius:8px; cursor:pointer;" onclick="openImageModal('${q.question_image}')">`;
        }
        
        html += `<div class="options">`;
        const options = [q.option_1, q.option_2, q.option_3, q.option_4].filter(Boolean);
        options.forEach((opt, oIdx) => {
            const isCorrect = (oIdx + 1) === parseInt(q.answer_key);
            html += `<div class="option" onclick="selectOption(this, ${isCorrect}, '${q._id}', 'full', ${idx})">${opt}</div>`;
        });
        html += `</div>
            <div id="explanation-full-${q._id}" class="explanation hidden">
                <strong>Explanation:</strong> ${q.explanation || 'No explanation available.'}
            </div>
        `;
        qDiv.innerHTML = html;
        list.appendChild(qDiv);

        // Build jump grid btn
        const btn = document.createElement('button');
        btn.className = 'grid-btn';
        btn.id = `jump-btn-${idx}`;
        btn.innerText = idx + 1;
        btn.onclick = () => {
            document.getElementById(`full-q-${idx}`).scrollIntoView({ behavior: 'smooth' });
        };
        jumpGrid.appendChild(btn);
    });
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
async function selectOption(el, isCorrect, questionId, mode, index = 0) {
    const parent = el.parentElement;
    if (parent.classList.contains('answered')) return;
    
    parent.classList.add('answered');
    
    if (isCorrect) {
        el.classList.add('correct');
    } else {
        el.classList.add('wrong');
        // Highlight correct answer
        const qIndex = mode === 'full' ? index : currentQIndex;
        const correctOptIndex = parseInt(currentQuestions[qIndex].answer_key) - 1;
        if(correctOptIndex >= 0 && correctOptIndex < parent.children.length) {
            parent.children[correctOptIndex].classList.add('correct');
        }
    }

    // Show explanation
    const explId = mode === 'full' ? `explanation-full-${questionId}` : `explanation-${questionId}`;
    const explanation = document.getElementById(explId);
    if(explanation) explanation.classList.remove('hidden');

    // Update Jump Grid if in full mode
    if (mode === 'full') {
        const jumpBtn = document.getElementById(`jump-btn-${index}`);
        if(jumpBtn) jumpBtn.classList.add('answered');
    }

    // Fire & Forget Progress Save API
    fetch('/api/progress/save', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}` 
        },
        body: JSON.stringify({
            questionId,
            isCorrect,
            section: currentQuestions[0].subject // Or passing dynamically
        })
    }).catch(console.error);
}

// ====== PAYMENT & RAZORPAY ======
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
                key: 'YOUR_RAZORPAY_KEY_ID', // Replaced in production
                amount: data.order.amount,
                currency: data.order.currency,
                name: "MPSC PYQ Portal",
                description: "Premium Lifetime Access",
                order_id: data.order.id,
                handler: function (response) {
                    alert("Payment Successful! Refreshing your account...");
                    // Just reload the page for now to re-fetch user status
                    window.location.reload();
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
    modal.style.display = 'flex';
    void modal.offsetWidth; 
    modal.classList.add('show');
    modalImg.src = src;
    
    zoomLevel = 1;
    modalImg.style.transform = `scale(${zoomLevel})`;
    modalImg.style.cursor = 'zoom-in';
}

function closeModal() {
    modal.classList.remove('show');
    setTimeout(() => {
        modal.style.display = "none";
    }, 300);
}

closeBtn.onclick = closeModal;

modal.onclick = function(e) {
    if (e.target === modal) {
        closeModal();
    }
}

modalImg.addEventListener('click', (e) => {
    e.stopPropagation();
    zoomLevel = zoomLevel === 1 ? 2 : 1;
    modalImg.style.transform = `scale(${zoomLevel})`;
    modalImg.style.cursor = zoomLevel === 1 ? 'zoom-in' : 'zoom-out';
    
    if(zoomLevel === 2) {
        const rect = modalImg.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        modalImg.style.transformOrigin = `${x}% ${y}%`;
    } else {
        modalImg.style.transformOrigin = `center center`;
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
