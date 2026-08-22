// Auth Check
const token = localStorage.getItem('access_token');
if (!token) {
    window.location.href = '/';
}

function getAuthHeaders(isFormData = false) {
    const headers = { 'Authorization': `Bearer ${token}` };
    if (!isFormData) {
        headers['Content-Type'] = 'application/json';
    }
    return headers;
}

// User Profile
async function loadUser() {
    try {
        const res = await fetch('/api/v1/auth/me', { headers: getAuthHeaders() });
        if (res.ok) {
            const data = await res.json();
            const email = data.email;
            document.getElementById('user-email').textContent = email;
            // Set avatar initial
            const avatar = document.getElementById('user-avatar');
            if (avatar && email) {
                const initial = email.charAt(0).toUpperCase();
                avatar.innerHTML = `<span style="color: white; font-weight: 600; font-size: 15px;">${initial}</span>`;
            }
        } else {
            throw new Error("Unauthorized");
        }
    } catch(e) {
        localStorage.removeItem('access_token');
        window.location.href = '/';
    }
}
loadUser();

// ===== Navigation: Top Navbar Tabs =====
document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        
        // Update active tab
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        // Show appropriate view
        document.querySelectorAll('.view-section').forEach(s => {
            s.classList.remove('active');
            s.classList.add('hidden');
        });

        if (tabName === 'files') {
            document.getElementById('view-dashboard').classList.remove('hidden');
            document.getElementById('view-dashboard').classList.add('active');
            // Also set sidebar dashboard as active
            document.querySelectorAll('.sidebar-item').forEach(si => si.classList.remove('active'));
            document.getElementById('sidebar-dashboard').classList.add('active');
        } else if (tabName === 'history') {
            document.getElementById('view-history').classList.remove('hidden');
            document.getElementById('view-history').classList.add('active');
            loadHistory();
            // Deactivate sidebar items
            document.querySelectorAll('.sidebar-item').forEach(si => si.classList.remove('active'));
        }
    });
});

// ===== Sidebar Dashboard Click =====
const sidebarDashboard = document.getElementById('sidebar-dashboard');
if (sidebarDashboard) {
    sidebarDashboard.addEventListener('click', () => {
        // Activate files tab
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        document.getElementById('tab-files').classList.add('active');
        
        // Show dashboard view
        document.querySelectorAll('.view-section').forEach(s => {
            s.classList.remove('active');
            s.classList.add('hidden');
        });
        document.getElementById('view-dashboard').classList.remove('hidden');
        document.getElementById('view-dashboard').classList.add('active');
        
        // Set sidebar active
        document.querySelectorAll('.sidebar-item').forEach(si => si.classList.remove('active'));
        sidebarDashboard.classList.add('active');
    });
}

// ===== User Dropdown Toggle =====
const userProfileArea = document.getElementById('user-profile-area');
const userDropdown = document.getElementById('user-dropdown');

if (userProfileArea && userDropdown) {
    userProfileArea.addEventListener('click', (e) => {
        e.stopPropagation();
        userDropdown.classList.toggle('hidden');
    });
    
    document.addEventListener('click', () => {
        userDropdown.classList.add('hidden');
    });
}

// Logout logic
const logoutBtn = document.getElementById('logout-btn-top');
if(logoutBtn) {
    logoutBtn.addEventListener('click', (e) => {
        e.preventDefault();
        localStorage.removeItem('access_token');
        window.location.href = '/';
    });
}

// ===== Folders Management =====
async function loadFolders() {
    try {
        const res = await fetch('/api/v1/folders', { headers: getAuthHeaders() });
        if(res.ok) {
            const folders = await res.json();
            
            // Populate sidebar folders
            const sidebarFolders = document.getElementById('sidebar-folders-list');
            const foldersList = document.getElementById('folders-list');
            const select = document.getElementById('folder-select');
            
            if(sidebarFolders) {
                if (folders.length === 0) {
                    sidebarFolders.innerHTML = '<p style="padding: 7px 14px; font-size: 12px; color: var(--text-light);">No folders yet</p>';
                } else {
                    sidebarFolders.innerHTML = '';
                    folders.forEach(f => {
                        sidebarFolders.innerHTML += `
                            <div class="sidebar-folder-item">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                                </svg>
                                ${f.name}
                            </div>
                        `;
                    });
                }
            }
            
            // Populate folders grid view
            if(foldersList) {
                foldersList.innerHTML = '';
                folders.forEach(f => {
                    foldersList.innerHTML += `
                        <div class="folder-item">
                            <h3>📁 ${f.name}</h3>
                            <p>${f.file_count} file(s)</p>
                        </div>
                    `;
                });
            }
            
            // Populate dropdown
            if(select) {
                select.innerHTML = '<option value="">-- None --</option>';
                folders.forEach(f => {
                    select.innerHTML += `<option value="${f.id}">${f.name}</option>`;
                });
            }
        }
    } catch(e) { console.error("Error loading folders", e); }
}
loadFolders();

// Add Folder Button
const addFolderBtn = document.getElementById('add-folder-btn');
if (addFolderBtn) {
    addFolderBtn.addEventListener('click', () => createFolder());
}

async function createFolder() {
    const name = prompt("Enter folder name:");
    if (!name) return;
    try {
        await fetch('/api/v1/folders', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ name })
        });
        loadFolders();
    } catch(e) { alert("Failed to create folder"); }
}

// ===== Folders Toggle =====
const foldersToggle = document.getElementById('folders-toggle');
const sidebarFoldersList = document.getElementById('sidebar-folders-list');
if (foldersToggle && sidebarFoldersList) {
    foldersToggle.addEventListener('click', () => {
        const isHidden = sidebarFoldersList.style.display === 'none';
        sidebarFoldersList.style.display = isHidden ? 'block' : 'none';
        foldersToggle.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-90deg)';
    });
}

// ===== Upload UI Elements =====
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
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

// ===== Drag Events =====
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    if(dropZone) dropZone.addEventListener(eventName, preventDefaults, false);
});
function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }
['dragenter', 'dragover'].forEach(eventName => {
    if(dropZone) dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
});
['dragleave', 'drop'].forEach(eventName => {
    if(dropZone) dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
});

if(dropZone) dropZone.addEventListener('drop', handleDrop, false);
function handleDrop(e) {
    const dt = e.dataTransfer;
    if(dt.files.length) stageFiles(dt.files);
}

if(fileInput) fileInput.addEventListener('change', function() {
    if(this.files.length) stageFiles(this.files);
});

async function getPageCount(file) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
        return pdf.numPages;
    } catch (e) {
        console.error("Error reading PDF", e);
        return "?";
    }
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function stageFiles(files) {
    const pdfFiles = Array.from(files).filter(file => file.name.toLowerCase().endsWith('.pdf'));
    if(pdfFiles.length === 0) {
        alert("Please upload at least one PDF file.");
        return;
    }
    
    // Keep previously staged files if they drop more
    if (!pendingFiles) pendingFiles = [];
    pendingFiles = pendingFiles.concat(pdfFiles);
    
    dropZone.classList.add('hidden');
    
    // Hide folder select area and action cards
    const folderArea = document.getElementById('folder-select-area');
    if (folderArea) folderArea.style.display = 'none';
    const actionCards = document.getElementById('action-cards');
    if (actionCards) actionCards.style.display = 'none';
    
    selectedState.classList.remove('hidden');
    
    await renderFileList();
    updateRecentFiles(pendingFiles);
}

async function renderFileList() {
    const tbody = document.getElementById('file-list-body');
    const summary = document.getElementById('selected-summary');
    if (!tbody || !summary) return;
    
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Loading pages...</td></tr>';
    
    let totalPages = 0;
    let html = '';
    
    for (let i = 0; i < pendingFiles.length; i++) {
        const file = pendingFiles[i];
        if (file.pageCount === undefined) {
            file.pageCount = await getPageCount(file);
        }
        if (typeof file.pageCount === 'number') totalPages += file.pageCount;
        
        html += `
            <tr>
                <td>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#64748B" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                        <span style="font-weight:500; color:var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px;">${file.name}</span>
                    </div>
                </td>
                <td style="color:var(--text-muted);">${formatSize(file.size)}</td>
                <td style="color:var(--text-muted);">${file.pageCount}</td>
                <td>
                    <button class="remove-btn" onclick="removeFile(${i})">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </td>
            </tr>
        `;
    }
    
    tbody.innerHTML = html;
    summary.textContent = `${pendingFiles.length} file(s) • ${totalPages} pages`;
}

window.removeFile = function(index) {
    pendingFiles.splice(index, 1);
    if (pendingFiles.length === 0) {
        resetUI();
    } else {
        renderFileList();
    }
}


function updateRecentFiles(files) {
    const recentList = document.getElementById('recent-files-list');
    if (!recentList) return;
    
    recentList.innerHTML = '';
    const filesToShow = Array.from(files).slice(0, 3);
    
    filesToShow.forEach(file => {
        recentList.innerHTML += `
            <div class="recent-file-item">
                <div class="file-icon-small">
                    <svg width="24" height="28" viewBox="0 0 24 28" fill="none">
                        <rect x="0.5" y="0.5" width="23" height="27" rx="3" fill="#F0F4FF" stroke="#CBD5E1"/>
                        <rect x="5" y="6" width="10" height="1.5" rx="0.75" fill="#93A3B8"/>
                        <rect x="5" y="10" width="14" height="1.5" rx="0.75" fill="#93A3B8"/>
                        <rect x="5" y="14" width="12" height="1.5" rx="0.75" fill="#93A3B8"/>
                        <rect x="5" y="18" width="8" height="1.5" rx="0.75" fill="#93A3B8"/>
                    </svg>
                </div>
                <div class="file-info">
                    <span class="file-name">${file.name}</span>
                    <span class="file-status">Pending</span>
                </div>
            </div>
        `;
    });
}

// ===== Upload and Process =====
if(startBtn) startBtn.addEventListener('click', async () => {
    if(pendingFiles.length === 0) return;

    selectedState.classList.add('hidden');
    errorState.classList.add('hidden');
    loadingState.classList.remove('hidden');
    progressContainer.classList.add('hidden');
    progressBar.style.width = '0%';
    
    document.getElementById('loading-title').textContent = "Uploading...";
    loadingMessage.textContent = `Transferring ${pendingFiles.length} file(s) to server...`;

    const formData = new FormData();
    pendingFiles.forEach(file => formData.append('files', file));
    formData.append('use_gpu', gpuToggle.checked);
    
    const folderId = document.getElementById('folder-select').value;
    if (folderId) formData.append('folder_id', folderId);

    try {
        const uploadResponse = await fetch('/api/v1/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });

        if (!uploadResponse.ok) {
            const errResult = await uploadResponse.json();
            throw new Error(errResult.detail || "Upload failed.");
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
    
    const pollInterval = setInterval(() => {
        if(ws.readyState === WebSocket.OPEN) {
            fetch(`/api/v1/status/${taskId}`, {headers: getAuthHeaders()})
                .then(res => res.json())
                .then(data => {
                    if (data.status === 'SUCCESS' || data.status === 'FAILED') {
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
            loadingMessage.textContent = `Processing ${completed}/${total}...`;
            if(total > 0) progressBar.style.width = `${Math.min((completed / total) * 100, 100)}%`;
            
            if (data.files_status) {
                renderPerFileProgress(data.files_status);
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
            downloadBtn.href = `/api/v1/download/${taskId}?token=${token}`;
            loadPreview(taskId);
            loadFolders();
            loadHistory();
            
            // Update recent file statuses
            updateRecentFileStatus('Complete');
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
        ws.close();
        pollTaskStatus(taskId);
    };
}

function updateRecentFileStatus(status) {
    const statusElements = document.querySelectorAll('#recent-files-list .file-status');
    statusElements.forEach(el => {
        el.textContent = status;
        if (status === 'Complete') {
            el.style.color = '#10B981';
        }
    });
}

function renderPerFileProgress(filesStatus) {
    const container = document.getElementById('per-file-progress');
    if (!container) return;
    
    let html = '';
    for (const [filename, status] of Object.entries(filesStatus)) {
        let statusClass = 'queued';
        let statusText = 'Queued';
        if (status === 'processing') { statusClass = 'processing'; statusText = 'Processing...'; }
        else if (status === 'done') { statusClass = 'done'; statusText = 'Done'; }
        else if (status === 'failed') { statusClass = 'failed'; statusText = 'Failed'; }
        
        html += `
            <div class="progress-row">
                <span class="progress-filename" title="${filename}">${filename}</span>
                <span class="status-badge ${statusClass}">${statusText}</span>
            </div>
        `;
    }
    container.innerHTML = html;
}

function updateRecentFileStatus(status) {
    const statusElements = document.querySelectorAll('#recent-files-list .file-status');
    statusElements.forEach(el => {
        el.textContent = status;
        if (status === 'Complete') {
            el.style.color = '#10B981';
        }
    });
}

async function loadPreview(taskId) {
    try {
        const response = await fetch(`/api/v1/compare/${taskId}`, {headers: getAuthHeaders()});
        if(response.ok) {
            const data = await response.json();
            renderComparisonUI(taskId, data);
            previewContainer.classList.remove('hidden');
        }
    } catch(err) {
        console.error("Failed to load comparison preview", err);
    }
}

function renderComparisonUI(taskId, filesData) {
    let html = '';
    Object.keys(filesData).forEach(filename => {
        const pages = filesData[filename];
        html += `
            <div class="comparison-file-card">
                <div class="comparison-header" onclick="this.nextElementSibling.classList.toggle('hidden')">
                    <span class="comparison-title">📄 ${filename}</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
                </div>
                <div class="comparison-grid">
        `;
        
        pages.forEach(page => {
            let rotationText = page.rotation === 0 ? 'No change' : `Rotated ${page.rotation}°`;
            html += `
                <div class="page-compare-card">
                    <div class="page-compare-header">
                        <span>Page ${page.page_num + 1}</span>
                        <span class="rotation-badge">${rotationText}</span>
                    </div>
                    <div style="display:flex; gap:10px;">
                        <div class="thumbnail-container">
                            <span style="position:absolute; top:4px; left:4px; font-size:10px; background:rgba(0,0,0,0.5); color:white; padding:2px 4px; border-radius:2px; z-index:5;">Original</span>
                            <img src="data:image/png;base64,${page.original_img}" class="compare-img">
                        </div>
                        <div class="thumbnail-container">
                            <span style="position:absolute; top:4px; left:4px; font-size:10px; background:rgba(37,99,235,0.8); color:white; padding:2px 4px; border-radius:2px; z-index:5;">Corrected</span>
                            <img id="corrected-img-${taskId}-${filename.replace(/[^a-zA-Z0-9]/g, '')}-${page.page_num}" src="data:image/png;base64,${page.corrected_img}" class="compare-img">
                        </div>
                    </div>
                    <div class="override-actions">
                        <button class="override-btn" onclick="overridePage('${taskId}', '${filename}', ${page.page_num}, 90)" title="Rotate CCW 90°">↺</button>
                        <button class="override-btn" onclick="overridePage('${taskId}', '${filename}', ${page.page_num}, 270)" title="Rotate CW 90°">↻</button>
                        <button class="override-btn" onclick="overridePage('${taskId}', '${filename}', ${page.page_num}, 180)" title="Rotate 180°">180°</button>
                    </div>
                </div>
            `;
        });
        
        html += `</div></div>`;
    });
    previewContainer.innerHTML = html;
}

window.overridePage = async function(taskId, filename, pageNum, rotation) {
    try {
        const res = await fetch(`/api/v1/override/${taskId}`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ filename, page: pageNum, rotation })
        });
        if(res.ok) {
            const data = await res.json();
            const imgId = `corrected-img-${taskId}-${filename.replace(/[^a-zA-Z0-9]/g, '')}-${pageNum}`;
            document.getElementById(imgId).src = `data:image/png;base64,${data.image}`;
            
            // Show toast
            const toast = document.createElement('div');
            toast.textContent = 'Page rotated successfully';
            toast.style.cssText = 'position:fixed; bottom:20px; right:20px; background:#10B981; color:white; padding:12px 20px; border-radius:8px; box-shadow:0 4px 6px rgba(0,0,0,0.1); z-index:1000; animation:fadein 0.3s, fadeout 0.3s 2.5s;';
            document.body.appendChild(toast);
            setTimeout(() => document.body.removeChild(toast), 3000);
        } else {
            alert("Failed to rotate page");
        }
    } catch (e) {
        alert("Error overriding page rotation");
    }
}

async function pollTaskStatus(taskId) {
    try {
        const response = await fetch(`/api/v1/status/${taskId}`, {headers: getAuthHeaders()});
        if (!response.ok) throw new Error("Failed to check status");
        
        const data = await response.json();
        
        if (data.status === 'SUCCESS') {
            if (countdownInterval) clearInterval(countdownInterval);
            document.getElementById('eta-message').classList.add('hidden');
            progressBar.style.width = `100%`;
            loadingState.classList.add('hidden');
            successState.classList.remove('hidden');
            downloadBtn.href = `/api/v1/download/${taskId}?token=${token}`;
            loadPreview(taskId);
            loadFolders();
            loadHistory();
        } else if (data.status === 'FAILED') {
            if (countdownInterval) clearInterval(countdownInterval);
            document.getElementById('eta-message').classList.add('hidden');
            throw new Error(data.error || "Unknown processing error");
        } else {
            if (data.details) {
                loadingMessage.textContent = data.details.status || `Processing... (${data.status})`;
                if(data.details.total_files) {
                    progressBar.style.width = `${Math.min(((data.details.completed_files || 0) / data.details.total_files) * 100, 100)}%`;
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
    if (!historyList) return;
    historyList.innerHTML = '<p style="text-align:center; color: var(--text-light); padding: 20px;">Loading...</p>';
    
    try {
        const response = await fetch('/api/v1/history', {headers: getAuthHeaders()});
        if(!response.ok) throw new Error("Failed to fetch history");
        
        const jobs = await response.json();
        if(jobs.length === 0) {
            historyList.innerHTML = '<p style="text-align:center; color: var(--text-light); padding: 40px;">No recent jobs found.</p>';
            return;
        }
        
        historyList.innerHTML = '';
        jobs.forEach(job => {
            const date = new Date(job.created_at).toLocaleString();
            let actionHtml = '';
            
            if(job.status === 'SUCCESS') {
                actionHtml = `<a href="/api/v1/download/${job.task_id}?token=${token}" class="btn-primary" style="padding: 8px 16px; text-decoration: none; font-size: 13px;">Download</a>`;
            } else if (job.status === 'FAILED') {
                actionHtml = `<span style="color: #EF4444; font-size: 13px; font-weight: 500;">Failed</span>`;
            } else {
                actionHtml = `<span style="color: var(--text-light); font-size: 13px;">Processing...</span>`;
            }
            
            historyList.innerHTML += `
                <div class="history-item">
                    <div class="details">
                        <span style="font-weight:600; font-size: 14px;">${job.total_files} PDF(s)</span>
                        <br>
                        <span style="font-size: 12px; color: var(--text-light);">${date}</span>
                        <br>
                        <span style="font-size: 12px; font-weight: 500; color: ${job.status === 'SUCCESS' ? '#10B981' : job.status === 'FAILED' ? '#EF4444' : 'var(--text-muted)'};">${job.status}</span>
                    </div>
                    <div>${actionHtml}</div>
                </div>
            `;
        });
    } catch (err) {
        historyList.innerHTML = `<p style="color:#ef4444; text-align: center; padding: 20px;">Error loading history.</p>`;
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
    
    document.getElementById('per-file-progress').innerHTML = '';
    
    // Show folder select area and action cards again
    const folderArea = document.getElementById('folder-select-area');
    if (folderArea) folderArea.style.display = '';
    const actionCards = document.getElementById('action-cards');
    if (actionCards) actionCards.style.display = '';
}

// Initial load
loadHistory();
