// =============================================
// CursorRemote - Controls (Dropdowns, History)
// =============================================

// --- Inputs ---
async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message) {
        messageInput.focus();
        return;
    }

    // Optimistic UI updates
    const previousValue = messageInput.value;
    messageInput.value = ''; // Clear immediately
    messageInput.style.height = 'auto'; // Reset height
    messageInput.blur(); // Close keyboard on mobile immediately
    syncShellPromptFromComposer('');
    updateComposerActionState();

    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.5';

    try {
        // If no chat is open, start a new one first
        if (!chatIsOpen) {
            const newChatRes = await fetchWithAuth('/new-chat', { method: 'POST' });
            const newChatData = await newChatRes.json();
            if (newChatData.success) {
                // Wait for the new chat to be ready
                await new Promise(r => setTimeout(r, 450));
                chatIsOpen = true;
            }
        }

        const res = await fetchWithAuth('/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });

        // Prioritize fast snapshot refresh right after send.
        queueSnapshotReload({ delays: FAST_ACTION_SNAPSHOT_DELAYS });
        setTimeout(checkChatStatus, ACTION_STATUS_RECHECK_DELAY);

        // Don't revert the input - if user sees the message in chat, it was sent
        // Only log errors for debugging, don't show alert popups
        if (!res.ok) {
            console.warn('Send response not ok, but message may have been sent:', await res.json().catch(() => ({})));
        }
    } catch (e) {
        // Network error - still try to refresh in case it went through
        console.error('Send error:', e);
        queueSnapshotReload({ delays: FAST_ACTION_SNAPSHOT_DELAYS });
    } finally {
        sendBtn.disabled = false;
        sendBtn.style.opacity = '1';
    }
}

// --- Event Listeners ---
sendBtn.addEventListener('click', sendMessage);

refreshBtn.addEventListener('click', () => {
    if (document.body.classList.contains('home-screen')) {
        startNewChat();
        return;
    }

    // Refresh both Chat and State (Mode/Model)
    loadSnapshot();
    fetchAppState(); // PRIORITY: Sync from Desktop
});

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

messageInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
    syncShellPromptFromComposer(this.value);
    updateComposerActionState();
});

// --- File Attach Logic ---
attachBtn.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files);
    if (!files.length) return;

    // Create or get preview bar
    let previewBar = document.querySelector('.file-preview-bar');
    if (!previewBar) {
        previewBar = document.createElement('div');
        previewBar.className = 'file-preview-bar';
        // Insert before textarea inside input-box
        const inputBox = document.querySelector('.input-box');
        inputBox.insertBefore(previewBar, inputBox.firstChild);
    }

    // Upload each file
    for (const file of files) {
        const fileId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        // Create preview item
        const item = document.createElement('div');
        item.className = 'file-preview-item uploading';
        item.id = fileId;
        item.innerHTML = `
            <span class="file-preview-name" title="${file.name}">${file.name}</span>
            <span class="file-preview-size">${formatFileSize(file.size)}</span>
            <div class="file-preview-spinner"></div>
        `;
        previewBar.appendChild(item);

        // Upload
        try {
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetchWithAuth('/upload', {
                method: 'POST',
                body: formData
            });
            const data = await res.json();

            if (data.success) {
                item.classList.remove('uploading');
                item.classList.add('uploaded');
                item.querySelector('.file-preview-spinner').outerHTML = '<span class="file-preview-check">âœ“</span>';
                const uploadStatus = item.querySelector('.file-preview-check');
                if (uploadStatus) uploadStatus.innerHTML = '&#10003;';
                // Add remove button
                const removeBtn = document.createElement('button');
                removeBtn.textContent = 'Ã—';
                removeBtn.className = 'file-preview-remove';
                removeBtn.innerHTML = 'Ã—';
                removeBtn.setAttribute('aria-label', 'Remove file');
                removeBtn.textContent = 'Ã—';
                removeBtn.addEventListener('click', () => {
                    item.remove();
                    if (previewBar.children.length === 0) previewBar.remove();
                });
                item.appendChild(removeBtn);

                // Auto-remove after 5s
                setTimeout(() => {
                    item.style.transition = 'opacity 0.3s';
                    item.style.opacity = '0';
                    setTimeout(() => {
                        item.remove();
                        if (previewBar && previewBar.children.length === 0) previewBar.remove();
                    }, 300);
                }, 5000);
            } else {
                item.classList.remove('uploading');
                item.classList.add('error');
                item.querySelector('.file-preview-spinner').outerHTML = '<span style="color:#ef4444">âœ—</span>';
                const uploadErrorStatus = item.querySelector('span[style="color:#ef4444"]');
                if (uploadErrorStatus) uploadErrorStatus.innerHTML = '&#10005;';
                console.error('[UPLOAD] Failed:', data.error);
            }
        } catch (e) {
            item.classList.remove('uploading');
            item.classList.add('error');
            item.querySelector('.file-preview-spinner').outerHTML = '<span style="color:#ef4444">âœ—</span>';
            const uploadErrorStatus = item.querySelector('span[style="color:#ef4444"]');
            if (uploadErrorStatus) uploadErrorStatus.innerHTML = '&#10005;';
            console.error('[UPLOAD] Error:', e);
        }
    }

    // Reset file input so the same file can be re-selected
    fileInput.value = '';

    // Reload snapshot to see the attached file in chat.
    queueSnapshotReload({ delays: FILE_UPLOAD_SNAPSHOT_DELAYS });
});

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

// --- Scroll Sync to Desktop ---
let scrollSyncTimeout = null;
let lastScrollSync = 0;
const SCROLL_SYNC_DEBOUNCE = 150; // ms between scroll syncs
let snapshotReloadPending = false;

async function syncScrollToDesktop() {
    const scrollableHeight = Math.max(chatContainer.scrollHeight - chatContainer.clientHeight, 0);
    const scrollPercent = scrollableHeight > 0 ? chatContainer.scrollTop / scrollableHeight : 0;
    try {
        await fetchWithAuth('/remote-scroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scrollPercent: Math.min(1, Math.max(0, scrollPercent)) })
        });

        // After scrolling desktop, reload snapshot to get newly visible content
        // (Cursor uses virtualized scrolling - only visible messages are in DOM)
        if (!snapshotReloadPending) {
            snapshotReloadPending = true;
            setTimeout(() => {
                loadSnapshot();
                snapshotReloadPending = false;
            }, 120);
        }
    } catch (e) {
        console.log('Scroll sync failed:', e.message);
    }
}

chatContainer.addEventListener('scroll', () => {
    userIsScrolling = true;
    // Set a lock to prevent auto-scroll jumping for a few seconds
    userScrollLockUntil = Date.now() + USER_SCROLL_LOCK_DURATION;
    clearTimeout(idleTimer);

    const isNearBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 120;
    if (isNearBottom) {
        scrollToBottomBtn.classList.remove('show');
        // If user scrolled to bottom, clear the lock so auto-scroll works
        userScrollLockUntil = 0;
    } else {
        scrollToBottomBtn.classList.add('show');
    }

    // Debounced scroll sync to desktop
    const now = Date.now();
    if (now - lastScrollSync > SCROLL_SYNC_DEBOUNCE) {
        lastScrollSync = now;
        clearTimeout(scrollSyncTimeout);
        scrollSyncTimeout = setTimeout(syncScrollToDesktop, 100);
    }

    idleTimer = setTimeout(() => {
        userIsScrolling = false;
        autoRefreshEnabled = true;
    }, 5000);
});

scrollToBottomBtn.addEventListener('click', () => {
    userIsScrolling = false;
    userScrollLockUntil = 0; // Clear lock so auto-scroll works again
    scrollToBottom();
});

// --- Stop Logic ---
stopBtn.addEventListener('click', async () => {
    stopBtn.style.opacity = '0.5';
    try {
        const res = await fetchWithAuth('/stop', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            // Immediately switch back to send button
            document.body.classList.remove('agent-running');
            updateWorkspaceChrome({ running: false });
        }
    } catch (e) { }
    setTimeout(() => stopBtn.style.opacity = '1', 500);
    // Re-sync state from desktop
    setTimeout(fetchAppState, 300);
});

// --- New Chat Logic ---
async function startNewChat() {
    newChatBtn.style.opacity = '0.5';
    newChatBtn.style.pointerEvents = 'none';

    try {
        const res = await fetchWithAuth('/new-chat', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            setActiveChatTitle('');
            // Reload snapshot quickly to show the new conversation.
            queueSnapshotReload({ delays: NEW_CHAT_SNAPSHOT_DELAYS });
            setTimeout(checkChatStatus, ACTION_STATUS_RECHECK_DELAY);
        } else {
            console.error('Failed to start new chat:', data.error);
        }
    } catch (e) {
        console.error('New chat error:', e);
    }

    setTimeout(() => {
        newChatBtn.style.opacity = '1';
        newChatBtn.style.pointerEvents = 'auto';
    }, 500);
}

newChatBtn.addEventListener('click', startNewChat);

// --- Settings / Theme Toggle ---
settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsDropdown.classList.toggle('open');
});

settingsDropdown.addEventListener('click', (e) => {
    const option = e.target.closest('.settings-option');
    if (!option) return;

    if (option === restartCursorCdpBtn) {
        restartCursorWithCdp();
        return;
    }

    if (option.dataset.themeValue) {
        applyTheme(option.dataset.themeValue);
        settingsDropdown.classList.remove('open');
    }
});

document.addEventListener('click', (e) => {
    if (!e.target.closest('.settings-wrapper')) {
        settingsDropdown.classList.remove('open');
    }
});

// --- Chat History Logic ---
showChatHistory = async function () {
    const historyLayer = document.getElementById('historyLayer');
    const historyList = document.getElementById('historyList');

    // Show loading state
    historyList.innerHTML = `
        <div class="history-state-container">
            <div class="history-spinner"></div>
            <div class="history-state-text">Loading History...</div>
        </div>
    `;
    historyLayer.classList.add('show');
    historyBtn.style.opacity = '1';

    try {
        const res = await fetchWithAuth('/chat-history');
        const data = await res.json();
        if (data?.activeTitle) {
            setActiveChatTitle(data.activeTitle);
        } else {
            updateActiveChatTitleFromHistory(data.chats, true);
        }

        if (data.error) {
            historyList.innerHTML = `
                <div class="history-state-container">
                    <div class="history-state-icon">âš ï¸</div>
                    <div class="history-state-title">Error loading history</div>
                    <div class="history-state-desc">${data.error}</div>
                    <button class="history-new-btn mt-4" onclick="hideChatHistory(); startNewChat();">
                        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                        Start New Conversation
                    </button>
                </div>
            `;
            applyHistoryStateIcon('warning');
            return;
        }

        const chats = Array.isArray(data.chats) ? data.chats.slice() : [];
        if (chats.length === 0) {
            historyList.innerHTML = `
                <div class="history-state-container">
                    <div class="history-state-icon">ðŸ“</div>
                    <div class="history-state-title">No conversations yet</div>
                    <div class="history-state-desc">Start a new conversation to see them here.</div>
                </div>
            `;
            applyHistoryStateIcon('empty');
            return;
        }

        const activeTitle = normalizeChatTitle(data.activeTitle);
        if (activeTitle) {
            const activeIndex = chats.findIndex((chat) => chatTitlesMatch(chat?.title, activeTitle));
            if (activeIndex > 0) {
                const [activeChat] = chats.splice(activeIndex, 1);
                chats.unshift(activeChat);
            }
        }

        // Helper: relative time
        function timeAgo(dateStr) {
            if (!dateStr) return '';
            const diff = Date.now() - new Date(dateStr).getTime();
            const mins = Math.floor(diff / 60000);
            if (mins < 1) return 'now';
            if (mins < 60) return mins + ' mins ago';
            const hrs = Math.floor(mins / 60);
            if (hrs < 24) return hrs + ' hrs ago';
            const days = Math.floor(hrs / 24);
            return days + ' day' + (days > 1 ? 's' : '') + ' ago';
        }

        // Current chat = first item (most recent/active)
        const current = chats[0];
        const rest = chats.slice(1);
        const safeCurrentTitle = current.title.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

        let html = '';

        // Current section
        html += `<div class="history-section-label">Current</div>`;
        html += `<div class="history-item current" onclick="hideChatHistory(); selectChat('${safeCurrentTitle}');">
            <span class="history-item-title">${escapeHtml(current.title)}</span>
            <span class="history-item-time">${timeAgo(current.lastModified)}</span>
        </div>`;

        // Recent section
        if (rest.length > 0) {
            html += `<div class="history-section-label">Recent</div>`;
            rest.forEach(chat => {
                const safeTitle = chat.title.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                html += `<div class="history-item" onclick="hideChatHistory(); selectChat('${safeTitle}');">
                    <span class="history-item-title">${escapeHtml(chat.title)}</span>
                    <span class="history-item-time">${timeAgo(chat.lastModified)}</span>
                </div>`;
            });
        }

        historyList.innerHTML = html;

    } catch (e) {
        historyList.innerHTML = `
            <div class="history-state-container">
                <div class="history-state-icon">ðŸ”Œ</div>
                <div class="history-state-title">Connection Error</div>
                <div class="history-state-desc">Failed to reach the server.</div>
            </div>
        `;
        applyHistoryStateIcon('offline');
    }
}


function hideChatHistory() {
    historyLayer.classList.remove('show');
    // Send an escape key to Cursor to close the History panel
    try {
        fetchWithAuth('/close-history', { method: 'POST' });
    } catch (e) {
        console.error('Failed to close history on desktop:', e);
    }
}

function openHistoryPanel(e) {
    if (e) e.stopPropagation();
    settingsDropdown.classList.remove('open');
    showChatHistory();
}

historyBtn.addEventListener('click', openHistoryPanel);
if (historyQuickBtn) {
    historyQuickBtn.addEventListener('click', openHistoryPanel);
}

if (homeRecentsList) {
    homeRecentsList.addEventListener('click', (e) => {
        const item = e.target.closest('.home-recent-item');
        if (!item) return;

        const title = item.getAttribute('data-chat-title');
        if (!title) return;

        selectChat(title);
    });
}

if (homeRecentsLink) {
    homeRecentsLink.addEventListener('click', () => {
        showChatHistory();
    });
}

const HISTORY_SECTION_ORDER = ['Today', 'Yesterday', 'Recent', 'Earlier'];

function normalizeHistorySection(section = '') {
    const value = String(section || '').trim().toLowerCase();
    if (value === 'today') return 'Today';
    if (value === 'yesterday') return 'Yesterday';
    if (value === 'archived') return 'Archived';
    if (value === 'earlier' || value === 'older') return 'Earlier';
    return 'Recent';
}

function getHistoryAnchor() {
    if (historyQuickBtn && historyQuickBtn.offsetParent !== null) return historyQuickBtn;
    if (historyBtn && historyBtn.offsetParent !== null) return historyBtn;
    return historyQuickBtn || historyBtn || null;
}

function positionHistoryPopover() {
    if (!historyLayer || !historyLayer.classList.contains('show')) return;
    const anchor = getHistoryAnchor();
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const panelWidth = Math.min(320, window.innerWidth - 16);
    const panelHeight = Math.min(460, window.innerHeight - 72);
    const topBelow = rect.bottom + 8;
    const topAbove = rect.top - panelHeight - 8;
    const top = topBelow + panelHeight <= window.innerHeight - 8
        ? topBelow
        : Math.max(8, topAbove);
    const right = Math.max(8, window.innerWidth - rect.right);

    historyLayer.style.top = `${Math.max(8, top)}px`;
    historyLayer.style.right = `${right}px`;
    historyLayer.style.width = `${panelWidth}px`;
    historyLayer.style.maxHeight = `${panelHeight}px`;
}

function renderHistoryState(html) {
    if (!historyList) return;
    historyList.innerHTML = html;
    positionHistoryPopover();
}

function renderHistoryItems(items = [], activeTitle = '') {
    return items.map((chat) => {
        const safeTitle = escapeHtmlAttribute(chat.title || '');
        const isCurrent = chatTitlesMatch(chat.title, activeTitle);
        return `<button class="history-item${isCurrent ? ' current' : ''}" type="button" data-chat-title="${safeTitle}">
            <span class="history-item-icon" aria-hidden="true"></span>
            <span class="history-item-title">${escapeHtml(chat.title || '')}</span>
        </button>`;
    }).join('');
}

function renderHistoryListContent() {
    if (!historyList) return;

    const query = historySearchQuery.trim().toLowerCase();
    const visibleChats = historyChatsCache.filter((chat) => {
        const title = String(chat?.title || '').toLowerCase();
        return !query || title.includes(query);
    });

    if (!visibleChats.length) {
        renderHistoryState(`
            <div class="history-search-wrap">
                <input class="history-search-input" type="text" value="${escapeHtmlAttribute(historySearchQuery)}" placeholder="Search Agents..." aria-label="Search history">
            </div>
            <div class="history-state-container compact">
                <div class="history-state-title">No matching conversations</div>
                <div class="history-state-desc">Try a different keyword or start a new chat.</div>
            </div>
            <button class="history-collapsed-row" type="button" data-history-toggle="archived">
                <span class="history-collapsed-chevron" aria-hidden="true">${historyArchivedExpanded ? '&#709;' : '&#8250;'}</span>
                <span>Archived</span>
            </button>
        `);
        return;
    }

    const sections = new Map();
    const archivedChats = [];
    visibleChats.forEach((chat) => {
        const section = normalizeHistorySection(chat?.section);
        if (section === 'Archived') {
            archivedChats.push(chat);
            return;
        }
        if (!sections.has(section)) {
            sections.set(section, []);
        }
        sections.get(section).push(chat);
    });

    let html = `
        <div class="history-search-wrap">
            <input class="history-search-input" type="text" value="${escapeHtmlAttribute(historySearchQuery)}" placeholder="Search Agents..." aria-label="Search history">
        </div>
    `;

    HISTORY_SECTION_ORDER.forEach((section) => {
        const items = sections.get(section);
        if (!items?.length) return;
        html += `<div class="history-section-label">${section}</div>`;
        html += `<div class="history-items-group">${renderHistoryItems(items, historyActiveTitle)}</div>`;
    });

    html += `
        <button class="history-collapsed-row${historyArchivedExpanded ? ' expanded' : ''}" type="button" data-history-toggle="archived">
            <span class="history-collapsed-chevron" aria-hidden="true">${historyArchivedExpanded ? '&#709;' : '&#8250;'}</span>
            <span>Archived</span>
        </button>
    `;

    if (historyArchivedExpanded && archivedChats.length) {
        html += `<div class="history-items-group history-archived-group">${renderHistoryItems(archivedChats, historyActiveTitle)}</div>`;
    }

    historyList.innerHTML = html;
    positionHistoryPopover();
}

showChatHistory = async function () {
    renderHistoryState(`
        <div class="history-state-container">
            <div class="history-spinner"></div>
            <div class="history-state-text">Loading History...</div>
        </div>
    `);
    historyLayer.classList.add('show');
    positionHistoryPopover();
    historyBtn.style.opacity = '1';

    try {
        const res = await fetchWithAuth('/chat-history');
        const data = await res.json();
        if (data?.activeTitle) {
            setActiveChatTitle(data.activeTitle);
        } else {
            updateActiveChatTitleFromHistory(data.chats, true);
        }

        if (data.error) {
            renderHistoryState(`
                <div class="history-state-container">
                    <div class="history-state-icon"></div>
                    <div class="history-state-title">Error loading history</div>
                    <div class="history-state-desc">${escapeHtml(data.error)}</div>
                    <button class="history-new-btn mt-4" onclick="hideChatHistory(); startNewChat();">
                        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                        Start New Conversation
                    </button>
                </div>
            `);
            applyHistoryStateIcon('warning');
            return;
        }

        historyChatsCache = Array.isArray(data.chats) ? data.chats.slice() : [];
        historyActiveTitle = normalizeChatTitle(data.activeTitle || activeChatTitle);
        historySearchQuery = '';
        historyArchivedExpanded = false;

        if (!historyChatsCache.length) {
            renderHistoryState(`
                <div class="history-state-container">
                    <div class="history-state-icon"></div>
                    <div class="history-state-title">No conversations yet</div>
                    <div class="history-state-desc">Start a new conversation to see them here.</div>
                </div>
            `);
            applyHistoryStateIcon('empty');
            return;
        }

        renderHistoryListContent();
    } catch (e) {
        renderHistoryState(`
            <div class="history-state-container">
                <div class="history-state-icon"></div>
                <div class="history-state-title">Connection Error</div>
                <div class="history-state-desc">Failed to reach the server.</div>
            </div>
        `);
        applyHistoryStateIcon('offline');
    }
};

hideChatHistory = function () {
    historyLayer.classList.remove('show');
    historyLayer.style.top = '';
    historyLayer.style.right = '';
    historyLayer.style.width = '';
    historyLayer.style.maxHeight = '';
    try {
        fetchWithAuth('/close-history', { method: 'POST' });
    } catch (e) {
        console.error('Failed to close history on desktop:', e);
    }
};

openHistoryPanel = function (e) {
    if (e) e.stopPropagation();
    settingsDropdown.classList.remove('open');
    showChatHistory();
};

if (historyList) {
    historyList.addEventListener('input', (e) => {
        const input = e.target.closest('.history-search-input');
        if (!input) return;
        historySearchQuery = input.value || '';
        renderHistoryListContent();
        const nextInput = historyList.querySelector('.history-search-input');
        if (nextInput) {
            nextInput.focus();
            nextInput.setSelectionRange(historySearchQuery.length, historySearchQuery.length);
        }
    });

    historyList.addEventListener('click', (e) => {
        const toggle = e.target.closest('[data-history-toggle="archived"]');
        if (toggle) {
            historyArchivedExpanded = !historyArchivedExpanded;
            renderHistoryListContent();
            return;
        }

        const item = e.target.closest('.history-item[data-chat-title]');
        if (!item) return;

        const title = item.getAttribute('data-chat-title');
        if (!title) return;
        hideChatHistory();
        selectChat(title);
    });
};

document.addEventListener('click', (e) => {
    if (!historyLayer.classList.contains('show')) return;
    if (historyLayer.contains(e.target)) return;
    if (historyQuickBtn?.contains(e.target) || historyBtn?.contains(e.target)) return;
    hideChatHistory();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && historyLayer.classList.contains('show')) {
        hideChatHistory();
    }
});

window.addEventListener('resize', positionHistoryPopover);

if (headerChatTabs) {
    headerChatTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.snapshot-chat-tab[data-chat-title]');
        if (!tab || tab.disabled) return;

        e.preventDefault();
        e.stopPropagation();

        const title = tab.getAttribute('data-chat-title');
        if (!title) return;

        selectChat(title);
    });
}

// --- Select Chat from History ---
async function selectChat(title) {
    const normalizedTitle = normalizeChatTitle(title);
    if (!normalizedTitle) return false;
    if (activeChatTitle === normalizedTitle) {
        return true;
    }

    const requestId = ++selectChatRequestId;
    const previousTitle = activeChatTitle;

    try {
        const res = await fetchWithAuth('/select-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: normalizedTitle })
        });
        const data = await res.json();

        if (data.success) {
            setActiveChatTitle(data.title || normalizedTitle);
            setHomeScreen(false);
            fetchAppState();
            queueSnapshotReload({ delays: FAST_ACTION_SNAPSHOT_DELAYS });
            setTimeout(fetchAppState, 300);
            setTimeout(checkChatStatus, ACTION_STATUS_RECHECK_DELAY);
            return true;
        } else {
            setActiveChatTitle(previousTitle);
            console.error('Failed to select chat:', data.error);
        }
    } catch (e) {
        setActiveChatTitle(previousTitle);
        console.error('Select chat error:', e);
    } finally {
        if (requestId === selectChatRequestId) {
            selectChatRequestId = 0;
        }
    }

    return false;
}

// --- Check Chat Status ---
async function checkChatStatus() {
    try {
        const syncedState = await fetchAppState({
            force: true,
            applyOptions: {
                loadSnapshotWhenMissing: !hasSnapshotLoaded
            }
        });
        if (syncedState) {
            return;
        }

        const res = await fetchWithAuth('/chat-status');
        const data = await res.json();
        const shouldShowHomeScreen = !data.hasChat && !data.editorFound;

        chatIsOpen = data.hasChat || data.editorFound;

        if (shouldShowHomeScreen) {
            showEmptyState();
        } else {
            setHomeScreen(false);
            if (!hasSnapshotLoaded) {
                loadSnapshot();
            }
            if (!activeChatTitle) {
                refreshActiveChatTitle();
            }
        }
    } catch (e) {
        console.error('Chat status check failed:', e);
    }
}

// --- Empty State (No Chat Open) ---
function showEmptyState() {
    hasSnapshotLoaded = false;
    lastRenderedHash = '';
    lastRenderedHtmlHash = '';
    pendingSnapshot = null;
    setActiveChatTitle('');
    renderHeaderChatTabs([], '');
    renderHomeShell();
    setHomeScreen(true);
    updateWorkspaceChrome({ snapshotReady: false });
}

// --- Utility: Escape HTML ---
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeHtmlAttribute(text) {
    return escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// --- Dropdown Logic ---

function closeAllDropdowns() {
    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
    document.querySelectorAll('.toolbar-chip.open').forEach(c => c.classList.remove('open'));
    dropdownBackdrop.classList.remove('show');
}

function toggleDropdown(menu, chip) {
    const isOpen = menu.classList.contains('show');
    closeAllDropdowns();
    if (!isOpen) {
        menu.classList.add('show');
        chip.classList.add('open');
        dropdownBackdrop.classList.add('show');
    }
}

dropdownBackdrop.addEventListener('click', closeAllDropdowns);

async function fetchDropdownOptions(kind) {
    const res = await fetchWithAuth(`/dropdown-options?kind=${encodeURIComponent(kind)}`);
    return res.json();
}

function buildDropdownMenu(menu, title, options, currentValue, descriptions = {}, badges = {}) {
    menu.innerHTML = '';

    const titleEl = document.createElement('div');
    titleEl.className = 'dropdown-title';
    titleEl.textContent = title;
    menu.appendChild(titleEl);

    if (!options.length) {
        const empty = document.createElement('div');
        empty.className = 'dropdown-option';
        empty.dataset.value = '';
        empty.textContent = 'No options available';
        menu.appendChild(empty);
        return;
    }

    options.forEach((value) => {
        const div = document.createElement('div');
        const isModelMenu = title === 'Model';
        const isActive = value === currentValue;
        div.className = 'dropdown-option' + (isModelMenu ? ' model-option' : '') + (isActive ? ' active' : '');
        div.dataset.value = value;

        if (isModelMenu) {
            const badgeHtml = badges[value] ? `<span class="model-badge">${escapeHtml(badges[value])}</span>` : '';
            div.innerHTML = `<span class="model-option-name">${escapeHtml(value)}</span>${badgeHtml}`;
        } else {
            const desc = descriptions[value];
            div.innerHTML = `<div class="dropdown-option-name">${escapeHtml(value)}</div>` +
                (desc ? `<div class="dropdown-option-desc">${escapeHtml(desc)}</div>` : '');
        }

        menu.appendChild(div);
    });
}

function normalizeModelDropdownState(data = {}) {
    const isLiveModelState = !!(data && typeof data === 'object' && !data.error && (
        data.live === true ||
        Array.isArray(data.toggles) ||
        Array.isArray(data.items) ||
        Array.isArray(data.options) ||
        Object.prototype.hasOwnProperty.call(data, 'searchPlaceholder') ||
        Object.prototype.hasOwnProperty.call(data, 'footerLabel') ||
        Object.prototype.hasOwnProperty.call(data, 'autoAvailable') ||
        Object.prototype.hasOwnProperty.call(data, 'compactAuto')
    ));
    const fallback = getModelDropdownFallbackState(data);
    const current = data.current && data.current !== 'Unknown' ? data.current : fallback.current;

    if (isLiveModelState) {
        let toggles = (Array.isArray(data.toggles) ? data.toggles : [])
            .map((toggle) => ({
                key: String(toggle?.key || toggle?.label || '')
                    .trim()
                    .toLowerCase()
                    .replace(/\s+/g, '-'),
                label: String(toggle?.label || toggle?.key || '').trim(),
                description: String(toggle?.description || '').trim(),
                enabled: !!toggle?.enabled
            }))
            .filter((toggle) => toggle.key && toggle.label);

        if (!toggles.length && (typeof data.autoAvailable === 'boolean' ? data.autoAvailable : /^auto$/i.test(current))) {
            toggles = [{
                key: 'auto',
                label: String(data.autoLabel || 'Auto').trim(),
                description: String(data.autoDescription || MODEL_FALLBACK_TOGGLES[0].description || '').trim(),
                enabled: typeof data.autoEnabled === 'boolean' ? data.autoEnabled : /^auto$/i.test(current)
            }];
        }

        let items = normalizeModelOptionItems(
            Array.isArray(data.items) && data.items.length
                ? data.items
                : (Array.isArray(data.options) ? data.options : [])
        ).filter((item) => item.value && !/^auto$/i.test(item.value));

        if (!items.length && current && current !== 'Unknown' && !/^auto$/i.test(current)) {
            items = normalizeModelOptionItems([{ value: current, icon: getModelOptionIcon(current) }])
                .filter((item) => item.value && !/^auto$/i.test(item.value));
        }

        const options = items.map((item) => item.value);
        const autoToggle = toggles.find((toggle) => toggle.key === 'auto') || null;

        return {
            current,
            options,
            items,
            toggles,
            searchPlaceholder: String(data.searchPlaceholder || '').trim(),
            footerLabel: String(data.footerLabel || '').trim(),
            compactAuto: typeof data.compactAuto === 'boolean'
                ? data.compactAuto
                : (/^auto$/i.test(current) && !!autoToggle && !options.length),
            live: true
        };
    }

    const incomingToggles = Array.isArray(data.toggles) && data.toggles.length
        ? data.toggles
        : [];
    const legacyAutoEnabled = typeof data.autoEnabled === 'boolean' ? data.autoEnabled : /^auto$/i.test(current);
    const toggles = MODEL_FALLBACK_TOGGLES.map((fallbackToggle) => {
        const incoming = incomingToggles.find((toggle) =>
            toggle?.key === fallbackToggle.key ||
            String(toggle?.label || '').toLowerCase() === fallbackToggle.label.toLowerCase()
        );

        if (incoming) {
            return {
                key: incoming.key || fallbackToggle.key,
                label: incoming.label || fallbackToggle.label,
                description: incoming.description || '',
                enabled: typeof incoming.enabled === 'boolean'
                    ? incoming.enabled
                    : (fallbackToggle.key === 'auto' ? legacyAutoEnabled : fallbackToggle.enabled)
            };
        }

        if (fallbackToggle.key === 'auto') {
            return {
                ...fallbackToggle,
                description: data.autoDescription || fallbackToggle.description,
                enabled: legacyAutoEnabled
            };
        }

        return { ...fallbackToggle };
    });
    const rawOptionItems = Array.isArray(data.items) && data.items.length
        ? data.items
        : (Array.isArray(data.options) && data.options.length >= 3 ? data.options : fallback.options);
    const items = normalizeModelOptionItems(rawOptionItems)
        .filter((item) => item.value && !/^auto$/i.test(item.value));
    const options = items.map((item) => item.value);

    return {
        current,
        options,
        items,
        toggles,
        searchPlaceholder: data.searchPlaceholder || fallback.searchPlaceholder,
        footerLabel: data.footerLabel || fallback.footerLabel || '',
        compactAuto: /^auto$/i.test(current)
    };
}

function applyNormalizedModelDropdownState(normalized, { rebuildMenu = false } = {}) {
    if (!normalized || typeof normalized !== 'object') return null;

    availableModels = Array.isArray(normalized.options) ? normalized.options : [];
    lastModelDropdownState = normalized;

    const nextModel = normalized.current && normalized.current !== 'Unknown'
        ? normalized.current
        : currentModel;

    if (nextModel) {
        currentModel = nextModel;
        modelText.textContent = nextModel;
        updateWorkspaceChrome({ model: nextModel });
    }

    if (rebuildMenu) {
        buildModelDropdownMenu(modelMenu, normalized);
    }

    return normalized;
}

async function syncModelDropdownState({ rebuildMenu = modelMenu.classList.contains('show'), delays = [0] } = {}) {
    if (modelDropdownMutationPromise) {
        return lastModelDropdownState;
    }

    let lastError = null;

    for (const delay of delays) {
        if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
        }

        if (modelDropdownMutationPromise) {
            return lastModelDropdownState;
        }

        try {
            const data = await fetchDropdownOptions('model');
            const normalized = normalizeModelDropdownState(data);
            return applyNormalizedModelDropdownState(normalized, { rebuildMenu });
        } catch (error) {
            lastError = error;
        }
    }

    if (lastError) {
        console.error('[SYNC] Failed to sync model dropdown', lastError);
    }

    return lastModelDropdownState;
}

function renderModelOptionsList(listEl, state, filterText = '') {
    if (!listEl) return;
    listEl.innerHTML = '';

    const normalizedFilter = filterText.trim().toLowerCase();
    const filteredOptions = (Array.isArray(state.items) ? state.items : [])
        .filter((item) => !normalizedFilter || item.value.toLowerCase().includes(normalizedFilter));

    if (!filteredOptions.length) {
        const empty = document.createElement('div');
        empty.className = 'model-empty-state';
        empty.textContent = normalizedFilter ? 'No matching models' : 'No additional models available';
        listEl.appendChild(empty);
        return;
    }

    filteredOptions.forEach((itemState) => {
        const value = itemState.value;
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'dropdown-option model-option' + (value === state.current ? ' active' : '');
        item.dataset.value = value;
        item.innerHTML = `
            <span class="model-option-main">
                <span class="model-option-name">${escapeHtml(value)}</span>
                ${itemState.icon ? `<span class="model-option-icon" aria-hidden="true">${getModelOptionIconSvg(itemState.icon)}</span>` : ''}
            </span>
            <span class="model-option-check" aria-hidden="true">${value === state.current ? '&#10003;' : ''}</span>
        `;
        listEl.appendChild(item);
    });
}

function getAutoToggle(state) {
    return Array.isArray(state?.toggles)
        ? state.toggles.find((toggle) => toggle?.key === 'auto' || /^auto$/i.test(toggle?.label || ''))
        : null;
}

function buildModelDropdownMenu(menu, state) {
    menu.innerHTML = '';

    const panel = document.createElement('div');
    panel.className = 'model-menu-panel';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'model-search-wrap';
    searchWrap.innerHTML = `
        <input
            type="search"
            class="model-search-input"
            placeholder="${escapeHtml(state.searchPlaceholder)}"
            aria-label="Search models"
            autocomplete="off"
            spellcheck="false"
        >
    `;
    panel.appendChild(searchWrap);
    const contentWrap = document.createElement('div');
    contentWrap.className = 'model-menu-content';
    panel.appendChild(contentWrap);

    menu.appendChild(panel);

    const searchInput = searchWrap.querySelector('.model-search-input');
    const renderMenuContent = (filterText = '') => {
        const normalizedFilter = String(filterText || '').trim();
        const visibleToggles = Array.isArray(state.toggles) ? state.toggles : [];
        const autoToggle = getAutoToggle(state);
        const shouldUseCompactAutoMenu = !!state.compactAuto && !normalizedFilter && autoToggle;

        menu.classList.remove('auto-compact-menu');
        panel.classList.remove('home-auto-model-menu', 'compact-auto-menu');
        contentWrap.innerHTML = '';

        if (shouldUseCompactAutoMenu) {
            menu.classList.add('auto-compact-menu');
            panel.classList.add('home-auto-model-menu', 'compact-auto-menu');

            const toggleList = document.createElement('div');
            toggleList.className = 'model-toggle-list';
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'model-toggle-row' + (autoToggle.enabled ? ' active' : '');
            row.dataset.toggleKey = autoToggle.key;
            row.innerHTML = `
                <span class="model-toggle-copy">
                    <span class="model-toggle-title">${escapeHtml(autoToggle.label)}</span>
                    ${autoToggle.description ? `<span class="model-toggle-desc">${escapeHtml(autoToggle.description)}</span>` : ''}
                </span>
                <span class="model-toggle-switch${autoToggle.enabled ? ' is-on' : ''}" aria-hidden="true">
                    <span class="model-toggle-knob"></span>
                </span>
            `;
            toggleList.appendChild(row);
            contentWrap.appendChild(toggleList);
            return;
        }

        if (visibleToggles.length) {
            const toggleList = document.createElement('div');
            toggleList.className = 'model-toggle-list';
            visibleToggles.forEach((toggle) => {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'model-toggle-row' + (toggle.enabled ? ' active' : '');
                row.dataset.toggleKey = toggle.key;
                row.innerHTML = `
                    <span class="model-toggle-copy">
                        <span class="model-toggle-title">${escapeHtml(toggle.label)}</span>
                        ${toggle.description ? `<span class="model-toggle-desc">${escapeHtml(toggle.description)}</span>` : ''}
                    </span>
                    <span class="model-toggle-switch${toggle.enabled ? ' is-on' : ''}" aria-hidden="true">
                        <span class="model-toggle-knob"></span>
                    </span>
                `;
                toggleList.appendChild(row);
            });
            contentWrap.appendChild(toggleList);
        }

        const listDivider = document.createElement('div');
        listDivider.className = 'model-menu-divider';
        contentWrap.appendChild(listDivider);

        const listEl = document.createElement('div');
        listEl.className = 'model-options-list';
        contentWrap.appendChild(listEl);
        renderModelOptionsList(listEl, state, normalizedFilter);

        if (state.footerLabel) {
            const bottomDivider = document.createElement('div');
            bottomDivider.className = 'model-menu-divider';
            contentWrap.appendChild(bottomDivider);

            const footer = document.createElement('button');
            footer.type = 'button';
            footer.className = 'model-footer-row';
            footer.dataset.action = 'add-models';
            footer.innerHTML = `
                <span class="model-footer-label">${escapeHtml(state.footerLabel)}</span>
                <span class="model-footer-chevron" aria-hidden="true">&#8250;</span>
            `;
            contentWrap.appendChild(footer);
        }
    };

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            renderMenuContent(searchInput.value);
        });
    }

    renderMenuContent('');
}

function setDropdownLoading(menu, title) {
    menu.innerHTML = `<div class="dropdown-title">${title}</div><div class="dropdown-option" data-value="">Loading...</div>`;
}

function buildModeDropdownMenu(menu, state) {
    menu.innerHTML = '';

    state.items.forEach((item) => {
        const option = document.createElement('div');
        option.className = 'mode-dropdown-option' + (item.label === state.current ? ' active' : '');
        option.dataset.value = item.label;
        option.dataset.requestValue = item.requestValue;
        option.innerHTML = `
            <span class="mode-dropdown-main">
                <span class="mode-dropdown-icon" aria-hidden="true">${getModeIconSvg(item.icon)}</span>
                <span class="mode-dropdown-label">${escapeHtml(item.label)}</span>
            </span>
            <span class="mode-dropdown-check" aria-hidden="true">${item.label === state.current ? '&#10003;' : ''}</span>
        `;
        menu.appendChild(option);
    });
}

async function openModeDropdown() {
    const isOpen = modeMenu.classList.contains('show');
    if (isOpen) {
        closeAllDropdowns();
        return;
    }

    const fallback = normalizeModeDropdownState({ current: currentMode });
    availableModes = fallback.items.map((item) => item.label);
    buildModeDropdownMenu(modeMenu, fallback);
    toggleDropdown(modeMenu, modeBtn);

    try {
        const data = await fetchDropdownOptions('mode');
        const normalized = normalizeModeDropdownState(data);
        availableModes = normalized.items.map((item) => item.label);
        if (data.current && data.current !== 'Unknown') {
            setCurrentModeValue(data.current);
            normalized.current = getModeDisplayLabel(data.current);
        }
        if (modeMenu.classList.contains('show')) {
            buildModeDropdownMenu(modeMenu, normalized);
        }
    } catch (e) {
        // Keep fallback menu if live fetch fails.
    }
}

function openModelDropdown() {
    const isOpen = modelMenu.classList.contains('show');
    if (isOpen) {
        closeAllDropdowns();
        return;
    }

    const immediateState = normalizeModelDropdownState(
        lastModelDropdownState && typeof lastModelDropdownState === 'object'
            ? lastModelDropdownState
            : getModelDropdownFallbackState({
                current: currentModel && currentModel !== 'Unknown' ? currentModel : modelText.textContent
            })
    );
    applyNormalizedModelDropdownState(immediateState, { rebuildMenu: true });
    toggleDropdown(modelMenu, modelBtn);
    syncModelDropdownState({ rebuildMenu: true, delays: [0] })
        .catch((error) => console.error('[SYNC] Failed to open model dropdown', error));
}

// --- Mode dropdown ---
modeBtn.addEventListener('click', openModeDropdown);

modeMenu.addEventListener('click', async (e) => {
    const opt = e.target.closest('.mode-dropdown-option');
    if (!opt) return;
    const mode = opt.dataset.requestValue;
    const displayMode = opt.dataset.value || getModeDisplayLabel(mode);
    if (!mode) return;
    closeAllDropdowns();

    const previousMode = currentMode;
    modeText.textContent = 'Setting...';
    try {
        const res = await fetchWithAuth('/set-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            const appliedMode = setCurrentModeValue(data.currentMode || displayMode);
            updateWorkspaceChrome({ mode: appliedMode });
        } else if (res.status === 503 || /cdp disconnected/i.test(String(data.error || ''))) {
            const appliedMode = setCurrentModeValue(displayMode);
            updateWorkspaceChrome({ mode: appliedMode });
        } else {
            alert('Error: ' + (data.error || 'Unknown'));
            setCurrentModeValue(previousMode);
        }
    } catch (e) {
        setCurrentModeValue(previousMode);
    }
});

// --- Model dropdown ---
modelBtn.addEventListener('click', openModelDropdown);

async function applyModelSelection(model, prev = currentModel || modelText.textContent) {
    if (!model) return;

    if (modelDropdownMutationPromise) {
        return modelDropdownMutationPromise;
    }

    modelDropdownMutationPromise = (async () => {
        modelText.textContent = 'Setting...';
        try {
            const res = await fetchWithAuth('/set-model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model })
            });
            const data = await res.json();
            if (data.success) {
                currentModel = data.currentModel || model;
                modelText.textContent = currentModel;
                updateWorkspaceChrome({ model: currentModel });
                if (lastModelDropdownState) {
                    lastModelDropdownState.current = currentModel;
                    lastModelDropdownState.toggles = (lastModelDropdownState.toggles || []).map((toggle) =>
                        toggle.key === 'auto'
                            ? { ...toggle, enabled: /^auto$/i.test(currentModel) }
                            : toggle
                    );
                }
                setTimeout(() => {
                    syncModelDropdownState({ rebuildMenu: modelMenu.classList.contains('show'), delays: [0, 180, 420] });
                }, 0);
                return true;
            }

            alert('Error: ' + (data.error || 'Unknown'));
        } catch (e) {
            console.error('Model selection failed:', e);
        }

        modelText.textContent = currentModel || prev;
        return false;
    })();

    try {
        return await modelDropdownMutationPromise;
    } finally {
        modelDropdownMutationPromise = null;
    }
}

async function applyModelToggle(toggleKey, enabled) {
    if (!toggleKey) return false;

    if (modelDropdownMutationPromise) {
        return modelDropdownMutationPromise;
    }

    modelDropdownMutationPromise = (async () => {
        try {
            const res = await fetchWithAuth('/set-model-toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: toggleKey, enabled })
            });
            const data = await res.json();
            if (data.success) {
                const normalized = normalizeModelDropdownState({
                    live: true,
                    current: data.currentModel || currentModel,
                    options: Array.isArray(data.options) ? data.options : [],
                    toggles: Array.isArray(data.toggles) ? data.toggles : [],
                    searchPlaceholder: data.searchPlaceholder || '',
                    footerLabel: data.footerLabel || '',
                    compactAuto: /^auto$/i.test(data.currentModel || currentModel) && (!Array.isArray(data.options) || !data.options.length)
                });
                applyNormalizedModelDropdownState(normalized, { rebuildMenu: true });
                setTimeout(() => {
                    syncModelDropdownState({ rebuildMenu: modelMenu.classList.contains('show'), delays: [120, 320, 700] });
                }, 0);
                return true;
            }
        } catch (e) {
            console.error('Model toggle failed:', e);
        }

        return false;
    })();

    try {
        return await modelDropdownMutationPromise;
    } finally {
        modelDropdownMutationPromise = null;
    }
}

modelMenu.addEventListener('click', async (e) => {
    if (modelDropdownMutationPromise) {
        e.preventDefault();
        return;
    }

    const toggleRow = e.target.closest('.model-toggle-row');
    if (toggleRow) {
        e.preventDefault();
        const toggleKey = toggleRow.dataset.toggleKey;
        const currentState = (lastModelDropdownState?.toggles || []).find((toggle) => toggle.key === toggleKey);
        if (!currentState) return;

        let success = await applyModelToggle(toggleKey, !currentState.enabled);
        if (!success && toggleKey === 'auto' && !currentState.enabled) {
            success = await applyModelSelection('Auto');
        }

        if (success) {
            modelMenu.classList.add('show');
            modelBtn.classList.add('open');
            dropdownBackdrop.classList.add('show');
        }
        return;
    }

    const footerRow = e.target.closest('.model-footer-row');
    if (footerRow) {
        e.preventDefault();
        return;
    }

    const opt = e.target.closest('.dropdown-option.model-option');
    if (!opt) return;
    const model = opt.dataset.value;
    if (!model) return;
    closeAllDropdowns();
    await applyModelSelection(model);
});

// --- Viewport / Keyboard Handling ---
// This fixes the issue where the keyboard hides the input or layout breaks
if (window.visualViewport) {
    function handleResize() {
        // Resize the body to match the visual viewport (screen minus keyboard)
        document.body.style.height = window.visualViewport.height + 'px';

        // Scroll to bottom if keyboard opened
        if (document.activeElement === messageInput) {
            setTimeout(scrollToBottom, 100);
        }
    }

    window.visualViewport.addEventListener('resize', handleResize);
    window.visualViewport.addEventListener('scroll', handleResize);
    handleResize(); // Init
} else {
    // Fallback for older browsers without visualViewport support
    window.addEventListener('resize', () => {
        document.body.style.height = window.innerHeight + 'px';
    });
    document.body.style.height = window.innerHeight + 'px'; // Init
}

// --- Remote Click Logic (Thinking/Thought) ---
