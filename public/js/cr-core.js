// =============================================
// CursorRemote - Core (DOM refs, state, utils)
// =============================================

// --- Touch Long-Press Tooltip System ---
(function () {
    let longPressTimer = null;
    let activeTooltip = null;

    function showTooltip(el) {
        hideTooltip();
        el.classList.add('tooltip-visible');
        activeTooltip = el;
    }

    function hideTooltip() {
        if (activeTooltip) {
            activeTooltip.classList.remove('tooltip-visible');
            activeTooltip = null;
        }
    }

    document.addEventListener('touchstart', (e) => {
        const el = e.target.closest('[data-tooltip]');
        if (!el) { hideTooltip(); return; }
        longPressTimer = setTimeout(() => showTooltip(el), 500);
    }, { passive: true });

    document.addEventListener('touchend', () => {
        clearTimeout(longPressTimer);
        setTimeout(hideTooltip, 1500); // auto-hide after 1.5s
    }, { passive: true });

    document.addEventListener('touchmove', () => {
        clearTimeout(longPressTimer);
        hideTooltip();
    }, { passive: true });
})();

// --- Elements ---
const chatContainer = document.getElementById('chatContainer');
const chatContent = document.getElementById('chatContent');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const scrollToBottomBtn = document.getElementById('scrollToBottom');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const refreshBtn = document.getElementById('refreshBtn');
const stopBtn = document.getElementById('stopBtn');
const newChatBtn = document.getElementById('newChatBtn');
const newChatLabel = newChatBtn?.querySelector('.new-chat-label');
const historyBtn = document.getElementById('historyBtn');
const historyQuickBtn = document.getElementById('historyQuickBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const settingsBtn = document.getElementById('settingsBtn');
const settingsDropdown = document.getElementById('settingsDropdown');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const restartCursorCdpBtn = document.getElementById('restartCursorCdpBtn');
const headerChatTabs = document.getElementById('headerChatTabs');
const homeContext = document.getElementById('homeContext');
const homeContextAgent = document.getElementById('homeContextAgent');
const homeRecents = document.getElementById('homeRecents');
const homeRecentsList = document.getElementById('homeRecentsList');
const homeRecentsLink = document.getElementById('homeRecentsLink');
const heroStatusTitle = document.getElementById('heroStatusTitle');
const heroStatusDetail = document.getElementById('heroStatusDetail');
const heroModeText = document.getElementById('heroModeText');
const heroModelText = document.getElementById('heroModelText');
const heroModelDetail = document.getElementById('heroModelDetail');
const sidebarConnectionTitle = document.getElementById('sidebarConnectionTitle');
const sidebarConnectionDetail = document.getElementById('sidebarConnectionDetail');
const sidebarProtocolChip = document.getElementById('sidebarProtocolChip');
const sidebcrThemeChip = document.getElementById('sidebcrThemeChip');
const appBrandTitle = document.querySelector('.app-brand-title');
const sidebarModeText = document.getElementById('sidebarModeText');
const sidebarModelText = document.getElementById('sidebarModelText');
const sidebarTransportText = document.getElementById('sidebarTransportText');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const isLoopbackHost = LOOPBACK_HOSTS.has(window.location.hostname);
const DEFAULT_COMPOSER_PLACEHOLDER = 'Ask anything, @ to mention, / for workflows';
const HOME_COMPOSER_PLACEHOLDER = 'Add a follow-up';
const DEFAULT_APP_TITLE = appBrandTitle?.textContent || 'Cursor Remote';
const DEFAULT_NEW_CHAT_LABEL = newChatLabel?.textContent || 'New Chat';
const DEFAULT_RESTART_CURSOR_LABEL = restartCursorCdpBtn?.querySelector('.settings-option-label')?.textContent || 'Restart Cursor';
const APP_STATE_REVALIDATE_INTERVAL = 1800;
const SNAPSHOT_REVALIDATE_INTERVAL = 900;
const CHAT_STATUS_REVALIDATE_INTERVAL = 2500;
const SNAPSHOT_STATE_CHANGE_RELOAD_DELAYS = [60, 220, 700];
const FAST_ACTION_SNAPSHOT_DELAYS = [80, 220, 550];
const COMMAND_ACTION_SNAPSHOT_DELAYS = [120, 360, 900];
const NEW_CHAT_SNAPSHOT_DELAYS = [160, 420, 900];
const FILE_UPLOAD_SNAPSHOT_DELAYS = [250, 700];
const ACTION_STATUS_RECHECK_DELAY = 450;

function setTextContent(element, value) {
    if (element) element.textContent = value;
}

function getComposerPlaceholder() {
    if (!document.body.classList.contains('has-chat-tabs') && document.body.classList.contains('home-screen')) {
        return HOME_COMPOSER_PLACEHOLDER;
    }

    const modeLabel = getModeDisplayLabel(currentMode || modeText.textContent || 'Agent');
    return `${modeLabel}, @ for context, / for commands`;
}

function updateComposerPlaceholder() {
    if (!messageInput) return;
    messageInput.placeholder = getComposerPlaceholder();
}

function updateComposerActionState() {
    if (!sendBtn || !messageInput) return;
    const hasText = !!messageInput.value.trim();
    sendBtn.classList.toggle('is-idle-mic', !hasText);
    sendBtn.setAttribute('aria-label', hasText ? 'Send' : 'Voice');
    sendBtn.setAttribute('data-tooltip', hasText ? 'Send' : 'Voice');
}

function normalizeChatTitle(title) {
    return typeof title === 'string' ? title.trim() : '';
}

function hasExplicitChatTitleTruncation(title) {
    return /(?:\u2026|\.{3})\s*$/.test(String(title || '').trim());
}

function normalizeChatTitleMatchKey(title) {
    return normalizeChatTitle(title)
        .replace(/[\u2026.]+$/g, '')
        .trim()
        .toLowerCase();
}

function chatTitlesMatch(left, right) {
    const a = normalizeChatTitleMatchKey(left);
    const b = normalizeChatTitleMatchKey(right);
    if (!a || !b) return false;
    if (a === b) return true;

    if (hasExplicitChatTitleTruncation(left) && b.startsWith(a) && b.length > a.length) {
        return true;
    }

    if (hasExplicitChatTitleTruncation(right) && a.startsWith(b) && a.length > b.length) {
        return true;
    }

    return false;
}

function getTransportLabel() {
    if (window.location.protocol === 'https:') return 'HTTPS + WSS';
    if (isLoopbackHost) return 'Local HTTP + WS';
    return 'HTTP + WS';
}

function syncShellPromptFromComposer(value = messageInput.value) {
    const shellInput = document.getElementById('shellPromptInput');
    if (!shellInput) return;
    shellInput.value = value;
}

function extractActiveChatTitleFromSnapshot() {
    if (headerChatTabs) {
        const activeHeaderTabLabel = headerChatTabs.querySelector('.snapshot-chat-tab.active .snapshot-chat-tab-label');
        if (activeHeaderTabLabel) {
            return normalizeChatTitle(activeHeaderTabLabel.textContent || '');
        }
    }

    if (!chatContent) return '';

    const activeTabLabel = chatContent.querySelector('.snapshot-chat-tab.active .snapshot-chat-tab-label');
    if (activeTabLabel) {
        return normalizeChatTitle(activeTabLabel.textContent || '');
    }

    const titleSource = chatContent.querySelector('[data-message-role="human"][style*="position: sticky"]')
        || chatContent.querySelector('[data-message-role="human"]');
    if (!titleSource) return '';

    const lines = (titleSource.innerText || titleSource.textContent || '')
        .split('\n')
        .map((line) => normalizeChatTitle(line))
        .filter(Boolean);

    return lines[0] || '';
}

function buildSnapshotTabsHtml(tabs = [], activeTitle = '') {
    const normalizedTabs = normalizeSnapshotChatTabs(tabs, activeTitle);

    if (!normalizedTabs.length) return '';

    const resolvedActiveTitle = normalizeChatTitle(activeTitle);
    const hasExplicitActive = normalizedTabs.some((tab) => tab.active);

    return `
        <div class="snapshot-chat-tabs" aria-label="Cursor chat tabs">
            <div class="snapshot-chat-tabs-track">
                ${normalizedTabs.map((tab) => {
                    const isActive = tab.active || (!hasExplicitActive && resolvedActiveTitle && chatTitlesMatch(tab.title, resolvedActiveTitle));
                    const safeTitle = escapeHtmlAttribute(tab.title);
                    return `
                        <button
                            class="snapshot-chat-tab${isActive ? ' active' : ''}"
                            type="button"
                            title="${safeTitle}"
                            data-chat-title="${safeTitle}"
                            aria-label="Open chat ${safeTitle}"
                            aria-pressed="${isActive ? 'true' : 'false'}"
                            ${isActive ? 'aria-current="page"' : ''}
                        >
                            <span class="snapshot-chat-tab-label">${escapeHtml(tab.title)}</span>
                        </button>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

function getSnapshotTabScore(tab, activeTitle = '') {
    const title = normalizeChatTitle(tab?.title);
    if (!title) return -1;

    let score = title.length;
    if (tab?.active) score += 1000;
    if (activeTitle) {
        if (title.toLowerCase() === activeTitle.toLowerCase()) {
            score += 240;
        } else if (chatTitlesMatch(title, activeTitle)) {
            score += 120;
        }
    }
    return score;
}

function getPreferredSnapshotActiveTabIndex(tabs = [], activeTitle = '') {
    const resolvedActiveTitle = normalizeChatTitle(activeTitle);
    let preferredIndex = -1;

    tabs.forEach((tab, index) => {
        const isCandidate = !!tab?.active || (!!resolvedActiveTitle && chatTitlesMatch(tab?.title, resolvedActiveTitle));
        if (!isCandidate) return;

        if (preferredIndex === -1 || getSnapshotTabScore(tab, resolvedActiveTitle) > getSnapshotTabScore(tabs[preferredIndex], resolvedActiveTitle)) {
            preferredIndex = index;
        }
    });

    return preferredIndex;
}

function normalizeSnapshotChatTabs(tabs = [], activeTitle = '') {
    const resolvedActiveTitle = normalizeChatTitle(activeTitle);
    const exactDeduped = [];

    (Array.isArray(tabs) ? tabs : []).forEach((tab) => {
        const candidate = {
            title: normalizeChatTitle(tab?.title),
            active: !!tab?.active
        };
        if (!candidate.title) return;

        const existingIndex = exactDeduped.findIndex((item) => item.title.toLowerCase() === candidate.title.toLowerCase());
        if (existingIndex === -1) {
            exactDeduped.push(candidate);
            return;
        }

        if (getSnapshotTabScore(candidate, resolvedActiveTitle) > getSnapshotTabScore(exactDeduped[existingIndex], resolvedActiveTitle)) {
            exactDeduped[existingIndex] = candidate;
        }
    });

    if (!resolvedActiveTitle) {
        const preferredIndex = getPreferredSnapshotActiveTabIndex(exactDeduped, resolvedActiveTitle);
        return exactDeduped.map((tab, index) => ({
            ...tab,
            active: index === preferredIndex
        }));
    }

    const preferredIndex = getPreferredSnapshotActiveTabIndex(exactDeduped, resolvedActiveTitle);
    return exactDeduped.map((tab, index) => ({
        ...tab,
        active: index === preferredIndex
    }));
}

function updateCursorShellStatus({ connected, running, snapshotReady }) {
    const statusLabel = document.getElementById('shellStatusText');
    const statusAction = document.getElementById('shellStatusAction');
    if (!statusLabel || !statusAction) return;

    let label = 'Waiting for extension host';
    let action = 'Cancel';

    if (running) {
        label = 'Agent is running';
        action = 'Stop';
    } else if (connected && snapshotReady) {
        label = 'Desktop connected';
    } else if (connected) {
        label = 'Waiting for extension host';
    }

    statusLabel.textContent = label;
    statusAction.textContent = action;
}

function renderHomeShell() {
    chatContent.innerHTML = '';
}

function updateWorkspaceChrome(overrides = {}) {
    const connected = overrides.connected ?? !!(ws && ws.readyState === WebSocket.OPEN);
    const running = overrides.running ?? document.body.classList.contains('agent-running');
    const snapshotReady = overrides.snapshotReady ?? hasSnapshotLoaded;
    const mode = getModeDisplayLabel(overrides.mode ?? modeText.textContent);
    const model = overrides.model ?? modelText.textContent;

    let title = 'Connecting...';
    let detail = 'Waiting for desktop state and the first live snapshot.';

    if (!connected) {
        title = 'Reconnecting to desktop';
        detail = 'The client keeps retrying in the background until the desktop session is reachable again.';
    } else if (running) {
        title = 'Agent is running';
        detail = 'The session is live. You can stop the run from the toolbar or let the current task finish.';
    } else if (snapshotReady) {
        title = 'Desktop connected';
        detail = 'Web and webview stay in sync with the active Cursor conversation.';
    } else {
        title = 'Connected, waiting for snapshot';
        detail = 'The transport is ready. Cursor still needs to expose a live chat snapshot.';
    }

    const heroTitle = !document.body.classList.contains('home-screen') && activeChatTitle
        ? activeChatTitle
        : title;

    const transport = getTransportLabel();
    const protocolChip = isLoopbackHost
        ? 'Local webview'
        : window.location.protocol === 'https:'
            ? 'Secure web'
            : 'LAN web';

    setTextContent(heroStatusTitle, heroTitle);
    setTextContent(heroStatusDetail, detail);
    setTextContent(sidebarConnectionTitle, title);
    setTextContent(sidebarConnectionDetail, detail);
    setTextContent(heroModeText, mode);
    setTextContent(sidebarModeText, mode);
    setTextContent(heroModelText, model);
    setTextContent(sidebarModelText, model);
    setTextContent(heroModelDetail, running ? 'Generation in progress.' : `${transport} transport active.`);
    setTextContent(sidebarTransportText, running ? `${transport} / running` : transport);
    setTextContent(sidebarProtocolChip, protocolChip);

    if (document.body.classList.contains('home-screen')) {
        setTextContent(heroStatusTitle, 'New Chat');
        updateCursorShellStatus({ connected, running, snapshotReady });
    }
}

// --- Fullscreen Toggle ---
if (!document.fullscreenEnabled || typeof document.documentElement.requestFullscreen !== 'function') {
    fullscreenBtn.style.display = 'none';
} else {
    fullscreenBtn.addEventListener('click', () => {
        if (document.body.classList.contains('home-screen')) {
            messageInput.value = '';
            messageInput.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }

        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => { });
        } else {
            document.exitFullscreen().catch(() => { });
        }
    });
}

document.addEventListener('fullscreenchange', () => {
    const icon = document.getElementById('fullscreenIcon');
    if (document.fullscreenElement) {
        icon.innerHTML = '<path d="M4 14h3a2 2 0 0 1 2 2v3"></path><path d="M20 10h-3a2 2 0 0 1-2-2V5"></path><path d="M14 20v-3a2 2 0 0 1 2-2h3"></path><path d="M10 4v3a2 2 0 0 1-2 2H5"></path>';
        fullscreenBtn.setAttribute('data-tooltip', 'Exit Fullscreen');
    } else {
        icon.innerHTML = '<path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M21 8V5a2 2 0 0 0-2-2h-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path>';
        fullscreenBtn.setAttribute('data-tooltip', 'Fullscreen');
    }
});

// --- Theme management ---
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('crTheme', theme);
    setTextContent(sidebcrThemeChip, theme === 'light' ? 'Light theme' : 'Dark theme');
    // Update active state on options
    document.querySelectorAll('.settings-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.themeValue === theme);
    });
    updateWorkspaceChrome();
}
const modeBtn = document.getElementById('modeBtn');
const modelBtn = document.getElementById('modelBtn');
const modeMenu = document.getElementById('modeMenu');
const modelMenu = document.getElementById('modelMenu');
const modeDropdown = document.getElementById('modeDropdown');
const modelDropdown = document.getElementById('modelDropdown');
const dropdownBackdrop = document.getElementById('dropdownBackdrop');
const modeIcon = document.getElementById('modeIcon');
const modeText = document.getElementById('modeText');
const modelText = document.getElementById('modelText');
const historyLayer = document.getElementById('historyLayer');
const historyList = document.getElementById('historyList');

// --- State ---
let autoRefreshEnabled = true;
let userIsScrolling = false;
let userScrollLockUntil = 0; // Timestamp until which we respect user scroll
let lastScrollPosition = 0;
let ws = null;
let idleTimer = null;
let lastHash = '';
let currentMode = modeText.textContent || 'Agent';
let currentModel = modelText.textContent || 'Auto';
let chatIsOpen = true; // Track if a chat is currently open
let cachedCssKey = ''; // Cache CSS signature to avoid unnecessary re-injection
let lastRenderedHash = ''; // Track last rendered HTML hash to skip identical updates
let lastRenderedHtmlHash = ''; // Track content hash to avoid unnecessary DOM rebuilds
let pendingSnapshot = null; // Buffer for incoming WebSocket snapshots
let renderScheduled = false; // Prevent multiple rAF calls
let hasSnapshotLoaded = false;
let availableModes = [];
let availableModels = [];
let lastModelDropdownState = null;
let modelDropdownMutationPromise = null;
let activeChatTitle = '';
let lastChatTabs = [];
let historyChatsCache = [];
let historyActiveTitle = '';
let historySearchQuery = '';
let historyArchivedExpanded = false;
let restartCursorPending = false;
let selectChatRequestId = 0;
let appStateRequestInFlight = null;
let queuedForcedAppStateRefresh = null;
let queuedForcedAppStateRefreshPromise = null;
let appStateRequestId = 0;
let latestAppliedAppStateRequestId = 0;
let snapshotRequestInFlight = null;
let queuedSnapshotReloadRequested = false;
let queuedSnapshotReloadExpectedHash = '';

function setHasChatTabs(hasTabs) {
    document.body.classList.toggle('has-chat-tabs', !!hasTabs);
    updateComposerPlaceholder();
}

function renderHeaderChatTabs(tabs = [], activeTitle = '') {
    if (!headerChatTabs) {
        lastChatTabs = [];
        setHasChatTabs(false);
        return;
    }

    const normalizedTabs = normalizeSnapshotChatTabs(tabs, activeTitle);
    lastChatTabs = normalizedTabs.slice();
    const tabsHtml = buildSnapshotTabsHtml(normalizedTabs, activeTitle);
    headerChatTabs.innerHTML = tabsHtml;
    headerChatTabs.setAttribute('aria-hidden', tabsHtml ? 'false' : 'true');
    setHasChatTabs(!!tabsHtml);
}

function getChatTabsSignature(tabs = [], activeTitle = '') {
    return JSON.stringify({
        activeTitle: normalizeChatTitle(activeTitle),
        tabs: normalizeSnapshotChatTabs(tabs, activeTitle).map((tab) => ({
            title: normalizeChatTitle(tab.title),
            active: !!tab.active
        }))
    });
}

function queueSnapshotReload({ delays = [0], allowWhileScrolling = false } = {}) {
    const normalizedDelays = Array.isArray(delays) ? delays : [delays];
    normalizedDelays.forEach((delay) => {
        window.setTimeout(() => {
            if (document.visibilityState === 'hidden') return;
            if (!allowWhileScrolling && (userIsScrolling || !autoRefreshEnabled)) return;

            const shouldLoadSnapshot =
                chatIsOpen ||
                hasSnapshotLoaded ||
                lastChatTabs.length > 0 ||
                !!normalizeChatTitle(activeChatTitle);

            if (!shouldLoadSnapshot) return;
            loadSnapshot();
        }, Math.max(0, Number(delay) || 0));
    });
}

function setRestartCursorButtonState(isBusy) {
    if (!restartCursorCdpBtn) return;
    restartCursorPending = isBusy;
    restartCursorCdpBtn.disabled = isBusy;
    restartCursorCdpBtn.classList.toggle('is-busy', isBusy);

    const label = restartCursorCdpBtn.querySelector('.settings-option-label');
    if (label) {
        label.textContent = isBusy ? 'Restarting...' : DEFAULT_RESTART_CURSOR_LABEL;
    }
}

async function restartCursorWithCdp() {
    if (!restartCursorCdpBtn || restartCursorPending) return;

    setRestartCursorButtonState(true);
    settingsDropdown.classList.remove('open');
    statusDot.classList.remove('connected');
    statusDot.classList.add('disconnected');
    statusText.textContent = 'Restarting Cursor...';

    try {
        const res = await fetchWithAuth('/restart-cursor-cdp', { method: 'POST' });
        const data = await res.json().catch(() => ({}));

        if (!res.ok || data.success === false) {
            throw new Error(data.error || data.reason || 'Failed to restart Cursor with CDP');
        }

        setTimeout(fetchAppState, 1000);
        setTimeout(checkChatStatus, 2500);
        setTimeout(loadSnapshot, 4000);
        setTimeout(loadSnapshot, 8000);
    } catch (error) {
        console.error('Restart Cursor CDP error:', error);
        statusText.textContent = 'Restart failed';
        setTimeout(() => updateStatus(!!(ws && ws.readyState === WebSocket.OPEN)), 2000);
    } finally {
        setRestartCursorButtonState(false);
    }
}

function setActiveChatTitle(title) {
    const normalizedTitle = normalizeChatTitle(title);
    if (activeChatTitle === normalizedTitle) return;
    activeChatTitle = normalizedTitle;
    if (lastChatTabs.length && headerChatTabs) {
        renderHeaderChatTabs(lastChatTabs, normalizedTitle);
    }
    if (!document.body.classList.contains('home-screen')) {
        updateWorkspaceChrome();
    }
}

function updateActiveChatTitleFromHistory(chats, force = false) {
    const nextTitle = Array.isArray(chats) && chats.length > 0
        ? normalizeChatTitle(chats[0]?.title)
        : '';

    if (nextTitle && (!activeChatTitle || force)) {
        setActiveChatTitle(nextTitle);
    } else if (force) {
        setActiveChatTitle('');
    }
}

async function refreshActiveChatTitle(force = false) {
    try {
        const res = await fetchWithAuth('/chat-history');
        const data = await res.json();
        if (data?.activeTitle) {
            setActiveChatTitle(data.activeTitle);
            return;
        }
        updateActiveChatTitleFromHistory(data.chats, force);
    } catch (e) {
        if (force) {
            setActiveChatTitle('');
        }
    }
}

// Fast string hash (FNV-1a) to compare HTML content
function fastHash(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(36);
}


// --- Auth Utilities ---
async function fetchWithAuth(url, options = {}) {
    // Add ngrok skip warning header to all requests
    if (!options.headers) options.headers = {};
    options.headers['ngrok-skip-browser-warning'] = 'true';

    try {
        const res = await fetch(url, options);
        if (res.status === 401) {
            console.log('[AUTH] Unauthorized, redirecting to login...');
            window.location.href = '/login.html';
            return new Promise(() => { }); // Halt execution
        }
        return res;
    } catch (e) {
        throw e;
    }
}
const USER_SCROLL_LOCK_DURATION = 3000; // 3 seconds of scroll protection

// --- Sync State (Desktop is Always Priority) ---
function hasLiveCursorView(state = {}) {
    return !!(
        state?.hasChat ||
        state?.editorFound ||
        (Array.isArray(state?.chatTabs) && state.chatTabs.length) ||
        normalizeChatTitle(state?.activeChatTitle || '')
    );
}

async function refreshOpenDropdowns({ modeChanged = false, modelChanged = false } = {}) {
    const refreshTasks = [];

    if (modeChanged && modeMenu.classList.contains('show')) {
        refreshTasks.push((async () => {
            try {
                const data = await fetchDropdownOptions('mode');
                const normalized = normalizeModeDropdownState(data);
                availableModes = normalized.items.map((item) => item.label);
                if (data.current && data.current !== 'Unknown') {
                    setCurrentModeValue(data.current);
                    normalized.current = getModeDisplayLabel(data.current);
                }
                buildModeDropdownMenu(modeMenu, normalized);
            } catch (error) {
                console.error('[SYNC] Failed to refresh mode dropdown', error);
            }
        })());
    }

    if (modelChanged && modelMenu.classList.contains('show') && !modelDropdownMutationPromise) {
        refreshTasks.push((async () => {
            try {
                await syncModelDropdownState({ rebuildMenu: true, delays: [0] });
            } catch (error) {
                console.error('[SYNC] Failed to refresh model dropdown', error);
            }
        })());
    }

    if (refreshTasks.length) {
        await Promise.allSettled(refreshTasks);
    }
}

function applyDesktopState(data = {}, { syncOpenDropdowns = true, loadSnapshotWhenMissing = true } = {}) {
    if (!data || typeof data !== 'object') return { modeChanged: false, modelChanged: false };

    const previousActiveChatTitle = normalizeChatTitle(activeChatTitle);
    const previousChatTabsSignature = getChatTabsSignature(lastChatTabs, previousActiveChatTitle);
    const nextMode = data.mode && data.mode !== 'Unknown'
        ? getModeDisplayLabel(data.mode)
        : currentMode;
    const nextModel = data.model && data.model !== 'Unknown'
        ? String(data.model).trim()
        : currentModel;
    const previousMode = currentMode;
    const previousModel = currentModel;
    const modeChanged = !!nextMode && nextMode !== previousMode;
    const modelChanged = !!nextModel && nextModel !== previousModel;
    const liveCursorView = hasLiveCursorView(data);
    const shouldShowHomeScreen =
        data.hasChat === false &&
        data.editorFound === false &&
        !liveCursorView;

    if (data.mode && data.mode !== 'Unknown') {
        setCurrentModeValue(data.mode);
    }

    if (nextModel) {
        currentModel = nextModel;
        modelText.textContent = nextModel;
        if (lastModelDropdownState) {
            lastModelDropdownState.current = nextModel;
            lastModelDropdownState.toggles = (lastModelDropdownState.toggles || []).map((toggle) =>
                toggle.key === 'auto'
                    ? { ...toggle, enabled: /^auto$/i.test(nextModel) }
                    : toggle
            );
        }
    }

    if (typeof data.activeChatTitle === 'string') {
        setActiveChatTitle(data.activeChatTitle);
    }

    if (Array.isArray(data.chatTabs)) {
        renderHeaderChatTabs(data.chatTabs, typeof data.activeChatTitle === 'string' ? data.activeChatTitle : activeChatTitle);
    }

    document.body.classList.toggle('agent-running', !!data.isRunning);
    chatIsOpen = !!(data.hasChat || data.editorFound || liveCursorView);

    if (shouldShowHomeScreen) {
        showEmptyState();
    } else if (chatIsOpen) {
        setHomeScreen(false);
        if (!hasSnapshotLoaded && loadSnapshotWhenMissing) {
            setTimeout(loadSnapshot, 0);
        }
    }

    updateWorkspaceChrome({
        mode: nextMode || modeText.textContent,
        model: nextModel || modelText.textContent,
        running: !!data.isRunning
    });

    if (syncOpenDropdowns && (modeChanged || modelChanged)) {
        refreshOpenDropdowns({ modeChanged, modelChanged });
    }

    const nextActiveChatTitle = normalizeChatTitle(activeChatTitle);
    const nextChatTabsSignature = getChatTabsSignature(lastChatTabs, nextActiveChatTitle);
    const chatViewChanged =
        hasSnapshotLoaded &&
        liveCursorView &&
        (
            previousActiveChatTitle !== nextActiveChatTitle ||
            previousChatTabsSignature !== nextChatTabsSignature
        );

    if (chatViewChanged) {
        queueSnapshotReload({
            delays: SNAPSHOT_STATE_CHANGE_RELOAD_DELAYS,
            allowWhileScrolling: true
        });
    }

    return { modeChanged, modelChanged };
}

async function fetchAppState({ force = false, applyOptions = {} } = {}) {
    if (appStateRequestInFlight) {
        if (!force) {
            return appStateRequestInFlight;
        }

        queuedForcedAppStateRefresh = {
            force: true,
            applyOptions: {
                ...(queuedForcedAppStateRefresh?.applyOptions || {}),
                ...applyOptions
            }
        };

        if (!queuedForcedAppStateRefreshPromise) {
            queuedForcedAppStateRefreshPromise = appStateRequestInFlight.finally(() => {
                const nextRefresh = queuedForcedAppStateRefresh;
                queuedForcedAppStateRefresh = null;
                queuedForcedAppStateRefreshPromise = null;
                return nextRefresh ? fetchAppState(nextRefresh) : null;
            });
        }

        return queuedForcedAppStateRefreshPromise;
    }

    const requestId = ++appStateRequestId;
    const request = (async () => {
        try {
            const res = await fetchWithAuth('/app-state');
            const data = await res.json();

            if (requestId >= latestAppliedAppStateRequestId) {
                latestAppliedAppStateRequestId = requestId;
                applyDesktopState(data, applyOptions);
            }

            console.log('[SYNC] State refreshed from Desktop:', data);
            return data;
        } catch (e) {
            console.error('[SYNC] Failed to sync state', e);
            return null;
        } finally {
            if (appStateRequestInFlight === request) {
                appStateRequestInFlight = null;
            }
        }
    })();

    appStateRequestInFlight = request;
    return request;
}

// --- SSL Banner ---
const sslBanner = document.getElementById('sslBanner');

async function checkSslStatus() {
    // Only show banner if currently on HTTP
    if (window.location.protocol === 'https:' || isLoopbackHost) return;

    // Check if user dismissed the banner before
    if (localStorage.getItem('sslBannerDismissed')) return;

    sslBanner.style.display = 'flex';
}

async function enableHttps() {
    const btn = document.getElementById('enableHttpsBtn');
    btn.textContent = 'Generating...';
    btn.disabled = true;

    try {
        const res = await fetchWithAuth('/generate-ssl', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            sslBanner.innerHTML = `
                <span>âœ… ${data.message}</span>
                <button onclick="location.reload()">Reload After Restart</button>
            `;
            sslBanner.style.background = 'linear-gradient(90deg, #22c55e, #16a34a)';
            const bannerMessage = sslBanner.querySelector('span');
            if (bannerMessage) bannerMessage.textContent = data.message;
        } else {
            btn.textContent = 'Failed - Retry';
            btn.disabled = false;
        }
    } catch (e) {
        btn.textContent = 'Error - Retry';
        btn.disabled = false;
    }
}

function dismissSslBanner() {
    sslBanner.style.display = 'none';
    localStorage.setItem('sslBannerDismissed', 'true');
}

// Check SSL on load
checkSslStatus();
// --- Dropdown fallbacks ---
const MODE_FALLBACK_OPTIONS = [
    { label: 'Agent', requestValue: 'Agent', icon: 'agent' },
    { label: 'Plan', requestValue: 'Plan', icon: 'plan' },
    { label: 'Debug', requestValue: 'Debug', icon: 'debug' },
    { label: 'Ask', requestValue: 'Ask', icon: 'ask' }
];
const MODE_DISPLAY_ALIASES = {
    agent: 'Agent',
    fast: 'Agent',
    plan: 'Plan',
    planning: 'Plan',
    debug: 'Debug',
    manual: 'Debug',
    ask: 'Ask'
};
const MODEL_FALLBACK_OPTIONS = [
    { name: 'Composer 1.5', icon: 'cloud' },
    { name: 'GPT-5.4', icon: 'cloud' },
    { name: 'GPT-5.3 Codex', icon: 'cloud' },
    { name: 'Sonnet 4.6', icon: 'cloud' },
    { name: 'Opus 4.6', icon: 'cloud' },
    { name: 'Gemini 3 Flash', icon: 'cloud' },
    { name: 'gpt-4', icon: '' }
];
const MODEL_FALLBACK_TOGGLES = [
    { key: 'auto', label: 'Auto', description: 'Balanced quality and speed, recommended for most tasks', enabled: false },
    { key: 'max-mode', label: 'MAX Mode', description: '', enabled: false },
    { key: 'multi-model', label: 'Use Multiple Models', description: '', enabled: false }
];

function getModeDisplayLabel(value = '') {
    const normalized = String(value || '').trim();
    if (!normalized) return 'Agent';
    return MODE_DISPLAY_ALIASES[normalized.toLowerCase()] || normalized;
}

function getModeIconName(value = '') {
    const label = getModeDisplayLabel(value);
    return MODE_FALLBACK_OPTIONS.find((option) => option.label === label)?.icon || 'agent';
}

function getModeIconSvg(iconName) {
    const common = 'width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"';
    switch (iconName) {
        case 'plan':
            return `<svg ${common}><circle cx="3" cy="4" r="1"></circle><circle cx="3" cy="8" r="1"></circle><circle cx="3" cy="12" r="1"></circle><path d="M6 4h7"></path><path d="M6 8h7"></path><path d="M6 12h7"></path></svg>`;
        case 'debug':
            return `<svg ${common}><circle cx="8" cy="8" r="2.2"></circle><path d="M8 2.4v1.5"></path><path d="M8 12.1v1.5"></path><path d="m3.9 3.9 1.1 1.1"></path><path d="m11 11 1.1 1.1"></path><path d="M2.4 8h1.5"></path><path d="M12.1 8h1.5"></path><path d="m3.9 12.1 1.1-1.1"></path><path d="m11 5 1.1-1.1"></path></svg>`;
        case 'ask':
            return `<svg ${common}><path d="M3.5 4.1a1.9 1.9 0 0 1 1.9-1.9h5.2a1.9 1.9 0 0 1 1.9 1.9v3.5a1.9 1.9 0 0 1-1.9 1.9H7.2l-2.6 2V9.5H5.4a1.9 1.9 0 0 1-1.9-1.9Z"></path></svg>`;
        case 'agent':
        default:
            return `<svg ${common}><path d="M3.1 9c0-1.7 1.1-3 2.5-3s2.5 1.3 2.5 3-1.1 3-2.5 3-2.5-1.3-2.5-3Z"></path><path d="M7.9 9c0-1.7 1.1-3 2.5-3s2.5 1.3 2.5 3-1.1 3-2.5 3-2.5-1.3-2.5-3Z"></path></svg>`;
    }
}

function setCurrentModeValue(value) {
    const displayValue = getModeDisplayLabel(value);
    currentMode = displayValue;
    if (modeIcon) {
        modeIcon.innerHTML = getModeIconSvg(getModeIconName(displayValue));
    }
    modeText.textContent = displayValue;
    modeBtn.dataset.mode = displayValue.toLowerCase();
    if (displayValue.toLowerCase() === 'debug') {
        modeBtn.style.backgroundColor = 'rgba(197, 74, 66, 0.2)';
        modeBtn.style.color = '#ff6e64';
    } else {
        modeBtn.style.backgroundColor = '';
        modeBtn.style.color = '';
    }
    updateComposerPlaceholder();
    return displayValue;
}

setCurrentModeValue(currentMode);
applyTheme(localStorage.getItem('crTheme') || 'dark');
updateComposerActionState();
