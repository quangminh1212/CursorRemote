#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execFileSync, execSync, spawn } from 'child_process';
import { createServer } from './src/server/http/create-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUNTIME_ROOT = process.env.CR_RUNTIME_DIR || __dirname;
const IS_EMBEDDED_RUNTIME = process.env.TAURI_EMBEDDED === '1';

try {
    fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
} catch (e) {
    console.error('Failed to initialize runtime directory:', e.message);
    process.exit(1);
}

// ============================================================
// FILE LOGGING SYSTEM - All output goes to log.txt for debugging
// ============================================================
const LOG_FILE = join(RUNTIME_ROOT, 'log.txt');
const LOG_BACKUP_FILE = join(RUNTIME_ROOT, 'log.old.txt');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB auto-rotate
const RESET_LOG_ON_START = process.env.CR_RESET_LOG_ON_START === '1';

if (RESET_LOG_ON_START) {
    try {
        if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);
        if (fs.existsSync(LOG_BACKUP_FILE)) fs.unlinkSync(LOG_BACKUP_FILE);
    } catch (e) {
        // Ignore reset failures and continue logging to the existing file.
    }
}

// Rotate log if too large
try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_SIZE) {
        if (fs.existsSync(LOG_BACKUP_FILE)) fs.unlinkSync(LOG_BACKUP_FILE);
        fs.renameSync(LOG_FILE, LOG_BACKUP_FILE);
    }
} catch (e) { /* ignore rotation errors */ }

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf8' });
const TERMINAL_LOG_ENABLED = process.env.CR_TERMINAL_LOG !== '0';
let terminalConsoleAvailable = TERMINAL_LOG_ENABLED;

function stringifyLogArg(value) {
    if (value instanceof Error) {
        return value.stack || value.message || String(value);
    }
    if (typeof value === 'object' && value !== null) {
        try {
            return JSON.stringify(value);
        } catch (error) {
            return `[Unserializable Object: ${error.message}]`;
        }
    }
    return String(value);
}

function formatLogLine(level, args) {
    const ts = new Date().toISOString();
    const msg = args.map(stringifyLogArg).join(' ');
    // Strip emoji for clean log file on Windows
    const clean = msg.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F900}-\u{1F9FF}]|[\u{200D}]|[\u{20E3}]|[\u{E0020}-\u{E007F}]/gu, '').trim();
    return `[${ts}] [${level}] ${clean}\n`;
}

function sanitizeLogUrl(rawUrl = '') {
    try {
        const parsed = new URL(rawUrl || '/', 'http://localhost');
        if (parsed.searchParams.has('key')) {
            parsed.searchParams.set('key', '[redacted]');
        }
        return `${parsed.pathname}${parsed.search}`;
    } catch {
        return String(rawUrl || '/').replace(/([?&]key=)[^&]*/ig, '$1[redacted]');
    }
}

// Intercept console methods Ã¢â€ â€™ write to both terminal AND log.txt
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

function writeToTerminalSafely(writer, args) {
    if (!terminalConsoleAvailable) return;
    try {
        writer(...args);
    } catch (error) {
        if (error?.code === 'EPIPE' || String(error?.message || '').includes('EPIPE')) {
            terminalConsoleAvailable = false;
            try { logStream.write(formatLogLine('WARN', ['Terminal pipe closed; continuing with file logging only.'])); } catch (e) { /* ignore */ }
            return;
        }
        throw error;
    }
}

console.log = (...args) => {
    writeToTerminalSafely(_origLog, args);
    try { logStream.write(formatLogLine('INFO', args)); } catch (e) { /* ignore */ }
};
console.warn = (...args) => {
    writeToTerminalSafely(_origWarn, args);
    try { logStream.write(formatLogLine('WARN', args)); } catch (e) { /* ignore */ }
};
console.error = (...args) => {
    writeToTerminalSafely(_origError, args);
    try { logStream.write(formatLogLine('ERROR', args)); } catch (e) { /* ignore */ }
};

// ============================================================
// CRASH PROTECTION - Prevent process from dying on unhandled errors
// ============================================================
process.on('uncaughtException', (err) => {
    if (err?.code === 'EPIPE' || String(err?.message || '').includes('EPIPE')) {
        terminalConsoleAvailable = false;
        try { logStream.write(formatLogLine('WARN', ['Suppressed EPIPE from terminal output.'])); } catch (e) { /* ignore */ }
        return;
    }
    console.error('Ã°Å¸â€™Â¥ UNCAUGHT EXCEPTION (process kept alive):', err.message);
    console.error('   Stack:', err.stack);
});

process.on('unhandledRejection', (reason) => {
    console.error('Ã°Å¸â€™Â¥ UNHANDLED REJECTION (process kept alive):', reason);
});

console.log('========================================');
console.log('Ã°Å¸Å¡â‚¬ Cursor Remote starting...');
console.log(`   PID: ${process.pid}`);
console.log(`   Node: ${process.version}`);
console.log(`   Time: ${new Date().toISOString()}`);
console.log(`   Runtime root: ${RUNTIME_ROOT}`);
console.log(`   Runtime mode: ${IS_EMBEDDED_RUNTIME ? 'embedded-webview' : 'browser-server'}`);
console.log('========================================');

const PORTS = [9000, 9001, 9002, 9003];
const PRIMARY_CDP_PORT = PORTS[0];
const POLL_INTERVAL = 500; // 500ms for smoother updates
const SERVER_PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD || 'Cursor';
const AUTH_COOKIE_NAME = 'cr_auth_token';
const AUTO_LAUNCH_cursor = process.env.CR_SKIP_AUTO_LAUNCH !== '1';
const FORCE_VISIBLE_CURSOR = process.env.CR_VISIBLE_CURSOR === '1';


// Shared CDP connection
let cdpConnection = null;
let lastSnapshot = null;
let lastSnapshotHash = null;
let lastAppState = null;
let lastAppStateHash = null;
let cursorLaunchPromise = null;

const CURSOR_UI_HELPERS = String.raw`
const __cr = (() => {
    const getClassName = (el) => {
        if (!el) return '';
        if (typeof el.className === 'string') return el.className;
        if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
        return '';
    };

    const isVisible = (el) => {
        if (!el || !el.isConnected || typeof el.getBoundingClientRect !== 'function') return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        return el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
    };

    const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const escapeRegExp = (value) => String(value || '').replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

    const queryAllVisible = (selector, root = document) => Array.from(root.querySelectorAll(selector)).filter(isVisible);
    const uniqueElements = (elements) => elements.filter((el, index, arr) => el && arr.indexOf(el) === index);
    const getArea = (el) => {
        const rect = el?.getBoundingClientRect?.();
        return rect ? Math.max(rect.width, 0) * Math.max(rect.height, 0) : 0;
    };
    const getLeafTexts = (el) => {
        if (!el) return [];
        const seen = new Set();
        return [el, ...Array.from(el.querySelectorAll('*'))]
            .filter(node => node === el || !node.children.length)
            .map(node => normalizeText(node.textContent || ''))
            .filter(text => {
                if (!text) return false;
                if (/^[\u2039\u203a\u25be\u2304\u2193]+$/u.test(text)) return false;
                const key = text.toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    };
    const MODE_TEXT_MATCHER = /^(agent|plan|debug|ask|fast|planning|manual)\b/i;
    const MODEL_TEXT_HINT_MATCHER = /(?:\bauto\b|gpt|claude|sonnet|opus|composer|gemini|\d\.\d)/i;
    const getBestLeafTextMatch = (el, matcher, { maxLength = 80 } = {}) => {
        if (!el || !matcher) return '';
        return getLeafTexts(el)
            .map(normalizeText)
            .filter(text => text && text.length <= maxLength && matcher.test(text))
            .sort((a, b) => a.length - b.length || a.localeCompare(b))[0] || '';
    };
    const isPlausibleModeText = (value) => {
        const text = normalizeText(value);
        return !!text && text.length <= 24 && MODE_TEXT_MATCHER.test(text);
    };
    const isPlausibleModelText = (value) => {
        const text = normalizeText(value);
        if (!text || text.length > 48) return false;
        if (/[{};]/.test(text) || /\.monaco-|cursorremote|upgrade to pro|launchpad|ctrl\+|https?:|\.png\b/i.test(text)) return false;
        return /^(auto|composer\s+\d+(?:\.\d+)*|gpt-\d+(?:\.\d+)*(?:\s+codex)?|sonnet\s+\d+(?:\.\d+)*|opus\s+\d+(?:\.\d+)*|gemini\s+\d+(?:\s+flash)?|claude(?:\s+[\w.-]+)?|o\d(?:\s+[\w.-]+)?)$/i.test(text);
    };
    const getModeHintText = () => {
        const panel = findPanel() || document;
        const hints = queryAllVisible('.aislash-editor-placeholder, [data-placeholder]', panel)
            .map(textOf)
            .map(normalizeText);
        for (const hint of hints) {
            const match = hint.match(/^(agent|plan|debug|ask|fast|planning|manual)\b/i);
            if (match) return match[1];
        }
        return '';
    };
    const pickModeName = (value) => {
        const normalized = normalizeText(value);
        if (!normalized) return '';
        const match = normalized.match(/(agent|plan|debug|ask|fast|planning|manual)/i);
        return match ? match[1] : normalized;
    };

    const isTabActive = (el) => {
        if (!el) return false;
        const ariaSelected = (el.getAttribute?.('aria-selected') || '').toLowerCase();
        const ariaCurrent = (el.getAttribute?.('aria-current') || '').toLowerCase();
        if (ariaSelected === 'true') return true;
        if (ariaCurrent && ariaCurrent !== 'false') return true;

        const cls = getClassName(el).toLowerCase();
        return cls.includes('checked') || cls.includes('active') || cls.includes('selected') || cls.includes('current');
    };

    const findPanel = () => {
        const candidates = uniqueElements([
            ...queryAllVisible('[id^="workbench.panel.aichat"]'),
            document.getElementById('conversation'),
            document.getElementById('chat'),
            document.getElementById('cascade')
        ].filter(isVisible));

        candidates.sort((a, b) => {
            const aScore = getArea(a) +
                (a.querySelector('.composer-bar, [data-composer-id]') ? 500000 : 0) +
                (a.querySelector('[data-lexical-editor="true"], [contenteditable="true"]') ? 250000 : 0);
            const bScore = getArea(b) +
                (b.querySelector('.composer-bar, [data-composer-id]') ? 500000 : 0) +
                (b.querySelector('[data-lexical-editor="true"], [contenteditable="true"]') ? 250000 : 0);
            return bScore - aScore;
        });

        return candidates[0] || null;
    };

    const normalizeChatTitleMatchKey = (value) => normalizeText(value)
        .replace(/[\u2026.]+$/g, '')
        .trim()
        .toLowerCase();

    const chatTitlesMatch = (left, right) => {
        const a = normalizeChatTitleMatchKey(left);
        const b = normalizeChatTitleMatchKey(right);
        if (!a || !b) return false;
        return a === b || a.includes(b) || b.includes(a);
    };

    const normalizeChatTabElement = (el) => {
        if (!el) return null;
        const rootTab = el.closest?.('[role="tab"]');
        return rootTab && isVisible(rootTab) ? rootTab : el;
    };

    const getChatTabElements = (container = findChatTabsContainer()) => {
        if (!container) return [];
        return uniqueElements(
            Array.from(container.querySelectorAll('[role="tab"], .composite-bar-action-tab'))
                .filter(isVisible)
                .map(normalizeChatTabElement)
                .filter(isVisible)
        );
    };

    const findChatTabsContainer = () => {
        const panel = findPanel();
        const panelRect = panel?.getBoundingClientRect?.() || null;
        const containers = uniqueElements(
            queryAllVisible('[role="tab"], .composite-bar-action-tab', document)
                .map(tab => tab.closest?.('.composite.title.has-composite-bar, .composite-bar-container, .composite-bar, .monaco-action-bar, [class*="auxiliary-bar-title"]'))
                .filter(isVisible)
        );

        containers.sort((a, b) => {
            const score = (container) => {
                if (!container) return -Infinity;
                const rect = container.getBoundingClientRect();
                const tabs = uniqueElements(Array.from(container.querySelectorAll('[role="tab"], .composite-bar-action-tab')).filter(isVisible));
                if (!tabs.length) return -Infinity;

                let value = tabs.length * 6;
                if (tabs.some(isTabActive)) value += 20;
                if (rect.height <= 56) value += 10;
                if (rect.width >= 180) value += 6;

                if (panelRect) {
                    const overlap = Math.max(0, Math.min(rect.right, panelRect.right) - Math.max(rect.left, panelRect.left));
                    if (overlap > 0) {
                        value += Math.min(12, (overlap / Math.max(Math.min(rect.width, panelRect.width), 1)) * 12);
                    }

                    const gap = panelRect.top >= rect.bottom
                        ? panelRect.top - rect.bottom
                        : rect.top >= panelRect.bottom
                            ? rect.top - panelRect.bottom
                            : 0;
                    value += Math.max(0, 10 - (gap / 12));
                    if (rect.top <= panelRect.top) value += 6;
                }

                return value;
            };

            return score(b) - score(a);
        });

        return containers[0] || null;
    };

    const getChatTabs = () => {
        const container = findChatTabsContainer();
        if (!container) return [];

        const seen = new Set();
        const tabs = getChatTabElements(container)
            .map((el) => {
                const title = normalizeText(el.getAttribute?.('aria-label') || textOf(el));
                if (!title || title.length > 120) return null;

                const lower = title.toLowerCase();
                if (lower === 'more actions' || lower === 'more actions...') return null;
                if (seen.has(lower)) return null;
                seen.add(lower);

                return {
                    title,
                    active: isTabActive(el)
                };
            })
            .filter(Boolean);

        const activeTitle = tabs.find(tab => tab.active)?.title || '';
        if (!activeTitle) return tabs;

        const normalizedActiveTitle = activeTitle.toLowerCase();
        return tabs.filter((tab) => {
            if (tab.active) return true;
            const normalizedTitle = tab.title.toLowerCase();
            if (normalizedTitle === normalizedActiveTitle) return false;
            return !(normalizedTitle.length < normalizedActiveTitle.length && chatTitlesMatch(tab.title, activeTitle));
        });
    };

    const getActiveChatTitle = () => {
        const tabs = getChatTabs();
        const activeTab = tabs.find(tab => tab.active);
        if (activeTab?.title) return activeTab.title;

        const panel = findPanel();
        const paneHeader = panel?.closest?.('.pane')?.querySelector?.('.pane-header, .pane-header .title, .pane-header h3');
        const rawTitle = normalizeText(paneHeader?.getAttribute?.('aria-label') || textOf(paneHeader));
        if (rawTitle) {
            return rawTitle.replace(/\s+section$/i, '').trim();
        }

        return '';
    };

    const findEditor = () => {
        const panel = findPanel();
        const candidates = [];
        if (panel) candidates.push(...queryAllVisible('[data-lexical-editor="true"], [contenteditable="true"]', panel));
        candidates.push(...queryAllVisible('[data-lexical-editor="true"], [contenteditable="true"]'));
        return candidates
            .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)
            .at(-1) || null;
    };

    const findComposerBar = () => {
        const panel = findPanel() || document;
        return uniqueElements(queryAllVisible('.composer-bar, [data-composer-id]', panel))
            .sort((a, b) => {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                return (bRect.bottom - aRect.bottom) || (aRect.left - bRect.left);
            })[0] || null;
    };

    const getComposerAnchorRect = () => {
        return findComposerBar()?.getBoundingClientRect?.() || findEditor()?.getBoundingClientRect?.() || null;
    };

    const scoreComposerChipCandidate = (el, {
        matcher,
        excludeMatcher = null,
        maxTextLength,
        minWidth,
        maxWidth,
        minHeight = 18,
        maxHeight = 44,
        maxContainerTextLength = Math.max(maxTextLength * 2, 72),
        horizontalWeight = 0.03
    } = {}) => {
        if (!el || !isVisible(el)) return -Infinity;

        const rect = el.getBoundingClientRect();
        const leafText = getBestLeafTextMatch(el, matcher, { maxLength: maxTextLength });
        const containerText = normalizeText(textOf(el));
        if (!leafText || !containerText) return -Infinity;
        if (excludeMatcher) {
            const excludedText = getBestLeafTextMatch(el, excludeMatcher, { maxLength: 48 });
            if (excludedText && excludedText.toLowerCase() !== leafText.toLowerCase()) return -Infinity;
        }
        if (containerText.length > maxContainerTextLength) return -Infinity;
        if (rect.width < minWidth || rect.width > maxWidth || rect.height < minHeight || rect.height > maxHeight) return -Infinity;

        const anchorRect = getComposerAnchorRect();
        if (!anchorRect) return 100 - containerText.length;

        const verticalDistance = Math.abs(rect.bottom - anchorRect.bottom);
        if (verticalDistance > 120) return -Infinity;

        const horizontalPenalty = Math.abs(rect.left - anchorRect.left) * horizontalWeight;
        return 100 - verticalDistance - horizontalPenalty - containerText.length;
    };

    const findPanelScrollRoot = () => {
        const panel = findPanel();
        if (!panel) return null;

        const candidates = [
            ...queryAllVisible('.pane-body .monaco-scrollable-element, .composer-bar .monaco-scrollable-element, .scrollable-div-container, .ui-scroll-area__viewport, .ui-scroll-area', panel),
            ...queryAllVisible('.monaco-scrollable-element, [class*="scroll"], [style*="overflow"]', panel)
        ].filter(el => el.scrollHeight > el.clientHeight + 12);

        candidates.sort((a, b) => {
            const sizeDiff = b.clientHeight - a.clientHeight;
            if (sizeDiff) return sizeDiff;
            return a.getBoundingClientRect().y - b.getBoundingClientRect().y;
        });

        return candidates[0] || panel;
    };

    const click = (el) => {
        if (!el) return false;
        const target = el.closest?.('.anysphere-icon-button, .send-with-mode, button, [role="button"], a, .cursor-pointer') || el;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            try {
                target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            } catch (e) { /* ignore */ }
        }
        try { target.click?.(); } catch (e) { /* ignore */ }
        return true;
    };

    const resolveTrigger = (el) => el?.closest?.(
        '.composer-unified-dropdown, .composer-unified-dropdown-model, .anysphere-icon-button, .send-with-mode, button, [role="button"], a, .cursor-pointer'
    ) || el || null;

    const focusEditor = (editor) => {
        if (!editor) return;
        editor.focus();
        const selection = window.getSelection?.();
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    };

    const setEditorText = (editor, text) => {
        if (!editor) return false;
        focusEditor(editor);
        try { document.execCommand?.('selectAll', false, null); } catch (e) { /* ignore */ }
        try { document.execCommand?.('delete', false, null); } catch (e) { /* ignore */ }

        let inserted = false;
        try { inserted = !!document.execCommand?.('insertText', false, text); } catch (e) { /* ignore */ }

        if (!inserted) {
            editor.textContent = text;
            try { editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: text })); } catch (e) { /* ignore */ }
            try { editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); } catch (e) { /* ignore */ }
        }

        return true;
    };

    const findByAria = (needle) => Array.from(document.querySelectorAll('button, [role="button"], a, div')).find(el => {
        if (!isVisible(el)) return false;
        return (el.getAttribute('aria-label') || '').toLowerCase().includes(needle);
    });

    const findNewChatButton = () => {
        const legacy = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
        if (legacy && isVisible(legacy)) return legacy;
        return findByAria('new chat') ||
            Array.from(document.querySelectorAll('button, [role="button"], a')).find(el => isVisible(el) && /\bnew chat\b/i.test(textOf(el))) ||
            null;
    };

    const findHistoryButton = () => {
        return findByAria('chat history') ||
            document.querySelector('[data-tooltip-id*="history"], [data-tooltip-id*="past"], [data-tooltip-id*="recent"], [data-tooltip-id*="conversation-history"]') ||
            null;
    };

    const findAttachButton = () => {
        const icon = queryAllVisible('.codicon-image-two, .codicon-paperclip, .codicon-attach, svg.lucide-paperclip, svg.lucide-plus', document)
            .find(candidate => {
                const trigger = resolveTrigger(candidate);
                if (!trigger || !isVisible(trigger)) return false;
                const aria = (trigger.getAttribute('aria-label') || '').toLowerCase();
                const title = (trigger.getAttribute('title') || '').toLowerCase();
                return !aria.includes('new chat') && !title.includes('new chat');
            });
        if (icon) return resolveTrigger(icon);

        const editor = findEditor();
        if (!editor) return null;
        const editorRect = editor.getBoundingClientRect();
        const candidates = queryAllVisible('button, [role="button"], a, div', document)
            .map(resolveTrigger)
            .filter((el, index, arr) => el && arr.indexOf(el) === index);

        return candidates.find(button => {
            const rect = button.getBoundingClientRect();
            const aria = (button.getAttribute('aria-label') || '').toLowerCase();
            const title = (button.getAttribute('title') || '').toLowerCase();
            const cls = getClassName(button).toLowerCase();
            const nearEditor = Math.abs(rect.top - editorRect.top) < 160 || Math.abs(rect.bottom - editorRect.bottom) < 160;
            return nearEditor && (
                aria.includes('context') || aria.includes('attach') || aria.includes('file') || aria.includes('image') ||
                title.includes('context') || title.includes('attach') || title.includes('file') || title.includes('image') ||
                cls.includes('attach') || cls.includes('image')
            );
        }) || null;
    };

    const findHistoryMenu = () => {
        const candidates = queryAllVisible('[id^="composer-history-menu"], .compact-agent-history-react-menu-content, .ui-menu__content, [role="menu"], .context-view', document);
        candidates.sort((a, b) => {
            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            return (bRect.width * bRect.height) - (aRect.width * aRect.height);
        });
        return candidates[0] || null;
    };

    const MENU_TEXT_MARKERS = [
        /^auto(?:\b|\s)/i,
        /^max mode(?:\b|\s)/i,
        /^use multiple models?(?:\b|\s)/i,
        /^search models?$/i,
        /^add models?$/i,
        /^(agent|plan|debug|ask|fast|planning|manual)\b/i
    ];

    const findPopupAncestor = (el) => {
        let current = el;
        while (current && current !== document.body) {
            if (isVisible(current)) {
                const rect = current.getBoundingClientRect();
                const text = normalizeText(textOf(current));
                if (
                    text &&
                    MENU_TEXT_MARKERS.some(marker => marker.test(text)) &&
                    rect.width >= 120 &&
                    rect.width <= 420 &&
                    rect.height >= 24 &&
                    rect.height <= Math.min(window.innerHeight * 0.92, 560)
                ) {
                    return current;
                }
            }
            current = current.parentElement;
        }
        return null;
    };

    const findMenuContainers = () => {
        const selectorContainers = queryAllVisible('[role="menu"], [role="dialog"], [role="listbox"], .ui-menu__content, .context-view, [data-radix-popper-content-wrapper], [data-radix-popper-content-wrapper] > div, .monaco-menu-container, .monaco-select-box-dropdown-container', document);
        const inferredContainers = uniqueElements(
            Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"], [role="button"], a, div, span'))
                .filter(isVisible)
                .filter((el) => {
                    const text = normalizeText(textOf(el));
                    return text && MENU_TEXT_MARKERS.some(marker => marker.test(text));
                })
                .map(findPopupAncestor)
                .filter(Boolean)
        );
        const containers = uniqueElements([...selectorContainers, ...inferredContainers]);
        containers.sort((a, b) => {
            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            return (bRect.width * bRect.height) - (aRect.width * aRect.height);
        });
        return containers;
    };

    const getMenuItems = (container) => {
        if (!container) return [];

        const seen = new Set();
        const items = [];
        const candidates = Array.from(container.querySelectorAll('[role="menuitem"], [role="option"], button, [role="button"], a, div, span')).filter(isVisible);

        for (const el of candidates) {
            const text = textOf(el);
            const lower = text.toLowerCase();
            if (!text || text.length > 140) continue;
            if (lower === 'archived' || lower === 'no matching agent') continue;
            if (lower.startsWith('show ')) continue;
            if (lower.endsWith(' ago') || /^\d+\s*(sec|min|hr|day|wk|mo|yr)/i.test(lower)) continue;
            if (seen.has(lower)) continue;

            const clickable = resolveTrigger(el);
            if (!clickable || !isVisible(clickable)) continue;

            seen.add(lower);
            items.push({ title: text, element: clickable });
        }

        return items;
    };

    const getMenuItemTexts = (containers = findMenuContainers()) => {
        const seen = new Set();
        const texts = [];
        for (const container of containers) {
            for (const item of getMenuItems(container)) {
                const key = item.title.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                texts.push(item.title);
            }
        }
        return texts;
    };

    const findModelSearchInput = (root = document) => Array.from(root.querySelectorAll('input, textarea, [role="textbox"]')).find(el => {
        if (!isVisible(el)) return false;
        const placeholder = normalizeText(el.getAttribute('placeholder') || el.getAttribute('aria-label') || '');
        return /search/i.test(placeholder);
    }) || null;

    const MODEL_MENU_MARKERS = [
        /^auto(?:\b|\s)/i,
        /^max mode(?:\b|\s)/i,
        /^use multiple models?(?:\b|\s)/i,
        /^search models?$/i,
        /^add models?$/i
    ];

    const getHorizontalOverlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));

    const scoreModelMenuContainer = (container) => {
        if (!container || !isVisible(container)) return -Infinity;

        const rect = container.getBoundingClientRect();
        if (rect.width < 150 || rect.width > 420 || rect.height < 40 || rect.height > Math.min(window.innerHeight * 0.9, 560)) {
            return -Infinity;
        }

        const text = normalizeText(textOf(container));
        let score = 0;

        if (findModelSearchInput(container)) score += 5;
        score += MODEL_MENU_MARKERS.reduce((count, marker) => count + (marker.test(text) ? 1 : 0), 0) * 3;

        const modelButton = findModelButton();
        if (modelButton) {
            const buttonRect = modelButton.getBoundingClientRect();
            const overlap = getHorizontalOverlap(rect, buttonRect);
            if (overlap > 0) score += Math.min(4, overlap / Math.max(buttonRect.width, 1));

            const verticalGap = rect.top >= buttonRect.bottom
                ? rect.top - buttonRect.bottom
                : buttonRect.top >= rect.bottom
                    ? buttonRect.top - rect.bottom
                    : 0;
            score += Math.max(0, 3 - verticalGap / 80);
            if (rect.bottom <= buttonRect.top + 80) score += 1;
        }

        if (rect.width >= 180 && rect.width <= 320) score += 1;
        if (rect.height >= 120 && rect.height <= 440) score += 1;
        return score;
    };

    const findModelMenuRoot = () => {
        const searchInput = findModelSearchInput(document);
        if (searchInput) {
            const nearestContainer = searchInput.closest('[role="menu"], [role="dialog"], [role="listbox"], .ui-menu__content, .context-view, [data-radix-popper-content-wrapper]');
            if (nearestContainer && isVisible(nearestContainer)) {
                return nearestContainer;
            }

            const owningContainer = findMenuContainers().find(container => container.contains(searchInput));
            if (owningContainer) {
                return owningContainer;
            }
        }

        const scoredContainers = findMenuContainers()
            .map(container => ({ container, score: scoreModelMenuContainer(container) }))
            .filter(item => Number.isFinite(item.score))
            .sort((a, b) => b.score - a.score);

        if (scoredContainers[0]?.score > 0) {
            return scoredContainers[0].container;
        }

        return findMenuContainers().find(container => !!findModelSearchInput(container)) || null;
    };

    const getSwitchState = (el) => {
        const switchEl =
            el?.querySelector?.('[role="switch"], input[type="checkbox"], [aria-checked], [aria-pressed]') ||
            el?.closest?.('[role="switch"], [aria-checked], [aria-pressed]');

        if (!switchEl) return false;

        const ariaChecked = switchEl.getAttribute?.('aria-checked');
        if (ariaChecked != null) return ariaChecked === 'true';

        const ariaPressed = switchEl.getAttribute?.('aria-pressed');
        if (ariaPressed != null) return ariaPressed === 'true';

        if (typeof switchEl.checked === 'boolean') {
            return !!switchEl.checked;
        }

        const cls = getClassName(switchEl).toLowerCase();
        return cls.includes('checked') || cls.includes('enabled') || cls.includes('active') || cls.includes('on');
    };

    const isSelectableRowActive = (el) => {
        if (!el) return false;
        const candidates = [
            el,
            ...Array.from(el.querySelectorAll('[aria-selected], [aria-current], [aria-checked], [aria-pressed], .checked, .active, .selected, .current'))
        ];

        return candidates.some((candidate) => {
            if (!candidate) return false;

            const ariaSelected = candidate.getAttribute?.('aria-selected');
            if (ariaSelected === 'true') return true;

            const ariaCurrent = candidate.getAttribute?.('aria-current');
            if (ariaCurrent && ariaCurrent !== 'false') return true;

            const ariaChecked = candidate.getAttribute?.('aria-checked');
            if (ariaChecked === 'true') return true;

            const ariaPressed = candidate.getAttribute?.('aria-pressed');
            if (ariaPressed === 'true') return true;

            const cls = getClassName(candidate).toLowerCase();
            return cls.includes('checked') || cls.includes('active') || cls.includes('selected') || cls.includes('current');
        });
    };

    const setInputValue = (input, value) => {
        if (!input) return false;

        input.focus?.();
        try { input.select?.(); } catch (e) { /* ignore */ }

        const inputSetter = typeof HTMLInputElement !== 'undefined'
            ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            : null;
        const textAreaSetter = typeof HTMLTextAreaElement !== 'undefined'
            ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
            : null;

        if (typeof HTMLTextAreaElement !== 'undefined' && input instanceof HTMLTextAreaElement && textAreaSetter) {
            textAreaSetter.call(input, value);
        } else if (typeof HTMLInputElement !== 'undefined' && input instanceof HTMLInputElement && inputSetter) {
            inputSetter.call(input, value);
        } else {
            input.value = value;
        }

        try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* ignore */ }
        try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { /* ignore */ }
        return true;
    };

    const getModelMenuRows = (root = findModelMenuRoot()) => {
        if (!root) return [];

        return Array.from(root.querySelectorAll('button, [role="menuitem"], [role="option"], [role="button"], label, a, div'))
            .filter(isVisible)
            .map(resolveTrigger)
            .filter((el, index, arr) => el && root.contains(el) && arr.indexOf(el) === index)
            .map(el => ({
                element: el,
                text: normalizeText(textOf(el)),
                rect: el.getBoundingClientRect()
            }))
            .filter(item => item.text && item.rect.width > 50 && item.rect.height >= 16 && item.rect.height <= 120)
            .sort((a, b) => {
                const yDiff = a.rect.top - b.rect.top;
                return Math.abs(yDiff) > 1 ? yDiff : a.rect.left - b.rect.left;
            });
    };

    const getSelectedModelMenuOption = (root = findModelMenuRoot()) => {
        const rows = getModelMenuRows(root)
            .filter((row) => isPlausibleModelText(row.text));

        const explicitSelection = rows
            .filter((row) => isSelectableRowActive(row.element))
            .sort((a, b) => (b.text.length - a.text.length) || (a.rect.top - b.rect.top))[0];
        if (explicitSelection) return explicitSelection.text;

        const checkmarkSelection = rows
            .filter((row) => /\bcheck(mark)?\b/i.test(getClassName(row.element)))
            .sort((a, b) => (b.text.length - a.text.length) || (a.rect.top - b.rect.top))[0];
        if (checkmarkSelection) return checkmarkSelection.text;

        return '';
    };

    const findModelToggleRow = (label, root = findModelMenuRoot()) => {
        const matcher = new RegExp('^' + escapeRegExp(label) + '(?:\\\\b|\\\\s)', 'i');
        return getModelMenuRows(root).find(row => matcher.test(row.text))?.element || null;
    };

    const getModelMenuState = () => {
        const root = findModelMenuRoot();
        const current = getModelText() || 'Unknown';
        if (!root) {
            return {
                current,
                searchPlaceholder: '',
                toggles: [],
                options: current && current !== 'Unknown' && !/^auto$/i.test(current) ? [current] : [],
                footerLabel: '',
                targets: []
            };
        }

        const searchInput = findModelSearchInput(root);
        const searchPlaceholder = normalizeText(searchInput?.getAttribute('placeholder') || searchInput?.getAttribute('aria-label') || '');
        const rows = getModelMenuRows(root);
        const targets = [];
        const toggleDefs = [
            { key: 'auto', label: 'Auto', matcher: /^auto(?:\b|\s)/i },
            { key: 'max-mode', label: 'MAX Mode', matcher: /^max mode(?:\b|\s)/i },
            { key: 'multi-model', label: 'Use Multiple Models', matcher: /^use multiple models?(?:\b|\s)/i }
        ];

        const toggles = toggleDefs.map(def => {
            const otherMatchers = toggleDefs.filter(other => other.key !== def.key).map(other => other.matcher);
            const row = rows
                .filter(item => def.matcher.test(item.text))
                .filter(item => !otherMatchers.some(matcher => matcher.test(item.text)))
                .sort((a, b) => (a.rect.height - b.rect.height) || (a.text.length - b.text.length))[0] ||
                rows
                    .filter(item => def.matcher.test(item.text))
                    .sort((a, b) => (a.rect.height - b.rect.height) || (a.text.length - b.text.length))[0];
            if (!row) return null;

            const description = normalizeText(row.text.replace(new RegExp('^(?:' + escapeRegExp(def.label) + '\\\\s*)+', 'i'), ''));
            targets.push({
                kind: 'toggle',
                key: def.key,
                label: def.label,
                title: def.label,
                x: Math.round(row.rect.left + (row.rect.width / 2)),
                y: Math.round(row.rect.top + (row.rect.height / 2))
            });
            return {
                key: def.key,
                label: def.label,
                description,
                enabled: getSwitchState(row.element) || (def.key === 'auto' && /^auto$/i.test(current))
            };
        }).filter(Boolean);

        const blockedMatchers = [
            /^search models?$/i,
            /^add models?$/i,
            ...toggleDefs.map(def => def.matcher)
        ];
        const seen = new Set();
        const options = [];

        for (const row of rows) {
            const title = row.text;
            const key = title.toLowerCase();
            if (!title || title.length > 80) continue;
            if (blockedMatchers.some(matcher => matcher.test(title))) continue;
            if (!isPlausibleModelText(title)) continue;
            if (seen.has(key)) continue;
            seen.add(key);
            options.push(title);
            targets.push({
                kind: 'option',
                title,
                x: Math.round(row.rect.left + (row.rect.width / 2)),
                y: Math.round(row.rect.top + (row.rect.height / 2))
            });
        }

        if (!options.length && current && current !== 'Unknown' && !/^auto$/i.test(current)) {
            options.push(current);
        }

        return {
            current,
            searchPlaceholder,
            toggles,
            options,
            footerLabel: rows.some(row => /^add models?$/i.test(row.text)) ? 'Add Models' : '',
            targets
        };
    };

    const getHistoryItems = () => {
        const menu = findHistoryMenu();
        if (!menu) return [];

        const seen = new Set();
        const items = [];
        const elements = Array.from(menu.querySelectorAll('button, [role="menuitem"], [role="button"], a, div, span')).filter(isVisible);

        for (const el of elements) {
            const text = textOf(el);
            const lower = text.toLowerCase();
            if (!text || text.length < 2 || text.length > 140) continue;
            if (lower === 'archived' || lower === 'no matching agent') continue;
            if (lower.startsWith('show ')) continue;
            if (lower.endsWith(' ago') || /^\d+\s*(sec|min|hr|day|wk|mo|yr)/i.test(lower)) continue;
            if (seen.has(text)) continue;

            const clickable = el.closest('button, [role="menuitem"], [role="button"], a, div');
            if (!clickable || !isVisible(clickable)) continue;

            seen.add(text);
            items.push({ title: text });
        }

        return items;
    };

    const findSendButton = () => {
        const icon = queryAllVisible('.codicon-arrow-up-two, .codicon-arrow-right, svg.lucide-arrow-right', document)[0];
        if (!icon) return null;
        const button = icon.closest('.anysphere-icon-button, .send-with-mode, button, [role="button"], div');
        return isVisible(button) ? button : null;
    };

    const findStopButton = () => {
        const panel = findPanel() || document;
        const controls = queryAllVisible('[data-click-ready="true"], button, [role="button"], a, div', panel)
            .map(resolveTrigger)
            .filter((el, index, arr) => el && arr.indexOf(el) === index);

        const textButton = controls
            .map(el => ({
                el,
                text: textOf(el),
                aria: (el.getAttribute('aria-label') || '').toLowerCase(),
                rect: el.getBoundingClientRect()
            }))
            .filter(item => /^stop$/i.test(item.text) || item.aria.includes('stop') || item.aria.includes('cancel'))
            .sort((a, b) => b.rect.y - a.rect.y)[0];
        if (textButton) return textButton.el;

        const legacy = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (legacy && isVisible(legacy)) return legacy;

        const icons = queryAllVisible('.codicon-debug-stop, .codicon-sync, .codicon-loading, .codicon-debug-pause, .codicon-primitive-square, .codicon-circle-slash, .lucide-square, .lucide-loader', document);
        for (const icon of icons) {
            const button = icon.closest('.anysphere-icon-button, .send-with-mode, button, [role="button"], div');
            if (isVisible(button)) return button;
        }
        return null;
    };

    const getComposerStatus = () => {
        const panel = findPanel();
        const composer = panel ? panel.querySelector('.composer-bar[data-composer-status]') : null;
        return (composer?.getAttribute('data-composer-status') || '').trim().toLowerCase();
    };

    const isBusy = () => {
        const status = getComposerStatus();
        return ['generating', 'running', 'streaming', 'working', 'loading'].includes(status);
    };

    const getDropdownText = (selector) => {
        const panel = findPanel() || document;
        const el = uniqueElements(queryAllVisible(selector, panel).map(resolveTrigger))[0] || null;
        if (!el) return '';
        const leafText = getLeafTexts(el)
            .map(normalizeText)
            .filter(text => text && text.length <= 64)
            .sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
        return leafText || textOf(el);
    };

    const getModeText = () => {
        const button = findModeButton();
        const dataMode = pickModeName(button?.getAttribute?.('data-mode') || '');
        if (isPlausibleModeText(dataMode)) return dataMode;

        const leafText = getBestLeafTextMatch(button, MODE_TEXT_MATCHER, { maxLength: 24 });
        if (isPlausibleModeText(leafText)) return pickModeName(leafText);

        const hintedMode = getModeHintText();
        if (isPlausibleModeText(hintedMode)) return pickModeName(hintedMode);

        const fallback = pickModeName(getDropdownText('.composer-unified-dropdown'));
        return isPlausibleModeText(fallback) ? fallback : '';
    };

    const getModelText = () => {
        const button = findModelButton();
        if (button) {
            const preferred = getBestLeafTextMatch(button, MODEL_TEXT_HINT_MATCHER, { maxLength: 48 });
            if (isPlausibleModelText(preferred)) return preferred;

            const fallback = getDropdownText('.composer-unified-dropdown-model');
            if (isPlausibleModelText(fallback)) return fallback;
        }

        const selectedFromMenu = getSelectedModelMenuOption();
        return isPlausibleModelText(selectedFromMenu) ? selectedFromMenu : '';
    };

    const findDropdownMenuItem = (targetText, containers = findMenuContainers()) => {
        const normalized = targetText.trim().toLowerCase();
        const items = containers.flatMap(getMenuItems);
        return items.find(item => item.title.toLowerCase() === normalized)?.element ||
            items.find(item => item.title.toLowerCase().includes(normalized))?.element ||
            items.find(item => normalized.includes(item.title.toLowerCase()))?.element ||
            null;
    };

    const findModeButton = () => {
        const panel = findPanel() || document;
        const composer = findComposerBar() || panel;
        return uniqueElements([
            ...queryAllVisible('.composer-unified-dropdown, [data-mode]', composer),
            ...queryAllVisible('button, [role="button"], a, div', composer),
            ...queryAllVisible('.composer-unified-dropdown, [data-mode]', document)
        ].map(resolveTrigger).filter(isVisible))
            .map(el => ({
                el,
                score: scoreComposerChipCandidate(el, {
                    matcher: MODE_TEXT_MATCHER,
                    excludeMatcher: MODEL_TEXT_HINT_MATCHER,
                    maxTextLength: 24,
                    minWidth: 44,
                    maxWidth: 180,
                    maxHeight: 40,
                    maxContainerTextLength: 56,
                    horizontalWeight: 0.08
                })
            }))
            .filter(item => Number.isFinite(item.score))
            .sort((a, b) => b.score - a.score)[0]?.el || null;
    };

    const findModelButton = () => {
        const panel = findPanel() || document;
        const composer = findComposerBar() || panel;
        const directMatch = uniqueElements([
            ...queryAllVisible('.composer-unified-dropdown-model, [id*="unifiedmodeldropdown"]', composer),
            ...queryAllVisible('button, [role="button"], a, div', composer),
            ...queryAllVisible('.composer-unified-dropdown-model, [id*="unifiedmodeldropdown"]', document)
        ].map(resolveTrigger).filter(isVisible))
            .map(el => ({
                el,
                score: scoreComposerChipCandidate(el, {
                    matcher: MODEL_TEXT_HINT_MATCHER,
                    excludeMatcher: MODE_TEXT_MATCHER,
                    maxTextLength: 48,
                    minWidth: 56,
                    maxWidth: 240,
                    maxHeight: 40,
                    maxContainerTextLength: 72,
                    horizontalWeight: 0.04
                })
            }))
            .filter(item => Number.isFinite(item.score))
            .sort((a, b) => b.score - a.score)[0]?.el || null;
        if (directMatch) return directMatch;

        const modeButton = findModeButton();
        if (!modeButton) return null;

        const modeRect = modeButton.getBoundingClientRect();
        return uniqueElements([
            ...queryAllVisible('button, [role="button"], a, div', composer),
            ...queryAllVisible('button, [role="button"], a, div', document)
        ].map(resolveTrigger).filter(isVisible))
            .filter(el => el !== modeButton)
            .map((el) => {
                const rect = el.getBoundingClientRect();
                const centerY = rect.top + (rect.height / 2);
                const modeCenterY = modeRect.top + (modeRect.height / 2);
                const horizontalGap = rect.left - modeRect.right;
                const leafText = getBestLeafTextMatch(el, MODEL_TEXT_HINT_MATCHER, { maxLength: 48 });
                const ariaText = normalizeText(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '');
                const combinedText = normalizeText([leafText, ariaText, textOf(el)].filter(Boolean).join(' '));
                const cls = getClassName(el).toLowerCase();

                if (rect.width < 40 || rect.width > 260 || rect.height < 18 || rect.height > 44) return { el, score: -Infinity };
                if (horizontalGap < -8 || horizontalGap > 220) return { el, score: -Infinity };
                if (Math.abs(centerY - modeCenterY) > 24) return { el, score: -Infinity };
                if (/^(send|stop|new chat|attach|more actions)/i.test(combinedText)) return { el, score: -Infinity };
                if (MODE_TEXT_MATCHER.test(combinedText) && !MODEL_TEXT_HINT_MATCHER.test(combinedText)) return { el, score: -Infinity };

                let score = 40 - Math.abs(centerY - modeCenterY) - Math.max(0, horizontalGap);
                if (isPlausibleModelText(leafText)) score += 35;
                if (isPlausibleModelText(ariaText)) score += 28;
                if (MODEL_TEXT_HINT_MATCHER.test(combinedText)) score += 14;
                if (cls.includes('dropdown') || cls.includes('chip') || cls.includes('composer')) score += 6;
                if (el.querySelector?.('svg, .codicon-chevron-down, .codicon-chevron-up, .codicon-chevron-small-down')) score += 4;
                return { el, score };
            })
            .filter(item => Number.isFinite(item.score) && item.score > 0)
            .sort((a, b) => b.score - a.score)[0]?.el || null;
    };

    const collectMessageNodes = () => {
        const panel = findPanel();
        if (!panel) return [];

        const candidates = Array.from(panel.querySelectorAll('.composer-message-group, .relative.composer-rendered-message, .composer-tool-former-message, .markdown-root, [class*="message"]')).filter(isVisible);
        const nodes = [];

        for (const el of candidates) {
            if (el.closest('.composer-input-blur-wrapper, .ai-input-full-input-box, .simple-find-part-wrapper, .compact-agent-history-react-menu-content, .ui-menu__content')) continue;
            if (nodes.some(existing => existing.contains(el))) continue;
            nodes.push(el);
        }

        return nodes;
    };

    return {
        getClassName,
        isVisible,
        isTabActive,
        textOf,
        queryAllVisible,
        findPanel,
        findEditor,
        findPanelScrollRoot,
        findChatTabsContainer,
        getChatTabElements,
        click,
        focusEditor,
        setEditorText,
        getChatTabs,
        getActiveChatTitle,
        findNewChatButton,
        findHistoryButton,
        findAttachButton,
        findHistoryMenu,
        findMenuContainers,
        getMenuItems,
        getMenuItemTexts,
        findModelSearchInput,
        findModelMenuRoot,
        getSwitchState,
        setInputValue,
        getModelMenuRows,
        findModelToggleRow,
        getModelMenuState,
        getHistoryItems,
        findSendButton,
        findStopButton,
        getComposerStatus,
        isBusy,
        getModeText,
        getModelText,
        findDropdownMenuItem,
        findModeButton,
        findModelButton,
        collectMessageNodes
    };
})();
`;

function getOrderedContexts(cdp) {
    return [...(cdp?.contexts || [])].sort((a, b) => Number(!!b?.auxData?.isDefault) - Number(!!a?.auxData?.isDefault));
}

function getExceptionMessage(exceptionDetails) {
    return exceptionDetails?.exception?.description ||
        exceptionDetails?.text ||
        exceptionDetails?.exception?.value ||
        'Runtime.evaluate failed';
}

function buildCursorExpression(body) {
    return `(async () => { ${CURSOR_UI_HELPERS}\n${body}\n})()`;
}

async function evaluateCursor(cdp, body, {
    accept = (value) => value !== undefined && value !== null && !value?.error,
    awaitPromise = true,
    returnByValue = true
} = {}) {
    const contexts = getOrderedContexts(cdp);
    if (!contexts.length) {
        return { error: 'No execution contexts available' };
    }

    let lastError = null;
    let lastValue = null;

    for (const ctx of contexts) {
        try {
            const result = await cdp.call('Runtime.evaluate', {
                expression: buildCursorExpression(body),
                returnByValue,
                awaitPromise,
                contextId: ctx.id
            });

            if (result.exceptionDetails) {
                lastError = getExceptionMessage(result.exceptionDetails);
                continue;
            }

            const value = result.result?.value;
            if (accept(value)) {
                return value;
            }

            if (value !== undefined) {
                lastValue = value;
                if (value?.error) lastError = value.error;
            }
        } catch (error) {
            lastError = error.message;
        }
    }

    return lastValue ?? { error: lastError || 'No matching DOM context' };
}

async function clickAtPoint(cdp, x, y) {
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

// Kill any existing process on the server port (prevents EADDRINUSE)
async function killPortProcess(port) {
    // Step 1: Find and kill processes on the port
    try {
        if (process.platform === 'win32') {
            const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            const lines = result.trim().split('\n');
            const pids = new Set();
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && pid !== '0' && pid !== String(process.pid)) pids.add(pid);
            }
            for (const pid of pids) {
                try {
                    execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
                    console.log(`Ã¢Å¡Â Ã¯Â¸Â  Killed existing process on port ${port} (PID: ${pid})`);
                } catch (e) { /* Process may have already exited */ }
            }
        } else {
            const result = execSync(`lsof -ti:${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            const pids = result.trim().split('\n').filter(p => p);
            for (const pid of pids) {
                try {
                    execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
                    console.log(`Ã¢Å¡Â Ã¯Â¸Â  Killed existing process on port ${port} (PID: ${pid})`);
                } catch (e) { /* Process may have already exited */ }
            }
        }
    } catch (e) {
        // No process found on port - this is fine
    }

    // Step 2: Wait until port is actually free (max 5 seconds)
    const maxWait = 5000;
    const checkInterval = 200;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        const isFree = await new Promise(resolve => {
            const testServer = http.createServer();
            testServer.once('error', () => resolve(false));
            testServer.once('listening', () => {
                testServer.close(() => resolve(true));
            });
            testServer.listen(port, '0.0.0.0');
        });
        if (isFree) {
            console.log(`Ã¢Å“â€¦ Port ${port} is free`);
            return;
        }
        await new Promise(r => setTimeout(r, checkInterval));
    }
    console.warn(`Ã¢Å¡Â Ã¯Â¸Â  Port ${port} may still be in use after ${maxWait}ms wait`);
}

// Get local IP address for mobile access
// Prefers real network IPs (192.168.x.x, 10.x.x.x) over virtual adapters (172.x.x.x from WSL/Docker)
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    const candidates = [];

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                candidates.push({
                    address: iface.address,
                    name: name,
                    // Prioritize common home/office network ranges
                    priority: iface.address.startsWith('192.168.') ? 1 :
                        iface.address.startsWith('10.') ? 2 :
                            iface.address.startsWith('172.') ? 3 : 4
                });
            }
        }
    }

    // Sort by priority and return the best one
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates.length > 0 ? candidates[0].address : 'localhost';
}

// Helper: HTTP GET JSON
function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getcursorStoragePath() {
    if (process.platform === 'win32' && process.env.APPDATA) {
        return join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'storage.json');
    }

    if (process.platform === 'darwin' && process.env.HOME) {
        return join(process.env.HOME, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'storage.json');
    }

    if (process.env.XDG_CONFIG_HOME) {
        return join(process.env.XDG_CONFIG_HOME, 'Cursor', 'User', 'globalStorage', 'storage.json');
    }

    if (process.env.HOME) {
        return join(process.env.HOME, '.config', 'Cursor', 'User', 'globalStorage', 'storage.json');
    }

    return null;
}

function findRecentcursorWorkspace() {
    const storagePath = getcursorStoragePath();
    if (!storagePath || !fs.existsSync(storagePath)) {
        return null;
    }

    try {
        const raw = fs.readFileSync(storagePath, 'utf8').replace(/^\uFEFF/, '');
        const storage = JSON.parse(raw);
        const folderUris = [
            storage?.windowsState?.lastActiveWindow?.folder,
            ...(storage?.backupWorkspaces?.folders || []).map(folder => folder?.folderUri)
        ].filter(Boolean);

        for (const folderUri of folderUris) {
            try {
                const workspacePath = fileURLToPath(folderUri);
                if (workspacePath && fs.existsSync(workspacePath)) {
                    return workspacePath;
                }
            } catch (error) {
                console.warn(`Ignoring invalid Cursor workspace URI: ${folderUri}`);
            }
        }
    } catch (error) {
        console.warn(`Failed to read cursor storage: ${error.message}`);
    }

    return null;
}

function getTargetWorkspace() {
    return findRecentcursorWorkspace() || process.cwd();
}

function findCommandOnPath(command) {
    const locator = process.platform === 'win32' ? 'where' : 'which';

    try {
        const output = execSync(`${locator} ${command}`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        return output.split(/\r?\n/).find(Boolean) || null;
    } catch (error) {
        return null;
    }
}

function findcursorExecutable() {
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
        const defaultPath = join(process.env.LOCALAPPDATA, 'Programs', 'Cursor', 'Cursor.exe');
        if (fs.existsSync(defaultPath)) {
            return defaultPath;
        }
    }

    return findCommandOnPath(process.platform === 'win32' ? 'Cursor.exe' : 'Cursor')
        || (process.platform === 'win32' ? findCommandOnPath('Cursor') : null);
}

function iscursorRunning() {
    try {
        if (process.platform === 'win32') {
            const output = execSync('tasklist /FI "IMAGENAME eq Cursor.exe"', {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
            return output.toLowerCase().includes('cursor.exe');
        }

        execSync('pgrep -f cursor', { stdio: 'ignore' });
        return true;
    } catch (error) {
        return false;
    }
}

function killcursorProcesses() {
    try {
        if (process.platform === 'win32') {
            execSync('taskkill /F /IM Cursor.exe', { stdio: 'ignore' });
            return;
        }

        execSync('pkill -f cursor', { stdio: 'ignore' });
    } catch (error) {
        // Ignore "not running" failures.
    }
}

async function waitForCDP(timeoutMs = 30000) {
    const start = Date.now();

    while ((Date.now() - start) < timeoutMs) {
        try {
            await discoverCDP();
            return true;
        } catch (error) {
            await sleep(1000);
        }
    }

    return false;
}

async function launchcursorWithCDP() {
    if (!AUTO_LAUNCH_cursor) {
        return { skipped: true };
    }

    if (cursorLaunchPromise) {
        return cursorLaunchPromise;
    }

    cursorLaunchPromise = (async () => {
        const executable = findcursorExecutable();
        if (!executable) {
            console.warn('Cursor executable not found. Start Cursor manually with CDP enabled.');
            return { attempted: false, reason: 'missing-executable' };
        }

        const targetWorkspace = getTargetWorkspace();

        // Step 1: Ensure argv.json has remote-debugging-port
        // Cursor 2.6.13+ rejects --remote-debugging-port as CLI flag
        // but reads it from %APPDATA%\Cursor\argv.json (Electron/VS Code pattern)
        const argvInjected = ensureCursorArgvCDP(PRIMARY_CDP_PORT);
        if (argvInjected) {
            console.log(`âœ… Injected remote-debugging-port=${PRIMARY_CDP_PORT} into Cursor argv.json`);
        }

        // Step 2: Kill and restart Cursor so it picks up the new argv.json
        if (iscursorRunning()) {
            console.log(`Cursor is running without CDP. Restarting to enable CDP on port ${PRIMARY_CDP_PORT}...`);
            killcursorProcesses();
            await sleep(2500);
        } else {
            console.log(`Cursor is not running. Launching with CDP on port ${PRIMARY_CDP_PORT}...`);
        }

        console.log(`Opening Cursor on workspace: ${targetWorkspace}`);
        if (FORCE_VISIBLE_CURSOR) {
            console.log('Cursor launch mode: visible window');
        }

        // Step 3: Launch Cursor - use multiple strategies
        let launched = false;
        let ready = false;

        // Strategy A: Direct spawn with CLI flag (works on Antigravity, may work on older Cursor)
        try {
            const child = spawn(executable, [
                targetWorkspace,
                `--remote-debugging-port=${PRIMARY_CDP_PORT}`
            ], {
                detached: true,
                stdio: 'ignore',
                windowsHide: !FORCE_VISIBLE_CURSOR
            });

            // Listen for quick exit (bad option rejection)
            const quickExitCode = await Promise.race([
                new Promise(resolve => child.on('exit', resolve)),
                new Promise(resolve => setTimeout(() => resolve(null), 3000)) // null = still running after 3s
            ]);

            if (quickExitCode === null) {
                // Process still running after 3s â€” CLI flag accepted
                child.unref();
                launched = true;
                console.log('Cursor launched with --remote-debugging-port CLI flag');
            } else if (quickExitCode === 9 || quickExitCode === 1) {
                // Exit code 9 = "bad option" â€” Cursor rejected the CLI flag
                console.log(`Cursor rejected --remote-debugging-port CLI flag (exit ${quickExitCode}), using argv.json fallback`);
                ready = await waitForCDP(10000);
                if (ready) {
                    launched = true;
                    console.log('Cursor exposed CDP after launcher exit; skipping argv.json fallback');
                }
            } else if (quickExitCode === 0) {
                // Exit 0 = single-instance detected, delegated to existing process
                console.log('Cursor delegated to existing instance (exit 0)');
                launched = true;
            }
        } catch (error) {
            console.warn(`Strategy A (direct spawn) failed: ${error.message}`);
        }

        // Strategy B: Launch via cmd start (simulates double-click, allows argv.json to take effect)
        if (!launched) {
            try {
                const child = spawn('cmd', ['/c', 'start', '', executable, targetWorkspace], {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: true
                });
                child.unref();
                launched = true;
                console.log('Cursor launched via cmd start (argv.json approach)');
            } catch (error) {
                console.warn(`Strategy B (cmd start) failed: ${error.message}`);
            }
        }

        // Strategy C: Launch via explorer.exe (last resort, simulates Windows shell activation)
        if (!launched) {
            try {
                const child = spawn('explorer.exe', [executable], {
                    detached: true,
                    stdio: 'ignore'
                });
                child.unref();
                launched = true;
                console.log('Cursor launched via explorer.exe (shell activation)');
            } catch (error) {
                console.error(`All launch strategies failed. Last error: ${error.message}`);
                return { attempted: false, reason: 'spawn-failed', error: error.message };
            }
        }

        if (!ready) {
            ready = await waitForCDP(45000); // Longer timeout for Cursor startup
        }
        if (ready) {
            console.log(`âœ… Cursor CDP is ready on port ${PRIMARY_CDP_PORT}.`);
        } else {
            console.warn('âš ï¸  Cursor launched, but CDP is still not available after 45s.');
            console.warn('   Ensure Cursor reads argv.json from: ' + getCursorArgvPath());
            console.warn('   Or start Cursor manually with: --remote-debugging-port=9000');
        }

        return { attempted: true, ready, targetWorkspace };
    })().finally(() => {
        cursorLaunchPromise = null;
    });

    return cursorLaunchPromise;
}

// Inject remote-debugging-port into Cursor's argv.json
// Cursor 2.6.13+ reads Electron flags from %APPDATA%\Cursor\argv.json
function getCursorArgvPath() {
    if (process.platform === 'win32' && process.env.APPDATA) {
        return join(process.env.APPDATA, 'Cursor', 'argv.json');
    }
    if (process.platform === 'darwin' && process.env.HOME) {
        return join(process.env.HOME, 'Library', 'Application Support', 'Cursor', 'argv.json');
    }
    if (process.env.HOME) {
        return join(process.env.HOME, '.config', 'Cursor', 'argv.json');
    }
    return null;
}

function ensureCursorArgvCDP(port) {
    const argvPath = getCursorArgvPath();
    if (!argvPath) return false;

    try {
        // Read existing argv.json if present
        let argv = {};
        if (fs.existsSync(argvPath)) {
            const raw = fs.readFileSync(argvPath, 'utf8')
                .replace(/^\uFEFF/, '') // strip BOM
                .replace(/\/\/.*/g, ''); // strip single-line comments (JSON5-like)
            try {
                argv = JSON.parse(raw);
            } catch (e) {
                console.warn(`Could not parse existing argv.json, will overwrite: ${e.message}`);
                argv = {};
            }
        }

        // Check if already configured
        if (argv['remote-debugging-port'] === port) {
            return true;
        }

        // Inject CDP port
        argv['remote-debugging-port'] = port;

        // Ensure directory exists
        const dir = dirname(argvPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(argvPath, JSON.stringify(argv, null, 4), 'utf8');
        return true;
    } catch (error) {
        console.error(`Failed to write Cursor argv.json: ${error.message}`);
        return false;
    }
}

// Find Cursor CDP endpoint (with identity verification to avoid connecting to Antigravity or other Electron apps)
async function discoverCDP() {
    const errors = [];
    for (const port of PORTS) {
        try {
            // Step 1: Verify this CDP port belongs to Cursor via /json/version
            let isCursorApp = false;
            try {
                const versionInfo = await getJson(`http://127.0.0.1:${port}/json/version`);
                const browser = (versionInfo.Browser || '').toLowerCase();
                const userAgent = (versionInfo['User-Agent'] || '').toLowerCase();
                if (browser.includes('cursor') || userAgent.includes('cursor')) {
                    isCursorApp = true;
                } else {
                    console.log(`âš ï¸  Port ${port} belongs to "${versionInfo.Browser || 'unknown'}" (not Cursor) â€” skipping`);
                    continue;
                }
            } catch (verErr) {
                // /json/version failed but /json/list might still work â€” proceed with URL-based check
            }

            // Step 2: Discover targets from this verified Cursor port
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);

            // Extra safety: if /json/version was unavailable, filter out non-Cursor targets by URL
            const isCursorTarget = (t) => {
                if (isCursorApp) return true; // Already verified at port level
                const url = (t.url || '').toLowerCase();
                const title = (t.title || '').toLowerCase();
                // Reject targets that clearly belong to Antigravity
                if (url.includes('antigravity') || title.includes('antigravity')) return false;
                return true;
            };

            // Priority 1: Standard Workbench (The main window)
            const workbench = list.find(t => isCursorTarget(t) && (t.url?.includes('workbench.html') || (t.title && t.title.includes('workbench'))));
            if (workbench && workbench.webSocketDebuggerUrl) {
                console.log('âœ… Found Cursor Workbench target:', workbench.title, `(port ${port})`);
                return { port, url: workbench.webSocketDebuggerUrl };
            }

            // Priority 2: Jetski/Launchpad (Fallback)
            const jetski = list.find(t => isCursorTarget(t) && (t.url?.includes('jetski') || t.title === 'Launchpad'));
            if (jetski && jetski.webSocketDebuggerUrl) {
                console.log('âœ… Found Cursor Jetski/Launchpad target:', jetski.title, `(port ${port})`);
                return { port, url: jetski.webSocketDebuggerUrl };
            }

            if (isCursorApp) {
                errors.push(`${port}: Cursor running but no workbench target found`);
            }
        } catch (e) {
            errors.push(`${port}: ${e.message}`);
        }
    }
    const errorSummary = errors.length ? `Errors: ${errors.join(', ')}` : 'No ports responding';
    throw new Error(`Cursor CDP not found. ${errorSummary}`);
}

// Connect to CDP
async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const pendingCalls = new Map(); // Track pending calls by ID
    const contexts = [];
    const CDP_CALL_TIMEOUT = 30000; // 30 seconds timeout

    // Single centralized message handler (fixes MaxListenersExceeded warning)
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            // Handle CDP method responses
            if (data.id !== undefined && pendingCalls.has(data.id)) {
                const { resolve, reject, timeoutId } = pendingCalls.get(data.id);
                clearTimeout(timeoutId);
                pendingCalls.delete(data.id);

                if (data.error) reject(data.error);
                else resolve(data.result);
            }

            // Handle execution context events
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const id = data.params.executionContextId;
                const idx = contexts.findIndex(c => c.id === id);
                if (idx !== -1) contexts.splice(idx, 1);
            } else if (data.method === 'Runtime.executionContextsCleared') {
                contexts.length = 0;
            }
        } catch (e) { }
    });

    // Handle CDP WebSocket disconnect - triggers auto-reconnect in polling loop
    ws.on('close', () => {
        console.warn('Ã°Å¸â€Å’ CDP WebSocket closed - will auto-reconnect');
        // Reject all pending calls
        for (const [id, { reject, timeoutId }] of pendingCalls) {
            clearTimeout(timeoutId);
            reject(new Error('CDP connection closed'));
        }
        pendingCalls.clear();
        cdpConnection = null;
    });

    ws.on('error', (err) => {
        console.error('Ã°Å¸â€Å’ CDP WebSocket error:', err.message);
        // Don't null cdpConnection here - 'close' event will handle it
    });

    const call = (method, params) => new Promise((resolve, reject) => {
        // Check if WebSocket is still open before sending
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return reject(new Error('CDP WebSocket not open'));
        }

        const id = idCounter++;

        // Setup timeout to prevent memory leaks from never-resolved calls
        const timeoutId = setTimeout(() => {
            if (pendingCalls.has(id)) {
                pendingCalls.delete(id);
                reject(new Error(`CDP call ${method} timed out after ${CDP_CALL_TIMEOUT}ms`));
            }
        }, CDP_CALL_TIMEOUT);

        pendingCalls.set(id, { resolve, reject, timeoutId });

        try {
            ws.send(JSON.stringify({ id, method, params }));
        } catch (e) {
            clearTimeout(timeoutId);
            pendingCalls.delete(id);
            reject(new Error(`CDP send failed: ${e.message}`));
        }
    });

    await call("Runtime.enable", {});
    await new Promise(r => setTimeout(r, 1000));

    return { ws, call, contexts };
}

// Capture chat snapshot
async function captureSnapshot(cdp) {
    const result = await evaluateCursor(cdp, `
        const panel = __cr.findPanel();
        const editor = __cr.findEditor();
        const chatTabs = __cr.getChatTabs();
        const activeChatTitle = __cr.getActiveChatTitle();

        if (!panel || !editor) {
            return {
                error: 'chat panel not found',
                debug: {
                    hasPanel: !!panel,
                    hasEditor: !!editor,
                    knownIds: Array.from(document.querySelectorAll('[id]')).slice(0, 80).map(el => el.id)
                }
            };
        }

        const clone = panel.cloneNode(true);
        clone.querySelectorAll('.composite.title, .title-actions, .simple-find-part-wrapper, .composer-input-blur-wrapper, .ai-input-full-input-box, .compact-agent-history-react-menu-content, .ui-menu__content, .context-view, .announcement-modal, .announcement-modal-close-button').forEach(el => el.remove());

        const scrollTarget = __cr.findPanelScrollRoot() || panel;
        const bodyStyles = getComputedStyle(document.body);
        const panelStyles = getComputedStyle(panel);
        const rootStyles = getComputedStyle(document.documentElement);

        const themeVars = {};
        [
            '--vscode-editor-background', '--vscode-editor-foreground',
            '--vscode-sideBar-background', '--vscode-panel-background',
            '--vscode-input-background', '--vscode-input-foreground',
            '--vscode-foreground', '--vscode-descriptionForeground',
            '--vscode-textLink-foreground', '--vscode-button-background',
            '--vscode-badge-background', '--vscode-badge-foreground',
            '--vscode-list-activeSelectionBackground',
            '--vscode-editorWidget-background',
            '--vscode-activityBar-background',
            '--vscode-tab-activeBackground'
        ].forEach(name => {
            const value = rootStyles.getPropertyValue(name).trim();
            if (value) themeVars[name] = value;
        });

        const html = clone.outerHTML;

        return {
            html,
            css: '',
            backgroundColor: panelStyles.backgroundColor || bodyStyles.backgroundColor,
            bodyBackgroundColor: bodyStyles.backgroundColor,
            color: panelStyles.color || bodyStyles.color,
            bodyColor: bodyStyles.color,
            fontFamily: panelStyles.fontFamily || bodyStyles.fontFamily,
            chatTabs,
            activeChatTitle,
            themeVars,
            scrollInfo: {
                scrollTop: scrollTarget.scrollTop || 0,
                scrollHeight: scrollTarget.scrollHeight || 0,
                clientHeight: scrollTarget.clientHeight || 0,
                scrollPercent: scrollTarget.scrollHeight > scrollTarget.clientHeight
                    ? (scrollTarget.scrollTop / (scrollTarget.scrollHeight - scrollTarget.clientHeight))
                    : 0
            },
            stats: {
                nodes: clone.getElementsByTagName('*').length,
                htmlSize: html.length,
                cssSize: 0
            }
        };
    `, {
        accept: (value) => value && !value.error && !!value.html
    });

    return result && !result.error ? result : null;
}

// Inject message into Cursor
async function injectMessage(cdp, text) {
    const safeText = JSON.stringify(text);
    const prepared = await evaluateCursor(cdp, `
        const editor = __cr.findEditor();
        if (!editor) return { ok: false, error: 'editor_not_found' };
        if (__cr.isBusy()) return { ok: false, reason: 'busy', status: __cr.getComposerStatus() };

        const textToInsert = ${safeText};
        __cr.setEditorText(editor, textToInsert);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const sendButton = __cr.findSendButton();
        const sendRect = sendButton ? sendButton.getBoundingClientRect() : null;

        return {
            ok: true,
            editorText: __cr.textOf(editor),
            sendButton: sendRect ? {
                x: sendRect.left + (sendRect.width / 2),
                y: sendRect.top + (sendRect.height / 2)
            } : null
        };
    `, {
        accept: (value) => value && typeof value === 'object' && !value.error
    });

    if (!prepared?.ok) {
        return prepared || { ok: false, reason: 'prepare_failed' };
    }

    try {
        await cdp.call('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13
        });
        await cdp.call('Input.dispatchKeyEvent', {
            type: 'char',
            key: '\r',
            code: 'Enter',
            text: '\r',
            unmodifiedText: '\r',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13
        });
        await cdp.call('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13
        });
    } catch (error) {
        console.warn('CDP Enter dispatch failed, falling back to DOM click only:', error.message);
    }

    await new Promise(resolve => setTimeout(resolve, 200));

    let finalState = await evaluateCursor(cdp, `
        const editor = __cr.findEditor();
        const sendButton = __cr.findSendButton();
        const sendRect = sendButton ? sendButton.getBoundingClientRect() : null;
        return {
            editorTextAfter: editor ? __cr.textOf(editor) : '',
            hasMessagesAfter: __cr.collectMessageNodes().length > 0,
            busyAfter: __cr.isBusy(),
            sendButton: sendRect ? {
                x: sendRect.left + (sendRect.width / 2),
                y: sendRect.top + (sendRect.height / 2)
            } : null
        };
    `, {
        accept: (value) => value && typeof value === 'object' && !value.error
    });

    let method = 'cdp_enter';

    if (finalState?.editorTextAfter && finalState.sendButton) {
        try {
            await cdp.call('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: finalState.sendButton.x,
                y: finalState.sendButton.y
            });
            await cdp.call('Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: finalState.sendButton.x,
                y: finalState.sendButton.y,
                button: 'left',
                clickCount: 1
            });
            await cdp.call('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: finalState.sendButton.x,
                y: finalState.sendButton.y,
                button: 'left',
                clickCount: 1
            });
            method = 'cdp_enter_then_mouse_send';
            await new Promise(resolve => setTimeout(resolve, 250));
            finalState = await evaluateCursor(cdp, `
                const editor = __cr.findEditor();
                return {
                    editorTextAfter: editor ? __cr.textOf(editor) : '',
                    hasMessagesAfter: __cr.collectMessageNodes().length > 0,
                    busyAfter: __cr.isBusy()
                };
            `, {
                accept: (value) => value && typeof value === 'object'
            });
        } catch (error) {
            console.warn('CDP mouse send fallback failed:', error.message);
        }
    }

    return {
        ok: !finalState?.editorTextAfter,
        method,
        editorTextAfter: finalState?.editorTextAfter || '',
        hasMessagesAfter: !!finalState?.hasMessagesAfter,
        busyAfter: !!finalState?.busyAfter
    };
}

// Inject file into Cursor via CDP file chooser
async function injectFile(cdp, filePath) {
    // Normalize to absolute Windows path for CDP
    const absolutePath = filePath.startsWith('/') ? filePath : join(__dirname, filePath).replace(/\\/g, '/');
    const winPath = absolutePath.replace(/\//g, '\\');

    console.log(`Ã°Å¸â€œâ€š Injecting file via CDP: ${winPath}`);

    try {
        // Step 1: Enable file chooser interception
        await cdp.call("Page.setInterceptFileChooserDialog", { enabled: true });

        // Step 2: Set up a promise to wait for the file chooser event
        const fileChooserPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cdp.ws.removeListener('message', handler);
                reject(new Error('File chooser did not open within 5s'));
            }, 5000);

            const handler = (rawMsg) => {
                try {
                    const msg = JSON.parse(rawMsg);
                    if (msg.method === 'Page.fileChooserOpened') {
                        clearTimeout(timeout);
                        cdp.ws.removeListener('message', handler);
                        resolve(msg.params);
                    }
                } catch (e) { /* ignore parse errors */ }
            };
            cdp.ws.on('message', handler);
        });

        // Step 3: Click the context/media "+" button in IDE (bottom-left, near editor)
        const clickResult = await clickContextPlusButton(cdp);
        console.log(`Ã°Å¸â€“Â±Ã¯Â¸Â Click context+ result:`, clickResult);

        if (!clickResult.success) {
            // Disable interception before returning
            try { await cdp.call("Page.setInterceptFileChooserDialog", { enabled: false }); } catch (e) { }
            return { success: false, error: 'Could not find context+ button in IDE', details: clickResult };
        }

        // Step 4: Wait for file chooser to open, then accept with our file
        try {
            const chooserParams = await fileChooserPromise;
            console.log(`Ã°Å¸â€œÂ File chooser opened, mode: ${chooserParams.mode}`);

            await cdp.call("Page.handleFileChooser", {
                action: "accept",
                files: [winPath]
            });

            console.log(`Ã¢Å“â€¦ File injected successfully: ${winPath}`);

            // Disable interception
            try { await cdp.call("Page.setInterceptFileChooserDialog", { enabled: false }); } catch (e) { }

            return { success: true, method: 'file_chooser', path: winPath };
        } catch (e) {
            // File chooser didn't open - perhaps the button doesn't open file dialog
            // Try fallback: drag-and-drop via CDP Input events
            console.warn(`Ã¢Å¡Â Ã¯Â¸Â File chooser approach failed: ${e.message}. Trying fallback...`);
            try { await cdp.call("Page.setInterceptFileChooserDialog", { enabled: false }); } catch (e2) { }

            // Fallback: Use DOM.setFileInputFiles if there's a file input
            return await injectFileViaInput(cdp, winPath);
        }
    } catch (e) {
        try { await cdp.call("Page.setInterceptFileChooserDialog", { enabled: false }); } catch (e2) { }
        console.error(`Ã¢ÂÅ’ File injection error: ${e.message}`);
        return { success: false, error: e.message };
    }
}

// Click the context/media "+" button in IDE (NOT the "new conversation" + button)
async function clickContextPlusButton(cdp) {
    return await evaluateCursor(cdp, `
        const editor = __cr.findEditor();
        if (!editor) return { success: false, error: 'editor_not_found' };

        const attachButton = __cr.findAttachButton();
        if (!attachButton) {
            return { success: false, error: 'attach_button_not_found' };
        }

        __cr.click(attachButton);
        await new Promise(r => setTimeout(r, 150));

        return {
            success: true,
            method: 'attach_button',
            ariaLabel: attachButton.getAttribute('aria-label') || '',
            title: attachButton.getAttribute('title') || ''
        };
    `, {
        accept: (value) => value && typeof value === 'object' && !value.error
    });
}

// Fallback: inject file via DOM file input
async function injectFileViaInput(cdp, filePath) {
    const EXP = `(() => {
        const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
        if (fileInputs.length === 0) return { found: false };
        return { found: true, count: fileInputs.length };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                contextId: ctx.id
            });

            if (res.result?.value?.found) {
                // Use DOM.setFileInputFiles to set files on the input
                // First get the document
                const doc = await cdp.call("DOM.getDocument", { depth: 0 });
                const nodeResult = await cdp.call("DOM.querySelector", {
                    nodeId: doc.root.nodeId,
                    selector: 'input[type="file"]'
                });

                if (nodeResult.nodeId) {
                    await cdp.call("DOM.setFileInputFiles", {
                        files: [filePath],
                        nodeId: nodeResult.nodeId
                    });
                    return { success: true, method: 'dom_set_file_input' };
                }
            }
        } catch (e) {
            console.warn(`DOM file input fallback failed in context ${ctx.id}:`, e.message);
        }
    }
    return { success: false, error: 'No file input found in IDE' };
}

function getModeRequestCandidates(mode) {
    const normalized = String(mode || '').trim();
    if (!normalized) return [];

    const lower = normalized.toLowerCase();
    if (lower === 'agent' || lower === 'fast') return ['Agent', 'Fast'];
    if (lower === 'plan' || lower === 'planning') return ['Plan', 'Planning'];
    if (lower === 'debug' || lower === 'manual') return ['Debug', 'Manual'];
    if (lower === 'ask') return ['Ask'];
    return [normalized];
}

// Set functionality mode (Fast vs Planning)
async function setMode(cdp, mode) {
    const targetMode = String(mode || '').trim();
    if (!targetMode) return { error: 'Invalid mode' };
    const requestedCandidates = getModeRequestCandidates(targetMode);
    const verifyModeState = async (fallbackAvailable = []) => {
        const verifiedState = await getDropdownOptions(cdp, 'mode');
        const verifiedCurrent = String(verifiedState?.current || '').trim();
        if (verifiedCurrent && requestedCandidates.some(candidate => verifiedCurrent.toLowerCase() === candidate.toLowerCase())) {
            return {
                success: true,
                currentMode: verifiedCurrent,
                available: verifiedState?.options || fallbackAvailable
            };
        }

        return {
            error: 'mode_apply_mismatch',
            currentMode: verifiedCurrent || 'Unknown',
            available: verifiedState?.options || fallbackAvailable
        };
    };

    const menuState = await getDropdownOptions(cdp, 'mode');
    const currentMode = String(menuState?.current || '').trim();
    if (currentMode && requestedCandidates.some((candidate) => currentMode.toLowerCase() === candidate.toLowerCase())) {
        return { success: true, alreadySet: true, currentMode };
    }

    if (!menuState?.buttonPoint) {
        return { error: 'mode_button_not_found' };
    }

    const directTarget = Array.isArray(menuState.targets)
        ? menuState.targets.find((target) => requestedCandidates.some((candidate) => String(target?.title || '').toLowerCase() === candidate.toLowerCase()))
        : null;
    if (!directTarget) {
        return {
            error: 'mode_option_not_found',
            currentMode: currentMode || 'Unknown',
            available: menuState.options || []
        };
    }

    await clickAtPoint(cdp, menuState.buttonPoint.x, menuState.buttonPoint.y);
    await new Promise((resolve) => setTimeout(resolve, 260));
    await clickAtPoint(cdp, directTarget.x, directTarget.y);
    await new Promise((resolve) => setTimeout(resolve, 260));

    const verified = await verifyModeState(menuState.options || []);
    if (verified?.success) return verified;

    const fallback = await evaluateCursor(cdp, `
        const requestedMode = ${JSON.stringify(targetMode)};
        const requestedCandidates = ${JSON.stringify(requestedCandidates)};
        let menus = __cr.findMenuContainers();
        const matchingMenus = menus.filter(menu => requestedCandidates.some(candidate => __cr.textOf(menu).toLowerCase().includes(candidate.toLowerCase())));
        if (matchingMenus.length) menus = matchingMenus;

        let option = null;
        for (const candidate of requestedCandidates) {
            option = __cr.findDropdownMenuItem(candidate, menus);
            if (option) break;
        }

        const available = __cr.getMenuItemTexts(menus).slice(0, 30);
        const closeMenu = () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
        };

        if (!option) {
            closeMenu();
            return {
                error: 'mode_option_not_found',
                currentMode: __cr.getModeText() || requestedMode,
                available
            };
        }

        __cr.click(option);
        await new Promise(r => setTimeout(r, 250));
        const appliedMode = __cr.getModeText() || requestedMode;
        closeMenu();

        if (!requestedCandidates.some(candidate => appliedMode.toLowerCase() === candidate.toLowerCase())) {
            return {
                error: 'mode_apply_mismatch',
                currentMode: appliedMode,
                available
            };
        }

        return {
            success: true,
            currentMode: appliedMode,
            available
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });

    if (fallback?.success) {
        const fallbackVerified = await verifyModeState(fallback.available || []);
        if (fallbackVerified?.success) return fallbackVerified;
    }

    return fallback || verified;
}

// Stop Generation
async function stopGeneration(cdp) {
    return await evaluateCursor(cdp, `
        if (!__cr.isBusy()) return { error: 'No active generation found to stop', status: __cr.getComposerStatus() || 'idle' };

        const stopButton = __cr.findStopButton();
        if (!stopButton) return { error: 'No active generation found to stop', status: __cr.getComposerStatus() || 'unknown' };
        __cr.click(stopButton);
        await new Promise(r => setTimeout(r, 300));
        return { success: true, status: __cr.getComposerStatus() || 'unknown' };
    `, {
        accept: (value) => value && typeof value === 'object'
    });
}

// Click Element (Remote)
async function clickElement(cdp, { selector, index, textContent }) {
    const safeSelector = JSON.stringify(selector || '*');
    const safeText = JSON.stringify(textContent || '');
    const targetIndex = Number.isFinite(Number(index)) ? Number(index) : 0;

    return await evaluateCursor(cdp, `
        const root = __cr.findPanel() || document;
        const query = ${safeSelector};
        const filterText = ${safeText};
        let elements = Array.from(root.querySelectorAll(query)).filter(__cr.isVisible);

        if (filterText) {
            elements = elements.filter(el => {
                const text = __cr.textOf(el);
                const firstLine = text.split('\\n')[0].trim();
                return firstLine === filterText || text.includes(filterText);
            });

            elements = elements.filter(el => !elements.some(other => other !== el && el.contains(other)));
        }

        const target = elements[${targetIndex}] || null;
        if (!target) {
            return {
                error: 'Element not found',
                found: elements.length,
                indexUsed: ${targetIndex}
            };
        }

        try { target.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* ignore */ }
        if (typeof target.focus === 'function') {
            try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        }
        __cr.click(target);
        await new Promise(r => setTimeout(r, 150));

        return {
            success: true,
            found: elements.length,
            indexUsed: ${targetIndex},
            text: __cr.textOf(target).slice(0, 120)
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });
}

// Remote scroll - sync phone scroll to desktop
async function remoteScroll(cdp, { scrollTop, scrollPercent }) {
    const numericScrollTop = Number.isFinite(Number(scrollTop)) ? Number(scrollTop) : 0;
    const normalizedPercent = Number.isFinite(Number(scrollPercent)) ? Math.min(1, Math.max(0, Number(scrollPercent))) : null;

    return await evaluateCursor(cdp, `
        const target = __cr.findPanelScrollRoot();
        if (!target) return { error: 'No scrollable element found' };

        const maxScroll = Math.max(target.scrollHeight - target.clientHeight, 0);
        if (${normalizedPercent === null ? 'null' : normalizedPercent} !== null) {
            target.scrollTop = maxScroll * ${normalizedPercent === null ? 0 : normalizedPercent};
        } else {
            target.scrollTop = Math.max(0, Math.min(${numericScrollTop}, maxScroll));
        }

        target.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        return {
            success: true,
            scrollTop: target.scrollTop,
            maxScroll,
            scrollPercent: maxScroll > 0 ? target.scrollTop / maxScroll : 0
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });
}

// Set AI Model
async function setModel(cdp, modelName) {
    const targetModel = String(modelName || '').trim();
    if (!targetModel) return { error: 'Invalid model' };

    const result = await evaluateCursor(cdp, `
        const requestedModel = ${JSON.stringify(targetModel)};
        let rootMenu = __cr.findModelMenuRoot();
        const modelButton = __cr.findModelButton();
        if (!modelButton && !rootMenu) return { error: 'model_button_not_found' };
        const escapeRegExp = (value) => String(value || '').replace(/[-/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
        const optionMatcher = new RegExp('^' + escapeRegExp(requestedModel) + '(?:\\\\b|\\\\s|$)', 'i');
        const waitForMenu = async () => {
            await new Promise(r => setTimeout(r, 250));
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        };
        const findOptionAnywhere = () => {
            const selector = 'button, [role="menuitem"], [role="option"], [role="button"], label, a, div';
            const seen = new Set();
            return Array.from(document.querySelectorAll(selector))
                .filter(el => __cr.isVisible(el))
                .map(el => el.closest(selector) || el)
                .filter(el => {
                    if (!el || seen.has(el)) return false;
                    seen.add(el);
                    return true;
                })
                .map(el => ({
                    element: el,
                    text: String(__cr.textOf(el) || '').replace(/\\s+/g, ' ').trim(),
                    rect: el.getBoundingClientRect()
                }))
                .filter(item =>
                    item.text &&
                    optionMatcher.test(item.text) &&
                    item.rect.width > 50 &&
                    item.rect.height >= 16 &&
                    item.rect.height <= 120
                )
                .sort((a, b) => {
                    const yDiff = a.rect.top - b.rect.top;
                    return Math.abs(yDiff) > 1 ? yDiff : a.rect.left - b.rect.left;
                })[0]?.element || null;
        };

        const currentModel = __cr.getModelText();
        if (currentModel && currentModel.toLowerCase() === requestedModel.toLowerCase()) {
            return { success: true, alreadySet: true, currentModel };
        }

        let menus = rootMenu ? [rootMenu] : __cr.findMenuContainers();
        let option = __cr.findDropdownMenuItem(requestedModel, menus) || findOptionAnywhere();
        let searchSubmitUsed = false;

        if (!option && modelButton) {
            __cr.click(modelButton);
            await waitForMenu();
            rootMenu = __cr.findModelMenuRoot();
            menus = rootMenu ? [rootMenu] : __cr.findMenuContainers();
            option = __cr.findDropdownMenuItem(requestedModel, menus) || findOptionAnywhere();
        }

        if (!option) {
            const searchInput = __cr.findModelSearchInput(rootMenu || document);
            if (searchInput) {
                __cr.setInputValue(searchInput, requestedModel);
                await new Promise(r => setTimeout(r, 180));
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                rootMenu = __cr.findModelMenuRoot();
                menus = rootMenu ? [rootMenu] : __cr.findMenuContainers();
                option = __cr.findDropdownMenuItem(requestedModel, menus) || findOptionAnywhere();
            }
        }

        if (!option && /^auto$/i.test(requestedModel)) {
            option = __cr.findModelToggleRow('Auto') || findOptionAnywhere();
        }

        if (!option && modelButton) {
            // Retry once in case the first click closed a menu that was already open.
            __cr.click(modelButton);
            await waitForMenu();
            rootMenu = __cr.findModelMenuRoot();
            menus = rootMenu ? [rootMenu] : __cr.findMenuContainers();
            option = __cr.findDropdownMenuItem(requestedModel, menus) || __cr.findModelToggleRow('Auto') || findOptionAnywhere();
            if (!option) {
                const searchInput = __cr.findModelSearchInput(rootMenu || document);
                if (searchInput) {
                    __cr.setInputValue(searchInput, requestedModel);
                    await new Promise(r => setTimeout(r, 180));
                    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                    rootMenu = __cr.findModelMenuRoot();
                    menus = rootMenu ? [rootMenu] : __cr.findMenuContainers();
                    option = __cr.findDropdownMenuItem(requestedModel, menus) || __cr.findModelToggleRow('Auto') || findOptionAnywhere();
                }
            }
        }

        const menuState = __cr.getModelMenuState();
        const available = Array.isArray(menuState.options) && menuState.options.length
            ? menuState.options.slice(0, 80)
            : __cr.getMenuItemTexts(menus).slice(0, 40);
        const toggleLabels = Array.isArray(menuState.toggles) ? menuState.toggles.map(toggle => toggle.label) : [];
        const availableWithToggles = [...new Set([...toggleLabels, ...available])];

        if (!option) {
            const searchInput = __cr.findModelSearchInput(rootMenu || document);
            if (searchInput) {
                searchInput.focus();
                __cr.setInputValue(searchInput, requestedModel);
                await new Promise(r => setTimeout(r, 180));
                const dispatchKey = (key) => {
                    const payload = { key, code: key, bubbles: true };
                    try { searchInput.dispatchEvent(new KeyboardEvent('keydown', payload)); } catch (e) { /* ignore */ }
                    try { searchInput.dispatchEvent(new KeyboardEvent('keyup', payload)); } catch (e) { /* ignore */ }
                    try { document.dispatchEvent(new KeyboardEvent('keydown', payload)); } catch (e) { /* ignore */ }
                    try { document.dispatchEvent(new KeyboardEvent('keyup', payload)); } catch (e) { /* ignore */ }
                };
                dispatchKey('ArrowDown');
                await new Promise(r => setTimeout(r, 80));
                dispatchKey('Enter');
                await new Promise(r => setTimeout(r, 260));
                searchSubmitUsed = true;
            }
        }

        if (!option && searchSubmitUsed) {
            const currentAfterSearchSubmit = __cr.getModelText();
            if (currentAfterSearchSubmit && currentAfterSearchSubmit.toLowerCase() === requestedModel.toLowerCase()) {
                return {
                    success: true,
                    currentModel: currentAfterSearchSubmit,
                    available: availableWithToggles,
                    via: 'search-submit'
                };
            }
        }

        if (!option) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
            return { error: 'model_option_not_found', currentModel, available: availableWithToggles };
        }

        __cr.click(option);
        await new Promise(r => setTimeout(r, 250));
        const appliedModel = __cr.getModelText() || requestedModel;
        if (appliedModel.toLowerCase() !== requestedModel.toLowerCase()) {
            return {
                error: 'model_apply_mismatch',
                currentModel: appliedModel,
                available: availableWithToggles
            };
        }

        return {
            success: true,
            currentModel: appliedModel,
            available: availableWithToggles
        };
    `, {
        accept: (value) => value && typeof value === 'object' && !value.error
    });

    if (result?.success) {
        return result;
    }

    const menuState = await getDropdownOptions(cdp, 'model');
    const currentModel = String(menuState?.current || result?.currentModel || '').trim();
    if (currentModel && currentModel.toLowerCase() === targetModel.toLowerCase()) {
        return { success: true, alreadySet: true, currentModel };
    }

    const targets = Array.isArray(menuState?.targets) ? menuState.targets : [];
    const targetEntry = /^auto$/i.test(targetModel)
        ? targets.find((target) => target.kind === 'toggle' && target.key === 'auto')
        : targets.find((target) => target.kind === 'option' && String(target.title || '').trim().toLowerCase() === targetModel.toLowerCase());

    if (menuState?.buttonPoint && !targetEntry) {
        await clickAtPoint(cdp, menuState.buttonPoint.x, menuState.buttonPoint.y);
        await new Promise((resolve) => setTimeout(resolve, 260));

        const searchFallback = await evaluateCursor(cdp, `
            const requestedModel = ${JSON.stringify(targetModel)};
            const waitForUi = async (delay = 180) => {
                await new Promise(r => setTimeout(r, delay));
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            };
            const dispatchKey = (target, key) => {
                const payload = { key, code: key, bubbles: true };
                try { target.dispatchEvent(new KeyboardEvent('keydown', payload)); } catch (e) { /* ignore */ }
                try { target.dispatchEvent(new KeyboardEvent('keyup', payload)); } catch (e) { /* ignore */ }
                try { document.dispatchEvent(new KeyboardEvent('keydown', payload)); } catch (e) { /* ignore */ }
                try { document.dispatchEvent(new KeyboardEvent('keyup', payload)); } catch (e) { /* ignore */ }
            };
            const closeMenu = () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
                document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
            };

            const searchInput = __cr.findModelSearchInput(__cr.findModelMenuRoot() || document) || __cr.findModelSearchInput(document);
            if (!searchInput) {
                closeMenu();
                return { error: 'model_search_input_not_found', currentModel: __cr.getModelText() || 'Unknown' };
            }

            __cr.setInputValue(searchInput, requestedModel);
            await waitForUi(180);

            let option = __cr.findDropdownMenuItem(requestedModel, __cr.findMenuContainers());
            if (option) {
                __cr.click(option);
                await waitForUi(260);
            } else {
                dispatchKey(searchInput, 'ArrowDown');
                await new Promise(r => setTimeout(r, 80));
                dispatchKey(searchInput, 'Enter');
                await waitForUi(260);
            }

            const currentModel = __cr.getModelText() || 'Unknown';
            closeMenu();
            if (currentModel.toLowerCase() !== requestedModel.toLowerCase()) {
                return { error: 'model_search_submit_failed', currentModel };
            }

            return {
                success: true,
                currentModel,
                via: 'search-fallback'
            };
        `, {
            accept: (value) => value && typeof value === 'object'
        });

        if (searchFallback?.success) {
            return {
                success: true,
                currentModel: searchFallback.currentModel || targetModel,
                available: menuState.options || []
            };
        }
    }

    if (!menuState?.buttonPoint || !targetEntry) {
        return result;
    }

    await clickAtPoint(cdp, menuState.buttonPoint.x, menuState.buttonPoint.y);
    await new Promise((resolve) => setTimeout(resolve, 260));
    await clickAtPoint(cdp, targetEntry.x, targetEntry.y);
    await new Promise((resolve) => setTimeout(resolve, 320));

    const refreshedMenuState = await getDropdownOptions(cdp, 'model');
    return {
        success: true,
        currentModel: refreshedMenuState.current || targetModel,
        available: refreshedMenuState.options || []
    };
}

async function setModelToggle(cdp, toggleKey, enabled) {
    const requestedToggle = String(toggleKey || '').trim().toLowerCase();
    if (!requestedToggle) return { error: 'Invalid toggle' };

    const toggleLabel = ({
        auto: 'Auto',
        'max-mode': 'MAX Mode',
        'multi-model': 'Use Multiple Models'
    })[requestedToggle] || toggleKey;

    const result = await evaluateCursor(cdp, `
        const requestedToggle = ${JSON.stringify(toggleLabel)};
        const desiredEnabled = ${enabled === undefined ? 'null' : JSON.stringify(!!enabled)};
        let rootMenu = __cr.findModelMenuRoot();
        const modelButton = __cr.findModelButton();
        if (!modelButton && !rootMenu) return { error: 'model_button_not_found' };
        const escapeRegExp = (value) => String(value || '').replace(/[-/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
        const toggleMatcher = new RegExp('^' + escapeRegExp(requestedToggle) + '(?:\\\\b|\\\\s)', 'i');

        const waitForMenu = async () => {
            await new Promise(r => setTimeout(r, 250));
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        };
        const findToggleRowAnywhere = () => {
            const selector = 'button, [role="menuitem"], [role="option"], [role="button"], label, a, div';
            const seen = new Set();
            return Array.from(document.querySelectorAll(selector))
                .filter(el => __cr.isVisible(el))
                .map(el => el.closest(selector) || el)
                .filter(el => {
                    if (!el || seen.has(el)) return false;
                    seen.add(el);
                    return true;
                })
                .map(el => ({
                    element: el,
                    text: String(__cr.textOf(el) || '').replace(/\\s+/g, ' ').trim(),
                    rect: el.getBoundingClientRect()
                }))
                .filter(item =>
                    item.text &&
                    toggleMatcher.test(item.text) &&
                    item.rect.width > 50 &&
                    item.rect.height >= 16 &&
                    item.rect.height <= 120 &&
                    !!(item.element.querySelector('[role="switch"], input[type="checkbox"], [aria-checked], [aria-pressed]') ||
                        item.element.closest('[role="switch"], [aria-checked], [aria-pressed]'))
                )
                .sort((a, b) => {
                    const yDiff = a.rect.top - b.rect.top;
                    return Math.abs(yDiff) > 1 ? yDiff : a.rect.left - b.rect.left;
                })[0]?.element || null;
        };

        let toggleRow = __cr.findModelToggleRow(requestedToggle, rootMenu) || findToggleRowAnywhere();
        if (!toggleRow && modelButton) {
            __cr.click(modelButton);
            await waitForMenu();
            rootMenu = __cr.findModelMenuRoot();
            toggleRow = __cr.findModelToggleRow(requestedToggle, rootMenu) || findToggleRowAnywhere();
        }

        if (!toggleRow && modelButton) {
            // If the menu was already open, the first click can close it. Retry once.
            __cr.click(modelButton);
            await waitForMenu();
            rootMenu = __cr.findModelMenuRoot();
            toggleRow = __cr.findModelToggleRow(requestedToggle, rootMenu) || findToggleRowAnywhere();
        }

        const menuState = __cr.getModelMenuState();
        if (!toggleRow) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
            return {
                error: 'model_toggle_not_found',
                requestedToggle,
                toggles: menuState.toggles || []
            };
        }

        const wasEnabled = __cr.getSwitchState(toggleRow);
        if (desiredEnabled === null || wasEnabled !== desiredEnabled) {
            __cr.click(toggleRow);
            await new Promise(r => setTimeout(r, 220));
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        }

        const updatedState = __cr.getModelMenuState();
        const updatedToggle = Array.isArray(updatedState.toggles)
            ? updatedState.toggles.find((toggle) =>
                toggle?.key === requestedToggle.toLowerCase().replace(/\s+/g, '-')
                || String(toggle?.label || '').trim().toLowerCase() === requestedToggle.toLowerCase()
            )
            : null;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));

        if (desiredEnabled !== null && (!updatedToggle || updatedToggle.enabled !== desiredEnabled)) {
            return {
                error: 'model_toggle_apply_mismatch',
                toggles: updatedState.toggles || [],
                currentModel: updatedState.current || __cr.getModelText() || 'Unknown'
            };
        }

        return {
            success: true,
            toggles: updatedState.toggles || [],
            currentModel: updatedState.current || __cr.getModelText() || 'Unknown'
        };
    `, {
        accept: (value) => value && typeof value === 'object' && !value.error
    });

    if (result?.success) {
        return result;
    }

    const menuState = await getDropdownOptions(cdp, 'model');
    const currentToggle = Array.isArray(menuState?.toggles)
        ? menuState.toggles.find((toggle) =>
            toggle?.key === requestedToggle ||
            String(toggle?.label || '').trim().toLowerCase() === toggleLabel.toLowerCase()
        )
        : null;

    if (currentToggle && enabled !== undefined && currentToggle.enabled === !!enabled) {
        return {
            success: true,
            toggles: menuState.toggles || [],
            currentModel: menuState.current || 'Unknown',
            alreadySet: true
        };
    }

    if (requestedToggle === 'auto' && enabled === true) {
        const autoResult = await setModel(cdp, 'Auto');
        if (autoResult?.success) {
            const refreshedMenuState = await getDropdownOptions(cdp, 'model');
            return {
                success: true,
                toggles: refreshedMenuState.toggles || [],
                currentModel: autoResult.currentModel || refreshedMenuState.current || 'Auto'
            };
        }
    }

    const targetEntry = Array.isArray(menuState?.targets)
        ? menuState.targets.find((target) => target.kind === 'toggle' && target.key === requestedToggle)
        : null;

    if (menuState?.buttonPoint && targetEntry) {
        await clickAtPoint(cdp, menuState.buttonPoint.x, menuState.buttonPoint.y);
        await new Promise((resolve) => setTimeout(resolve, 260));
        await clickAtPoint(cdp, targetEntry.x, targetEntry.y);
        await new Promise((resolve) => setTimeout(resolve, 320));

        const refreshedMenuState = await getDropdownOptions(cdp, 'model');
        const refreshedToggle = Array.isArray(refreshedMenuState?.toggles)
            ? refreshedMenuState.toggles.find((toggle) => toggle?.key === requestedToggle)
            : null;

        if ((enabled === undefined && refreshedToggle) || (refreshedToggle && refreshedToggle.enabled === !!enabled)) {
            return {
                success: true,
                toggles: refreshedMenuState.toggles || [],
                currentModel: refreshedMenuState.current || result?.currentModel || 'Unknown'
            };
        }
    }

    return result;
}

async function getDropdownOptions(cdp, kind) {
    const normalizedKind = kind === 'model' ? 'model' : 'mode';
    const buttonState = await evaluateCursor(cdp, `
        const kind = ${JSON.stringify(normalizedKind)};
        const button = kind === 'model' ? __cr.findModelButton() : __cr.findModeButton();
        const current = kind === 'model' ? (__cr.getModelText() || 'Unknown') : (__cr.getModeText() || 'Unknown');
        const menuAlreadyOpen = kind === 'model' && !!__cr.findModelMenuRoot();
        if (!button && !menuAlreadyOpen) return { error: kind + '_button_not_found', options: [] };
        if (!button) {
            return {
                success: true,
                kind,
                current,
                menuAlreadyOpen,
                buttonPoint: null
            };
        }

        const buttonRect = button.getBoundingClientRect();
        return {
            success: true,
            kind,
            current,
            menuAlreadyOpen,
            buttonPoint: {
                x: kind === 'mode'
                    ? Math.round(buttonRect.left + Math.max(14, Math.min(buttonRect.width * 0.35, buttonRect.width / 2)))
                    : Math.round(buttonRect.left + (buttonRect.width / 2)),
                y: Math.round(buttonRect.top + (buttonRect.height / 2))
            }
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });
    if (!buttonState || buttonState.error) {
        return buttonState;
    }

    if (buttonState.buttonPoint && !buttonState.menuAlreadyOpen) {
        await clickAtPoint(cdp, buttonState.buttonPoint.x, buttonState.buttonPoint.y);
        await new Promise((resolve) => setTimeout(resolve, 260));
    }

    const result = await evaluateCursor(cdp, `
        const kind = ${JSON.stringify(normalizedKind)};
        const current = kind === 'model' ? (__cr.getModelText() || 'Unknown') : (__cr.getModeText() || 'Unknown');
        const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const menus = __cr.findMenuContainers();

        let normalizedOptions;
        let searchPlaceholder = '';
        let autoAvailable = false;
        let autoEnabled = false;
        let autoLabel = 'Auto';
        let autoDescription = '';
        let toggles = [];
        let footerLabel = '';
        let targets = [];

        if (kind === 'model') {
            const modelMenuState = __cr.getModelMenuState();
            searchPlaceholder = modelMenuState.searchPlaceholder || '';
            toggles = Array.isArray(modelMenuState.toggles) ? modelMenuState.toggles : [];
            footerLabel = modelMenuState.footerLabel || '';
            targets = Array.isArray(modelMenuState.targets) ? modelMenuState.targets : [];

            const autoToggle = toggles.find(toggle => toggle.key === 'auto' || /^auto$/i.test(toggle.label || ''));
            if (autoToggle) {
                autoAvailable = true;
                autoEnabled = !!autoToggle.enabled;
                autoLabel = autoToggle.label || 'Auto';
                autoDescription = autoToggle.description || '';
            } else if (/auto/i.test(current)) {
                autoAvailable = true;
                autoEnabled = true;
                autoDescription = 'Balanced quality and speed, recommended for most tasks';
            }

            normalizedOptions = Array.isArray(modelMenuState.options) && modelMenuState.options.length
                ? modelMenuState.options.slice(0, 80)
                : (current && current !== 'Unknown' && !/auto/i.test(current) ? [current] : []);
        } else {
            const collectModeItems = (menuList) => menuList
                .flatMap(menu => __cr.getMenuItems(menu))
                .map(item => ({
                    title: normalizeText(item.title),
                    rect: item.element?.getBoundingClientRect?.() || null
                }))
                .filter(item => item.rect && /^(agent|plan|debug|ask|fast|planning|manual)$/i.test(item.title));

            const matchingMenus = current
                ? menus.filter(menu => __cr.textOf(menu).toLowerCase().includes(current.toLowerCase()))
                : [];
            const allModeItems = collectModeItems(menus);
            const matchingModeItems = collectModeItems(matchingMenus);
            const modeItems = matchingModeItems.length >= 2 ? matchingModeItems : allModeItems;
            const seen = new Set();

            normalizedOptions = [];
            targets = [];
            for (const item of modeItems) {
                const key = item.title.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                normalizedOptions.push(item.title);
                targets.push({
                    kind: 'option',
                    title: item.title,
                    x: Math.round(item.rect.left + (item.rect.width / 2)),
                    y: Math.round(item.rect.top + (item.rect.height / 2))
                });
            }

            normalizedOptions = normalizedOptions.length
                ? normalizedOptions
                : (current && current !== 'Unknown' ? [current] : []);
        }

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));

        return {
            success: true,
            kind,
            current,
            options: normalizedOptions,
            searchPlaceholder,
            toggles,
            autoAvailable,
            autoEnabled,
            autoLabel,
            autoDescription,
            footerLabel,
            targets
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });
    if (result && !result.error) {
        result.buttonPoint = buttonState.buttonPoint;
    }

    if (normalizedKind === 'model' && result && !result.error) {
        const fallbackAutoDescription = 'Balanced quality and speed, recommended for most tasks';
        const fallbackModelItems = [
            { value: 'Composer 1.5', icon: 'cloud' },
            { value: 'GPT-5.4', icon: 'cloud' },
            { value: 'GPT-5.3 Codex', icon: 'cloud' },
            { value: 'Sonnet 4.6', icon: 'cloud' },
            { value: 'Opus 4.6', icon: 'cloud' },
            { value: 'Gemini 3 Flash', icon: 'cloud' },
            { value: 'gpt-4', icon: '' }
        ];
        const fallbackToggleDefs = [
            { key: 'auto', label: 'Auto', description: fallbackAutoDescription, enabled: false },
            { key: 'max-mode', label: 'MAX Mode', description: '', enabled: false },
            { key: 'multi-model', label: 'Use Multiple Models', description: '', enabled: false }
        ];
        const iconByValue = new Map(fallbackModelItems.map((item) => [item.value.toLowerCase(), item.icon]));
        const mergeModelItems = (...lists) => {
            const seen = new Set();
            const merged = [];

            lists.flat().forEach((entry) => {
                const value = String(
                    typeof entry === 'string'
                        ? entry
                        : (entry?.value || entry?.name || '')
                ).trim();

                if (!value || /^auto$/i.test(value)) return;

                const key = value.toLowerCase();
                if (seen.has(key)) return;
                seen.add(key);

                const explicitIcon = typeof entry === 'object' && entry ? String(entry.icon || '').trim() : '';
                merged.push({
                    value,
                    icon: explicitIcon || iconByValue.get(key) || ''
                });
            });

            return merged;
        };
        const hasStructuredMenu =
            !!result.searchPlaceholder ||
            !!result.footerLabel ||
            (Array.isArray(result.toggles) && result.toggles.length >= 2) ||
            (Array.isArray(result.options) && result.options.length >= 3);
        const fallbackCurrent = result.current && result.current !== 'Unknown' ? result.current : 'Auto';
        const needsCatalogAugment =
            !hasStructuredMenu ||
            !result.footerLabel ||
            !Array.isArray(result.options) ||
            result.options.length < fallbackModelItems.length;

        result.current = fallbackCurrent;
        result.searchPlaceholder = result.searchPlaceholder || 'Search models';
        result.toggles = fallbackToggleDefs.map((fallbackToggle) => {
            const incoming = Array.isArray(result.toggles)
                ? result.toggles.find((toggle) =>
                    toggle?.key === fallbackToggle.key ||
                    String(toggle?.label || '').trim().toLowerCase() === fallbackToggle.label.toLowerCase()
                )
                : null;

            return {
                key: incoming?.key || fallbackToggle.key,
                label: incoming?.label || fallbackToggle.label,
                description: String(incoming?.description || fallbackToggle.description || '')
                    .replace(new RegExp('^(?:' + escapeRegExp(incoming?.label || fallbackToggle.label) + '\\s*)+', 'i'), '')
                    .trim(),
                enabled: typeof incoming?.enabled === 'boolean'
                    ? incoming.enabled
                    : (fallbackToggle.key === 'auto' ? /^auto$/i.test(fallbackCurrent) : fallbackToggle.enabled)
            };
        });

        const currentItem = fallbackCurrent && !/^auto$/i.test(fallbackCurrent)
            ? [{ value: fallbackCurrent, icon: iconByValue.get(fallbackCurrent.toLowerCase()) || '' }]
            : [];
        const mergedItems = mergeModelItems(
            currentItem,
            Array.isArray(result.items) ? result.items : [],
            Array.isArray(result.options) ? result.options : [],
            needsCatalogAugment ? fallbackModelItems : []
        );

        result.items = mergedItems;
        result.options = mergedItems.map((item) => item.value);
        result.autoAvailable = true;
        result.autoEnabled = result.toggles.find((toggle) => toggle.key === 'auto')?.enabled || /^auto$/i.test(fallbackCurrent);
        result.autoLabel = result.autoLabel || 'Auto';
        result.autoDescription = String(result.autoDescription || fallbackAutoDescription || '')
            .replace(/^(?:auto\s*)+/i, '')
            .trim() || fallbackAutoDescription;
        result.footerLabel = result.footerLabel || (mergedItems.length ? 'Add Models' : '');

        if (!hasStructuredMenu) {
            result.targets = Array.isArray(result.targets) ? result.targets : [];
        }
    }

    if (normalizedKind === 'mode' && result && !result.error) {
        const fallbackModeOptions = ['Agent', 'Plan', 'Debug', 'Ask'];
        const aliasMap = {
            agent: 'Agent',
            fast: 'Agent',
            plan: 'Plan',
            planning: 'Plan',
            debug: 'Debug',
            manual: 'Debug',
            ask: 'Ask'
        };
        const normalizedCurrent = String(result.current || '').trim();
        const displayCurrent = aliasMap[normalizedCurrent.toLowerCase()] || normalizedCurrent;

        if (displayCurrent && displayCurrent !== 'Unknown') {
            result.current = displayCurrent;
        }

        const normalizedOptions = Array.isArray(result.options)
            ? result.options
                .map(option => aliasMap[String(option || '').trim().toLowerCase()] || String(option || '').trim())
                .filter(Boolean)
            : [];

        result.options = normalizedOptions.length >= 2
            ? Array.from(new Set(normalizedOptions))
            : (displayCurrent && displayCurrent !== 'Unknown'
                ? Array.from(new Set([displayCurrent, ...fallbackModeOptions]))
                : fallbackModeOptions);
    }

    return result;
}

// Start New Chat - Click the + button at the TOP of the chat window (NOT the context/media + button)
async function startNewChat(cdp) {
    return await evaluateCursor(cdp, `
        const newChatButton = __cr.findNewChatButton();
        if (!newChatButton) return { error: 'New chat button not found' };

        __cr.click(newChatButton);
        await new Promise(r => setTimeout(r, 250));

        const editor = __cr.findEditor();
        return {
            success: true,
            method: 'new_chat_button',
            editorFound: !!editor,
            editorText: editor ? __cr.textOf(editor) : ''
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });
}
// Get Chat History - Click history button and scrape conversations
async function getChatHistory(cdp) {
    const opener = await evaluateCursor(cdp, `
        const historyButton = __cr.findHistoryButton();
        if (!historyButton) return { error: 'History button not found', chats: [] };
        const rect = historyButton.getBoundingClientRect();
        return {
            success: true,
            button: {
                x: rect.left + (rect.width / 2),
                y: rect.top + (rect.height / 2)
            }
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });

    if (!opener?.success || !opener.button) {
        return opener || { error: 'History button not found', chats: [] };
    }

    await clickAtPoint(cdp, opener.button.x, opener.button.y);
    await new Promise(resolve => setTimeout(resolve, 500));

    const result = await evaluateCursor(cdp, `
        const menu = __cr.findHistoryMenu();
        const chats = __cr.getHistoryItems().slice(0, 50).map(item => ({
            title: item.title,
            date: 'Recent'
        }));
        const activeTitle = __cr.getActiveChatTitle() || '';

        return {
            success: true,
            chats,
            activeTitle,
            debug: {
                menuFound: !!menu,
                menuText: menu ? __cr.textOf(menu).slice(0, 200) : '',
                itemCount: chats.length,
                activeTitle
            }
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });

    const titlesMatch = (left, right) => {
        const a = String(left || '').replace(/[\u2026.]+$/g, '').trim().toLowerCase();
        const b = String(right || '').replace(/[\u2026.]+$/g, '').trim().toLowerCase();
        if (!a || !b) return false;
        return a === b || a.includes(b) || b.includes(a);
    };

    if (result?.success && Array.isArray(result.chats) && result.activeTitle) {
        const activeIndex = result.chats.findIndex(chat => titlesMatch(chat?.title, result.activeTitle));
        if (activeIndex > 0) {
            const [activeChat] = result.chats.splice(activeIndex, 1);
            result.chats.unshift(activeChat);
        }
    }

    return result;
}

async function selectChat(cdp, chatTitle) {
    const targetTitle = String(chatTitle || '').trim();
    if (!targetTitle) return { error: 'Chat title required' };

    const titlesMatch = (left, right) => {
        const a = String(left || '').replace(/[\u2026.]+$/g, '').trim().toLowerCase();
        const b = String(right || '').replace(/[\u2026.]+$/g, '').trim().toLowerCase();
        if (!a || !b) return false;
        return a === b || a.includes(b) || b.includes(a);
    };

    const tabSelection = await evaluateCursor(cdp, `
        const desiredTitle = ${JSON.stringify(targetTitle)};
        const desiredLower = desiredTitle.toLowerCase();
        const container = __cr.findChatTabsContainer();
        if (!container) return { success: false, reason: 'chat_tabs_not_found' };

        const tabs = __cr.getChatTabElements(container)
            .map((element) => ({
                element,
                title: String(element.getAttribute('aria-label') || __cr.textOf(element) || '').trim(),
                active: __cr.isTabActive(element)
            }))
            .filter((tab) => tab.title && !/^more actions(?:\\.\\.\\.)?$/i.test(tab.title));

        const target = tabs
            .filter((tab) => {
                const titleLower = tab.title.toLowerCase();
                return titleLower === desiredLower ||
                    titleLower.includes(desiredLower) ||
                    desiredLower.includes(titleLower);
            })
            .sort((a, b) => {
                const aExact = a.title.toLowerCase() === desiredLower ? 1 : 0;
                const bExact = b.title.toLowerCase() === desiredLower ? 1 : 0;
                if (bExact !== aExact) return bExact - aExact;
                return b.title.length - a.title.length;
            })[0];

        if (!target) {
            return {
                success: false,
                reason: 'chat_tab_not_found',
                available: tabs.map((tab) => tab.title)
            };
        }

        const rect = target.element.getBoundingClientRect();
        if (!target.active) {
            __cr.click(target.element);
        }
        return {
            success: true,
            method: 'chat_tab',
            title: target.title,
            alreadyActive: target.active,
            target: {
                x: rect.left + (rect.width / 2),
                y: rect.top + (rect.height / 2)
            }
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });

    if (tabSelection?.success) {
        if (!tabSelection.alreadyActive) {
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        let activeCheck = await evaluateCursor(cdp, `
            const activeChatTitle = __cr.getActiveChatTitle() || '';
            return { activeChatTitle };
        `, {
            accept: (value) => value && typeof value === 'object'
        });

        if (!tabSelection.alreadyActive && tabSelection.target && !titlesMatch(activeCheck?.activeChatTitle, tabSelection.title)) {
            await clickAtPoint(cdp, tabSelection.target.x, tabSelection.target.y);
            await new Promise(resolve => setTimeout(resolve, 300));
            activeCheck = await evaluateCursor(cdp, `
                const activeChatTitle = __cr.getActiveChatTitle() || '';
                return { activeChatTitle };
            `, {
                accept: (value) => value && typeof value === 'object'
            });
        }

        if (tabSelection.alreadyActive || titlesMatch(activeCheck?.activeChatTitle, tabSelection.title)) {
            return {
                success: true,
                method: tabSelection.method,
                title: activeCheck?.activeChatTitle || tabSelection.title
            };
        }
    }

    const opener = await evaluateCursor(cdp, `
        const desiredTitle = ${JSON.stringify(targetTitle)};
        let menu = __cr.findHistoryMenu();
        if (!menu) {
            const historyButton = __cr.findHistoryButton();
            if (!historyButton) return { error: 'History button not found' };
            const rect = historyButton.getBoundingClientRect();
            return {
                success: true,
                requiresOpen: true,
                desiredTitle,
                button: {
                    x: rect.left + (rect.width / 2),
                    y: rect.top + (rect.height / 2)
                }
            };
        }

        return { success: true, requiresOpen: false, desiredTitle };
    `, {
        accept: (value) => value && typeof value === 'object'
    });

    if (!opener?.success) {
        return opener || { error: 'History button not found' };
    }

    if (opener.requiresOpen && opener.button) {
        await clickAtPoint(cdp, opener.button.x, opener.button.y);
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    const selection = await evaluateCursor(cdp, `
        const desiredTitle = ${JSON.stringify(targetTitle)};
        const menu = __cr.findHistoryMenu();
        if (!menu) return { error: 'History menu not found' };

        let items = __cr.getMenuItems(menu);
        const desiredLower = desiredTitle.toLowerCase();
        items = items.filter(item => {
            const titleLower = item.title.toLowerCase();
            return titleLower === desiredLower ||
                titleLower.includes(desiredLower) ||
                desiredLower.includes(titleLower);
        });

        const target = items
            .sort((a, b) => {
                const aExact = a.title.toLowerCase() === desiredLower ? 1 : 0;
                const bExact = b.title.toLowerCase() === desiredLower ? 1 : 0;
                if (bExact !== aExact) return bExact - aExact;
                return b.title.length - a.title.length;
            })[0];

        if (!target) {
            return {
                error: 'Chat not found: ' + desiredTitle,
                available: __cr.getHistoryItems().slice(0, 20).map(item => item.title)
            };
        }

        const rect = target.element.getBoundingClientRect();
        return {
            success: true,
            method: 'history_menu',
            title: target.title,
            target: {
                x: rect.left + (rect.width / 2),
                y: rect.top + (rect.height / 2)
            }
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });

    if (!selection?.success || !selection.target) {
        return selection || { error: 'Chat not found: ' + targetTitle };
    }

    await clickAtPoint(cdp, selection.target.x, selection.target.y);
    await new Promise(resolve => setTimeout(resolve, 300));

    return {
        success: true,
        method: selection.method,
        title: selection.title
    };
}

// Close History Panel (Escape)
async function closeHistory(cdp) {
    const EXP = `(async () => {
        try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', code: 'Escape', bubbles: true }));
            return { success: true };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Failed to close history panel' };
}

// Check if a chat is currently open (has cascade element)
async function hasChatOpen(cdp) {
    return await evaluateCursor(cdp, `
        const panel = __cr.findPanel();
        const editor = __cr.findEditor();
        const messages = __cr.collectMessageNodes();
        return {
            hasChat: !!panel,
            hasMessages: messages.length > 0,
            editorFound: !!editor
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });
}

// Get App State (Mode & Model)
async function getAppState(cdp) {
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
            if (result.mode === 'Unknown') {
                const modeState = await getDropdownOptions(cdp, 'mode');
                if (modeState?.current && modeState.current !== 'Unknown') {
                    result.mode = modeState.current;
                }
            }

            if (result.model === 'Unknown') {
                const modelState = await getDropdownOptions(cdp, 'model');
                if (modelState?.current && modelState.current !== 'Unknown') {
                    result.model = modelState.current;
                }
            }
        } catch (error) {
            // Keep best-effort state; fallbacks above already applied where possible.
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

// Initialize CDP connection
async function initCDP() {
    console.log('Ã°Å¸â€Â Discovering Cursor CDP endpoint...');
    const cdpInfo = await discoverCDP();
    console.log(`Ã¢Å“â€¦ Found cursor on port ${cdpInfo.port} `);

    console.log('Ã°Å¸â€Å’ Connecting to CDP...');
    cdpConnection = await connectCDP(cdpInfo.url);
    console.log(`Ã¢Å“â€¦ Connected! Found ${cdpConnection.contexts.length} execution contexts\n`);
}

// Background polling
async function startPolling(wss) {
    let lastErrorLog = 0;
    let isConnecting = false;
    const broadcast = (payload) => {
        const message = JSON.stringify(payload);
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try { client.send(message); } catch (e) { /* ignore dead sockets */ }
            }
        });
    };

    const poll = async () => {
        if (!cdpConnection || (cdpConnection.ws && cdpConnection.ws.readyState !== WebSocket.OPEN)) {
            if (!isConnecting) {
                console.log('Ã°Å¸â€Â Looking for Cursor CDP connection...');
                isConnecting = true;
            }
            if (cdpConnection) {
                // Was connected, now lost
                console.log('Ã°Å¸â€â€ž CDP connection lost. Attempting to reconnect...');
                cdpConnection = null;
            }
            try {
                await initCDP();
                if (cdpConnection) {
                    console.log('Ã¢Å“â€¦ CDP Connection established from polling loop');
                    isConnecting = false;
                }
            } catch (err) {
                // Not found yet, just wait for next cycle
            }
            setTimeout(poll, 2000); // Try again in 2 seconds if not found
            return;
        }

        try {
            const appState = await getAppState(cdpConnection);
            if (appState && typeof appState === 'object') {
                const appStateHash = hashString(JSON.stringify(appState));
                if (appStateHash !== lastAppStateHash) {
                    lastAppState = appState;
                    lastAppStateHash = appStateHash;
                    broadcast({
                        type: 'app_state_update',
                        hash: appStateHash,
                        state: appState
                    });
                }
            }

            const snapshot = await captureSnapshot(cdpConnection);
            if (snapshot && !snapshot.error) {
                const hash = hashString(JSON.stringify({
                    html: snapshot.html,
                    activeChatTitle: snapshot.activeChatTitle || '',
                    chatTabs: snapshot.chatTabs || []
                }));

                // Only update if content changed
                if (hash !== lastSnapshotHash) {
                    lastSnapshot = snapshot;
                    lastSnapshotHash = hash;

                    // Broadcast lightweight notification via WebSocket (hash only)
                    // Full snapshot data stays on server, client fetches via HTTP only when hash changes
                    broadcast({
                        type: 'snapshot_update',
                        hash: hash
                    });

                    console.log(`Ã°Å¸â€œÂ¸ Snapshot updated(hash: ${hash})`);
                }
            } else {
                // Snapshot is null or has error
                const now = Date.now();
                if (!lastErrorLog || now - lastErrorLog > 10000) {
                    const errorMsg = snapshot?.error || 'No valid snapshot captured (check contexts)';
                    console.warn(`Ã¢Å¡Â Ã¯Â¸Â  Snapshot capture issue: ${errorMsg} `);
                    if (errorMsg.includes('container not found')) {
                        console.log('   (Tip: Ensure an active chat is open in cursor)');
                    }
                    if (cdpConnection.contexts.length === 0) {
                        console.log('   (Tip: No active execution contexts found. Try interacting with the Cursor window)');
                    }
                    lastErrorLog = now;
                }
            }
        } catch (err) {
            console.error('Poll error:', err.message);
        }

        setTimeout(poll, POLL_INTERVAL);
    };

    poll();
}

function ensureHttpsCertificates() {
    const keyPath = join(RUNTIME_ROOT, 'certs', 'server.key');
    const certPath = join(RUNTIME_ROOT, 'certs', 'server.cert');
    let certsExist = fs.existsSync(keyPath) && fs.existsSync(certPath);

    if (IS_EMBEDDED_RUNTIME || certsExist) {
        return { keyPath, certPath, certsExist };
    }

    console.log('[HTTPS] SSL certificates missing. Generating local certificates...');
    try {
        execFileSync(process.execPath, [join(__dirname, 'generate_ssl.js')], {
            cwd: __dirname,
            stdio: 'pipe',
            env: {
                ...process.env,
                CR_RUNTIME_DIR: RUNTIME_ROOT
            }
        });
    } catch (error) {
        const stderr = error?.stderr?.toString?.().trim();
        const stdout = error?.stdout?.toString?.().trim();
        const detail = stderr || stdout || error.message;
        console.error('[HTTPS] Failed to generate SSL certificates:', detail);
    }

    certsExist = fs.existsSync(keyPath) && fs.existsSync(certPath);
    if (!certsExist) {
        console.error('[HTTPS] Browser mode requires HTTPS certificates. Refusing to start without HTTPS.');
    }

    return { keyPath, certPath, certsExist };
}


// Main
async function main() {
    let initialCdpError = null;

    try {
        await initCDP();
    } catch (err) {
        initialCdpError = err;
        const launchResult = await launchcursorWithCDP();
        if (launchResult?.ready) {
            try {
                await initCDP();
            } catch (retryErr) {
                initialCdpError = retryErr;
            }
        }

        if (!cdpConnection) {
            console.warn(`Ã¢Å¡Â Ã¯Â¸Â  Initial CDP discovery failed: ${err.message}`);
            console.log('Ã°Å¸â€™Â¡ Start Cursor with --remote-debugging-port=9000 to connect.');
        }

    }

    try {
        const { server, wss, hasSSL } = await createServer({
            APP_PASSWORD,
            AUTH_COOKIE_NAME,
            IS_EMBEDDED_RUNTIME,
            PORTS,
            RUNTIME_ROOT,
            SERVER_PORT,
            __dirname,
            clickElement,
            closeHistory,
            ensureHttpsCertificates,
            getAppState,
            getCdpConnection: () => cdpConnection,
            getChatHistory,
            getDropdownOptions,
            getJson,
            getLocalIP,
            getSnapshot: () => lastSnapshot,
            hasChatOpen,
            hashString,
            injectFile,
            injectMessage,
            isLocalRequest,
            killPortProcess,
            launchcursorWithCDP,
            remoteScroll,
            sanitizeLogUrl,
            selectChat,
            setMode,
            setModel,
            setModelToggle,
            startNewChat,
            stopGeneration
        });

        startPolling(wss);

        // Kill any existing process on the port before starting
        await killPortProcess(SERVER_PORT);

        // Start server with EADDRINUSE retry
        const localIP = getLocalIP();
        const protocol = hasSSL ? 'https' : 'http';
        let listenRetries = 0;
        const MAX_LISTEN_RETRIES = 3;

        const startListening = () => {
            server.listen(SERVER_PORT, '0.0.0.0', () => {
                console.log(`Ã°Å¸Å¡â‚¬ Server running on ${protocol}://${localIP}:${SERVER_PORT}`);
                if (hasSSL) {
                    console.log(`Ã°Å¸â€™Â¡ First time on phone? Accept the security warning to proceed.`);
                }
            });
        };

        server.on('error', async (err) => {
            if (err.code === 'EADDRINUSE' && listenRetries < MAX_LISTEN_RETRIES) {
                listenRetries++;
                console.warn(`Ã¢Å¡Â Ã¯Â¸Â  Port ${SERVER_PORT} busy, retry ${listenRetries}/${MAX_LISTEN_RETRIES}...`);
                await killPortProcess(SERVER_PORT);
                setTimeout(startListening, 1000);
            } else if (err.code === 'EADDRINUSE') {
                console.error(`Ã¢ÂÅ’ Port ${SERVER_PORT} still in use after ${MAX_LISTEN_RETRIES} retries. Exiting.`);
                process.exit(1);
            } else {
                console.error('Ã¢ÂÅ’ Server error:', err.message);
            }
        });

        startListening();

        // Graceful shutdown handlers
        const gracefulShutdown = (signal) => {
            console.log(`\nÃ°Å¸â€ºâ€˜ Received ${signal}. Shutting down gracefully...`);
            wss.close(() => {
                console.log('   WebSocket server closed');
            });
            server.close(() => {
                console.log('   HTTP server closed');
            });
            if (cdpConnection?.ws) {
                cdpConnection.ws.close();
                console.log('   CDP connection closed');
            }
            setTimeout(() => process.exit(0), 1000);
        };

        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    } catch (err) {
        console.error('Ã¢ÂÅ’ Fatal error:', err.message);
        process.exit(1);
    }
}

main();
