import crypto from 'crypto';
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

// Secure hash function using HMAC-SHA256
function hashString(str, salt = 'cr_default') {
    return crypto.createHmac('sha256', salt).update(str).digest('hex');
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

    // Strip IPv6-mapped IPv4 prefix for unified checking
    const plainIp = ip.replace(/^::ffff:/, '');

    // Loopback
    if (plainIp === '127.0.0.1' || ip === '::1') return true;

    // RFC 1918 private ranges
    const parts = plainIp.split('.');
    if (parts.length === 4) {
        const [a, b] = parts.map(Number);
        // 10.0.0.0/8
        if (a === 10) return true;
        // 192.168.0.0/16
        if (a === 192 && b === 168) return true;
        // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
        if (a === 172 && b >= 16 && b <= 31) return true;
    }

    return false;
}

export { getAppState, hashString, normalizeUiStateText, escapeRegExp, isPlausibleUiMode, isPlausibleUiModel, isLocalRequest };
