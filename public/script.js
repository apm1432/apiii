// ====== UI LOGIC ======

// Theme Management
function changeTheme(themeName) {
    document.body.className = themeName;
    localStorage.setItem('selectedTheme', themeName);
}

// Load saved theme on startup
const savedTheme = localStorage.getItem('selectedTheme') || 'theme-night';
document.body.className = savedTheme;
document.addEventListener('DOMContentLoaded', () => {
    const selector = document.getElementById('theme-selector');
    if (selector) selector.value = savedTheme;
});


document.addEventListener('DOMContentLoaded', () => {
    
    // View Switching
    const btnQuiz = document.getElementById('btn-quiz');
    const btnFull = document.getElementById('btn-full');
    const quizView = document.getElementById('quiz-view');
    const fullView = document.getElementById('full-view');

    btnQuiz.addEventListener('click', () => {
        btnQuiz.classList.add('active');
        btnFull.classList.remove('active');
        quizView.classList.add('active');
        fullView.classList.remove('active');
    });

    btnFull.addEventListener('click', () => {
        btnFull.classList.add('active');
        btnQuiz.classList.remove('active');
        fullView.classList.add('active');
        quizView.classList.remove('active');
    });
});

// Quiz Option Selection Logic
function selectOption(el, isCorrect) {
    // Prevent multiple selections
    const parent = el.parentElement;
    if (parent.classList.contains('answered')) return;
    
    parent.classList.add('answered');
    
    if (isCorrect) {
        el.classList.add('correct');
    } else {
        el.classList.add('wrong');
        // Highlight correct answer (Mocking logic for Demo)
        Array.from(parent.children).forEach(child => {
            if (child.textContent.includes('Jyotirao Phule')) { 
                child.classList.add('correct');
            }
        });
    }

    // Show explanation smoothly
    const explanation = document.getElementById('explanation-1');
    explanation.classList.remove('hidden');
}

// Modal Logic
const modal = document.getElementById('image-modal');
const modalImg = document.getElementById('modal-img');
const closeBtn = document.querySelector('.close-modal');
let zoomLevel = 1;

function openImageModal() {
    modal.style.display = 'flex';
    // Trigger reflow for transition
    void modal.offsetWidth; 
    modal.classList.add('show');
    
    zoomLevel = 1;
    modalImg.style.transform = `scale(${zoomLevel})`;
    modalImg.style.cursor = 'zoom-in';
}

function closeModal() {
    modal.classList.remove('show');
    setTimeout(() => {
        modal.style.display = "none";
    }, 300); // match transition duration
}

closeBtn.onclick = closeModal;

modal.onclick = function(e) {
    // Close only if clicking outside the image content wrapper
    if (e.target === modal) {
        closeModal();
    }
}

// Zoom logic on image click
modalImg.addEventListener('click', (e) => {
    e.stopPropagation();
    zoomLevel = zoomLevel === 1 ? 2 : 1;
    modalImg.style.transform = `scale(${zoomLevel})`;
    modalImg.style.cursor = zoomLevel === 1 ? 'zoom-in' : 'zoom-out';
    
    // Adjust transform origin based on click position for better zooming
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

// 1. Disable Right Click (Context Menu)
document.addEventListener('contextmenu', event => {
    event.preventDefault();
});

// 2. Disable Text Selection (Fallback for older browsers in JS, mainly handled in CSS)
document.addEventListener('selectstart', event => {
    event.preventDefault();
});

// 3. Disable Keyboard Shortcuts (F12, Ctrl+Shift+I/J/C, Ctrl+U, Ctrl+C)
document.addEventListener('keydown', function(event) {
    // F12
    if (event.key === 'F12' || event.keyCode === 123) {
        event.preventDefault();
        return false;
    }
    
    // Ctrl+Shift+I / J / C
    if (event.ctrlKey && event.shiftKey && (event.key === 'I' || event.key === 'J' || event.key === 'C' || event.key === 'i' || event.key === 'j' || event.key === 'c' || event.keyCode === 73 || event.keyCode === 74 || event.keyCode === 67)) {
        event.preventDefault();
        return false;
    }
    
    // Ctrl+U (View Source)
    if (event.ctrlKey && (event.key === 'U' || event.key === 'u' || event.keyCode === 85)) {
        event.preventDefault();
        return false;
    }

    // Ctrl+C (Copy)
    if (event.ctrlKey && (event.key === 'C' || event.key === 'c' || event.keyCode === 67)) {
        event.preventDefault();
        return false;
    }
});

// 4. Anti-DevTools Debugger Trap
// This function detects DevTools and crashes/freezes the page
function detectDevTools() {
    // Trap 1: Evaluate based on debugger timing
    setInterval(function() {
        let startTime = performance.now();
        // The debugger statement will pause execution if DevTools is open
        debugger; 
        let endTime = performance.now();
        
        // If execution was paused, it took longer than expected
        if (endTime - startTime > 100) {
            triggerSecurityViolation();
        }
    }, 1000);
}

function triggerSecurityViolation() {
    // Overwrite the DOM to prevent content access
    document.body.innerHTML = `
        <div style="height: 100vh; display: flex; justify-content: center; align-items: center; background: #0f172a; color: #ef4444; font-family: sans-serif; flex-direction: column;">
            <h1 style="font-size: 2.5rem; margin-bottom: 20px;">SECURITY VIOLATION</h1>
            <p>Developer Tools access is strictly prohibited on this platform.</p>
        </div>
    `;
    
    // Infinite loop to freeze the tab (crashing it effectively)
    while(true) {
        // CPU Intensive loop
        console.error("Security Violation. Access Denied.");
    }
}

// Initialize anti-debugging trap
detectDevTools();
