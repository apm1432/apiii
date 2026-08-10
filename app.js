// Use the examData loaded from data.js
const state = {
    currentExam: null,
    score: 0,
    progress: {},
    totalQuestions: 0,
    answeredQuestions: 0
};

// --- Anti-Piracy Measures ---
// Disable right-click
document.addEventListener('contextmenu', event => event.preventDefault());
// Disable keyboard shortcuts for copy and inspect element
document.addEventListener('keydown', event => {
    if (
        (event.ctrlKey && (event.key === 'c' || event.key === 'C')) || // Ctrl+C
        (event.ctrlKey && event.shiftKey && (event.key === 'i' || event.key === 'I')) || // Ctrl+Shift+I
        (event.ctrlKey && (event.key === 'u' || event.key === 'U')) || // Ctrl+U (View Source)
        event.key === 'F12' // F12
    ) {
        event.preventDefault();
        return false;
    }
});
// -----------------------------

let groupedData = {};

function getSortedFolders() {
    return Object.keys(groupedData).sort((a, b) => {
        const yearA = a.match(/\d{4}/) ? parseInt(a.match(/\d{4}/)[0]) : 0;
        const yearB = b.match(/\d{4}/) ? parseInt(b.match(/\d{4}/)[0]) : 0;
        if (yearA !== yearB) {
            return yearA - yearB; // ascending year order
        }
        return a.localeCompare(b); // alphabetical fallback
    });
}

// Progress stored as { examFolder: { qnum: { selected: "1", isCorrect: true } } }

function init() {
    // Build grouped data first
    const rawData = examData.data || examData;
    const mapping = examData.mapping || {};
    
    for (const filePath in rawData) {
        const parts = filePath.split(/[\\/]/);
        if (parts.length >= 2) {
            const rawFolder = parts[parts.length - 2];
            
            // Clean up windows duplicate suffix like " (3)" to help mapping
            const cleanFolder = rawFolder.replace(/\s\(\d+\)$/, '');
            
            // Get official display name
            let displayFolder = mapping[rawFolder] || mapping[cleanFolder] || cleanFolder;
            if (displayFolder.endsWith('.pdf')) {
                displayFolder = displayFolder.replace('.pdf', '');
            }

            if (!groupedData[displayFolder]) groupedData[displayFolder] = [];
            
            rawData[filePath].forEach(q => {
                groupedData[displayFolder].push({ ...q, _originalFilePath: filePath });
            });
        }
    }
    
    // Sort questions numerically by qnum
    for (const folder in groupedData) {
        groupedData[folder].sort((a, b) => parseInt(a.qnum) - parseInt(b.qnum));
    }
    
    loadProgress();
    renderSidebar();
    
    // Theme toggle setup
    const savedTheme = localStorage.getItem('mpscTheme') || 'dark';
    if (savedTheme === 'light') document.body.classList.add('light-mode');
    
    document.getElementById('themeToggle').onclick = () => {
        document.body.classList.toggle('light-mode');
        const isLight = document.body.classList.contains('light-mode');
        localStorage.setItem('mpscTheme', isLight ? 'light' : 'dark');
    };

    // Modal setup
    document.getElementById('closeModal').onclick = () => {
        document.getElementById('imageModal').style.display = "none";
    };

    // Select first exam by default
    const folders = getSortedFolders();
    if (folders.length > 0) {
        selectExam(folders[0]);
    }
}

function loadProgress() {
    const saved = localStorage.getItem('mpscProgress');
    if (saved) {
        state.progress = JSON.parse(saved);
    }
    updateGlobalStats();
}

function saveProgress() {
    localStorage.setItem('mpscProgress', JSON.stringify(state.progress));
    updateGlobalStats();
}

function resetProgress() {
    if (confirm('Are you sure you want to reset all your progress?')) {
        state.progress = {};
        saveProgress();
        selectExam(state.currentExam);
    }
}

function updateGlobalStats() {
    let totalQs = 0;
    let answered = 0;
    let correct = 0;

    for (const folder in groupedData) {
        const questions = groupedData[folder];
        totalQs += questions.length;
        
        if (state.progress[folder]) {
            for (const qnum in state.progress[folder]) {
                answered++;
                if (state.progress[folder][qnum].isCorrect) {
                    correct++;
                }
            }
        }
    }

    state.totalQuestions = totalQs;
    state.answeredQuestions = answered;
    state.score = correct;

    document.getElementById('scoreVal').textContent = `${correct} / ${answered}`;
    const percent = totalQs === 0 ? 0 : Math.round((answered / totalQs) * 100);
    document.getElementById('progressVal').textContent = `${percent}% (${answered}/${totalQs})`;
    document.getElementById('globalProgressBar').style.width = `${percent}%`;
}

function renderSidebar() {
    const container = document.getElementById('examFilters');
    container.innerHTML = '';
    
    const mapping = examData.mapping || {};
    const sortedFolders = getSortedFolders();
    
    for (const folder of sortedFolders) {
        let fSolved = 0;
        let fCorrect = 0;
        let fTotal = groupedData[folder].length;
        if (state.progress[folder]) {
            for (const qnum in state.progress[folder]) {
                fSolved++;
                if (state.progress[folder][qnum].isCorrect) fCorrect++;
            }
        }
        
        // No need for mapping lookup, folder is already the official name
        let officialName = folder;

        const div = document.createElement('div');
        div.className = 'filter-item';
        // Check if current exam
        if (state.currentExam === folder) div.classList.add('active');
        
        div.innerHTML = `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-size: 0.75rem; color: var(--accent); font-weight: bold;">${folder.toUpperCase()}</span>
            <span style="font-size: 0.8rem; background: rgba(0,0,0,0.2); padding: 2px 6px; border-radius: 4px;">${fCorrect}/${fSolved}</span>
        </div>
        <div style="font-size: 0.9rem; line-height: 1.2;">${officialName}</div>`;
        
        div.onclick = () => selectExam(folder);
        container.appendChild(div);
    }
}

function selectExam(folder) {
    state.currentExam = folder;
    
    // Update active state in sidebar
    document.querySelectorAll('.filter-item').forEach(el => {
        el.classList.remove('active');
        // Because innerHTML contains spans, we check if the raw folder name is inside
        if (el.innerHTML.includes(folder.toUpperCase())) el.classList.add('active');
    });

    let officialName = folder;
    
    const totalQs = groupedData[folder] ? groupedData[folder].length : 0;

    document.getElementById('currentExamTitle').innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 15px;">
            <span style="flex: 1; line-height: 1.3;">${officialName}</span>
            <span style="font-size: 0.9rem; background: var(--surface-light); padding: 5px 12px; border-radius: 8px; color: var(--accent); white-space: nowrap;">
                Total Questions: ${totalQs}
            </span>
        </div>
    `;
    renderQuestions(folder);
}

function renderQuestions(folder) {
    const container = document.getElementById('questionsContainer');
    container.innerHTML = '';
    
    const questions = groupedData[folder] || [];
    
    if (!state.progress[folder]) {
        state.progress[folder] = {};
    }

    questions.forEach(q => {
        const qData = q.enriched || {};
        const qCard = document.createElement('div');
        qCard.className = 'question-card';
        qCard.id = `q-${q.qnum}`;
        
        // Extract correct option (clean it up, sometimes LLM returns "1" or 1)
        let correctOpt = qData.correct_option ? String(qData.correct_option).trim() : null;
        
        // Check if answered
        const answeredData = state.progress[folder][q.qnum];
        const isAnswered = !!answeredData;
        
        let tagsHtml = '';
        if (qData.topic) tagsHtml += `<span class="tag">${qData.topic}</span>`;
        if (qData.imp_score) tagsHtml += `<span class="tag">IMP: ${qData.imp_score}</span>`;
        if (q.is_verified_from_key === false) tagsHtml += `<span class="tag" style="color: #fbbf24;">UNVERIFIED (Internet)</span>`;

        let optionsHtml = '<div class="options-list">';
        q.options.forEach((optText, index) => {
            const optNum = String(index + 1);
            let optClass = 'option';
            
            if (isAnswered) {
                optClass += ' disabled';
                if (answeredData.selected === optNum) {
                    optClass += ' selected';
                    optClass += (answeredData.selected === correctOpt || correctOpt === '#') ? ' correct' : ' incorrect';
                } else if (correctOpt === optNum && correctOpt !== '#') {
                    // Reveal correct option if wrong was chosen
                    optClass += ' correct reveal';
                }
            }
            
            optionsHtml += `<div class="${optClass}" data-opt="${optNum}">
                <strong style="margin-right: 15px;">${optNum}.</strong> ${optText}
            </div>`;
        });
        optionsHtml += '</div>';

        // Add special handling for Cancelled (#) questions
        let cancelledWarning = '';
        if (correctOpt === '#') {
            cancelledWarning = `<div style="color: #fca5a5; font-weight: bold; margin-bottom: 1rem;">This question was officially CANCELLED (#) by MPSC.</div>`;
        }

        // Find original page path
        // We use the injected property from grouping
        let originalFilePath = q._originalFilePath || "";
        
        // Extract relative path (everything after pdf_images)
        let relativeImagePath = "";
        const parts = originalFilePath.split(/pdf_images[\\/]/i);
        if (parts.length > 1) {
            relativeImagePath = `../PYQ_DATA/pdf_images/${parts[1].replace(/\\/g, '/')}`;
        }

        qCard.innerHTML = `
            <div class="question-header">
                <span class="q-badge">Question ${q.qnum}</span>
                ${relativeImagePath ? `<button class="btn" style="background: rgba(59,130,246,0.2); color: #60a5fa; padding: 0.2rem 0.6rem; font-size: 0.85rem;" onclick="openImageModal('${relativeImagePath}')">🖼️ View Original Page</button>` : ''}
            </div>
            <div class="q-text">
                ${q.text || ''}
                ${q.text_eng ? '<br><br><span style="color: #64748b; font-size: 0.9em;">' + q.text_eng + '</span>' : ''}
            </div>
            ${cancelledWarning}
            ${optionsHtml}
            <div class="explanation-box ${isAnswered ? 'show' : ''}" id="exp-${q.qnum}">
                <h4>Explanation</h4>
                <p>${qData.explanation || 'No explanation available.'}</p>
                ${qData.extra_points ? `<p style="margin-top: 10px; color: #fbbf24;"><small>Extra: ${qData.extra_points}</small></p>` : ''}
            </div>
            <div class="tag-list">${tagsHtml}</div>
        `;
        
        container.appendChild(qCard);

        // Add Event Listeners
        if (!isAnswered) {
            const options = qCard.querySelectorAll('.option');
            options.forEach(opt => {
                opt.onclick = () => handleAnswer(folder, q.qnum, opt.getAttribute('data-opt'), correctOpt, qCard);
            });
        }
    });
}

function handleAnswer(folder, qnum, selectedOpt, correctOpt, qCard) {
    const isCorrect = (selectedOpt === correctOpt || correctOpt === '#');
    
    // Save state
    state.progress[folder][qnum] = {
        selected: selectedOpt,
        isCorrect: isCorrect
    };
    saveProgress();

    // Re-render this specific question to show colors and explanation
    renderQuestions(folder);
    
    // Also re-render sidebar to update the correct/solved count for this exam
    renderSidebar();
}

function openImageModal(imgSrc) {
    const modal = document.getElementById('imageModal');
    const modalImg = document.getElementById('modalImage');
    modalImg.src = imgSrc;
    modal.style.display = "block";
}

document.getElementById('resetBtn').onclick = resetProgress;

// Close modal if user clicks outside the image
window.onclick = function(event) {
    const modal = document.getElementById('imageModal');
    if (event.target === modal) {
        modal.style.display = "none";
    }
}

// Start app
window.onload = init;
