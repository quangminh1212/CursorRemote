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

function setTextContent(element, value) {
    if (element) element.textContent = value;
}

function normalizeChatTitle(title) {
    return typeof title === 'string' ? title.trim() : '';
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
    return a === b || a.includes(b) || b.includes(a);
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
        if (chatTitlesMatch(title, activeTitle)) score += 120;
        if (title.toLowerCase() === activeTitle.toLowerCase()) score += 120;
    }
    return score;
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
        return exactDeduped;
    }

    const activeLikeIndexes = exactDeduped
        .map((tab, index) => (chatTitlesMatch(tab.title, resolvedActiveTitle) ? index : -1))
        .filter((index) => index >= 0);

    if (activeLikeIndexes.length <= 1) {
        return exactDeduped;
    }

    const keepIndex = activeLikeIndexes.reduce((bestIndex, currentIndex) =>
        getSnapshotTabScore(exactDeduped[currentIndex], resolvedActiveTitle) > getSnapshotTabScore(exactDeduped[bestIndex], resolvedActiveTitle)
            ? currentIndex
            : bestIndex
    );

    return exactDeduped.filter((tab, index) => !activeLikeIndexes.includes(index) || index === keepIndex);
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
let activeChatTitle = '';
let lastChatTabs = [];
let restartCursorPending = false;
let selectChatRequestId = 0;
let appStateRequestInFlight = null;
let appStateRequestId = 0;
let latestAppliedAppStateRequestId = 0;

function setHasChatTabs(hasTabs) {
    document.body.classList.toggle('has-chat-tabs', !!hasTabs);
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

    if (modelChanged && modelMenu.classList.contains('show')) {
        refreshTasks.push((async () => {
            try {
                const data = await fetchDropdownOptions('model');
                const hasStructuredModelMenu = !data.error && (
                    !!data.searchPlaceholder ||
                    !!data.footerLabel ||
                    (Array.isArray(data.toggles) && data.toggles.length >= 2) ||
                    (Array.isArray(data.options) && data.options.length >= 3)
                );
                const normalized = normalizeModelDropdownState(
                    hasStructuredModelMenu
                        ? data
                        : getModelDropdownFallbackState({
                            current: currentModel && currentModel !== 'Unknown' ? currentModel : modelText.textContent
                        })
                );

                availableModels = normalized.options;
                lastModelDropdownState = normalized;
                buildModelDropdownMenu(modelMenu, normalized);
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

    return { modeChanged, modelChanged };
}

async function fetchAppState({ force = false, applyOptions = {} } = {}) {
    if (appStateRequestInFlight && !force) {
        return appStateRequestInFlight;
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
    return displayValue;
}

setCurrentModeValue(currentMode);
applyTheme(localStorage.getItem('crTheme') || 'dark');

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

    return {
        current: fallbackCurrent,
        options: MODEL_FALLBACK_OPTIONS.map(item => item.name),
        toggles: MODEL_FALLBACK_TOGGLES.map(toggle => ({
            ...toggle,
            enabled: toggle.key === 'auto' ? fallbackAutoEnabled : toggle.enabled
        })),
        searchPlaceholder: 'Search models',
        footerLabel: 'Add Models'
    };
}

function getModelOptionValue(option) {
    if (!option) return '';
    if (typeof option === 'string') return option.trim();
    return String(option.value || option.name || '').trim();
}

function getModelOptionIcon(option) {
    if (option && typeof option === 'object' && 'icon' in option) {
        return String(option.icon || '').trim();
    }

    const value = getModelOptionValue(option).toLowerCase();
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
    if (iconName !== 'cloud') return '';
    return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 12.4h5.4a2.4 2.4 0 0 0 .2-4.8 3.3 3.3 0 0 0-6.4-.8 2.2 2.2 0 0 0 .8 5.6Z"></path></svg>`;
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
    messageInput.placeholder = enabled ? HOME_COMPOSER_PLACEHOLDER : DEFAULT_COMPOSER_PLACEHOLDER;
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
        if (data.type === 'snapshot_update' && autoRefreshEnabled && !userIsScrolling) {
            if (data.hash && data.hash === lastRenderedHash) return; // Skip identical
            lastRenderedHash = data.hash || '';
            loadSnapshot();
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
    font-family: 'Inter', system-ui, sans-serif !important;
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
    max-width: min(800px, 100%) !important;
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
    top: 6px !important;
    z-index: 25 !important;
    margin-left: 0 !important;
    max-width: none !important;
    padding: 0 8px 8px !important;
}

${snapshotRootScope} [data-message-role="human"][style*="position: sticky"] .composer-human-message-container {
    justify-content: flex-start !important;
}

${snapshotRootScope} [data-message-role="human"][style*="position: sticky"] .composer-human-message,
${snapshotRootScope} [data-message-role="human"][style*="position: sticky"] .human-message-with-todos-wrapper {
    width: 100% !important;
    background: #33353a !important;
    border: 1px solid rgba(255, 255, 255, 0.04) !important;
    border-radius: 8px !important;
    box-shadow: none !important;
}

${snapshotRootScope} .ui-step-group-header,
${snapshotRootScope} .ui-collapsible-header {
    display: inline-flex !important;
    align-items: center !important;
    gap: 4px !important;
    font-size: 13px !important;
    line-height: 1.4 !important;
    letter-spacing: -0.01em !important;
}

${snapshotRootScope} .ui-collapsible-header span:first-child {
    color: rgba(255, 255, 255, 0.72) !important;
}

${snapshotRootScope} .ui-collapsible-header span:last-of-type,
${snapshotRootScope} .ui-collapsible-chevron,
${snapshotRootScope} .cursor-icon {
    color: rgba(255, 255, 255, 0.48) !important;
    opacity: 0.7 !important;
}

${snapshotRootScope} [data-message-kind="assistant"] .markdown-root,
${snapshotRootScope} [data-message-kind="assistant"] .markdown-root p,
${snapshotRootScope} [data-message-kind="tool"] .markdown-root,
${snapshotRootScope} [data-message-kind="tool"] .markdown-root p {
    font-size: 15px !important;
    line-height: 1.65 !important;
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
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    border-radius: 10px !important;
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
    font-size: 13px !important;
    line-height: 1.45 !important;
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
    font-size: 14px !important;
    line-height: 1.55 !important;
}

${snapshotRootScope} .composer-human-ai-pair-container {
    gap: 12px !important;
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
    padding-left: 8px !important;
    padding-right: 8px !important;
}`;
        styleTag.textContent = darkModeOverrides;
    }

    // --- HTML UPDATE (skip if unchanged to prevent text jittering) ---
    const renderedHtml = data.html;
    const htmlHash = fastHash(renderedHtml);
    if (htmlHash !== lastRenderedHtmlHash) {
        lastRenderedHtmlHash = htmlHash;
        chatContent.innerHTML = renderedHtml;

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
async function loadSnapshot() {
    try {
        // Add spin animation to refresh button
        const icon = refreshBtn.querySelector('svg');
        icon.classList.remove('spin-anim');
        void icon.offsetWidth; // trigger reflow
        icon.classList.add('spin-anim');

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

    } catch (err) {
        console.error(err);
    }
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

// --- Inputs ---
async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message) return;

    // Optimistic UI updates
    const previousValue = messageInput.value;
    messageInput.value = ''; // Clear immediately
    messageInput.style.height = 'auto'; // Reset height
    messageInput.blur(); // Close keyboard on mobile immediately
    syncShellPromptFromComposer('');

    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.5';

    try {
        // If no chat is open, start a new one first
        if (!chatIsOpen) {
            const newChatRes = await fetchWithAuth('/new-chat', { method: 'POST' });
            const newChatData = await newChatRes.json();
            if (newChatData.success) {
                // Wait for the new chat to be ready
                await new Promise(r => setTimeout(r, 800));
                chatIsOpen = true;
            }
        }

        const res = await fetchWithAuth('/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });

        // Always reload snapshot to check if message appeared
        setTimeout(loadSnapshot, 300);
        setTimeout(loadSnapshot, 800);
        setTimeout(checkChatStatus, 1000);

        // Don't revert the input - if user sees the message in chat, it was sent
        // Only log errors for debugging, don't show alert popups
        if (!res.ok) {
            console.warn('Send response not ok, but message may have been sent:', await res.json().catch(() => ({})));
        }
    } catch (e) {
        // Network error - still try to refresh in case it went through
        console.error('Send error:', e);
        setTimeout(loadSnapshot, 500);
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

    // Reload snapshot to see the attached file in chat
    setTimeout(loadSnapshot, 1000);
    setTimeout(loadSnapshot, 2500);
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
            }, 300);
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
    setTimeout(fetchAppState, 1000);
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
            // Reload snapshot to show new empty chat
            setTimeout(loadSnapshot, 500);
            setTimeout(loadSnapshot, 1000);
            setTimeout(checkChatStatus, 1500);
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
async function showChatHistory() {
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
            setTimeout(loadSnapshot, 300);
            setTimeout(fetchAppState, 600);
            setTimeout(loadSnapshot, 800);
            setTimeout(checkChatStatus, 1000);
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
    const fallback = getModelDropdownFallbackState(data);
    const current = data.current && data.current !== 'Unknown' ? data.current : fallback.current;
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

    setDropdownLoading(modeMenu, 'Mode');
    toggleDropdown(modeMenu, modeBtn);

    try {
        const data = await fetchDropdownOptions('mode');
        const normalized = normalizeModeDropdownState(data);
        availableModes = normalized.items.map((item) => item.label);
        if (data.current && data.current !== 'Unknown') {
            setCurrentModeValue(data.current);
            normalized.current = getModeDisplayLabel(data.current);
        }
        buildModeDropdownMenu(modeMenu, normalized);
    } catch (e) {
        const normalized = normalizeModeDropdownState({ current: currentMode });
        availableModes = normalized.items.map((item) => item.label);
        buildModeDropdownMenu(modeMenu, normalized);
    }
}

async function openModelDropdown() {
    const isOpen = modelMenu.classList.contains('show');
    if (isOpen) {
        closeAllDropdowns();
        return;
    }

    setDropdownLoading(modelMenu, 'Model');
    toggleDropdown(modelMenu, modelBtn);

    try {
        const data = await fetchDropdownOptions('model');
        const hasStructuredModelMenu = !data.error && (
            !!data.searchPlaceholder ||
            !!data.footerLabel ||
            (Array.isArray(data.toggles) && data.toggles.length >= 2) ||
            (Array.isArray(data.options) && data.options.length >= 3)
        );
        const fallbackState = getModelDropdownFallbackState({
            current: currentModel && currentModel !== 'Unknown' ? currentModel : modelText.textContent
        });
        const normalized = normalizeModelDropdownState(
            hasStructuredModelMenu
                ? data
                : fallbackState
        );

        availableModels = normalized.options;
        lastModelDropdownState = normalized;

        if (hasStructuredModelMenu && normalized.current && normalized.current !== 'Unknown') {
            currentModel = normalized.current;
            modelText.textContent = normalized.current;
        }

        buildModelDropdownMenu(modelMenu, normalized);
    } catch (e) {
        const normalized = normalizeModelDropdownState(getModelDropdownFallbackState({
            current: currentModel && currentModel !== 'Unknown' ? currentModel : modelText.textContent
        }));
        availableModels = normalized.options;
        lastModelDropdownState = normalized;
        buildModelDropdownMenu(modelMenu, normalized);
    }
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
            return true;
        }

        alert('Error: ' + (data.error || 'Unknown'));
    } catch (e) {
        console.error('Model selection failed:', e);
    }

    modelText.textContent = currentModel || prev;
    return false;
}

async function applyModelToggle(toggleKey, enabled) {
    if (!toggleKey) return false;

    try {
        const res = await fetchWithAuth('/set-model-toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: toggleKey, enabled })
        });
        const data = await res.json();
        if (data.success) {
            const normalized = normalizeModelDropdownState({
                current: data.currentModel || currentModel,
                options: lastModelDropdownState?.options || MODEL_FALLBACK_OPTIONS.map(item => item.name),
                toggles: Array.isArray(data.toggles) && data.toggles.length ? data.toggles : lastModelDropdownState?.toggles,
                footerLabel: lastModelDropdownState?.footerLabel || ''
            });
            currentModel = normalized.current || currentModel;
            modelText.textContent = currentModel;
            updateWorkspaceChrome({ model: currentModel });
            availableModels = normalized.options;
            lastModelDropdownState = normalized;
            buildModelDropdownMenu(modelMenu, normalized);
            return true;
        }
    } catch (e) {
        console.error('Model toggle failed:', e);
    }

    return false;
}

modelMenu.addEventListener('click', async (e) => {
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
chatContainer.addEventListener('click', async (e) => {
    // Strategy: Check if the clicked element OR its parent contains "Thought" or "Thinking" text.
    // This handles both opening (collapsed) and closing (expanded) states.

    // 1. Find the nearest container that might be the "Thought" block
    const target = e.target.closest('div, span, p, summary, button, details');
    if (!target) return;

    const text = target.innerText || '';

    // Check if this looks like a thought toggle (matches "Thought for Xs" or "Thinking" patterns)
    // Also match the header of expanded thoughts which may have more content
    const isThoughtToggle = /Thought|Thinking/i.test(text) && text.length < 500;

    if (isThoughtToggle) {
        // Visual feedback - briefly dim the clicked element
        target.style.opacity = '0.5';
        setTimeout(() => target.style.opacity = '1', 300);

        // Extract just the first line for matching (e.g., "Thought for 3s")
        const firstLine = text.split('\n')[0].trim();

        // Determine which occurrence of this text the user tapped
        // This handles multiple Thought blocks with identical labels
        const allElements = chatContainer.querySelectorAll(target.tagName.toLowerCase());
        let tapIndex = 0;
        for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i];
            const elText = el.innerText || '';
            const elFirstLine = elText.split('\n')[0].trim();

            // Only count if it looks like a thought toggle and matches the first line exactly
            if (/Thought|Thinking/i.test(elText) && elText.length < 500 && elFirstLine === firstLine) {
                // If this is our target (or contains it), we've found the correct index
                if (el === target || el.contains(target)) {
                    break;
                }
                tapIndex++;
            }
        }

        try {
            const response = await fetchWithAuth('/remote-click', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    selector: target.tagName.toLowerCase(),
                    index: tapIndex,
                    textContent: firstLine  // Use first line for more reliable matching
                })
            });

            // Reload snapshot multiple times to catch the UI change
            // Desktop animation takes time, so we poll a few times
            setTimeout(loadSnapshot, 400);   // Quick check
            setTimeout(loadSnapshot, 800);   // After animation starts
            setTimeout(loadSnapshot, 1500);  // After animation completes
        } catch (e) {
            console.error('Remote click failed:', e);
        }
        return;
    }

    // --- Command Action Buttons (Run / Reject) ---
    const btn = e.target.closest('button');
    if (btn) {
        const btnText = (btn.innerText || '').trim();
        // Match "Run", "Run Alt+âŽ", "Reject"
        const isRun = /^Run/i.test(btnText);
        const isReject = /^Reject$/i.test(btnText);

        if (isRun || isReject) {
            btn.style.opacity = '0.5';
            setTimeout(() => btn.style.opacity = '1', 300);

            // Determine which occurrence of this button text the user tapped
            const label = isRun ? 'Run' : 'Reject';
            const allButtons = Array.from(chatContainer.querySelectorAll('button'));

            // Filter to only those that match our specific label (to handle multiple commands)
            const matchingButtons = allButtons.filter(b => (b.innerText || '').includes(label));
            const btnIndex = matchingButtons.indexOf(btn);

            try {
                await fetchWithAuth('/remote-click', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        selector: 'button',
                        index: btnIndex >= 0 ? btnIndex : 0,
                        textContent: label
                    })
                });
                setTimeout(loadSnapshot, 500);
                setTimeout(loadSnapshot, 1500);
                setTimeout(loadSnapshot, 3000);
            } catch (err) {
                console.error('Remote command click failed:', err);
            }
        }
    }
});

// --- Init ---
updateWorkspaceChrome();
connectWebSocket();
// Sync state initially and every 5 seconds to keep phone in sync with desktop changes
fetchAppState();
setInterval(fetchAppState, 5000);

// Check chat status initially and periodically
checkChatStatus();
setInterval(checkChatStatus, 10000); // Check every 10 seconds

// --- QR Code Modal ---
const qrBtn = document.getElementById('qrBtn');
const qrOverlay = document.getElementById('qrOverlay');
const qrCloseBtn = document.getElementById('qrCloseBtn');
const qrImage = document.getElementById('qrImage');
const qrUrl = document.getElementById('qrUrl');
const qrLoading = document.getElementById('qrLoading');

if (qrBtn) {
    qrBtn.addEventListener('click', async () => {
        qrOverlay.classList.add('open');
        qrImage.style.display = 'none';
        qrUrl.textContent = '';
        qrLoading.style.display = 'flex';

        try {
            const res = await fetchWithAuth('/qr-info');
            const data = await res.json();

            qrImage.src = data.qrDataUrl;
            qrImage.style.display = 'block';
            qrUrl.textContent = data.connectUrl;
            qrLoading.style.display = 'none';
        } catch (e) {
            qrLoading.innerHTML = '<p style="color: var(--error)">Failed to generate QR code</p>';
            console.error('[QR] Error:', e);
        }
    });
}

if (qrCloseBtn) {
    qrCloseBtn.addEventListener('click', () => {
        qrOverlay.classList.remove('open');
    });
}

if (qrOverlay) {
    qrOverlay.addEventListener('click', (e) => {
        if (e.target === qrOverlay) qrOverlay.classList.remove('open');
    });
}

// Copy URL on click
if (qrUrl) {
    qrUrl.addEventListener('click', async () => {
        const url = qrUrl.textContent;
        if (url) {
            const ok = await copyToClipboard(url);
            if (ok) {
                const orig = qrUrl.textContent;
                qrUrl.textContent = 'âœ“ Copied!';
                setTimeout(() => { qrUrl.textContent = orig; }, 1500);
            }
        }
    });
}
