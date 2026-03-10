// =============================================
// CursorRemote - Snapshot & WebSocket
// =============================================

function normalizeModeDropdownState(data = {}) {
    const currentRaw = data.current && data.current !== 'Unknown' ? data.current : currentMode;
    const items = [];
    const seen = new Set();

    const pushItem = (rawValue, fallbackRequestValue = rawValue) => {
        const displayValue = getModeDisplayLabel(rawValue);
        if (!displayValue) return;

        const key = displayValue.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);

        items.push({
            label: displayValue,
            requestValue: String(rawValue || fallbackRequestValue || displayValue).trim() || displayValue,
            icon: getModeIconName(displayValue)
        });
    };

    if (Array.isArray(data.options) && data.options.length) {
        data.options.forEach((option) => pushItem(option));
    }

    if (!items.length) {
        MODE_FALLBACK_OPTIONS.forEach((option) => {
            items.push({ ...option });
            seen.add(option.label.toLowerCase());
        });
    }

    const currentDisplay = getModeDisplayLabel(currentRaw);
    if (!items.some((item) => item.label === currentDisplay)) {
        items.unshift({
            label: currentDisplay,
            requestValue: String(currentRaw || currentDisplay).trim() || currentDisplay,
            icon: getModeIconName(currentDisplay)
        });
    }

    return {
        current: currentDisplay,
        items
    };
}

function getModelDropdownFallbackState(overrides = {}) {
    const fallbackCurrent = overrides.current && overrides.current !== 'Unknown'
        ? overrides.current
        : (currentModel && currentModel !== 'Unknown'
            ? currentModel
            : (modelText?.textContent || MODEL_FALLBACK_OPTIONS[0]?.name || 'Auto'));
    const fallbackAutoEnabled = /^auto$/i.test(fallbackCurrent);
    const fallbackItems = MODEL_FALLBACK_OPTIONS.map((item) => ({
        value: item.name,
        icon: item.icon
    }));

    if (fallbackAutoEnabled) {
        return {
            current: fallbackCurrent,
            options: [],
            items: [],
            toggles: [{
                key: 'auto',
                label: 'Auto',
                description: 'Balanced quality and speed, recommended for most tasks',
                enabled: true
            }],
            searchPlaceholder: 'Search models',
            footerLabel: '',
            compactAuto: true,
            expandedItems: fallbackItems,
            expandedFooterLabel: 'Add Models'
        };
    }

    return {
        current: fallbackCurrent,
        options: MODEL_FALLBACK_OPTIONS.map(item => item.name),
        items: fallbackItems,
        toggles: MODEL_FALLBACK_TOGGLES.map(toggle => ({
            ...toggle,
            enabled: toggle.key === 'auto' ? fallbackAutoEnabled : toggle.enabled
        })),
        searchPlaceholder: 'Search models',
        footerLabel: 'Add Models',
        compactAuto: false,
        expandedItems: [],
        expandedFooterLabel: ''
    };
}

function getModelOptionValue(option) {
    if (!option) return '';
    if (typeof option === 'string') return option.trim();
    return String(option.value || option.name || '').trim();
}

function getModelOptionIcon(option) {
    const value = getModelOptionValue(option).toLowerCase();
    if (option && typeof option === 'object' && 'icon' in option) {
        const explicitIcon = String(option.icon || '').trim();
        if (explicitIcon === 'cloud' && value && value !== 'gpt-4') {
            return 'brain';
        }
        return explicitIcon;
    }

    const fallback = MODEL_FALLBACK_OPTIONS.find((item) => item.name.toLowerCase() === value);
    return fallback?.icon || '';
}

function normalizeModelOptionItems(options = []) {
    const seen = new Set();
    return options
        .map((option) => {
            const value = getModelOptionValue(option);
            if (!value) return null;
            const key = value.toLowerCase();
            if (seen.has(key)) return null;
            seen.add(key);
            return {
                value,
                icon: getModelOptionIcon(option)
            };
        })
        .filter(Boolean);
}

function getModelOptionIconSvg(iconName = '') {
    if (iconName === 'cloud') {
        return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 12.4h5.4a2.4 2.4 0 0 0 .2-4.8 3.3 3.3 0 0 0-6.4-.8 2.2 2.2 0 0 0 .8 5.6Z"></path></svg>`;
    }
    if (iconName === 'brain') {
        return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 4.4a1.7 1.7 0 0 1 3-1 2.1 2.1 0 0 1 3.1 2.2 1.9 1.9 0 0 1 .5 3.6 2.1 2.1 0 0 1-2.2 3 2 2 0 0 1-3.5.4 1.8 1.8 0 0 1-2.7-2.3A1.9 1.9 0 0 1 4 6.3a1.8 1.8 0 0 1 1.2-1.9"></path><path d="M7.9 3.2v8.9"></path><path d="M6 5.1c.6.2 1 .6 1.2 1.2"></path><path d="M9.7 4.9c-.6.2-1 .6-1.2 1.2"></path><path d="M5.9 8.4c.7 0 1.1.2 1.4.6"></path><path d="M10 8.4c-.7 0-1.1.2-1.4.6"></path></svg>`;
    }
    return '';
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
}

function setHomeScreen(enabled) {
    document.body.classList.toggle('home-screen', enabled);
    updateComposerPlaceholder();
    refreshBtn.setAttribute('aria-label', enabled ? 'New Chat' : 'Refresh');
    refreshBtn.setAttribute('data-tooltip', enabled ? 'New Chat' : 'Refresh');
    fullscreenBtn.setAttribute('aria-label', enabled ? 'Close' : document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen');
    fullscreenBtn.setAttribute('data-tooltip', enabled ? 'Close' : document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen');
    if (newChatLabel) newChatLabel.textContent = DEFAULT_NEW_CHAT_LABEL;
    if (appBrandTitle) appBrandTitle.textContent = DEFAULT_APP_TITLE;

    if (enabled) {
        setTextContent(homeContextAgent, 'Cursor');
    }
}

async function loadHomeRecents() {
    if (!homeRecentsList) return;
    homeRecentsList.innerHTML = '<div class="home-recents-empty">Loading recent conversations...</div>';

    try {
        const res = await fetchWithAuth('/chat-history');
        const data = await res.json();
        updateActiveChatTitleFromHistory(data.chats);
        const chats = Array.isArray(data.chats) ? data.chats.slice(0, 3) : [];

        if (data.error || chats.length === 0) {
            homeRecentsList.innerHTML = `
                <div class="home-recents-empty">
                    Start a new conversation or open history to continue where you left off.
                </div>
            `;
            return;
        }

        homeRecentsList.innerHTML = chats.map((chat) => {
            const safeTitle = escapeHtml(chat.title || 'Untitled conversation');
            const safeAttr = (chat.title || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            return `
                <button class="home-recent-item" type="button" data-chat-title="${safeAttr}">
                    <span class="home-recent-title">${safeTitle}</span>
                    <span class="home-recent-time">${timeAgo(chat.lastModified)}</span>
                </button>
            `;
        }).join('');
    } catch (e) {
        homeRecentsList.innerHTML = `
            <div class="home-recents-empty">
                Waiting for chat history from the desktop session.
            </div>
        `;
    }
}

const HISTORY_STATE_ICONS = {
    warning: `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 9v4"></path>
            <path d="M12 17h.01"></path>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path>
        </svg>
    `,
    empty: `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            <path d="M8 10h8"></path>
            <path d="M8 14h5"></path>
        </svg>
    `,
    offline: `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16.72 11.06A10.94 10.94 0 0 1 22 12"></path>
            <path d="M5 12a10.94 10.94 0 0 1 5.17-1.88"></path>
            <path d="M2 8.82a15 15 0 0 1 4.17-2.65"></path>
            <path d="M18.83 6.17A15 15 0 0 1 22 8.82"></path>
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
            <path d="M12 20h.01"></path>
            <path d="M2 2l20 20"></path>
        </svg>
    `
};

function applyHistoryStateIcon(kind) {
    const icon = historyList.querySelector('.history-state-icon');
    if (icon && HISTORY_STATE_ICONS[kind]) {
        icon.innerHTML = HISTORY_STATE_ICONS[kind];
    }
}

// --- WebSocket ---
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        console.log('WS Connected');
        updateStatus(true);
        fetchAppState({ force: true });
        loadSnapshot(); // Initial load via HTTP
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'error' && data.message === 'Unauthorized') {
            window.location.href = '/login.html';
            return;
        }
        if (data.type === 'app_state_update' && data.state) {
            applyDesktopState(data.state);
            return;
        }
        // Hash-based dedup: only fetch if content actually changed
        if (data.type === 'snapshot_update' && autoRefreshEnabled) {
            if (data.hash && data.hash === lastRenderedHash) return; // Skip identical
            loadSnapshot({ expectedHash: data.hash || '' });
        }
    };

    ws.onclose = () => {
        console.log('WS Disconnected');
        updateStatus(false);
        setTimeout(connectWebSocket, 2000);
    };
}

function updateStatus(connected) {
    if (connected) {
        statusDot.classList.remove('disconnected');
        statusDot.classList.add('connected');
        statusText.textContent = 'Live';
    } else {
        statusDot.classList.remove('connected');
        statusDot.classList.add('disconnected');
        statusText.textContent = 'Reconnecting';
    }
    updateWorkspaceChrome({ connected });
}

// --- Schedule render with requestAnimationFrame (prevents layout thrashing) ---
function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
        renderScheduled = false;
        if (pendingSnapshot) {
            renderSnapshot(pendingSnapshot);
            pendingSnapshot = null;
        }
    });
}

// --- Core render function (used by both WS and HTTP paths) ---
function renderSnapshot(data) {
    chatIsOpen = true;
    hasSnapshotLoaded = true;
    if (data?.hash) {
        lastRenderedHash = data.hash;
        if (queuedSnapshotReloadExpectedHash === data.hash) {
            queuedSnapshotReloadExpectedHash = '';
        }
    }
    renderHeaderChatTabs(data.chatTabs, data.activeChatTitle);

    setHomeScreen(false);
    if (data.activeChatTitle) {
        setActiveChatTitle(data.activeChatTitle);
    } else if (!activeChatTitle) {
        refreshActiveChatTitle();
    }

    // Capture scroll state BEFORE updating content
    const scrollPos = chatContainer.scrollTop;
    const scrollHeight = chatContainer.scrollHeight;
    const clientHeight = chatContainer.clientHeight;
    const wasAtTop = scrollPos <= 1;
    const isNearBottom = scrollHeight - scrollPos - clientHeight < 120;
    const isUserScrollLocked = Date.now() < userScrollLockUntil;

    // --- UPDATE STATS ---
    if (data.stats) {
        const kbs = Math.round((data.stats.htmlSize + data.stats.cssSize) / 1024);
        const nodes = data.stats.nodes;
        const statsText = document.getElementById('statsText');
        if (statsText) statsText.textContent = `${nodes} Nodes Â· ${kbs}KB`;
    }

    // --- SYNC THEME FROM IDE ---
    if (data.backgroundColor || data.themeVars) {
        const tv = data.themeVars || {};
        const root = document.documentElement.style;
        // Determine best background: prefer VS Code theme var > effective cascade bg > body bg
        const bg = tv['--vscode-editor-background'] || data.backgroundColor || data.bodyBackgroundColor;
        const fg = tv['--vscode-editor-foreground'] || tv['--vscode-foreground'] || data.color || data.bodyColor;
        const panelBg = tv['--vscode-panel-background'] || tv['--vscode-sideBar-background'] || bg;
        const inputBg = tv['--vscode-input-background'] || panelBg;
        const mutedFg = tv['--vscode-descriptionForeground'] || '';

        // Update CSS custom properties so ALL elements using var(--bg-app) etc. auto-sync
        if (bg) root.setProperty('--bg-app', bg);
        if (panelBg) root.setProperty('--bg-panel', panelBg);
        if (inputBg) root.setProperty('--bg-input', inputBg);
        if (fg) root.setProperty('--text-main', fg);
        if (mutedFg) root.setProperty('--text-muted', mutedFg);
    }

    // --- CSS INJECTION (Cached - only update when CSS changes) ---
    let styleTag = document.getElementById('cdp-styles');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'cdp-styles';
        document.head.appendChild(styleTag);
    }

    const cssKey = fastHash(JSON.stringify({
        css: data.css || '',
        backgroundColor: data.backgroundColor || '',
        color: data.color || '',
        themeVars: data.themeVars || {}
    }));

    // Rebuild CSS when theme-relevant snapshot data changes.
    if (cssKey !== cachedCssKey) {
        cachedCssKey = cssKey;
        // Use IDE theme colors or fallback to defaults
        const tv = data.themeVars || {};
        const themeFg = tv['--vscode-editor-foreground'] || tv['--vscode-foreground'] || data.color || '#f0f0f2';
        const themeMuted = tv['--vscode-descriptionForeground'] || '#8a8d92';
        const snapshotRootSelector = '[id^="workbench.panel.aichat"], #conversation, #chat, #cascade';
        const snapshotRootScope = `#chatContent :is(${snapshotRootSelector})`;
        const darkModeOverrides = `/* --- BASE SNAPSHOT CSS --- */
${data.css || ''}

/* --- THEME OVERRIDES --- */
${snapshotRootScope} {
    background-color: transparent !important;
    color: var(--text-main) !important;
    font-family: "Segoe UI Variable", "Segoe WPC", "Segoe UI", system-ui, sans-serif !important;
    position: relative !important;
    height: auto !important;
    width: 100% !important;
}

${snapshotRootScope} .monaco-pane-view,
${snapshotRootScope} .monaco-scrollable-element,
${snapshotRootScope} .split-view-container,
${snapshotRootScope} .split-view-view,
${snapshotRootScope} .pane,
${snapshotRootScope} .pane-body,
${snapshotRootScope} .conversations,
${snapshotRootScope} .composer-messages-container,
${snapshotRootScope} .scrollable-div-container {
    position: static !important;
    height: auto !important;
    max-height: none !important;
    overflow: visible !important;
}

${snapshotRootScope} .composer-human-ai-pair-container {
    min-height: 0 !important;
    padding-bottom: 0 !important;
    gap: 10px !important;
}

${snapshotRootScope} [style*="position: sticky"] {
    position: static !important;
    top: auto !important;
}

${snapshotRootScope} [style*="position: absolute"],
${snapshotRootScope} [style*="position: fixed"],
${snapshotRootScope} [data-headlessui-state],
${snapshotRootScope} [id*="headlessui"] {
    position: absolute !important;
}

${snapshotRootScope} .cr-preserved-alerts {
    display: grid !important;
    gap: 8px !important;
    margin: 8px 0 14px !important;
}

${snapshotRootScope} .announcement-modal,
${snapshotRootScope} .cr-preserved-alert,
${snapshotRootScope} [role="alert"],
${snapshotRootScope} [aria-live="assertive"],
${snapshotRootScope} [aria-live="polite"] {
    display: block !important;
    position: relative !important;
    inset: auto !important;
    margin: 8px 0 14px !important;
    padding: 14px 16px 15px !important;
    background: #4a4b4f !important;
    border: 1px solid rgba(255, 255, 255, 0.07) !important;
    border-radius: 10px !important;
    color: rgba(255, 255, 255, 0.92) !important;
    box-shadow: none !important;
    overflow: hidden !important;
}

${snapshotRootScope} .announcement-modal-close-button,
${snapshotRootScope} .announcement-modal button[aria-label*="close" i],
${snapshotRootScope} .announcement-modal button[title*="close" i],
${snapshotRootScope} .cr-preserved-alert button[aria-label*="close" i],
${snapshotRootScope} .cr-preserved-alert button[title*="close" i] {
    position: absolute !important;
    top: 10px !important;
    right: 10px !important;
    width: 24px !important;
    height: 24px !important;
    border: 0 !important;
    background: transparent !important;
    color: rgba(255, 255, 255, 0.56) !important;
    padding: 0 !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    font-size: 18px !important;
    line-height: 1 !important;
}

${snapshotRootScope} .announcement-modal-close-button::before,
${snapshotRootScope} .announcement-modal button[aria-label*="close" i]::before,
${snapshotRootScope} .announcement-modal button[title*="close" i]::before,
${snapshotRootScope} .cr-preserved-alert button[aria-label*="close" i]::before,
${snapshotRootScope} .cr-preserved-alert button[title*="close" i]::before {
    content: '×' !important;
}

${snapshotRootScope} .announcement-modal strong,
${snapshotRootScope} .announcement-modal b,
${snapshotRootScope} .cr-preserved-alert strong,
${snapshotRootScope} .cr-preserved-alert b {
    display: block !important;
    position: relative !important;
    margin: 0 28px 8px 0 !important;
    padding-left: 24px !important;
    font-size: 14px !important;
    line-height: 1.35 !important;
    font-weight: 600 !important;
    color: rgba(255, 255, 255, 0.96) !important;
}

${snapshotRootScope} .announcement-modal strong::before,
${snapshotRootScope} .announcement-modal b::before,
${snapshotRootScope} .cr-preserved-alert strong::before,
${snapshotRootScope} .cr-preserved-alert b::before {
    content: '' !important;
    position: absolute !important;
    left: 0 !important;
    top: 1px !important;
    width: 16px !important;
    height: 16px !important;
    background: center / contain no-repeat url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23b8bac0' stroke-width='1.35' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M8 2.2 13.2 12a1 1 0 0 1-.88 1.5H3.68A1 1 0 0 1 2.8 12L8 2.2Z'/%3E%3Cpath d='M8 5.5v3.4'/%3E%3Ccircle cx='8' cy='11.5' r='.55' fill='%23b8bac0' stroke='none'/%3E%3C/svg%3E") !important;
}

${snapshotRootScope} .announcement-modal-close-button::before,
${snapshotRootScope} .announcement-modal button[aria-label*="close" i]::before,
${snapshotRootScope} .announcement-modal button[title*="close" i]::before,
${snapshotRootScope} .cr-preserved-alert button[aria-label*="close" i]::before,
${snapshotRootScope} .cr-preserved-alert button[title*="close" i]::before {
    content: '\\00d7' !important;
}

${snapshotRootScope} .announcement-modal > div,
${snapshotRootScope} .announcement-modal p,
${snapshotRootScope} .announcement-modal span:not(.codicon),
${snapshotRootScope} .cr-preserved-alert > div,
${snapshotRootScope} .cr-preserved-alert p,
${snapshotRootScope} .cr-preserved-alert span:not(.codicon) {
    font-size: 13.1px !important;
    line-height: 1.42 !important;
    color: rgba(255, 255, 255, 0.84) !important;
}

${snapshotRootScope} .announcement-modal > :last-child,
${snapshotRootScope} .cr-preserved-alert > :last-child {
    margin-top: 14px !important;
    font-size: 12.3px !important;
    line-height: 1.38 !important;
    color: rgba(255, 255, 255, 0.56) !important;
}

${snapshotRootScope} [style*="color: rgb(0, 0, 0)"],
${snapshotRootScope} [style*="color: black"],
${snapshotRootScope} [style*="color:#000"],
${snapshotRootScope} [style*="color: #000"],
${snapshotRootScope} [style*="color: rgb(3"],
${snapshotRootScope} [style*="color: rgb(2"],
${snapshotRootScope} [style*="color: rgb(1, "],
${snapshotRootScope} [style*="color: rgb(5, "],
${snapshotRootScope} [style*="color: rgb(10,"],
${snapshotRootScope} [style*="color: rgb(15,"],
${snapshotRootScope} [style*="color: rgb(20,"],
${snapshotRootScope} [style*="color: rgb(25,"],
${snapshotRootScope} [style*="color: rgb(30,"],
${snapshotRootScope} [style*="color: rgb(35,"],
${snapshotRootScope} [style*="color: rgb(40,"],
${snapshotRootScope} [style*="color: rgb(45,"],
${snapshotRootScope} [style*="color: rgb(50,"],
${snapshotRootScope} [style*="color: rgb(55,"],
${snapshotRootScope} [style*="color: rgb(60,"],
${snapshotRootScope} [style*="color: rgb(65,"],
${snapshotRootScope} [style*="color: rgb(70,"],
${snapshotRootScope} [style*="color: rgb(75,"] {
    color: var(--text-main) !important;
}

${snapshotRootScope} .markdown-root a[href] {
    color: #8fa3ff !important;
    text-decoration: underline !important;
}

${snapshotRootScope} .markdown-root,
${snapshotRootScope} .markdown-root :not(a):not(svg):not(img),
${snapshotRootScope} [data-message-role="human"] :not(a):not(svg):not(img) {
    color: var(--text-main) !important;
    text-decoration: none !important;
}

${snapshotRootScope} img[src^="/c:"],
${snapshotRootScope} img[src^="/C:"],
${snapshotRootScope} img[src*="AppData"] {
    display: none !important;
}

${snapshotRootScope} img,
${snapshotRootScope} svg {
    display: inline !important;
    vertical-align: middle !important;
}

${snapshotRootScope} div:has(> img[src^="data:"]),
${snapshotRootScope} div:has(> img[alt]),
${snapshotRootScope} span:has(> img) {
    display: inline !important;
    vertical-align: middle !important;
}

${snapshotRootScope} [class*="inline-flex"],
${snapshotRootScope} [class*="inline-block"],
${snapshotRootScope} [class*="items-center"]:has(img) {
    display: inline-flex !important;
    vertical-align: middle !important;
}

${snapshotRootScope} :not(pre) > code {
    padding: 0px 2px !important;
    border-radius: 2px !important;
    background-color: rgba(255, 255, 255, 0.08) !important;
    font-size: 0.82em !important;
    line-height: 1 !important;
    white-space: normal !important;
}

${snapshotRootScope} pre,
${snapshotRootScope} code,
${snapshotRootScope} .monaco-editor-background,
${snapshotRootScope} [class*="terminal"] {
    background-color: #1a1b20 !important;
    color: #e0e0e4 !important;
    font-family: 'JetBrains Mono', monospace !important;
    border-radius: 6px;
    border: 1px solid #2a2b32;
}

${snapshotRootScope} pre {
    position: relative !important;
    white-space: pre-wrap !important;
    word-break: break-word !important;
    padding: 8px 10px !important;
    margin: 8px 0 !important;
    display: block !important;
    width: 100% !important;
}

${snapshotRootScope} pre.has-copy-btn {
    padding-right: 28px !important;
}

${snapshotRootScope} pre.single-line-pre {
    display: inline-block !important;
    width: auto !important;
    max-width: 100% !important;
    padding: 0px 4px !important;
    margin: 0px !important;
    vertical-align: middle !important;
    font-size: 0.85em !important;
}

${snapshotRootScope} pre.single-line-pre > code {
    display: inline !important;
    white-space: nowrap !important;
}

${snapshotRootScope} pre:not(.single-line-pre) > code {
    display: block !important;
    width: 100% !important;
    overflow-x: auto !important;
    background: transparent !important;
    border: none !important;
    padding: 0 !important;
    margin: 0 !important;
}

${snapshotRootScope} .mobile-copy-btn {
    position: absolute !important;
    top: 2px !important;
    right: 2px !important;
    background: rgba(26, 27, 32, 0.6) !important;
    color: #8a8d92 !important;
    border: none !important;
    width: 24px !important;
    height: 24px !important;
    padding: 0 !important;
    cursor: pointer !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    border-radius: 4px !important;
    transition: all 0.2s ease !important;
    -webkit-tap-highlight-color: transparent !important;
    z-index: 10 !important;
    margin: 0 !important;
}

${snapshotRootScope} .mobile-copy-btn:hover,
${snapshotRootScope} .mobile-copy-btn:focus {
    background: rgba(99, 102, 241, 0.2) !important;
    color: #818cf8 !important;
}

${snapshotRootScope} .mobile-copy-btn svg {
    width: 16px !important;
    height: 16px !important;
    stroke: currentColor !important;
    stroke-width: 2 !important;
    fill: none !important;
}

${snapshotRootScope} blockquote {
    border-left: 3px solid #6366f1 !important;
    background: rgba(99, 102, 241, 0.08) !important;
    color: #c8c8cc !important;
    padding: 8px 12px !important;
    margin: 8px 0 !important;
}

${snapshotRootScope} table {
    border-collapse: collapse !important;
    width: 100% !important;
    border: 1px solid #2a2b32 !important;
}

${snapshotRootScope} th,
${snapshotRootScope} td {
    border: 1px solid #2a2b32 !important;
    padding: 8px !important;
    color: #e0e0e4 !important;
}

${snapshotRootScope} ::-webkit-scrollbar {
    width: 0 !important;
}

${snapshotRootScope} [style*="background-color: rgb(255, 255, 255)"],
${snapshotRootScope} [style*="background-color: white"],
${snapshotRootScope} [style*="background: white"],
${snapshotRootScope} [style*="background-color: rgb(249"],
${snapshotRootScope} [style*="background-color: rgb(248"],
${snapshotRootScope} [style*="background-color: rgb(244"],
${snapshotRootScope} [style*="background-color: rgb(243"],
${snapshotRootScope} [style*="background-color: rgb(241"],
${snapshotRootScope} [style*="background-color: rgb(31"],
${snapshotRootScope} [style*="background-color: rgb(30"],
${snapshotRootScope} [style*="background-color: rgb(15"],
${snapshotRootScope} [style*="background-color: rgb(17"],
${snapshotRootScope} [style*="background-color: rgb(24"],
${snapshotRootScope} [style*="background-color: rgb(32"],
${snapshotRootScope} [style*="background-color: rgb(38"],
${snapshotRootScope} [class*="bg-gray"],
${snapshotRootScope} [class*="bg-slate"],
${snapshotRootScope} [class*="bg-neutral"],
${snapshotRootScope} [class*="bg-zinc"],
${snapshotRootScope} [class*="bg-ide-"],
${snapshotRootScope} [class*="from-ide-"],
${snapshotRootScope} [class*="bg-white"] {
    background-color: transparent !important;
}

${snapshotRootScope} > div > div,
${snapshotRootScope} .composer-message-group,
${snapshotRootScope} .composer-rendered-message,
${snapshotRootScope} .markdown-root {
    background-color: transparent !important;
}

${snapshotRootScope} .rounded-lg {
    background-color: rgba(255, 255, 255, 0.04) !important;
    border: 1px solid rgba(255, 255, 255, 0.06) !important;
    border-radius: 10px !important;
    padding: 6px !important;
    margin: 4px 0 !important;
}

${snapshotRootScope} .rounded-lg:has(> details),
${snapshotRootScope} .rounded-lg:has(> summary),
${snapshotRootScope} details.rounded-lg,
${snapshotRootScope} .rounded-lg > details,
${snapshotRootScope} .isolate,
${snapshotRootScope} .isolate > button,
${snapshotRootScope} .rounded-lg:has([data-tooltip-id^="up-"], [data-tooltip-id^="down-"]) {
    background-color: transparent !important;
    border: none !important;
    padding: 0 !important;
    margin: 0 !important;
    border-radius: 0 !important;
    outline: none !important;
    box-shadow: none !important;
}

${snapshotRootScope} [data-message-role="human"] {
    margin-left: auto !important;
    max-width: min(78%, 720px) !important;
}

${snapshotRootScope} [data-message-role="assistant"],
${snapshotRootScope} .composer-message-group {
    margin-right: auto !important;
    max-width: min(920px, 100%) !important;
}

${snapshotRootScope} [data-message-role="human"] .composer-human-message-container {
    justify-content: flex-end !important;
    background-color: transparent !important;
}

${snapshotRootScope} [data-message-role="human"] .composer-human-message,
${snapshotRootScope} [data-message-role="human"] .human-message-with-todos-wrapper {
    background-color: rgba(255, 255, 255, 0.08) !important;
    border: 1px solid rgba(255, 255, 255, 0.06) !important;
    border-radius: 12px !important;
}

${snapshotRootScope} [data-message-role="human"] .rounded-lg,
${snapshotRootScope} [data-message-role="human"] [class*="bg-gray-500"] {
    background-color: transparent !important;
    border: none !important;
    padding: 0 !important;
    margin: 0 !important;
}

${snapshotRootScope} .text-ide-text-color {
    color: var(--text-main) !important;
}

${snapshotRootScope} [style*="max-width: 740px"] {
    max-width: min(740px, 100%) !important;
}

${snapshotRootScope} .composer-message-blur,
${snapshotRootScope} .composer-rendered-message,
${snapshotRootScope} .composer-message-group > div,
${snapshotRootScope} [data-message-role="ai"],
${snapshotRootScope} [data-message-role="tool"] {
    opacity: 1 !important;
}

${snapshotRootScope} [data-message-role="human"][style*="position: sticky"] {
    position: sticky !important;
    top: 0 !important;
    z-index: 25 !important;
    margin-left: 0 !important;
    max-width: none !important;
    padding: 0 0 10px !important;
}

${snapshotRootScope} [data-message-role="human"][style*="position: sticky"] .composer-human-message-container {
    justify-content: flex-start !important;
}

${snapshotRootScope} [data-message-role="human"][style*="position: sticky"] .composer-human-message,
${snapshotRootScope} [data-message-role="human"][style*="position: sticky"] .human-message-with-todos-wrapper {
    width: 100% !important;
    background: #3a3b40 !important;
    border: 1px solid rgba(255, 255, 255, 0.05) !important;
    border-radius: 10px !important;
    box-shadow: none !important;
}

${snapshotRootScope} .ui-step-group-header,
${snapshotRootScope} .ui-collapsible-header {
    display: inline-flex !important;
    align-items: center !important;
    gap: 6px !important;
    font-size: 12.6px !important;
    line-height: 1.35 !important;
    letter-spacing: -0.01em !important;
}

${snapshotRootScope} .ui-collapsible-header span:first-child {
    color: rgba(255, 255, 255, 0.64) !important;
    font-weight: 500 !important;
}

${snapshotRootScope} .ui-collapsible-header span:last-of-type,
${snapshotRootScope} .ui-collapsible-chevron,
${snapshotRootScope} .cursor-icon {
    color: rgba(255, 255, 255, 0.4) !important;
    opacity: 1 !important;
}

${snapshotRootScope} [data-message-kind="assistant"] .markdown-root,
${snapshotRootScope} [data-message-kind="assistant"] .markdown-root p,
${snapshotRootScope} [data-message-kind="tool"] .markdown-root,
${snapshotRootScope} [data-message-kind="tool"] .markdown-root p {
    font-family: "Segoe UI Variable", "Segoe WPC", "Segoe UI", system-ui, sans-serif !important;
    font-size: 13.2px !important;
    line-height: 1.55 !important;
    letter-spacing: -0.01em !important;
}

${snapshotRootScope} .markdown-root .space-y-4 {
    display: flex !important;
    flex-direction: column !important;
    gap: 12px !important;
}

${snapshotRootScope} .composer-tool-former-message,
${snapshotRootScope} .composer-tool-call-container,
${snapshotRootScope} .composer-terminal-tool-call-block-container {
    background: transparent !important;
    border: 1px solid rgba(255, 255, 255, 0.09) !important;
    border-radius: 8px !important;
    box-shadow: none !important;
}

${snapshotRootScope} .composer-tool-call-top-header,
${snapshotRootScope} .composer-terminal-top-header-row,
${snapshotRootScope} .composer-tool-call-header,
${snapshotRootScope} .composer-tool-call-header-content,
${snapshotRootScope} .composer-tool-call-content,
${snapshotRootScope} .composer-tool-call-body,
${snapshotRootScope} .composer-tool-call-body-inner,
${snapshotRootScope} .composer-tool-call-body-content,
${snapshotRootScope} .composer-terminal-output {
    background: transparent !important;
    border: none !important;
    box-shadow: none !important;
}

${snapshotRootScope} .composer-tool-call-container .rounded-lg,
${snapshotRootScope} .composer-tool-call-container .composer-terminal-output,
${snapshotRootScope} .composer-tool-call-container pre,
${snapshotRootScope} .composer-tool-call-container code,
${snapshotRootScope} .composer-tool-call-container .monaco-editor-background {
    background: transparent !important;
    border: none !important;
    box-shadow: none !important;
    border-radius: 0 !important;
    padding: 0 !important;
    margin: 0 !important;
}

${snapshotRootScope} .composer-tool-call-control-row,
${snapshotRootScope} .composer-tool-call-header-right,
${snapshotRootScope} .composer-terminal-copy-button,
${snapshotRootScope} .composer-tool-call-allowlist-button,
${snapshotRootScope} .composer-tool-call-menu-button,
${snapshotRootScope} .mobile-copy-btn {
    display: none !important;
}

${snapshotRootScope} .composer-tool-call-left-controls {
    display: flex !important;
    align-items: center !important;
    gap: 6px !important;
}

${snapshotRootScope} .composer-terminal-top-header-row {
    min-height: 0 !important;
    padding: 0 !important;
}

${snapshotRootScope} .composer-terminal-top-header-icon-slot {
    display: none !important;
}

${snapshotRootScope} .composer-terminal-top-header-text,
${snapshotRootScope} .composer-terminal-top-header-description,
${snapshotRootScope} .composer-tool-former-message,
${snapshotRootScope} .composer-tool-call-container {
    font-family: "Segoe UI Variable", "Segoe WPC", "Segoe UI", system-ui, sans-serif !important;
    font-size: 12.8px !important;
    line-height: 1.35 !important;
}

${snapshotRootScope} .composer-terminal-top-header-description {
    color: rgba(255, 255, 255, 0.74) !important;
}

${snapshotRootScope} .composer-terminal-top-header-candidates {
    color: rgba(255, 255, 255, 0.42) !important;
}

${snapshotRootScope} .composer-terminal-top-header-description,
${snapshotRootScope} .composer-terminal-top-header-candidates,
${snapshotRootScope} .composer-terminal-top-header-text > span {
    background: transparent !important;
    border: none !important;
    box-shadow: none !important;
    padding: 0 !important;
    border-radius: 0 !important;
}

${snapshotRootScope} .composer-tool-call-container.composer-terminal-compact-mode.composer-terminal-header-only,
${snapshotRootScope} .composer-terminal-tool-call-block-container.composer-terminal-compact-mode.composer-terminal-header-only {
    padding: 5px 8px !important;
    gap: 0 !important;
}

${snapshotRootScope} .composer-tool-call-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-tool-call-top-header,
${snapshotRootScope} .composer-terminal-tool-call-block-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-tool-call-top-header,
${snapshotRootScope} .composer-tool-call-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-terminal-top-header-row,
${snapshotRootScope} .composer-terminal-tool-call-block-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-terminal-top-header-row {
    align-items: center !important;
    gap: 6px !important;
    min-width: 0 !important;
    overflow: hidden !important;
}

${snapshotRootScope} .composer-tool-call-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-terminal-top-header-text,
${snapshotRootScope} .composer-terminal-tool-call-block-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-terminal-top-header-text {
    display: block !important;
    min-width: 0 !important;
    width: 100% !important;
    overflow: hidden !important;
    white-space: nowrap !important;
    text-overflow: ellipsis !important;
}

${snapshotRootScope} .composer-tool-call-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-terminal-top-header-description,
${snapshotRootScope} .composer-tool-call-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-terminal-top-header-candidates,
${snapshotRootScope} .composer-terminal-tool-call-block-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-terminal-top-header-description,
${snapshotRootScope} .composer-terminal-tool-call-block-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-terminal-top-header-candidates {
    display: inline !important;
    white-space: nowrap !important;
}

${snapshotRootScope} .composer-tool-call-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-tool-call-content,
${snapshotRootScope} .composer-tool-call-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-tool-call-body,
${snapshotRootScope} .composer-tool-call-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-tool-call-body-inner,
${snapshotRootScope} .composer-tool-call-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-tool-call-body-content,
${snapshotRootScope} .composer-terminal-tool-call-block-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-tool-call-content,
${snapshotRootScope} .composer-terminal-tool-call-block-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-tool-call-body,
${snapshotRootScope} .composer-terminal-tool-call-block-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-tool-call-body-inner,
${snapshotRootScope} .composer-terminal-tool-call-block-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-tool-call-body-content {
    max-height: 0 !important;
    min-height: 0 !important;
    overflow: hidden !important;
    padding: 0 !important;
    margin: 0 !important;
}

${snapshotRootScope} .composer-tool-call-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-tool-call-bottom-expand-inline,
${snapshotRootScope} .composer-terminal-tool-call-block-container.composer-terminal-compact-mode.composer-terminal-header-only .composer-tool-call-bottom-expand-inline {
    display: none !important;
}

${snapshotRootScope} [data-message-role="human"] .composer-human-message,
${snapshotRootScope} [data-message-role="human"] .human-message-with-todos-wrapper,
${snapshotRootScope} [data-message-role="human"] .composer-human-message-container {
    border-radius: 14px !important;
}

${snapshotRootScope} [data-message-role="human"] .composer-human-message {
    padding: 2px !important;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02) !important;
}

${snapshotRootScope} [data-message-role="human"] .aislash-editor-input-readonly,
${snapshotRootScope} [data-message-role="human"] [data-lexical-editor="true"] {
    font-family: "Segoe UI Variable", "Segoe WPC", "Segoe UI", system-ui, sans-serif !important;
    font-size: 13.2px !important;
    line-height: 1.45 !important;
}

${snapshotRootScope} .composer-human-ai-pair-container {
    gap: 10px !important;
}

${snapshotRootScope} [style*="padding-inline: 9px"] {
    padding-inline: 0 !important;
}

${snapshotRootScope} .pane-header,
${snapshotRootScope} #composer-toolbar-section,
${snapshotRootScope} [aria-label="New Chat Section"] {
    display: none !important;
}

${snapshotRootScope} .composer-message-group,
${snapshotRootScope} [data-message-kind="assistant"],
${snapshotRootScope} [data-message-kind="tool"] {
    padding-left: 0 !important;
    padding-right: 0 !important;
}`;
        styleTag.textContent = darkModeOverrides;
    }

    // --- HTML UPDATE (skip if unchanged to prevent text jittering) ---
    const renderedHtml = data.html;
    const htmlHash = fastHash(renderedHtml);
    if (htmlHash !== lastRenderedHtmlHash) {
        lastRenderedHtmlHash = htmlHash;
        chatContent.innerHTML = renderedHtml;
        syncComposerAlertDock();

        // Ensure dark mode classes are set for Tailwind dark variant activation
        chatContent.classList.add('dark');
        chatContent.setAttribute('data-theme', 'dark');
        document.documentElement.classList.add('dark');
        document.documentElement.style.colorScheme = 'dark';

        const snapshotTitle = normalizeChatTitle(data.activeChatTitle) || extractActiveChatTitleFromSnapshot();
        if (snapshotTitle) {
            setActiveChatTitle(snapshotTitle);
        }
    }

    // Smart scroll behavior: respect user scroll, only auto-scroll when appropriate
    if (isUserScrollLocked) {
        // User recently scrolled - try to maintain their approximate position
        if (wasAtTop) {
            chatContainer.scrollTop = 0;
        } else {
            const previousScrollableHeight = Math.max(scrollHeight - clientHeight, 0);
            const nextScrollableHeight = Math.max(chatContainer.scrollHeight - chatContainer.clientHeight, 0);
            const scrollPercent = previousScrollableHeight > 0 ? scrollPos / previousScrollableHeight : 0;
            chatContainer.scrollTop = nextScrollableHeight * scrollPercent;
        }
    } else if (isNearBottom && !wasAtTop) {
        // User was near the bottom, so keep the latest messages in view
        chatContainer.scrollTop = chatContainer.scrollHeight;
    } else if (wasAtTop) {
        // Preserve the top position instead of snapping down on refresh
        chatContainer.scrollTop = 0;
    } else {
        // Preserve exact scroll position
        chatContainer.scrollTop = scrollPos;
    }

    updateWorkspaceChrome({ snapshotReady: true });
}

// --- Rendering (HTTP fallback - used for initial load and manual refresh) ---
async function loadSnapshot({ expectedHash = '' } = {}) {
    const normalizedExpectedHash = String(expectedHash || '').trim();
    if (normalizedExpectedHash) {
        queuedSnapshotReloadExpectedHash = normalizedExpectedHash;
    }

    if (snapshotRequestInFlight) {
        queuedSnapshotReloadRequested = true;
        return snapshotRequestInFlight;
    }

    const requestExpectedHash = queuedSnapshotReloadExpectedHash;

    const request = (async () => {
        try {
            // Add spin animation to refresh button
            const icon = refreshBtn?.querySelector('svg');
            if (icon) {
                icon.classList.remove('spin-anim');
                void icon.offsetWidth; // trigger reflow
                icon.classList.add('spin-anim');
            }

            const response = await fetchWithAuth('/snapshot');
            if (!response.ok) {
                if (response.status === 503) {
                    const latestState = await fetchAppState({
                        force: true,
                        applyOptions: {
                            loadSnapshotWhenMissing: false
                        }
                    });
                    if (hasLiveCursorView(latestState)) {
                        return;
                    }
                    // No snapshot available - likely no chat open
                    chatIsOpen = false;
                    hasSnapshotLoaded = false;
                    updateWorkspaceChrome({ snapshotReady: false });
                    showEmptyState();
                    return;
                }
                throw new Error('Failed to load');
            }

            const data = await response.json();
            renderSnapshot(data);

            const responseHash = String(data?.hash || '').trim();
            if (requestExpectedHash && responseHash && requestExpectedHash !== responseHash) {
                queuedSnapshotReloadExpectedHash = requestExpectedHash;
                queuedSnapshotReloadRequested = true;
            } else if (!responseHash && requestExpectedHash) {
                queuedSnapshotReloadExpectedHash = requestExpectedHash;
                queuedSnapshotReloadRequested = true;
            } else if (responseHash && queuedSnapshotReloadExpectedHash === responseHash) {
                queuedSnapshotReloadExpectedHash = '';
            }

        } catch (err) {
            console.error(err);
        }
    })().finally(() => {
        if (snapshotRequestInFlight === request) {
            snapshotRequestInFlight = null;
        }

        if (queuedSnapshotReloadRequested) {
            queuedSnapshotReloadRequested = false;
            setTimeout(() => {
                if (!snapshotRequestInFlight) {
                    loadSnapshot({ expectedHash: queuedSnapshotReloadExpectedHash });
                }
            }, 0);
        }
    });

    snapshotRequestInFlight = request;
    return request;
}

// --- Mobile Code Block Copy Functionality ---
function addMobileCopyButtons() {
    // Find all pre elements (code blocks) in the chat
    const codeBlocks = chatContent.querySelectorAll('pre');

    codeBlocks.forEach((pre, index) => {
        // Skip if already has our button
        if (pre.querySelector('.mobile-copy-btn')) return;

        // Get the code text
        const codeElement = pre.querySelector('code') || pre;
        const textToCopy = (codeElement.textContent || codeElement.innerText).trim();

        // Check if there's a newline character in the TRIMMED text
        // This ensures single-line blocks with trailing newlines don't get buttons
        const hasNewline = /\n/.test(textToCopy);

        // If it's a single line code block, don't add the copy button
        if (!hasNewline) {
            pre.classList.remove('has-copy-btn');
            pre.classList.add('single-line-pre');
            return;
        }

        // Add class for padding
        pre.classList.remove('single-line-pre');
        pre.classList.add('has-copy-btn');

        // Create the copy button (icon only)
        const copyBtn = document.createElement('button');
        copyBtn.className = 'mobile-copy-btn';
        copyBtn.setAttribute('data-code-index', index);
        copyBtn.setAttribute('aria-label', 'Copy code');
        copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            `;

        // Add click handler for copy
        copyBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const success = await copyToClipboard(textToCopy);

            if (success) {
                // Visual feedback - show checkmark
                copyBtn.classList.add('copied');
                copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            `;

                // Reset after 2 seconds
                setTimeout(() => {
                    copyBtn.classList.remove('copied');
                    copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
            `;
                }, 2000);
            } else {
                // Show X icon briefly on error
                copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
            `;
                setTimeout(() => {
                    copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
            `;
                }, 2000);
            }
        });

        // Insert button into pre element
        pre.appendChild(copyBtn);
    });
}

// --- Cross-platform Clipboard Copy ---
async function copyToClipboard(text) {
    // Method 1: Modern Clipboard API (works on HTTPS or localhost)
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            console.log('[COPY] Success via Clipboard API');
            return true;
        } catch (err) {
            console.warn('[COPY] Clipboard API failed:', err);
        }
    }

    // Method 2: Fallback using execCommand (works on HTTP, older browsers)
    try {
        const textArea = document.createElement('textarea');
        textArea.value = text;

        // Avoid scrolling to bottom on iOS
        textArea.style.position = 'fixed';
        textArea.style.top = '0';
        textArea.style.left = '0';
        textArea.style.width = '2em';
        textArea.style.height = '2em';
        textArea.style.padding = '0';
        textArea.style.border = 'none';
        textArea.style.outline = 'none';
        textArea.style.boxShadow = 'none';
        textArea.style.background = 'transparent';
        textArea.style.opacity = '0';

        document.body.appendChild(textArea);

        // iOS specific handling
        if (navigator.userAgent.match(/ipad|iphone/i)) {
            const range = document.createRange();
            range.selectNodeContents(textArea);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            textArea.setSelectionRange(0, text.length);
        } else {
            textArea.select();
        }

        const success = document.execCommand('copy');
        document.body.removeChild(textArea);

        if (success) {
            console.log('[COPY] Success via execCommand fallback');
            return true;
        }
    } catch (err) {
        console.warn('[COPY] execCommand fallback failed:', err);
    }

    // Method 3: For Android WebView or restricted contexts
    // Show the text in a selectable modal if all else fails
    console.error('[COPY] All copy methods failed');
    return false;
}

function scrollToBottom() {
    chatContainer.scrollTo({
        top: chatContainer.scrollHeight,
        behavior: 'smooth'
    });
}
