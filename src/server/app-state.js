import { evaluateCursor } from './cdp-eval.js';
import { summarizeLogText, summarizeAppStateForLog } from './logger.js';
import { getDropdownOptions } from './actions/mode-model.js';

// Get App State (Mode & Model)
async function getAppState(cdp, { lastAppState = null } = {}) {
    const result = await evaluateCursor(cdp, `
        const chatTabs = __cr.getChatTabs();
        return {
            mode: __cr.getModeText() || 'Unknown',
            model: __cr.getModelText() || 'Unknown',
            isRunning: __cr.isBusy(),
            composerStatus: __cr.getComposerStatus() || 'idle',
            hasChat: !!__cr.findPanel(),
            hasMessages: __cr.collectMessageNodes().length > 0,
            editorFound: !!__cr.findEditor(),
            activeChatTitle: __cr.getActiveChatTitle() || '',
            chatTabs
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });

    const modeAliasMap = {
        agent: 'Agent',
        fast: 'Agent',
        plan: 'Plan',
        planning: 'Plan',
        debug: 'Debug',
        manual: 'Debug',
        ask: 'Ask'
    };

    if (result?.mode) {
        const normalizedMode = normalizeUiStateText(result.mode).toLowerCase();
        result.mode = modeAliasMap[normalizedMode] || normalizeUiStateText(result.mode);
        if (!isPlausibleUiMode(result.mode)) {
            result.mode = 'Unknown';
        }
    }

    if (result?.model) {
        result.model = normalizeUiStateText(result.model);
        if (!isPlausibleUiModel(result.model)) {
            result.model = 'Unknown';
        }
    }

    if (result && lastAppState && typeof lastAppState === 'object') {
        if ((!result.mode || result.mode === 'Unknown') && lastAppState.mode && lastAppState.mode !== 'Unknown') {
            result.mode = lastAppState.mode;
        }
        if ((!result.model || result.model === 'Unknown') && lastAppState.model && lastAppState.model !== 'Unknown') {
            result.model = lastAppState.model;
        }
        if (!result.activeChatTitle && lastAppState.activeChatTitle) {
            result.activeChatTitle = lastAppState.activeChatTitle;
        }
        if ((!Array.isArray(result.chatTabs) || !result.chatTabs.length) && Array.isArray(lastAppState.chatTabs) && lastAppState.chatTabs.length) {
            result.chatTabs = lastAppState.chatTabs;
        }
    }

    if ((result?.mode === 'Unknown' || result?.model === 'Unknown') && cdp) {
        try {
            const fallbackUsage = { mode: false, model: false };
            if (result.mode === 'Unknown') {
                const modeState = await getDropdownOptions(cdp, 'mode');
                if (modeState?.current && modeState.current !== 'Unknown') {
                    result.mode = modeState.current;
                    fallbackUsage.mode = true;
                }
            }

            if (result.model === 'Unknown') {
                const modelState = await getDropdownOptions(cdp, 'model');
                if (modelState?.current && modelState.current !== 'Unknown') {
                    result.model = modelState.current;
                    fallbackUsage.model = true;
                }
            }

            if (fallbackUsage.mode || fallbackUsage.model) {
                console.log('[APP_STATE] Resolved unknown values via dropdown fallback', {
                    fallbackUsage,
                    state: summarizeAppStateForLog(result)
                });
            }
        } catch (error) {
            // Keep best-effort state; fallbacks above already applied where possible.
            console.warn('[APP_STATE] Dropdown fallback failed', {
                message: error?.message || String(error),
                state: summarizeAppStateForLog(result)
            });
        }
    }

    return result;
}

// Simple hash function
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

function normalizeUiStateText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
    return String(value || '').replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function isPlausibleUiMode(value) {
    const text = normalizeUiStateText(value);
    return !!text && text.length <= 24 && /^(agent|plan|debug|ask|fast|planning|manual)\b/i.test(text);
}

function isPlausibleUiModel(value) {
    const text = normalizeUiStateText(value);
    if (!text || text.length > 48) return false;
    if (/[{};]/.test(text) || /\.monaco-|cursorremote|upgrade to pro|launchpad|ctrl\+|https?:|\.png\b/i.test(text)) return false;
    return /^(auto|composer\s+\d+(?:\.\d+)*|gpt-\d+(?:\.\d+)*(?:\s+codex)?|sonnet\s+\d+(?:\.\d+)*|opus\s+\d+(?:\.\d+)*|gemini\s+\d+(?:\s+flash)?|claude(?:\s+[\w.-]+)?|o\d(?:\s+[\w.-]+)?)$/i.test(text);
}

// Check if a request is from the same Wi-Fi (internal network)
function isLocalRequest(req) {
    // 1. Check for proxy headers (Cloudflare, ngrok, etc.)
    // If these exist, the request is coming via an external tunnel/proxy
    if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-real-ip']) {
        return false;
    }

    // 2. Check the remote IP address
    const ip = req.ip || req.socket.remoteAddress || '';

    // Standard local/private IPv4 and IPv6 ranges
    return ip === '127.0.0.1' ||
        ip === '::1' ||
        ip === '::ffff:127.0.0.1' ||
        ip.startsWith('192.168.') ||
        ip.startsWith('10.') ||
        ip.startsWith('172.16.') || ip.startsWith('172.17.') ||
        ip.startsWith('172.18.') || ip.startsWith('172.19.') ||
        ip.startsWith('172.2') || ip.startsWith('172.3') ||
        ip.startsWith('::ffff:192.168.') ||
        ip.startsWith('::ffff:10.');
}

export { getAppState, hashString, normalizeUiStateText, escapeRegExp, isPlausibleUiMode, isPlausibleUiModel, isLocalRequest };
