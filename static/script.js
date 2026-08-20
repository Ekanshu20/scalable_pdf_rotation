// Theme Toggling
const themeToggle = document.getElementById('theme-toggle');

// Load theme from local storage or default to light
const savedTheme = localStorage.getItem('theme') || 'light-theme';
document.body.className = savedTheme;
themeToggle.textContent = savedTheme === 'dark-theme' ? '☀️' : '🌙';

themeToggle.addEventListener('click', () => {
    const isDark = document.body.classList.contains('dark-theme');
    if (isDark) {
        document.body.className = 'light-theme';
        themeToggle.textContent = '🌙';
        localStorage.setItem('theme', 'light-theme');
    } else {
        document.body.className = 'dark-theme';
        themeToggle.textContent = '☀️';
        localStorage.setItem('theme', 'dark-theme');
    }
});

// Tabs Logic
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        // Remove active class from all tabs and contents
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        
        // Add active class to clicked tab and corresponding content
        tab.classList.add('active');
        document.getElementById(tab.dataset.tab).classList.add('active');
        
        if(tab.dataset.tab === 'history-panel') {
            loadHistory();
        }
    });
});

// UI Elements
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const folderInput = document.getElementById('folder-input');
const selectedState = document.getElementById('selected-state');
const selectedCount = document.getElementById('selected-count');
const startBtn = document.getElementById('start-btn');
const loadingState = document.getElementById('loading-state');
const successState = document.getElementById('success-state');
const errorState = document.getElementById('error-state');
const downloadBtn = document.getElementById('download-btn');
const gpuToggle = document.getElementById('gpu-toggle');
const loadingMessage = document.getElementById('loading-message');
const errorMessage = document.getElementById('error-message');
const progressBar = document.getElementById('progress-bar');
const progressContainer = document.getElementById('progress-container');
const previewContainer = document.getElementById('preview-container');
const previewImg = document.getElementById('preview-img');

let pendingFiles = [];
let countdownInterval = null;
const SEC_PER_PAGE_GPU = 5;
const SEC_PER_PAGE_CPU = 15;
const STARTUP_OVERHEAD = 10;

// Drag Events
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
});
function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}
['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
});
['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
});

// Handle Drop
dropZone.addEventListener('drop', handleDrop, false);
function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;
    if(files.length) stageFiles(files);
}

// Handle File/Folder Select
fileInput.addEventListener('change', function() {
    if(this.files.length) stageFiles(this.files);
});
folderInput.addEventListener('change', function() {
    if(this.files.length) stageFiles(this.files);
});

function stageFiles(files) {
    const pdfFiles = Array.from(files).filter(file => file.name.toLowerCase().endsWith('.pdf'));
    
    if(pdfFiles.length === 0) {
        alert("Please upload at least one PDF file.");
        return;
    }

    pendingFiles = pdfFiles;

    // Show selection confirm state
    dropZone.classList.add('hidden');
    selectedState.classList.remove('hidden');
    selectedCount.textContent = `${pendingFiles.length} PDF(s) Selected`;
}

// Start Processing Button Logic
startBtn.addEventListener('click', async () => {
    if(pendingFiles.length === 0) return;

    selectedState.classList.add('hidden');
    errorState.classList.add('hidden');
    loadingState.classList.remove('hidden');
    progressContainer.classList.add('hidden');
    progressBar.style.width = '0%';
    
    document.getElementById('loading-title').textContent = "Uploading...";
    loadingMessage.textContent = `Transferring ${pendingFiles.length} file(s) to server...`;

    const formData = new FormData();
    pendingFiles.forEach(file => {
        formData.append('files', file);
    });
    formData.append('use_gpu', gpuToggle.checked);

    try {
        const uploadResponse = await fetch('/api/v1/upload', {
            method: 'POST',
            body: formData
        });

        if (!uploadResponse.ok) {
            const errResult = await uploadResponse.json();
            throw new Error(errResult.detail || "Upload failed. You might be rate-limited.");
        }

        const result = await uploadResponse.json();
        const taskId = result.task_id;
        const totalPages = result.total_pages || 0;
        
        document.getElementById('loading-title').textContent = "Processing PDFs...";
        loadingMessage.textContent = `Waiting for AI worker to start...`;
        progressContainer.classList.remove('hidden');
        
        const etaMessage = document.getElementById('eta-message');
        etaMessage.classList.remove('hidden');
        
        const secondsPerPage = gpuToggle.checked ? SEC_PER_PAGE_GPU : SEC_PER_PAGE_CPU;
        let estimatedSeconds = (totalPages * secondsPerPage) + STARTUP_OVERHEAD;
        
        // Start Countdown
        if (countdownInterval) clearInterval(countdownInterval);
        etaMessage.textContent = `Estimated Time Remaining: ~${estimatedSeconds}s`;
        
        countdownInterval = setInterval(() => {
            estimatedSeconds--;
            if (estimatedSeconds > 0) {
                etaMessage.textContent = `Estimated Time Remaining: ~${estimatedSeconds}s`;
            } else {
                etaMessage.textContent = `Almost done...`;
            }
        }, 1000);
        
        connectWebSocket(taskId);

    } catch (error) {
        showError("Error uploading files: " + error.message);
    }
});

function connectWebSocket(taskId) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/progress/${taskId}`;
    const ws = new WebSocket(wsUrl);
    
    // Backup polling just in case we miss a message from Redis Pub/Sub
    const pollInterval = setInterval(() => {
        if(ws.readyState === WebSocket.OPEN) {
            fetch(`/api/v1/status/${taskId}`)
                .then(res => res.json())
                .then(data => {
                    if (data.status === 'SUCCESS' || data.status === 'FAILED') {
                        // Trick the websocket handler into handling the completion
                        ws.onmessage({ data: JSON.stringify(data) });
                    }
                }).catch(e => console.error("Fallback poll error", e));
        } else {
            clearInterval(pollInterval);
        }
    }, 5000);

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.status === 'PROCESSING') {
            const completed = data.completed_files || 0;
            const total = data.total_files || pendingFiles.length;
            const filename = data.filename || '';
            
            loadingMessage.textContent = `Processing ${completed}/${total}: ${filename}`;
            if(total > 0) {
                const percent = Math.min((completed / total) * 100, 100);
                progressBar.style.width = `${percent}%`;
            }
        } 
        else if (data.status === 'SUCCESS') {
            if (countdownInterval) clearInterval(countdownInterval);
            document.getElementById('eta-message').classList.add('hidden');
            clearInterval(pollInterval);
            ws.close();
            progressBar.style.width = `100%`;
            loadingState.classList.add('hidden');
            successState.classList.remove('hidden');
            downloadBtn.href = `/api/v1/download/${taskId}`;
            loadPreview(taskId);
        }
        else if (data.status === 'FAILED') {
            if (countdownInterval) clearInterval(countdownInterval);
            document.getElementById('eta-message').classList.add('hidden');
            clearInterval(pollInterval);
            ws.close();
            showError(data.error || "Unknown processing error");
        }
    };
    
    ws.onerror = (error) => {
        console.error("WebSocket Error:", error);
        clearInterval(pollInterval);
        // Fallback to polling if WS fails
        ws.close();
        pollTaskStatus(taskId);
    };
}

async function loadPreview(taskId) {
    try {
        const response = await fetch(`/api/v1/preview/${taskId}`);
        if(response.ok) {
            const data = await response.json();
            previewImg.src = `data:image/png;base64,${data.image}`;
            previewContainer.classList.remove('hidden');
        }
    } catch(err) {
        console.error("Failed to load preview:", err);
    }
}

// Fallback polling just in case WebSocket fails
async function pollTaskStatus(taskId) {
    try {
        const response = await fetch(`/api/v1/status/${taskId}`);
        if (!response.ok) throw new Error("Failed to check status");
        
        const data = await response.json();
        
        if (data.status === 'SUCCESS') {
            if (countdownInterval) clearInterval(countdownInterval);
            document.getElementById('eta-message').classList.add('hidden');
            progressBar.style.width = `100%`;
            loadingState.classList.add('hidden');
            successState.classList.remove('hidden');
            downloadBtn.href = `/api/v1/download/${taskId}`;
            loadPreview(taskId);
        } else if (data.status === 'FAILED') {
            if (countdownInterval) clearInterval(countdownInterval);
            document.getElementById('eta-message').classList.add('hidden');
            throw new Error(data.error || "Unknown processing error");
        } else {
            if (data.details) {
                loadingMessage.textContent = data.details.status || `Processing... (${data.status})`;
                if(data.details.total_files) {
                    const percent = Math.min(((data.details.completed_files || 0) / data.details.total_files) * 100, 100);
                    progressBar.style.width = `${percent}%`;
                }
            }
            setTimeout(() => pollTaskStatus(taskId), 2000);
        }
    } catch (error) {
        showError(error.message);
    }
}

async function loadHistory() {
    const historyList = document.getElementById('history-list');
    historyList.innerHTML = '<div class="spinner" style="margin: 2rem auto; width: 30px; height: 30px;"></div>';
    
    try {
        const response = await fetch('/api/v1/history');
        if(!response.ok) throw new Error("Failed to fetch history");
        
        const jobs = await response.json();
        
        if(jobs.length === 0) {
            historyList.innerHTML = '<p style="text-align:center; opacity:0.7;">No recent jobs found.</p>';
            return;
        }
        
        historyList.innerHTML = '';
        jobs.forEach(job => {
            const date = new Date(job.created_at).toLocaleString();
            let actionHtml = '';
            
            if(job.status === 'SUCCESS') {
                actionHtml = `<a href="/api/v1/download/${job.task_id}" class="btn-primary" style="padding: 0.5rem 1rem; text-decoration: none;">Download</a>`;
            } else if (job.status === 'FAILED') {
                actionHtml = `<span style="opacity:0.5;">Failed</span>`;
            } else {
                actionHtml = `<span style="opacity:0.5;">Processing...</span>`;
            }
            
            const html = `
                <div class="history-item">
                    <div class="details">
                        <span style="font-weight:600;">${job.total_files} PDF(s)</span>
                        <span style="font-size:0.85rem; opacity:0.7;">${date}</span>
                        <span class="status ${job.status.toLowerCase()}">${job.status}</span>
                    </div>
                    <div>
                        ${actionHtml}
                    </div>
                </div>
            `;
            historyList.innerHTML += html;
        });
        
    } catch (err) {
        historyList.innerHTML = `<p style="text-align:center; color:#ef4444;">Error loading history.</p>`;
    }
}

function showError(msg) {
    loadingState.classList.add('hidden');
    errorState.classList.remove('hidden');
    errorMessage.textContent = msg;
}

function resetUI() {
    if (countdownInterval) clearInterval(countdownInterval);
    document.getElementById('eta-message').classList.add('hidden');
    pendingFiles = [];
    successState.classList.add('hidden');
    errorState.classList.add('hidden');
    loadingState.classList.add('hidden');
    selectedState.classList.add('hidden');
    previewContainer.classList.add('hidden');
    dropZone.classList.remove('hidden');
    fileInput.value = "";
    folderInput.value = "";
}
