import fs from 'fs';
import { join } from 'path';

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB auto-rotate

export function setupLogging(runtimeRoot) {
    const LOG_FILE = join(runtimeRoot, 'log.txt');
    const LOG_BACKUP_FILE = join(runtimeRoot, 'log.old.txt');
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

    // CRASH PROTECTION - Prevent process from dying on unhandled errors
    process.on('uncaughtException', (err) => {
        if (err?.code === 'EPIPE' || String(err?.message || '').includes('EPIPE')) {
            terminalConsoleAvailable = false;
            try { logStream.write(formatLogLine('WARN', ['Suppressed EPIPE from terminal output.'])); } catch (e) { /* ignore */ }
            return;
        }
        console.error('UNCAUGHT EXCEPTION (process kept alive):', err.message);
        console.error('   Stack:', err.stack);
    });

    process.on('unhandledRejection', (reason) => {
        console.error('UNHANDLED REJECTION (process kept alive):', reason);
    });

    return { logStream, terminalConsoleAvailable: () => terminalConsoleAvailable };
}

// --- Log formatting utilities ---

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

export function formatLogLine(level, args) {
    const ts = new Date().toISOString();
    const msg = args.map(stringifyLogArg).join(' ');
    // Strip emoji for clean log file on Windows
    const clean = msg.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F900}-\u{1F9FF}]|[\u{200D}]|[\u{20E3}]|[\u{E0020}-\u{E007F}]/gu, '').trim();
    return `[${ts}] [${level}] ${clean}\n`;
}

export function sanitizeLogUrl(rawUrl = '') {
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

const ACTION_TRACE_LOG_ENABLED = process.env.CR_ACTION_TRACE_LOG !== '0';
let actionTraceCounter = 0;

export function summarizeLogText(value, maxLength = 120) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.length > maxLength
        ? `${normalized.slice(0, Math.max(0, maxLength - 1))}…`
        : normalized;
}

export function summarizeLogValue(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return summarizeLogText(value, depth === 0 ? 180 : 120);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Error) {
        return {
            name: value.name,
            message: summarizeLogText(value.message || String(value), 180)
        };
    }
    if (Array.isArray(value)) {
        const items = value.slice(0, 6).map((item) => summarizeLogValue(item, depth + 1));
        if (value.length > 6) items.push(`…(+${value.length - 6} more)`);
        return items;
    }
    if (typeof value === 'object') {
        if (depth >= 2) {
            return `[object ${value.constructor?.name || 'Object'}]`;
        }
        const entries = Object.entries(value).slice(0, 10).map(([key, entryValue]) => [key, summarizeLogValue(entryValue, depth + 1)]);
        const summarized = Object.fromEntries(entries);
        const hiddenKeys = Object.keys(value).length - entries.length;
        if (hiddenKeys > 0) summarized.__moreKeys = hiddenKeys;
        return summarized;
    }
    return String(value);
}

export function createTraceId(prefix = 'trace') {
    actionTraceCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${actionTraceCounter.toString(36)}`;
}

export function logTraceStep(traceId, step, details = null) {
    if (!ACTION_TRACE_LOG_ENABLED || !traceId) return;
    if (details && typeof details === 'object' && Object.keys(details).length > 0) {
        console.log(`[TRACE ${traceId}] ${step}`, summarizeLogValue(details));
        return;
    }
    if (details !== null && details !== undefined) {
        console.log(`[TRACE ${traceId}] ${step}`, summarizeLogValue(details));
        return;
    }
    console.log(`[TRACE ${traceId}] ${step}`);
}

export function summarizeDropdownStateForLog(state) {
    if (!state || typeof state !== 'object') return state;
    return {
        kind: state.kind || undefined,
        current: summarizeLogText(state.current || '', 72) || undefined,
        optionCount: Array.isArray(state.options) ? state.options.length : 0,
        toggleCount: Array.isArray(state.toggles) ? state.toggles.length : 0,
        compactAuto: typeof state.compactAuto === 'boolean' ? state.compactAuto : undefined,
        footerLabel: summarizeLogText(state.footerLabel || '', 64) || undefined,
        targets: Array.isArray(state.targets) ? state.targets.length : 0,
        menuAlreadyOpen: !!state.menuAlreadyOpen,
        error: state.error || undefined
    };
}

export function summarizeAppStateForLog(state) {
    if (!state || typeof state !== 'object') return state;
    return {
        mode: summarizeLogText(state.mode || '', 40) || undefined,
        model: summarizeLogText(state.model || '', 56) || undefined,
        composerStatus: summarizeLogText(state.composerStatus || '', 40) || undefined,
        isRunning: !!state.isRunning,
        hasChat: !!state.hasChat,
        hasMessages: !!state.hasMessages,
        editorFound: !!state.editorFound,
        activeChatTitle: summarizeLogText(state.activeChatTitle || '', 96) || undefined,
        chatTabCount: Array.isArray(state.chatTabs) ? state.chatTabs.length : 0
    };
}

export function summarizeSnapshotForLog(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    return {
        activeChatTitle: summarizeLogText(snapshot.activeChatTitle || '', 96) || undefined,
        chatTabCount: Array.isArray(snapshot.chatTabs) ? snapshot.chatTabs.length : 0,
        htmlSize: snapshot.stats?.htmlSize || snapshot.html?.length || 0,
        nodes: snapshot.stats?.nodes || 0,
        scrollPercent: typeof snapshot.scrollInfo?.scrollPercent === 'number'
            ? Number(snapshot.scrollInfo.scrollPercent.toFixed(4))
            : undefined,
        hash: snapshot.hash || undefined
    };
}

export function summarizeActionResultForLog(result) {
    if (!result || typeof result !== 'object') return summarizeLogValue(result);
    return {
        success: result.success ?? result.ok ?? undefined,
        error: summarizeLogText(result.error || result.reason || '', 160) || undefined,
        currentMode: summarizeLogText(result.currentMode || '', 40) || undefined,
        currentModel: summarizeLogText(result.currentModel || '', 56) || undefined,
        title: summarizeLogText(result.title || '', 96) || undefined,
        method: summarizeLogText(result.method || '', 48) || undefined,
        optionCount: Array.isArray(result.options) ? result.options.length : Array.isArray(result.available) ? result.available.length : undefined,
        toggleCount: Array.isArray(result.toggles) ? result.toggles.length : undefined,
        chatCount: Array.isArray(result.chats) ? result.chats.length : undefined,
        alreadySet: result.alreadySet === true ? true : undefined,
        alreadyActive: result.alreadyActive === true ? true : undefined
    };
}

export function summarizeChangedKeys(previous = {}, next = {}) {
    const candidateKeys = new Set([
        ...Object.keys(previous || {}),
        ...Object.keys(next || {})
    ]);

    return [...candidateKeys].filter((key) => {
        const before = JSON.stringify(summarizeLogValue(previous?.[key]));
        const after = JSON.stringify(summarizeLogValue(next?.[key]));
        return before !== after;
    }).slice(0, 12);
}
