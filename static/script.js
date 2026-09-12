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

// ===== Sidebar Hamburger & Resizer =====
const sidebar = document.getElementById('sidebar');
const toggleBtn = document.getElementById('sidebar-toggle-btn');
const resizer = document.getElementById('sidebar-resizer');

if (toggleBtn && sidebar) {
    toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
    });
}

if (resizer && sidebar) {
    let isResizing = false;
    let startX, startWidth;

    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = parseInt(document.defaultView.getComputedStyle(sidebar).width, 10);
        sidebar.classList.add('is-resizing');
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const newWidth = startWidth + (e.clientX - startX);
        if (newWidth >= 150 && newWidth <= 600) {
            sidebar.style.width = newWidth + 'px';
            sidebar.style.minWidth = newWidth + 'px';
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            sidebar.classList.remove('is-resizing');
            document.body.style.cursor = '';
        }
    });
}

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
        } else if (tabName === 'folders') {
            showFoldersView();
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

// ===== In-app dialogs =====
// Replaces native alert/confirm/prompt, which render as browser chrome ("localhost
// says...") and block the page. These are styled, dismissible, and promise-based so
// call sites read the same as before.

function toast(message, type = 'error') {
    let stack = document.getElementById('toast-stack');
    if (!stack) {
        stack = document.createElement('div');
        stack.id = 'toast-stack';
        stack.className = 'toast-stack';
        document.body.appendChild(stack);
    }

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `
        <span class="toast-icon">${type === 'success' ? '✓' : type === 'info' ? 'ℹ' : '!'}</span>
        <span class="toast-msg"></span>
        <button type="button" class="toast-close" aria-label="Dismiss">×</button>
    `;
    el.querySelector('.toast-msg').textContent = message;

    const remove = () => {
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 180);
    };
    el.querySelector('.toast-close').addEventListener('click', remove);
    stack.appendChild(el);
    setTimeout(remove, type === 'error' ? 6000 : 4000);
}
window.toast = toast;

function openModal({ title, message, confirmLabel = 'Confirm', danger = false, input = null }) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal" role="dialog" aria-modal="true">
                <h3 class="modal-title"></h3>
                <p class="modal-message"></p>
                ${input !== null ? '<input type="text" class="form-input modal-input">' : ''}
                <div class="modal-actions">
                    <button type="button" class="btn-secondary modal-cancel">Cancel</button>
                    <button type="button" class="${danger ? 'btn-danger' : 'btn-primary'} modal-confirm"></button>
                </div>
            </div>
        `;
        overlay.querySelector('.modal-title').textContent = title;
        overlay.querySelector('.modal-message').textContent = message || '';
        overlay.querySelector('.modal-confirm').textContent = confirmLabel;

        const field = overlay.querySelector('.modal-input');
        if (field) field.value = input;

        const close = value => {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(value);
        };
        const accept = () => close(field ? (field.value.trim() || null) : true);
        const onKey = e => {
            if (e.key === 'Escape') close(field ? null : false);
            if (e.key === 'Enter' && field) accept();
        };

        overlay.querySelector('.modal-cancel').addEventListener('click', () => close(field ? null : false));
        overlay.querySelector('.modal-confirm').addEventListener('click', accept);
        overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(field ? null : false); });
        document.addEventListener('keydown', onKey);

        document.body.appendChild(overlay);
        (field || overlay.querySelector('.modal-confirm')).focus();
    });
}

function confirmDialog(title, message, confirmLabel = 'Delete') {
    return openModal({ title, message, confirmLabel, danger: true });
}

function promptDialog(title, message, value = '', confirmLabel = 'Save') {
    return openModal({ title, message, confirmLabel, input: value });
}

// ===== Folders navigation =====
// Reachable from the top nav tab, the sidebar item, and the sidebar section label -
// all of them land on the full folder list, never inside a folder.
function showFoldersView() {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    const tab = document.getElementById('tab-folders');
    if (tab) tab.classList.add('active');

    document.querySelectorAll('.view-section').forEach(s => {
        s.classList.remove('active');
        s.classList.add('hidden');
    });
    document.getElementById('view-folders').classList.remove('hidden');
    document.getElementById('view-folders').classList.add('active');

    document.querySelectorAll('.sidebar-item').forEach(si => si.classList.remove('active'));
    const sidebarItem = document.getElementById('sidebar-folders');
    if (sidebarItem) sidebarItem.classList.add('active');

    loadFolders();
    showFoldersList();
}
window.showFoldersView = showFoldersView;

['sidebar-folders-label', 'sidebar-folders'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', showFoldersView);
});

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
                            const foldersTab = document.getElementById('tab-folders');
                            if (foldersTab) foldersTab.classList.add('active');
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
                            <div class="folder-item" onclick="loadFolderFiles(${f.id}, '${jsArg(f.name)}')">
                                <div class="folder-item-top">
                                    <input type="checkbox" class="folder-checkbox" value="${f.id}"
                                           onclick="event.stopPropagation(); updateSelectedFoldersCount()">
                                    <div class="folder-icon-lg">
                                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="1.5">
                                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                                        </svg>
                                    </div>
                                    <button class="folder-delete-btn" onclick="event.stopPropagation(); deleteFolder(${f.id})" title="Delete folder">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                                    </button>
                                </div>
                                <h3 class="folder-item-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</h3>
                                <div class="folder-meta">
                                    <span class="folder-file-count">${f.file_count} file${f.file_count === 1 ? '' : 's'}</span>
                                    <span class="folder-date">${date}</span>
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
    window.viewingUnfiled = (folderId === null || folderId === undefined);

    const renameBtn = window.viewingUnfiled ? '' : `<button class="icon-btn" onclick="renameFolder(${folderId}, '${folderName}')" title="Rename Folder" style="background:none; border:none; color:var(--text-light); cursor:pointer;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`;
    document.getElementById('folder-detail-name').innerHTML = `${folderName} ${renameBtn}`;

    // Folder-only bulk actions don't apply to the virtual "unfiled" view
    const downloadZipBtn = document.getElementById('folder-download-zip-btn');
    const mergeBtn = document.getElementById('folder-merge-btn');
    if (downloadZipBtn) downloadZipBtn.classList.toggle('hidden', window.viewingUnfiled);
    if (mergeBtn) mergeBtn.classList.toggle('hidden', window.viewingUnfiled);

    // Hide the folders list and show the detail view
    document.getElementById('folders-list').classList.add('hidden');
    document.getElementById('folders-header-card').classList.add('hidden');
    document.getElementById('folders-view-title').textContent = folderName;
    document.getElementById('folders-view-subtitle').textContent = window.viewingUnfiled
        ? 'PDFs uploaded without picking a folder.'
        : 'Files and processing history for this folder.';

    const detailView = document.getElementById('folder-detail-view');
    const filesList = document.getElementById('folder-files-list');
    detailView.classList.remove('hidden');
    filesList.innerHTML = '<p style="text-align:center; color: var(--text-light); padding: 20px;">Loading...</p>';

    try {
        const url = window.viewingUnfiled ? '/api/v1/files/unfiled' : `/api/v1/folders/${folderId}/files`;
        const res = await fetch(url, { headers: getAuthHeaders() });
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
                        <h3 style="color: var(--text-muted); font-size: 16px; margin-top: 12px;">${window.viewingUnfiled ? 'No unfiled uploads' : 'This folder is empty'}</h3>
                        <p style="color: var(--text-light); font-size: 13px;">${window.viewingUnfiled ? 'PDFs uploaded from the dashboard without picking a folder will show up here.' : 'Click the <b>+ Upload Here</b> button above, or move a file from your history to this folder.'}</p>
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
    
    if (!await confirmDialog('Delete files', `${selectedIds.length} selected file(s) will be permanently deleted.`, 'Delete files')) return;
    
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
            toast('Failed to delete files');
        }
    } catch (e) {
        toast('Error deleting files');
    }
}

window.showFoldersList = function () {
    // Leaving the detail view means we're no longer inside any folder - clear the
    // context too, or actions like "Upload Here" keep targeting the folder you left.
    window.currentViewFolderId = null;
    window.viewingUnfiled = false;

    document.getElementById('folders-list').classList.remove('hidden');
    document.getElementById('folders-header-card').classList.remove('hidden');
    document.getElementById('folder-detail-view').classList.add('hidden');
    document.getElementById('folders-view-title').textContent = 'Your Folders';
    document.getElementById('folders-view-subtitle').textContent = 'All of your folders.';
}

window.loadFolderFiles = loadFolderFiles;

async function deleteFolder(folderId) {
    if (!await confirmDialog('Delete folder', 'This folder and its file records will be deleted. The processed PDFs themselves are not removed.', 'Delete folder')) return;
    try {
        const res = await fetch(`/api/v1/folders/${folderId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (res.ok) {
            loadFolders();
            loadDashboard();
        } else {
            toast('Failed to delete folder');
        }
    } catch (e) { toast('Error deleting folder'); }
}
window.deleteFolder = deleteFolder;

window.deleteFolderFile = async function(fileId, folderId, folderName) {
    if (!await confirmDialog('Delete file', 'This file will be permanently deleted from the folder.', 'Delete file')) return;
    try {
        const res = await fetch(`/api/v1/folders/files/${fileId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (res.ok) {
            loadFolderFiles(folderId, folderName);
            loadFolders(); // refresh folder stats
        } else {
            toast('Failed to delete file');
        }
    } catch (e) {
        toast('Error deleting file');
    }
};

// Add Folder Button
const addFolderBtn = document.getElementById('add-folder-btn');
if (addFolderBtn) {
    addFolderBtn.addEventListener('click', () => createFolder());
}

async function createFolder() {
    const name = await promptDialog('New folder', 'Give the folder a name.', '', 'Create folder');
    if (!name) return;
    try {
        await fetch('/api/v1/folders', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ name })
        });
        loadFolders();
    } catch (e) { toast("Failed to create folder"); }
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
const previewImg = document.getElementById('preview-img');

let pendingFiles = [];
let countdownInterval = null;

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
        toast("Please upload at least one PDF file.");
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

// ===== ETA =====
// Driven by the worker's measured pages/second, not a per-page constant. The local
// tick just counts down smoothly between server updates.
let etaState = { seconds: null, pagesDone: 0, totalPages: 0 };

function formatDuration(seconds) {
    if (seconds < 60) return `${Math.max(seconds, 1)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return secs ? `${mins}m ${secs}s` : `${mins}m`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
}

function renderEta() {
    const el = document.getElementById('eta-message');
    if (!el) return;

    const { seconds, pagesDone, totalPages } = etaState;
    const pages = totalPages ? ` · ${pagesDone}/${totalPages} pages` : '';

    if (seconds === null) {
        el.textContent = `Estimating time remaining…${pages}`;
    } else if (seconds <= 0) {
        el.textContent = `Finishing up…${pages}`;
    } else {
        el.textContent = `About ${formatDuration(seconds)} remaining${pages}`;
    }
}

function tickEta() {
    if (etaState.seconds !== null && etaState.seconds > 0) etaState.seconds -= 1;
    renderEta();
}

function updateEtaFromProgress(data) {
    if (typeof data.completed_pages === 'number') etaState.pagesDone = data.completed_pages;
    if (typeof data.total_pages === 'number' && data.total_pages) etaState.totalPages = data.total_pages;
    if (data.eta_seconds !== undefined && data.eta_seconds !== null) etaState.seconds = data.eta_seconds;
    renderEta();
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

        // No fabricated estimate up front - the worker reports measured throughput as
        // soon as the first pages land, and the ETA comes from that.
        if (countdownInterval) clearInterval(countdownInterval);
        etaState = { seconds: null, pagesDone: 0, totalPages };
        etaMessage.textContent = 'Estimating time remaining…';

        countdownInterval = setInterval(tickEta, 1000);

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
            loadingMessage.textContent = `Processing ${completed}/${total} file(s)...`;

            // Page-level progress is far smoother than file-level: a single 74 page PDF
            // would otherwise sit at 0% until the entire file finished.
            if (data.total_pages) {
                progressBar.style.width = `${Math.min((data.completed_pages / data.total_pages) * 100, 100)}%`;
            } else if (total > 0) {
                progressBar.style.width = `${Math.min((completed / total) * 100, 100)}%`;
            }

            updateEtaFromProgress(data);

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
            wireReviewButton(taskId);
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
        if (status.startsWith('processing')) { statusClass = 'processing'; statusText = 'Processing...'; }
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
            wireReviewButton(taskId);
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

// ===== Review Queue =====
// Shows only the pages the pipeline flagged as uncertain. Thumbnails are lazy-loaded
// one page at a time so a 5,000-page job costs the same as a 5-page one to open.
window.reviewState = { taskId: null, offset: 0, limit: 10, scope: 'flagged' };

const REVIEW_REASONS = {
    no_text: 'No readable text found at any rotation',
    close_to_zero: 'Barely beat leaving the page unrotated',
    ambiguous: "Two rotations scored almost the same",
    error: 'Page failed to process',
    blank: 'Page appears to be blank',
    skewed: 'Page is tilted and may need straightening'
};

function reviewThumbUrl(taskId, filename, page, side) {
    return `/api/v1/page-thumb/${taskId}/${page}?filename=${encodeURIComponent(filename)}&side=${side}&token=${token}`;
}

// Filenames are user-supplied, so they can't go into markup or inline handlers raw.
function escapeHtml(value) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value).replace(/[&<>"']/g, c => map[c]);
}

function jsArg(value) {
    return encodeURIComponent(value).replace(/'/g, '%27');
}

function wireReviewButton(taskId) {
    const btn = document.getElementById('review-btn');
    if (btn) btn.onclick = () => openReview(taskId);
}

// ===== Bulk / pattern view =====
// A 5,000 page job can flag thousands of pages. Reviewing those one at a time isn't a
// workflow, so we collapse them into patterns and let one decision cover the group.
const REVIEW_GROUPS_THRESHOLD = 20;

window.reviewSetMode = function (mode) {
    window.reviewState.mode = mode;
    const groupsTab = document.getElementById('review-mode-groups');
    const pagesTab = document.getElementById('review-mode-pages');
    if (groupsTab) groupsTab.classList.toggle('active', mode === 'groups');
    if (pagesTab) pagesTab.classList.toggle('active', mode === 'pages');

    document.getElementById('review-groups').classList.toggle('hidden', mode !== 'groups');
    document.querySelector('.review-body').classList.toggle('hidden', mode === 'groups');
    document.getElementById('review-pager').classList.toggle('hidden', mode === 'groups');

    if (mode === 'groups') loadReviewGroups();
    else loadReview();
};

async function loadReviewGroups() {
    const container = document.getElementById('review-groups');
    container.innerHTML = '<p style="text-align:center; color: var(--text-light); padding: 20px;">Loading...</p>';

    try {
        const res = await fetch(`/api/v1/review/${window.reviewState.taskId}/groups`, { headers: getAuthHeaders() });
        if (!res.ok) {
            container.innerHTML = '<p style="color:#ef4444; text-align:center; padding:20px;">Could not load groups.</p>';
            return;
        }
        renderReviewGroups(await res.json());
    } catch (e) {
        container.innerHTML = '<p style="color:#ef4444; text-align:center; padding:20px;">Error loading groups.</p>';
    }
}

function renderReviewGroups(data) {
    const container = document.getElementById('review-groups');
    const taskId = window.reviewState.taskId;
    const s = data.summary;

    document.getElementById('review-subtitle').textContent =
        `${s.total_pages} pages · ${s.needs_review} flagged · grouped into ${s.groups} pattern(s)`;

    document.getElementById('review-summary').innerHTML = `
        <div class="review-summary-stats">
            <span class="review-stat flagged" data-remaining="${Math.max(s.needs_review - s.reviewed, 0)}">⚠ ${Math.max(s.needs_review - s.reviewed, 0)} need review</span>
            <span class="review-stat ok">✓ ${s.auto_corrected} auto-corrected</span>
        </div>
        <div class="review-summary-actions">
            <a href="/api/v1/text/${taskId}/download?token=${token}" class="btn-secondary" style="text-decoration:none;">⬇ Text (.txt)</a>
            <a href="/api/v1/markdown/${taskId}/download?token=${token}" class="btn-secondary" style="text-decoration:none;">⬇ Markdown (.md)</a>
            <a href="/api/v1/download/${taskId}?token=${token}" class="btn-primary" style="text-decoration:none;">⬇ Download final PDF</a>
        </div>
    `;

    if (!data.groups.length) {
        container.innerHTML = `
            <div class="review-empty">
                <h3>✓ Nothing needs review</h3>
                <p>Every page was corrected with high confidence.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = data.groups.map(g => {
        const done = g.reviewed >= g.count;
        const samples = g.sample.map(sp => `
            <figure class="review-group-sample">
                <img loading="lazy" src="${reviewThumbUrl(taskId, sp.filename, sp.page, 'after')}"
                     alt="${escapeHtml(sp.filename)} page ${sp.page + 1}">
                <figcaption title="${escapeHtml(sp.filename)}">${escapeHtml(sp.filename)} · p${sp.page + 1}</figcaption>
            </figure>
        `).join('');

        return `
            <div class="review-group ${done ? 'done' : ''}">
                <div class="review-group-head">
                    <div>
                        <h3>${done ? '✓' : '⚠'} ${escapeHtml(g.label)}</h3>
                        <p class="review-group-meta">
                            <strong>${g.count}</strong> page(s) across <strong>${g.files}</strong> file(s) ·
                            ${g.angle === 0 ? 'left unrotated' : `corrected to ${g.angle}°`}
                            ${g.reviewed ? ` · ${g.reviewed} already reviewed` : ''}
                        </p>
                        ${g.hint ? `<p class="review-group-hint">${escapeHtml(g.hint)}</p>` : ''}
                    </div>
                </div>

                <div class="review-group-samples">${samples}</div>

                <div class="review-group-actions">
                    ${g.reason === 'skewed' ? `
                        <span class="review-group-prompt">These are tilted:</span>
                        <button type="button" class="btn-primary" onclick="reviewGroupAction('${escapeHtml(g.reason)}', ${g.angle}, 'deskew', 0, ${g.count})">
                            ⟲ Straighten all ${g.count}
                        </button>
                        <span class="review-group-note">Re-renders these pages as images (larger file, text stays searchable)</span>
                    ` : ''}
                    <span class="review-group-prompt">If these samples look right:</span>
                    <button type="button" class="btn-primary" onclick="reviewGroupAction('${escapeHtml(g.reason)}', ${g.angle}, 'accept', 0, ${g.count})">
                        ✓ Accept all ${g.count}
                    </button>
                    <span class="review-group-prompt">If they're all turned the same way:</span>
                    <button type="button" class="btn-secondary" onclick="reviewGroupAction('${escapeHtml(g.reason)}', ${g.angle}, 'rotate', 90, ${g.count})">↻ Rotate all 90°</button>
                    <button type="button" class="btn-secondary" onclick="reviewGroupAction('${escapeHtml(g.reason)}', ${g.angle}, 'rotate', 180, ${g.count})">Rotate all 180°</button>
                    <button type="button" class="btn-secondary" onclick="reviewGroupAction('${escapeHtml(g.reason)}', ${g.angle}, 'rotate', 270, ${g.count})">↺ Rotate all -90°</button>
                    <button type="button" class="btn-secondary review-group-drill" onclick="reviewDrillIntoGroup('${escapeHtml(g.reason)}')">Review these individually →</button>
                </div>
            </div>
        `;
    }).join('');
}

window.reviewGroupAction = async function (reason, angle, action, rotateBy, count) {
    const what = action === 'accept'
        ? `Accept all ${count} page(s) as they are?`
        : action === 'deskew'
            ? `Straighten all ${count} tilted page(s)? They will be re-rendered as images - file size will grow, but the text stays searchable.`
            : `Rotate all ${count} page(s) by ${rotateBy}°?`;
    if (!await confirmDialog(action === 'accept' ? 'Accept pages' : 'Rotate pages', what, action === 'accept' ? 'Accept all' : 'Rotate all')) return;

    try {
        toast(action === 'deskew' ? 'Straightening pages…' : 'Applying…', 'info');
        const res = await fetch(`/api/v1/review/${window.reviewState.taskId}/group-action`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ reason, angle, action, rotate_by: rotateBy })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            toast(err.detail || 'Group action failed');
            return;
        }
        const data = await res.json();
        toast(`Done — ${data.pages} page(s) across ${data.files} file(s) updated.`, 'success');
        loadReviewGroups();
    } catch (e) {
        toast('Error applying group action');
    }
};

window.reviewDrillIntoGroup = function (reason) {
    const st = window.reviewState;
    st.reason = reason;
    st.file = null;
    st.offset = 0;
    reviewSetMode('pages');
};

window.openReview = async function (taskId) {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view-section').forEach(s => { s.classList.remove('active'); s.classList.add('hidden'); });
    document.querySelectorAll('.sidebar-item').forEach(si => si.classList.remove('active'));
    const view = document.getElementById('view-review');
    view.classList.remove('hidden');
    view.classList.add('active');

    window.reviewState = {
        taskId, offset: 0, limit: 10, scope: 'flagged',
        file: null, reason: null, goto: null, gotoFile: null, mode: 'pages'
    };

    // Peek at the size first: small jobs go straight to page-by-page, bulk jobs open
    // on the pattern view so nobody is handed 800 cards.
    try {
        const res = await fetch(`/api/v1/review/${taskId}?limit=1`, { headers: getAuthHeaders() });
        if (res.ok) {
            const peek = await res.json();
            const modes = document.getElementById('review-modes');
            if (peek.summary.needs_review >= REVIEW_GROUPS_THRESHOLD) {
                if (modes) modes.classList.remove('hidden');
                return reviewSetMode('groups');
            }
            if (modes) modes.classList.add('hidden');
        }
    } catch (e) { /* fall through to the page view */ }

    reviewSetMode('pages');
};

async function loadReview() {
    const st = window.reviewState;
    const cards = document.getElementById('review-cards');
    cards.innerHTML = '<p style="text-align:center; color: var(--text-light); padding: 20px;">Loading...</p>';

    let url = `/api/v1/review/${st.taskId}?scope=${st.scope}&offset=${st.offset}&limit=${st.limit}`;
    if (st.file) url += `&file=${encodeURIComponent(st.file)}`;
    if (st.reason) url += `&reason=${encodeURIComponent(st.reason)}`;
    if (st.goto) {
        url += `&goto=${st.goto}`;
        if (st.gotoFile) url += `&goto_file=${encodeURIComponent(st.gotoFile)}`;
    }

    try {
        const res = await fetch(url, { headers: getAuthHeaders() });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            cards.innerHTML = `<p style="color:#ef4444; text-align:center; padding:20px;">${err.detail || 'Could not load review data.'}</p>`;
            return;
        }

        const data = await res.json();

        // On first open, land on the first file that actually needs attention so the
        // user isn't staring at a file picker wondering where to start. Skipped when
        // drilling in from a pattern group, where the point is to span all files.
        if (!st.file && !st.reason && data.files.length > 1) {
            const firstFlagged = data.files.find(f => f.needs_review > f.reviewed)
                || data.files.find(f => f.needs_review > 0);
            if (firstFlagged) {
                st.file = firstFlagged.filename;
                st.offset = 0;
                return loadReview();
            }
        }

        // A jump resolves to a real offset server-side; adopt it so Next/Previous
        // continue from where we landed instead of from the old position.
        st.offset = data.offset;
        st.goto = null;
        st.gotoFile = null;
        renderReview(data);
    } catch (e) {
        cards.innerHTML = '<p style="color:#ef4444; text-align:center; padding:20px;">Error loading review data.</p>';
    }
}

// Left rail: only files that actually need attention. Clean files collapse to one
// line - with 32 uploads, 27 of them typically need nothing and shouldn't be scrolled past.
function renderReviewRail(data, filesWithFlags, cleanFiles) {
    const rail = document.getElementById('review-rail');
    if (!rail) return;

    // Single-file jobs don't need a file picker at all
    if (data.files.length <= 1) {
        rail.classList.add('hidden');
        rail.innerHTML = '';
        return;
    }
    rail.classList.remove('hidden');

    const rows = filesWithFlags.map(f => {
        const done = f.reviewed >= f.needs_review;
        const active = f.filename === window.reviewState.file;
        return `
            <button type="button"
                    class="review-rail-item ${active ? 'active' : ''} ${done ? 'done' : ''}"
                    onclick="reviewSelectFile('${jsArg(f.filename)}')"
                    title="${escapeHtml(f.filename)}"
                    data-reviewed="${f.reviewed}" data-flagged="${f.needs_review}">
                <span class="review-rail-name">${escapeHtml(f.filename)}</span>
                <span class="review-rail-count">${done ? '✓' : `${f.reviewed}/${f.needs_review}`}</span>
            </button>
        `;
    }).join('');

    const cleanBlock = cleanFiles.length ? `
        <div class="review-rail-clean">
            <button type="button" class="review-rail-clean-toggle" onclick="toggleCleanFiles()">
                ✓ ${cleanFiles.length} file(s) needed no review
                <span id="review-clean-caret">▾</span>
            </button>
            <div id="review-clean-list" class="review-rail-clean-list hidden">
                ${cleanFiles.map(f => `
                    <button type="button" class="review-rail-item subtle ${f.filename === window.reviewState.file ? 'active' : ''}"
                            onclick="reviewSelectFile('${jsArg(f.filename)}')" title="${escapeHtml(f.filename)}">
                        <span class="review-rail-name">${escapeHtml(f.filename)}</span>
                        <span class="review-rail-count">${f.total_pages}p</span>
                    </button>
                `).join('')}
            </div>
        </div>
    ` : '';

    rail.innerHTML = `
        <div class="review-rail-head">Needs review</div>
        ${rows || '<p class="review-rail-empty">Nothing flagged 🎉</p>'}
        ${cleanBlock}
    `;
}

// Text is fetched only when a panel is opened - loading it for every card would pull
// the whole document's text just to render a list.
window.togglePageText = async function (button, fileEnc, page) {
    const panel = button.parentElement.querySelector('.review-text-body');
    if (!panel) return;

    if (!panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
        button.textContent = button.textContent.replace('Hide', 'Show');
        return;
    }

    if (!panel.dataset.loaded) {
        panel.textContent = 'Loading…';
        panel.classList.remove('hidden');
        try {
            const filename = decodeURIComponent(fileEnc);
            const res = await fetch(
                `/api/v1/text/${window.reviewState.taskId}?filename=${encodeURIComponent(filename)}&page=${page}`,
                { headers: getAuthHeaders() }
            );
            if (!res.ok) throw new Error('failed');
            const data = await res.json();
            const body = (((data.files[0] || {}).pages || [])[0] || {}).text || '';
            panel.textContent = body || '(no text recognised on this page)';
            panel.dataset.loaded = '1';
        } catch (e) {
            panel.textContent = 'Could not load text for this page.';
        }
    } else {
        panel.classList.remove('hidden');
    }
    button.textContent = button.textContent.replace('Show', 'Hide');
};

window.reviewClearReason = function () {
    window.reviewState.reason = null;
    window.reviewState.offset = 0;
    loadReview();
};

window.reviewSelectFile = function (fileEnc) {
    const st = window.reviewState;
    st.file = decodeURIComponent(fileEnc);
    st.offset = 0;
    st.goto = null;
    loadReview();
};

window.toggleCleanFiles = function () {
    const list = document.getElementById('review-clean-list');
    const caret = document.getElementById('review-clean-caret');
    if (!list) return;
    list.classList.toggle('hidden');
    if (caret) caret.textContent = list.classList.contains('hidden') ? '▾' : '▴';
};

function renderReview(data) {
    const { taskId } = window.reviewState;
    const s = data.summary;
    const remaining = Math.max(s.needs_review - s.reviewed, 0);

    const activeFile = data.files.find(f => f.filename === window.reviewState.file) || null;
    const filesWithFlags = data.files.filter(f => f.needs_review > 0);
    const cleanFiles = data.files.filter(f => f.needs_review === 0);

    document.getElementById('review-subtitle').textContent = data.files.length > 1
        ? `${data.files.length} files · ${s.total_pages} pages · ${s.needs_review} flagged across ${filesWithFlags.length} file(s)`
        : `${s.total_pages} page(s) processed · ${s.needs_review} flagged for review`;

    renderReviewRail(data, filesWithFlags, cleanFiles);

    // Drilled in from a pattern group - make the active filter visible and escapable
    const filterBar = document.getElementById('review-filter-bar');
    if (filterBar) {
        if (window.reviewState.reason) {
            filterBar.classList.remove('hidden');
            filterBar.innerHTML = `
                <span>Showing only: <strong>${escapeHtml(REVIEW_REASONS[window.reviewState.reason] || window.reviewState.reason)}</strong></span>
                <button type="button" class="btn-secondary" onclick="reviewClearReason()">Clear filter</button>
            `;
        } else {
            filterBar.classList.add('hidden');
            filterBar.innerHTML = '';
        }
    }

    // --- Summary bar ---
    document.getElementById('review-summary').innerHTML = `
        <div class="review-summary-stats">
            <span class="review-stat flagged" data-remaining="${remaining}">⚠ ${remaining} need review</span>
            <span class="review-stat ok">✓ ${s.auto_corrected} auto-corrected</span>
        </div>
        <div class="review-summary-actions">
            ${remaining > 0 ? `<button class="btn-secondary" onclick="reviewBulk('accept_all')">Approve all</button>` : ''}
            <a href="/api/v1/text/${taskId}/download?token=${token}" class="btn-secondary" style="text-decoration:none;">⬇ Text (.txt)</a>
            <a href="/api/v1/markdown/${taskId}/download?token=${token}" class="btn-secondary" style="text-decoration:none;">⬇ Markdown (.md)</a>
            <a href="/api/v1/download/${taskId}?token=${token}" class="btn-primary" style="text-decoration:none;">⬇ Download final PDF</a>
        </div>
    `;

    // --- Every page was a guess: one bulk decision instead of hundreds of cards ---
    // Scoped to the selected file, since one bad scan in a 32-file batch shouldn't
    // offer to rotate the other 31.
    const bulkPanel = document.getElementById('review-bulk-panel');
    const bulkTarget = activeFile || (data.files.length === 1 ? data.files[0] : null);
    if (bulkTarget && bulkTarget.all_low_confidence && bulkTarget.total_pages > 0) {
        const scopeArg = data.files.length > 1 ? `'${jsArg(bulkTarget.filename)}'` : 'null';
        bulkPanel.classList.remove('hidden');
        bulkPanel.innerHTML = `
            <h3>⚠ All ${bulkTarget.total_pages} pages of ${escapeHtml(bulkTarget.filename)} came back low confidence</h3>
            <p>No readable text was detected at any rotation — this is usually an image-only scan.
               Reviewing every page individually won't help. Pick one action for this document:</p>
            <div class="review-bulk-actions">
                <button type="button" class="btn-secondary" onclick="reviewBulk('accept_all', 0, ${scopeArg})">Leave all unchanged</button>
                <button type="button" class="btn-secondary" onclick="reviewBulk('rotate_all', 90, ${scopeArg})">Rotate all 90°</button>
                <button type="button" class="btn-secondary" onclick="reviewBulk('rotate_all', 180, ${scopeArg})">Rotate all 180°</button>
                <button type="button" class="btn-secondary" onclick="reviewBulk('rotate_all', 270, ${scopeArg})">Rotate all 270°</button>
            </div>
        `;
    } else {
        bulkPanel.classList.add('hidden');
        bulkPanel.innerHTML = '';
    }

    // --- Review cards ---
    const cards = document.getElementById('review-cards');
    if (data.pages.length === 0) {
        cards.innerHTML = `
            <div class="review-empty">
                <h3>${data.scope === 'all' ? 'No pages to show' : '✓ Nothing needs review'}</h3>
                <p>Every page was corrected with high confidence. You can download the result directly.</p>
                <button class="btn-secondary" onclick="reviewSetScope('all')">Show all pages anyway</button>
            </div>
        `;
    } else {
        cards.innerHTML = data.pages.map(p => {
            const key = escapeHtml(`${p.filename}::${p.page}`);
            const safeName = escapeHtml(p.filename);
            const argName = jsArg(p.filename);
            const scores = Object.entries(p.scores || {})
                .map(([angle, val]) => `<span class="review-score">${escapeHtml(angle)}°: ${escapeHtml(val)}</span>`)
                .join('');
            return `
                <div class="review-card ${p.reviewed ? 'reviewed' : ''}" data-key="${key}">
                    <div class="review-card-head">
                        <div>
                            <strong>${safeName}</strong> · Page ${p.page + 1}
                            <div class="review-reason">${REVIEW_REASONS[p.reason] || (p.needs_review ? 'Uncertain' : 'High confidence')}</div>
                        </div>
                        <div class="review-card-badges">
                            <span class="review-angle">detected ${p.angle}°</span>
                            ${p.reviewed ? '<span class="review-done">✓ reviewed</span>' : ''}
                        </div>
                    </div>
                    <div class="review-compare">
                        <figure class="review-pane">
                            <figcaption><span class="review-pane-label before">Before</span> original upload</figcaption>
                            <div class="review-img-frame">
                                <img loading="lazy" src="${reviewThumbUrl(taskId, p.filename, p.page, 'before')}" alt="Page ${p.page + 1} before">
                            </div>
                        </figure>
                        <div class="review-arrow" aria-hidden="true">→</div>
                        <figure class="review-pane">
                            <figcaption><span class="review-pane-label after">After</span> corrected ${p.angle === 0 ? '(unchanged)' : `(${p.angle}°)`}</figcaption>
                            <div class="review-img-frame">
                                <img loading="lazy" class="review-after-img" src="${reviewThumbUrl(taskId, p.filename, p.page, 'after')}" alt="Page ${p.page + 1} after">
                            </div>
                        </figure>
                    </div>
                    <div class="review-scores">${scores}</div>
                    <div class="review-text">
                        <button type="button" class="review-text-toggle" onclick="togglePageText(this, '${argName}', ${p.page})">
                            📄 Show extracted text${p.word_count ? ` (${p.word_count} words)` : ''}
                        </button>
                        <pre class="review-text-body hidden"></pre>
                    </div>
                    <div class="review-actions">
                        <button type="button" class="btn-primary" onclick="approveReviewPage('${argName}', ${p.page})">✓ Looks right</button>
                        <button type="button" class="btn-secondary" onclick="rotateReviewPage('${argName}', ${p.page}, 90)">↻ Rotate 90°</button>
                        <button type="button" class="btn-secondary" onclick="rotateReviewPage('${argName}', ${p.page}, 270)">↺ Rotate -90°</button>
                        <button type="button" class="btn-secondary" onclick="rotateReviewPage('${argName}', ${p.page}, 180)">⤡ Rotate 180°</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    // --- Pagination + jump to a specific page ---
    const pager = document.getElementById('review-pager');
    const shownTo = Math.min(data.offset + data.limit, data.total);

    if (data.total === 0) {
        pager.innerHTML = '';
        return;
    }

    // The rail already scopes to a file, so the jump only needs a page number
    const fileOptions = '';

    const nav = data.total > data.limit
        ? `<button type="button" class="btn-secondary" ${data.offset === 0 ? 'disabled' : ''} onclick="reviewPage(-1)">← Previous</button>
           <span>${data.offset + 1}–${shownTo} of ${data.total}</span>
           <button type="button" class="btn-secondary" ${shownTo >= data.total ? 'disabled' : ''} onclick="reviewPage(1)">Next →</button>`
        : `<span>${data.total} page(s)</span>`;

    pager.innerHTML = `
        <div class="review-pager-nav">${nav}</div>
        <div class="review-goto">
            <label for="review-goto-input">Go to page</label>
            ${fileOptions}
            <input type="number" id="review-goto-input" class="form-input review-goto-input" min="1" placeholder="#">
            <button type="button" class="btn-secondary" onclick="reviewGoto()">Go</button>
            <span id="review-goto-msg" class="review-goto-msg"></span>
        </div>
    `;

    // Enter should submit, not just the Go button
    const input = document.getElementById('review-goto-input');
    if (input) {
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); reviewGoto(); }
        });
    }

    if (data.goto_found === false) {
        const msg = document.getElementById('review-goto-msg');
        if (msg) {
            msg.textContent = window.reviewState.scope === 'flagged'
                ? "That page isn't flagged for review."
                : 'No such page in this job.';
            msg.classList.add('miss');
        }
    }
}

window.reviewGoto = function () {
    const input = document.getElementById('review-goto-input');
    const msg = document.getElementById('review-goto-msg');
    const fileSelect = document.getElementById('review-goto-file');
    if (!input) return;

    const value = parseInt(input.value, 10);
    if (!value || value < 1) {
        if (msg) { msg.textContent = 'Enter a page number.'; msg.classList.add('miss'); }
        return;
    }

    window.reviewState.goto = value;
    window.reviewState.gotoFile = fileSelect ? fileSelect.value : window.reviewState.file;
    loadReview();
};

window.reviewPage = function (direction) {
    const st = window.reviewState;
    st.offset = Math.max(0, st.offset + direction * st.limit);
    loadReview();
};

window.reviewSetScope = function (scope) {
    window.reviewState.scope = scope;
    window.reviewState.offset = 0;
    loadReview();
};

// Actions update their own card in place. Re-rendering the whole list would reset
// the scroll position, and the thumbnail URL is cached so a reload wouldn't even
// show the new rotation.
function reviewCardFor(filename, page) {
    // Inside a quoted attribute selector only backslashes and quotes need escaping -
    // CSS.escape would mangle spaces and dots and never match.
    const key = `${filename}::${page}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return document.querySelector(`.review-card[data-key="${key}"]`);
}

function markCardReviewed(card) {
    if (!card || card.classList.contains('reviewed')) return;
    card.classList.add('reviewed');

    const badges = card.querySelector('.review-card-badges');
    if (badges && !badges.querySelector('.review-done')) {
        const badge = document.createElement('span');
        badge.className = 'review-done';
        badge.textContent = '✓ reviewed';
        badges.appendChild(badge);
    }

    // Keep the header count honest without refetching
    const stat = document.querySelector('.review-stat.flagged');
    if (stat) {
        const remaining = Math.max((parseInt(stat.dataset.remaining || '0', 10)) - 1, 0);
        stat.dataset.remaining = remaining;
        stat.textContent = `⚠ ${remaining} need review`;
    }

    // ...and the selected file's progress in the rail
    const railItem = document.querySelector('.review-rail-item.active');
    if (railItem) {
        const flagged = parseInt(railItem.dataset.flagged || '0', 10);
        const done = Math.min(parseInt(railItem.dataset.reviewed || '0', 10) + 1, flagged);
        railItem.dataset.reviewed = done;
        const count = railItem.querySelector('.review-rail-count');
        if (count) count.textContent = done >= flagged ? '✓' : `${done}/${flagged}`;
        if (done >= flagged) railItem.classList.add('done');
    }
}

async function withBusyButtons(card, fn) {
    const buttons = card ? card.querySelectorAll('.review-actions button') : [];
    buttons.forEach(b => { b.disabled = true; });
    try {
        await fn();
    } finally {
        buttons.forEach(b => { b.disabled = false; });
    }
}

window.approveReviewPage = async function (filenameEnc, page) {
    const filename = decodeURIComponent(filenameEnc);
    const card = reviewCardFor(filename, page);

    await withBusyButtons(card, async () => {
        try {
            const res = await fetch(`/api/v1/review/${window.reviewState.taskId}/approve`, {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ filename, page })
            });
            if (res.ok) markCardReviewed(card);
            else toast('Failed to approve page');
        } catch (e) { toast('Error approving page'); }
    });
};

window.rotateReviewPage = async function (filenameEnc, page, rotation) {
    const filename = decodeURIComponent(filenameEnc);
    const card = reviewCardFor(filename, page);

    await withBusyButtons(card, async () => {
        try {
            const res = await fetch(`/api/v1/override/${window.reviewState.taskId}`, {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ filename, page, rotation })
            });
            if (!res.ok) {
                toast('Failed to rotate page');
                return;
            }

            // The endpoint hands back the freshly rendered page - use it directly so we
            // don't fight the thumbnail cache.
            const data = await res.json();
            const img = card && card.querySelector('.review-after-img');
            if (img && data.image) img.src = `data:image/png;base64,${data.image}`;

            const angleBadge = card && card.querySelector('.review-angle');
            if (angleBadge) angleBadge.textContent = 'adjusted manually';

            markCardReviewed(card);
        } catch (e) { toast('Error rotating page'); }
    });
};

window.reviewBulk = async function (action, angle = 0, fileEnc = null) {
    const filename = fileEnc ? decodeURIComponent(fileEnc) : null;
    const target = filename ? `"${filename}"` : 'this job';
    const label = action === 'accept_all'
        ? `accept every flagged page in ${target} as-is`
        : `rotate every page in ${target} by ${angle}°`;
    if (!await confirmDialog('Apply to all pages', `This will ${label}.`, 'Apply')) return;
    try {
        const res = await fetch(`/api/v1/review/${window.reviewState.taskId}/bulk`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(filename ? { action, angle, filename } : { action, angle })
        });
        if (res.ok) {
            window.reviewState.offset = 0;
            loadReview();
        } else {
            const err = await res.json().catch(() => ({}));
            toast(err.detail || 'Bulk action failed');
        }
    } catch (e) { toast('Error applying bulk action'); }
};

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
                let reviewBtn = `<button class="btn-secondary" onclick="openReview('${job.task_id}')" style="padding: 6px 14px; font-size: 12px; margin-right: 8px;">Review</button>`;
                actionHtml = `${reviewBtn}<a href="/api/v1/download/${job.task_id}?token=${token}" class="btn-primary" style="padding: 6px 14px; text-decoration: none; font-size: 12px;">Download</a>${moveSelect}`;
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
    const newName = await promptDialog('Rename folder', 'Enter a new name for this folder.', currentName, 'Rename');
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
        } else toast("Failed to rename");
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
        } else toast("Failed to move job");
    } catch (e) { console.error(e); }
}

function uploadToFolder(event) {
    if (!window.currentViewFolderId && !window.viewingUnfiled) return;
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
    toast("Merging PDFs... this might take a moment.", 'info');
    try {
        const res = await fetch(`/api/v1/folders/${window.currentViewFolderId}/merge`, {
            method: 'POST',
            headers: getAuthHeaders()
        });
        if (res.ok) {
            loadFolderFiles(window.currentViewFolderId, document.getElementById('folder-detail-name').innerText.trim());
        } else {
            const err = await res.json();
            toast(err.detail || "Failed to merge");
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
    const downloadBtn = document.getElementById('download-selected-history-btn');
    const countSpan = document.getElementById('selected-history-count');
    const selectAllCb = document.getElementById('select-all-history-jobs');
    const allCheckboxes = document.querySelectorAll('.history-checkbox');

    if (countSpan) countSpan.textContent = count;
    if (btn) btn.style.display = count > 0 ? 'inline-block' : 'none';
    if (downloadBtn) downloadBtn.style.display = count > 0 ? 'inline-block' : 'none';
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

function downloadSelectedHistoryJobs() {
    const checked = Array.from(document.querySelectorAll('.history-checkbox:checked')).map(cb => cb.value);
    if (checked.length === 0) return;
    const taskIds = checked.join(',');
    window.location.href = `/api/v1/download_bulk?task_ids=${taskIds}&token=${token}`;
}
window.downloadSelectedHistoryJobs = downloadSelectedHistoryJobs;

function downloadAllFolders() {
    if (!window.userFolders || window.userFolders.length === 0) {
        toast("No folders to download.", 'info');
        return;
    }
    const folderIds = window.userFolders.map(f => f.id).join(',');
    window.location.href = `/api/v1/download_bulk?folder_ids=${folderIds}&token=${token}`;
}
window.downloadAllFolders = downloadAllFolders;

function updateSelectedFoldersCount() {
    const checkboxes = document.querySelectorAll('.folder-checkbox:checked');
    const count = checkboxes.length;
    const downloadBtn = document.getElementById('download-selected-folders-btn');
    const selectAllCb = document.getElementById('select-all-folders');
    const allCheckboxes = document.querySelectorAll('.folder-checkbox');

    if (downloadBtn) {
        downloadBtn.style.display = count > 0 ? 'inline-block' : 'none';
        if (count > 0) {
            downloadBtn.textContent = `⬇️ Download Selected (${count})`;
        }
    }

    const deleteBtn = document.getElementById('delete-selected-folders-btn');
    if (deleteBtn) {
        deleteBtn.style.display = count > 0 ? 'inline-block' : 'none';
        if (count > 0) {
            deleteBtn.textContent = `🗑️ Delete Selected (${count})`;
        }
    }

    if (selectAllCb) {
        selectAllCb.checked = (allCheckboxes.length > 0 && count === allCheckboxes.length);
    }
}
window.updateSelectedFoldersCount = updateSelectedFoldersCount;

function toggleSelectAllFolders(checked) {
    const checkboxes = document.querySelectorAll('.folder-checkbox');
    checkboxes.forEach(cb => cb.checked = checked);
    updateSelectedFoldersCount();
}
window.toggleSelectAllFolders = toggleSelectAllFolders;

async function deleteSelectedFolders() {
    const selected = Array.from(document.querySelectorAll('.folder-checkbox:checked')).map(cb => parseInt(cb.value, 10));
    if (selected.length === 0) return;

    if (!await confirmDialog('Delete folders', `${selected.length} folder(s) and their file records will be deleted. The processed PDFs themselves are not removed.`, `Delete ${selected.length} folder(s)`)) return;

    try {
        const res = await fetch('/api/v1/folders/delete-batch', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ folder_ids: selected })
        });
        if (res.ok) {
            const selectAllCb = document.getElementById('select-all-folders');
            if (selectAllCb) selectAllCb.checked = false;

            // loadFolders() rebuilds the grid (and its checkboxes), so the count has to
            // be recalculated AFTER it finishes - otherwise it counts the stale, still
            // ticked boxes and the button keeps showing the old selection.
            await loadFolders();
            updateSelectedFoldersCount();
            showFoldersList();
            loadDashboard();
        } else {
            toast('Failed to delete folders');
        }
    } catch (e) {
        toast('Error deleting folders');
    }
}
window.deleteSelectedFolders = deleteSelectedFolders;

function downloadSelectedFolders() {
    const checked = Array.from(document.querySelectorAll('.folder-checkbox:checked')).map(cb => cb.value);
    if (checked.length === 0) return;
    const folderIds = checked.join(',');
    window.location.href = `/api/v1/download_bulk?folder_ids=${folderIds}&token=${token}`;
}
window.downloadSelectedFolders = downloadSelectedFolders;
