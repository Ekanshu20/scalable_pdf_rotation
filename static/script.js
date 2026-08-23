// Auth Check
const token = localStorage.getItem('access_token');
window.userFolders = [];
window.currentViewFolderId = null;

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
    } catch (e) {
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

// ===== Sidebar Folders Click =====
const sidebarFoldersLabel = document.getElementById('sidebar-folders-label');
if (sidebarFoldersLabel) {
    sidebarFoldersLabel.addEventListener('click', () => {
        // Deactivate all top tabs since we are on a sidebar view
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));

        // Show folders view
        document.querySelectorAll('.view-section').forEach(s => {
            s.classList.remove('active');
            s.classList.add('hidden');
        });
        document.getElementById('view-folders').classList.remove('hidden');
        document.getElementById('view-folders').classList.add('active');

        // Set sidebar active logic (remove active from dashboard)
        document.querySelectorAll('.sidebar-item').forEach(si => si.classList.remove('active'));

        loadFolders();
        showFoldersList();
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
if (logoutBtn) {
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
        if (res.ok) {
            const folders = await res.json();
            window.userFolders = folders;

            // Populate sidebar folders
            const sidebarFolders = document.getElementById('sidebar-folders-list');
            const foldersList = document.getElementById('folders-list');
            const select = document.getElementById('folder-select');

            if (sidebarFolders) {
                if (folders.length === 0) {
                    sidebarFolders.innerHTML = '<p style="padding: 7px 14px; font-size: 12px; color: var(--text-light);">No folders yet</p>';
                } else {
                    sidebarFolders.innerHTML = '';
                    folders.forEach(f => {
                        const item = document.createElement('div');
                        item.className = 'sidebar-folder-item';
                        item.style.cursor = 'pointer';
                        item.innerHTML = `
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                            </svg>
                            <span>${f.name}</span>
                            <span style="margin-left:auto; font-size:11px; color:var(--text-light);">${f.file_count}</span>
                        `;
                        item.addEventListener('click', () => {
                            // Navigate to folders view and open this folder
                            document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
                            document.querySelectorAll('.view-section').forEach(s => { s.classList.remove('active'); s.classList.add('hidden'); });
                            document.getElementById('view-folders').classList.remove('hidden');
                            document.getElementById('view-folders').classList.add('active');
                            document.querySelectorAll('.sidebar-item').forEach(si => si.classList.remove('active'));
                            loadFolderFiles(f.id, f.name);
                        });
                        sidebarFolders.appendChild(item);
                    });
                }
            }

            // Populate folders grid view
            if (foldersList) {
                if (folders.length === 0) {
                    foldersList.innerHTML = '<p style="text-align:center; color: var(--text-light); padding: 40px; grid-column: 1/-1;">No folders yet. Create one to organize your PDFs.</p>';
                } else {
                    foldersList.innerHTML = '';
                    folders.forEach(f => {
                        const date = new Date(f.created_at).toLocaleDateString();
                        foldersList.innerHTML += `
                            <div class="folder-item" onclick="loadFolderFiles(${f.id}, '${f.name.replace(/'/g, "\\'")}')"> 
                                <div class="folder-item-top">
                                    <div class="folder-icon-lg">
                                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="1.5">
                                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                                        </svg>
                                    </div>
                                    <button class="folder-delete-btn" onclick="event.stopPropagation(); deleteFolder(${f.id})" title="Delete folder">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                                    </button>
                                </div>
                                <h3>${f.name}</h3>
                                <div class="folder-meta">
                                    <span>${f.file_count} file(s)</span>
                                    <span>${date}</span>
                                </div>
                            </div>
                        `;
                    });
                }
            }


        }
    } catch (e) { console.error("Error loading folders", e); }
}
loadFolders();

async function loadFolderFiles(folderId, folderName) {
    window.currentViewFolderId = folderId;
    document.getElementById('folder-detail-name').innerHTML = `${folderName} <button class="icon-btn" onclick="renameFolder(${folderId}, '${folderName}')" title="Rename Folder" style="background:none; border:none; color:var(--text-light); cursor:pointer;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`;
    // Hide the folders list and show the detail view
    document.getElementById('folders-list').classList.add('hidden');
    document.getElementById('folders-header-card').classList.add('hidden');
    document.getElementById('folders-view-title').textContent = folderName;
    document.getElementById('folders-view-subtitle').textContent = 'Files and processing history for this folder.';

    const detailView = document.getElementById('folder-detail-view');
    const filesList = document.getElementById('folder-files-list');
    detailView.classList.remove('hidden');
    filesList.innerHTML = '<p style="text-align:center; color: var(--text-light); padding: 20px;">Loading...</p>';

    try {
        const res = await fetch(`/api/v1/folders/${folderId}/files`, { headers: getAuthHeaders() });
        if (res.ok) {
            const data = await res.json();
            const files = data.files || [];
            const jobs = data.jobs || [];

            let html = '';

            // --- Files Section ---
            if (files.length === 0) {
                filesList.innerHTML = `
                    <div class="folder-empty-state" style="grid-column: 1/-1;">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-light)" stroke-width="1.5">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        </svg>
                        <h3 style="color: var(--text-muted); font-size: 16px; margin-top: 12px;">This folder is empty</h3>
                        <p style="color: var(--text-light); font-size: 13px;">Click the <b>+ Upload Here</b> button above, or move a file from your history to this folder.</p>
                    </div>
                `;
                return;
            }

            if (files.length > 0) {
                files.forEach(f => {
                    const date = new Date(f.created_at).toLocaleDateString();
                    let downloadBtn = '';
                    if (f.available) {
                        downloadBtn = `<a href="/api/v1/folders/files/${f.id}/download?token=${token}" class="btn-primary folder-download-btn" style="text-decoration:none;">Download</a>`;
                    } else {
                        downloadBtn = `<span class="folder-file-expired">Expired</span>`;
                    }
                    
                    let deleteBtn = `<button class="btn-secondary folder-delete-file-btn" onclick="deleteFolderFile(${f.id}, ${folderId}, '${folderName}')" style="padding: 8px; margin-left: 8px;" title="Delete File">
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                                     </button>`;

                    let fileCheckbox = `<input type="checkbox" class="folder-file-checkbox" value="${f.id}" onchange="updateSelectedFolderFilesCount()" style="margin-right: 12px; cursor: pointer;">`;

                    html += `
                        <div class="folder-file-item" style="display:flex; align-items:center;">
                            ${fileCheckbox}
                            <div class="folder-file-icon">
                                <svg width="24" height="28" viewBox="0 0 24 28" fill="none">
                                    <rect x="0.5" y="0.5" width="23" height="27" rx="3" fill="${f.available ? '#F0F4FF' : '#FEF2F2'}" stroke="${f.available ? '#CBD5E1' : '#FECACA'}"/>
                                    <rect x="5" y="6" width="10" height="1.5" rx="0.75" fill="${f.available ? '#93A3B8' : '#FCA5A5'}"/>
                                    <rect x="5" y="10" width="14" height="1.5" rx="0.75" fill="${f.available ? '#93A3B8' : '#FCA5A5'}"/>
                                    <rect x="5" y="14" width="12" height="1.5" rx="0.75" fill="${f.available ? '#93A3B8' : '#FCA5A5'}"/>
                                </svg>
                            </div>
                            <div class="folder-file-info">
                                <span class="folder-file-name" title="${f.filename}">${f.filename}</span>
                                <span class="folder-file-date">${date}</span>
                            </div>
                            <div class="folder-file-actions" style="display:flex; align-items:center;">
                                ${downloadBtn}
                                ${deleteBtn}
                            </div>
                        </div>
                    `;
                });
            }

            filesList.innerHTML = html;
            updateSelectedFolderFilesCount(); // reset UI state
        }
    } catch (e) {
        filesList.innerHTML = '<p style="color:#ef4444; text-align:center; padding:20px;">Error loading folder contents.</p>';
    }
}

window.toggleSelectAllFolderFiles = function(checked) {
    document.querySelectorAll('.folder-file-checkbox').forEach(cb => {
        cb.checked = checked;
    });
    updateSelectedFolderFilesCount();
}

window.updateSelectedFolderFilesCount = function() {
    const selectedCount = document.querySelectorAll('.folder-file-checkbox:checked').length;
    const btn = document.getElementById('delete-selected-folder-files-btn');
    const countSpan = document.getElementById('selected-folder-files-count');
    const selectAllCb = document.getElementById('select-all-folder-files');
    
    const totalCount = document.querySelectorAll('.folder-file-checkbox').length;
    
    if (selectAllCb && totalCount > 0) {
        selectAllCb.checked = (selectedCount === totalCount && totalCount > 0);
    } else if (selectAllCb) {
        selectAllCb.checked = false;
    }
    
    if (btn && countSpan) {
        if (selectedCount > 0) {
            btn.style.display = 'inline-flex';
            countSpan.textContent = selectedCount;
        } else {
            btn.style.display = 'none';
        }
    }
}

window.deleteSelectedFolderFiles = async function() {
    const selectedIds = Array.from(document.querySelectorAll('.folder-file-checkbox:checked')).map(cb => parseInt(cb.value));
    if (selectedIds.length === 0) return;
    
    if (!confirm(`Delete ${selectedIds.length} selected files?`)) return;
    
    try {
        const res = await fetch('/api/v1/folders/files/delete-batch', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ file_ids: selectedIds })
        });
        if (res.ok) {
            const folderName = document.getElementById('folder-detail-name').childNodes[0].textContent.trim();
            loadFolderFiles(window.currentViewFolderId, folderName);
            loadFolders(); // refresh folder stats
        } else {
            alert('Failed to delete files');
        }
    } catch (e) {
        alert('Error deleting files');
    }
}

window.showFoldersList = function () {
    document.getElementById('folders-list').classList.remove('hidden');
    document.getElementById('folders-header-card').classList.remove('hidden');
    document.getElementById('folder-detail-view').classList.add('hidden');
    document.getElementById('folders-view-title').textContent = 'Your Folders';
    document.getElementById('folders-view-subtitle').textContent = 'Organize your rotated PDFs into folders.';
}

window.loadFolderFiles = loadFolderFiles;

async function deleteFolder(folderId) {
    if (!confirm('Delete this folder and all its file records?')) return;
    try {
        const res = await fetch(`/api/v1/folders/${folderId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (res.ok) {
            loadFolders();
            loadDashboard();
        } else {
            alert('Failed to delete folder');
        }
    } catch (e) { alert('Error deleting folder'); }
}
window.deleteFolder = deleteFolder;

window.deleteFolderFile = async function(fileId, folderId, folderName) {
    if (!confirm('Delete this file from the folder?')) return;
    try {
        const res = await fetch(`/api/v1/folders/files/${fileId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (res.ok) {
            loadFolderFiles(folderId, folderName);
            loadFolders(); // refresh folder stats
        } else {
            alert('Failed to delete file');
        }
    } catch (e) {
        alert('Error deleting file');
    }
};

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
    } catch (e) { alert("Failed to create folder"); }
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
    if (dropZone) dropZone.addEventListener(eventName, preventDefaults, false);
});
function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }
['dragenter', 'dragover'].forEach(eventName => {
    if (dropZone) dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
});
['dragleave', 'drop'].forEach(eventName => {
    if (dropZone) dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
});

if (dropZone) dropZone.addEventListener('drop', handleDrop, false);
function handleDrop(e) {
    const dt = e.dataTransfer;
    if (dt.files.length) stageFiles(dt.files);
}

if (fileInput) fileInput.addEventListener('change', function () {
    if (this.files.length) stageFiles(this.files);
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
    if (pdfFiles.length === 0) {
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

window.removeFile = function (index) {
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
async function processFiles(folderIdOverride = null) {
    if (pendingFiles.length === 0) return;

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

    if (folderIdOverride) formData.append('folder_id', folderIdOverride);

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
}

function connectWebSocket(taskId) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/progress/${taskId}`;
    const ws = new WebSocket(wsUrl);

    const pollInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            fetch(`/api/v1/status/${taskId}`, { headers: getAuthHeaders() })
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
            if (total > 0) progressBar.style.width = `${Math.min((completed / total) * 100, 100)}%`;

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
            loadDashboard();

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
if (startBtn) startBtn.addEventListener('click', () => processFiles());

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

async function loadPreview(taskId) {
    try {
        const response = await fetch(`/api/v1/compare/${taskId}`, { headers: getAuthHeaders() });
        if (response.ok) {
            const data = await response.json();
            renderComparisonUI(taskId, data);
            previewContainer.classList.remove('hidden');
        }
    } catch (err) {
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

window.overridePage = async function (taskId, filename, pageNum, rotation) {
    try {
        const res = await fetch(`/api/v1/override/${taskId}`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ filename, page: pageNum, rotation })
        });
        if (res.ok) {
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
        const response = await fetch(`/api/v1/status/${taskId}`, { headers: getAuthHeaders() });
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
            loadDashboard();
        } else if (data.status === 'FAILED') {
            if (countdownInterval) clearInterval(countdownInterval);
            document.getElementById('eta-message').classList.add('hidden');
            throw new Error(data.error || "Unknown processing error");
        } else {
            if (data.details) {
                loadingMessage.textContent = data.details.status || `Processing... (${data.status})`;
                if (data.details.total_files) {
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
        const response = await fetch('/api/v1/history', { headers: getAuthHeaders() });
        if (!response.ok) throw new Error("Failed to fetch history");

        const jobs = await response.json();
        if (jobs.length === 0) {
            historyList.innerHTML = '<p style="text-align:center; color: var(--text-light); padding: 40px;">No recent jobs found.</p>';
            updateSelectedHistoryCount();
            return;
        }

        historyList.innerHTML = '';
        jobs.forEach(job => {
            const date = new Date(job.created_at).toLocaleString();
            const completedAt = job.completed_at ? new Date(job.completed_at).toLocaleString() : null;

            // Status badge
            let statusColor = 'var(--text-muted)';
            let statusBg = '#F1F5F9';
            let statusText = job.status;
            if (job.status === 'SUCCESS') { statusColor = '#16A34A'; statusBg = '#F0FDF4'; statusText = 'Completed'; }
            else if (job.status === 'FAILED') { statusColor = '#DC2626'; statusBg = '#FEF2F2'; statusText = 'Failed'; }
            else if (job.status === 'PROCESSING') { statusColor = '#D97706'; statusBg = '#FFFBEB'; statusText = 'Processing'; }

            // Action buttons
            let actionHtml = '';
            if (job.status === 'SUCCESS') {
                let options = `<option value="">-- Move to Folder --</option>`;
                window.userFolders.forEach(f => {
                    options += `<option value="${f.id}" ${f.id == job.folder_id ? 'selected' : ''}>${f.name}</option>`;
                });
                let moveSelect = `<select class="form-input" onchange="moveJobToFolder('${job.task_id}', this.value)" style="padding:4px; font-size:11px; margin-left:8px; width:auto; display:inline-block;">${options}</select>`;
                actionHtml = `<a href="/api/v1/download/${job.task_id}?token=${token}" class="btn-primary" style="padding: 6px 14px; text-decoration: none; font-size: 12px;">Download</a>${moveSelect}`;
            } else if (job.status === 'FAILED') {
                actionHtml = `<span style="font-size: 12px; color: #DC2626;" title="${job.error_message || ''}">Error</span>`;
            } else {
                actionHtml = `<span style="font-size: 12px; color: var(--text-light);">In Progress...</span>`;
            }

            // Rotation breakdown
            let rotationHtml = '';
            if (job.status === 'SUCCESS' && (job.pages_rotated > 0 || job.pages_unchanged > 0)) {
                rotationHtml = `
                    <div class="history-rotation-breakdown">
                        <span class="rotation-chip rotated">↻ ${job.pages_rotated} rotated</span>
                        <span class="rotation-chip unchanged">✓ ${job.pages_unchanged} unchanged</span>
                    </div>
                `;
            }

            let filenamesHtml = '';
            if (job.filenames && job.filenames.length > 0) {
                filenamesHtml = `<div class="history-filenames" style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">📄 ${job.filenames.join(', ')}</div>`;
            }

            historyList.innerHTML += `
                <div class="history-item" data-folder="${job.folder_name || ''}" data-filenames="${(job.filenames || []).join(' ')}">
                    <div class="history-item-left">
                        <input type="checkbox" class="history-checkbox" value="${job.task_id}" onchange="updateSelectedHistoryCount()" style="margin-right: 12px; cursor: pointer; transform: scale(1.15);">
                        <div class="history-icon">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        </div>
                        <div class="history-details">
                            <div class="history-top-row">
                                <span class="history-files">${job.total_files} PDF(s) · ${job.total_pages || 0} pages ${job.folder_name ? ' 📁 ' + job.folder_name : ''}</span>
                                <span class="history-status-badge" style="color: ${statusColor}; background: ${statusBg};">${statusText}</span>
                            </div>
                            ${filenamesHtml}
                            <span class="history-date">${date}${completedAt ? ' → ' + completedAt : ''}</span>
                            ${rotationHtml}
                        </div>
                    </div>
                    <div class="history-item-right" style="display: flex; align-items: center; gap: 8px;">
                        ${actionHtml}
                        <button onclick="deleteHistoryJob('${job.task_id}')" class="btn-secondary" title="Delete from history" style="padding: 6px 10px; color: #dc2626; border-color: #fca5a5; cursor: pointer;">🗑️</button>
                    </div>
                </div>
            `;
        });
        updateSelectedHistoryCount();
    } catch (err) {
        historyList.innerHTML = `<p style="color:#ef4444; text-align: center; padding: 20px;">Error loading history.</p>`;
    }
}

function filterHistoryFiles() {
    const term = document.getElementById('history-search-input').value.toLowerCase();
    const items = document.querySelectorAll('.history-item');
    items.forEach(item => {
        const folderName = (item.getAttribute('data-folder') || '').toLowerCase();
        const fileNames = (item.getAttribute('data-filenames') || '').toLowerCase();

        if (folderName.includes(term) || fileNames.includes(term)) {
            item.style.display = '';
        } else {
            item.style.display = 'none';
        }
    });
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
loadDashboard();

// ===== Dashboard =====
async function loadDashboard() {
    try {
        const res = await fetch('/api/v1/dashboard', { headers: getAuthHeaders() });
        if (!res.ok) return;
        const data = await res.json();

        document.getElementById('stat-total-files').textContent = data.total_files || 0;
        document.getElementById('stat-total-pages').textContent = data.total_pages || 0;
        document.getElementById('stat-pages-rotated').textContent = data.pages_rotated || 0;
        document.getElementById('stat-folders').textContent = data.folder_count || 0;

        // Recent jobs table
        const tbody = document.getElementById('recent-jobs-body');
        if (tbody) {
            if (!data.recent_jobs || data.recent_jobs.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-light); padding:20px;">No jobs yet. Upload a PDF to get started.</td></tr>';
            } else {
                tbody.innerHTML = '';
                data.recent_jobs.forEach(job => {
                    const date = new Date(job.created_at).toLocaleDateString();
                    let statusColor = 'var(--text-muted)';
                    let statusBg = '#F1F5F9';
                    let statusText = job.status;
                    if (job.status === 'SUCCESS') { statusColor = '#16A34A'; statusBg = '#F0FDF4'; statusText = 'Completed'; }
                    else if (job.status === 'FAILED') { statusColor = '#DC2626'; statusBg = '#FEF2F2'; statusText = 'Failed'; }
                    else if (job.status === 'PROCESSING') { statusColor = '#D97706'; statusBg = '#FFFBEB'; statusText = 'Processing'; }

                    let actionHtml = '';
                    if (job.status === 'SUCCESS') {
                        actionHtml = `<a href="/api/v1/download/${job.task_id}?token=${token}" style="color: var(--primary); text-decoration: none; font-weight: 500; font-size: 13px;">Download</a>`;
                    }

                    tbody.innerHTML += `
                        <tr>
                            <td>${date}</td>
                            <td>${job.total_files}</td>
                            <td>${job.total_pages || 0}</td>
                            <td><span style="color:${statusColor}; background:${statusBg}; padding:2px 8px; border-radius:4px; font-size:12px; font-weight:500;">${statusText}</span></td>
                            <td>${actionHtml}</td>
                        </tr>
                    `;
                });
            }
        }
    } catch (e) {
        console.error('Error loading dashboard', e);
    }
}

// --- NEW FOLDER FEATURES ---

async function renameFolder(id, currentName) {
    const newName = prompt("Enter new folder name:", currentName);
    if (!newName || newName === currentName) return;
    try {
        const res = await fetch(`/api/v1/folders/${id}`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({ name: newName })
        });
        if (res.ok) {
            loadFolders();
            document.getElementById('folder-detail-name').innerHTML = `${newName} <button class="icon-btn" onclick="renameFolder(${id}, '${newName}')" title="Rename Folder" style="background:none; border:none; color:var(--text-light); cursor:pointer;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`;
        } else alert("Failed to rename");
    } catch (e) { console.error(e); }
}

async function moveJobToFolder(taskId, folderId) {
    try {
        const res = await fetch(`/api/v1/jobs/${taskId}/move`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ folder_id: folderId ? parseInt(folderId) : null })
        });
        if (res.ok) {
            loadHistory();
            loadFolders();
        } else alert("Failed to move job");
    } catch (e) { console.error(e); }
}

function uploadToFolder(event) {
    if (!window.currentViewFolderId) return;
    pendingFiles = Array.from(event.target.files);
    if (pendingFiles.length === 0) return;

    // Switch to upload view manually to use existing process UI
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-files').classList.add('active');
    document.querySelectorAll('.view-section').forEach(s => { s.classList.remove('active'); s.classList.add('hidden'); });
    document.getElementById('view-dashboard').classList.remove('hidden');
    document.getElementById('view-dashboard').classList.add('active');

    processFiles(window.currentViewFolderId);
}

function downloadAllFromFolder() {
    if (!window.currentViewFolderId) return;
    window.location.href = `/api/v1/folders/${window.currentViewFolderId}/download_all?token=${token}`;
}

async function mergeFolderPdfs() {
    if (!window.currentViewFolderId) return;
    alert("Merging PDFs... this might take a moment. Check the folder in a few seconds.");
    try {
        const res = await fetch(`/api/v1/folders/${window.currentViewFolderId}/merge`, {
            method: 'POST',
            headers: getAuthHeaders()
        });
        if (res.ok) {
            loadFolderFiles(window.currentViewFolderId, document.getElementById('folder-detail-name').innerText.trim());
        } else {
            const err = await res.json();
            alert(err.detail || "Failed to merge");
        }
    } catch (e) { console.error(e); }
}

let isFolderGridView = false;
function toggleFolderGrid() {
    isFolderGridView = !isFolderGridView;
    const btn = document.getElementById('grid-toggle-btn');
    const list = document.getElementById('folder-files-list');
    btn.textContent = isFolderGridView ? "📄 List View" : "🔲 Grid View";

    if (isFolderGridView) {
        list.classList.add('grid-view-active');
    } else {
        list.classList.remove('grid-view-active');
    }
}

function filterFolderFiles() {
    const term = document.getElementById('folder-search-input').value.toLowerCase();
    const items = document.querySelectorAll('.folder-file-item');
    items.forEach(item => {
        const text = item.innerText.toLowerCase();
        item.style.display = text.includes(term) ? '' : 'none';
    });
}

// --- History Selection & Deletion Functions ---

function updateSelectedHistoryCount() {
    const checkboxes = document.querySelectorAll('.history-checkbox:checked');
    const count = checkboxes.length;
    const btn = document.getElementById('delete-selected-history-btn');
    const countSpan = document.getElementById('selected-history-count');
    const selectAllCb = document.getElementById('select-all-history-jobs');
    const allCheckboxes = document.querySelectorAll('.history-checkbox');

    if (countSpan) countSpan.textContent = count;
    if (btn) btn.style.display = count > 0 ? 'inline-block' : 'none';
    if (selectAllCb) {
        selectAllCb.checked = (allCheckboxes.length > 0 && count === allCheckboxes.length);
    }
}
window.updateSelectedHistoryCount = updateSelectedHistoryCount;

function toggleSelectAllHistory(checked) {
    const checkboxes = document.querySelectorAll('.history-checkbox');
    checkboxes.forEach(cb => cb.checked = checked);
    updateSelectedHistoryCount();
}
window.toggleSelectAllHistory = toggleSelectAllHistory;

async function deleteHistoryJob(taskId) {
    try {
        const res = await fetch(`/api/v1/history/${taskId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (res.ok) {
            loadHistory();
            loadDashboard();
        }
    } catch (e) {
        console.error('Error deleting history item', e);
    }
}
window.deleteHistoryJob = deleteHistoryJob;

async function deleteSelectedHistoryJobs() {
    const checked = Array.from(document.querySelectorAll('.history-checkbox:checked')).map(cb => cb.value);
    if (checked.length === 0) return;

    try {
        const res = await fetch('/api/v1/history/delete-batch', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ task_ids: checked })
        });
        if (res.ok) {
            loadHistory();
            loadDashboard();
        }
    } catch (e) {
        console.error('Error deleting history items', e);
    }
}
window.deleteSelectedHistoryJobs = deleteSelectedHistoryJobs;

async function clearAllHistory() {
    try {
        const res = await fetch('/api/v1/history', {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (res.ok) {
            loadHistory();
            loadDashboard();
        }
    } catch (e) {
        console.error('Error clearing history', e);
    }
}
window.clearAllHistory = clearAllHistory;
