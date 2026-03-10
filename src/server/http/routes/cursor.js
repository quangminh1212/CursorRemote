import fs from 'fs';
import multer from 'multer';
import { join } from 'path';

function getConnectedCdp(getCdpConnection, res, errorMessage = 'CDP disconnected') {
    const cdpConnection = getCdpConnection();
    if (!cdpConnection) {
        res.status(503).json({ error: errorMessage });
        return null;
    }
    return cdpConnection;
}

function summarizeLogText(value, maxLength = 120) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.length > maxLength
        ? `${normalized.slice(0, Math.max(0, maxLength - 1))}…`
        : normalized;
}

function summarizePayload(payload = {}) {
    const entries = Object.entries(payload)
        .filter(([, value]) => value !== undefined)
        .slice(0, 8)
        .map(([key, value]) => {
            if (typeof value === 'string') return [key, summarizeLogText(value, 120)];
            if (Array.isArray(value)) return [key, { count: value.length, sample: value.slice(0, 4).map((item) => summarizeLogText(item, 48)) }];
            if (value && typeof value === 'object') return [key, '[object]'];
            return [key, value];
        });
    return Object.fromEntries(entries);
}

function summarizeResult(result) {
    if (!result || typeof result !== 'object') return result;
    return {
        success: result.success ?? result.ok ?? undefined,
        error: summarizeLogText(result.error || result.reason || '', 160) || undefined,
        method: summarizeLogText(result.method || '', 48) || undefined,
        mode: summarizeLogText(result.mode || '', 40) || undefined,
        model: summarizeLogText(result.model || result.current || '', 56) || undefined,
        currentMode: summarizeLogText(result.currentMode || '', 40) || undefined,
        currentModel: summarizeLogText(result.currentModel || '', 56) || undefined,
        title: summarizeLogText(result.title || '', 96) || undefined,
        activeChatTitle: summarizeLogText(result.activeChatTitle || '', 96) || undefined,
        optionCount: Array.isArray(result.options) ? result.options.length : Array.isArray(result.available) ? result.available.length : undefined,
        toggleCount: Array.isArray(result.toggles) ? result.toggles.length : undefined,
        chatCount: Array.isArray(result.chats) ? result.chats.length : undefined,
        chatTabCount: Array.isArray(result.chatTabs) ? result.chatTabs.length : undefined,
        hasChat: typeof result.hasChat === 'boolean' ? result.hasChat : undefined,
        hasMessages: typeof result.hasMessages === 'boolean' ? result.hasMessages : undefined,
        editorFound: typeof result.editorFound === 'boolean' ? result.editorFound : undefined,
        status: summarizeLogText(result.status || '', 40) || undefined
    };
}

function createActionTrace(req, action, payload = {}) {
    const startedAt = Date.now();
    const traceId = `${action}-${req.requestId || 'na'}-${Date.now().toString(36)}`;
    console.log(`[ACTION ${traceId}] start`, {
        requestId: req.requestId || undefined,
        action,
        route: req.requestTarget || req.originalUrl || req.url,
        payload: summarizePayload(payload)
    });
    return {
        traceId,
        finish(result, extra = {}) {
            console.log(`[ACTION ${traceId}] finish`, {
                requestId: req.requestId || undefined,
                action,
                durationMs: Date.now() - startedAt,
                result: summarizeResult(result),
                ...extra
            });
        },
        fail(error, extra = {}) {
            console.error(`[ACTION ${traceId}] fail`, {
                requestId: req.requestId || undefined,
                action,
                durationMs: Date.now() - startedAt,
                error: error?.message || String(error),
                ...extra
            });
        }
    };
}

export function registerCursorRoutes(app, {
    RUNTIME_ROOT,
    getCdpConnection,
    clickElement,
    closeHistory,
    closeTab,
    getAppState,
    getAppStateForApi,
    getChatHistory,
    getDropdownOptions,
    hasChatOpen,
    injectFile,
    injectMessage,
    launchcursorWithCDP,
    remoteScroll,
    selectChat,
    setMode,
    setModel,
    setModelToggle,
    triggerModelMenuAction,
    startNewChat,
    stopGeneration
}) {
    app.post('/set-mode', async (req, res) => {
        const { mode } = req.body;
        const trace = createActionTrace(req, 'set-mode', { mode });
        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) {
            trace.finish({ error: 'CDP disconnected' }, { httpStatus: 503 });
            return;
        }
        const result = await setMode(cdpConnection, mode, trace.traceId);
        trace.finish(result);
        res.json(result);
    });

    app.post('/set-model', async (req, res) => {
        const { model } = req.body;
        const trace = createActionTrace(req, 'set-model', { model });
        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) {
            trace.finish({ error: 'CDP disconnected' }, { httpStatus: 503 });
            return;
        }
        const result = await setModel(cdpConnection, model, trace.traceId);
        trace.finish(result);
        res.json(result);
    });

    app.post('/set-model-toggle', async (req, res) => {
        const { key, enabled } = req.body || {};
        const trace = createActionTrace(req, 'set-model-toggle', { key, enabled });
        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) {
            trace.finish({ error: 'CDP disconnected' }, { httpStatus: 503 });
            return;
        }
        const result = await setModelToggle(cdpConnection, key, enabled, trace.traceId);
        trace.finish(result);
        res.json(result);
    });

    app.post('/model-menu-action', async (req, res) => {
        const { action } = req.body || {};
        const trace = createActionTrace(req, 'model-menu-action', { action });
        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) {
            trace.finish({ error: 'CDP disconnected' }, { httpStatus: 503 });
            return;
        }

        if (typeof triggerModelMenuAction !== 'function') {
            trace.finish({ error: 'Model menu action is unavailable' }, { httpStatus: 501 });
            return res.status(501).json({ success: false, error: 'Model menu action is unavailable' });
        }

        const result = await triggerModelMenuAction(cdpConnection, action, trace.traceId);
        trace.finish(result);
        res.json(result);
    });

    app.post('/stop', async (req, res) => {
        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) return;
        const result = await stopGeneration(cdpConnection);
        res.json(result);
    });

    app.post('/send', async (req, res) => {
        const { message } = req.body;
        const trace = createActionTrace(req, 'send', {
            messageLength: typeof message === 'string' ? message.length : 0,
            preview: summarizeLogText(message, 120)
        });

        if (!message) {
            trace.finish({ error: 'Message required' }, { httpStatus: 400 });
            return res.status(400).json({ error: 'Message required' });
        }

        const cdpConnection = getConnectedCdp(getCdpConnection, res, 'CDP not connected');
        if (!cdpConnection) {
            trace.finish({ error: 'CDP not connected' }, { httpStatus: 503 });
            return;
        }

        const result = await injectMessage(cdpConnection, message, trace.traceId);
        const response = {
            success: result.ok !== false,
            method: result.method || 'attempted',
            details: result
        };
        trace.finish(response);
        res.json(response);
    });

    const uploadsDir = join(RUNTIME_ROOT, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const upload = multer({
        storage: multer.diskStorage({
            destination: uploadsDir,
            filename: (req, file, cb) => {
                const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
                cb(null, `${Date.now()}-${safeName}`);
            }
        }),
        limits: { fileSize: 50 * 1024 * 1024 }
    });

    app.post('/upload', upload.single('file'), async (req, res) => {
        const trace = createActionTrace(req, 'upload', {
            fileName: req.file?.originalname,
            fileSize: req.file?.size
        });
        if (!req.file) {
            trace.finish({ error: 'No file provided' }, { httpStatus: 400 });
            return res.status(400).json({ error: 'No file provided' });
        }

        const cdpConnection = getConnectedCdp(getCdpConnection, res, 'CDP not connected');
        if (!cdpConnection) {
            trace.finish({ error: 'CDP not connected' }, { httpStatus: 503 });
            return;
        }

        const filePath = req.file.path.replace(/\\/g, '/');
        console.log(`File uploaded: ${req.file.originalname} (${req.file.size} bytes) -> ${filePath}`);

        try {
            const result = await injectFile(cdpConnection, filePath);
            const response = {
                success: result.success !== false,
                file: req.file.originalname,
                size: req.file.size,
                details: result
            };
            trace.finish(response);
            res.json(response);
        } catch (error) {
            console.error('File inject error:', error);
            trace.fail(error, {
                file: req.file.originalname
            });
            res.json({
                success: false,
                file: req.file.originalname,
                error: error.message
            });
        }
    });

    app.post('/remote-click', async (req, res) => {
        const { selector, index, textContent } = req.body;
        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) return;
        const result = await clickElement(cdpConnection, { selector, index, textContent });
        res.json(result);
    });

    app.post('/remote-scroll', async (req, res) => {
        const { scrollTop, scrollPercent } = req.body;
        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) return;
        const result = await remoteScroll(cdpConnection, { scrollTop, scrollPercent });
        res.json(result);
    });

    app.get('/app-state', async (req, res) => {
        const trace = createActionTrace(req, 'app-state');
        const cdpConnection = getCdpConnection();
        if (!cdpConnection) {
            const fallbackState = { mode: 'Unknown', model: 'Unknown', isRunning: false, hasChat: false, hasMessages: false, editorFound: false, activeChatTitle: '', chatTabs: [] };
            trace.finish(fallbackState, { cdpConnected: false });
            return res.json(fallbackState);
        }

        const appStateResult = getAppStateForApi
            ? await getAppStateForApi(cdpConnection)
            : { state: await getAppState(cdpConnection, {}), source: 'live' };
        trace.finish(appStateResult.state, { cdpConnected: true, source: appStateResult.source });
        res.json(appStateResult.state);
    });

    app.get('/dropdown-options', async (req, res) => {
        const kind = req.query.kind === 'model' ? 'model' : 'mode';
        const trace = createActionTrace(req, 'dropdown-options', { kind });
        const cdpConnection = getCdpConnection();
        if (!cdpConnection) {
            const fallbackResult = { error: 'CDP disconnected', kind, options: [] };
            trace.finish(fallbackResult, { cdpConnected: false });
            return res.json(fallbackResult);
        }

        const result = await getDropdownOptions(cdpConnection, kind, trace.traceId);
        trace.finish(result, { cdpConnected: true });
        res.json(result);
    });

    app.post('/new-chat', async (req, res) => {
        const trace = createActionTrace(req, 'new-chat');
        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) {
            trace.finish({ error: 'CDP disconnected' }, { httpStatus: 503 });
            return;
        }
        const result = await startNewChat(cdpConnection, trace.traceId);
        trace.finish(result);
        res.json(result);
    });

    app.post('/restart-cursor-cdp', async (req, res) => {
        if (typeof launchcursorWithCDP !== 'function') {
            return res.status(501).json({ success: false, error: 'Restart Cursor action is unavailable' });
        }

        try {
            const result = await launchcursorWithCDP();

            if (result?.ready) {
                return res.json({ success: true, ...result });
            }

            if (result?.attempted) {
                return res.status(202).json({
                    success: true,
                    ...result,
                    warning: 'Cursor was restarted, but CDP is not ready yet'
                });
            }

            const errorMessage = result?.error
                || (result?.reason === 'missing-executable'
                    ? 'Cursor executable not found'
                    : 'Failed to restart Cursor with CDP');

            return res.status(503).json({ success: false, error: errorMessage, ...result });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/chat-history', async (req, res) => {
        const trace = createActionTrace(req, 'chat-history');
        const cdpConnection = getCdpConnection();
        if (!cdpConnection) {
            const fallbackResult = { error: 'CDP disconnected', chats: [] };
            trace.finish(fallbackResult, { cdpConnected: false });
            return res.json(fallbackResult);
        }

        const result = await getChatHistory(cdpConnection, trace.traceId);
        trace.finish(result, { cdpConnected: true });
        res.json(result);
    });

    app.post('/select-chat', async (req, res) => {
        const { title } = req.body;
        const trace = createActionTrace(req, 'select-chat', { title });
        if (!title) {
            trace.finish({ error: 'Chat title required' }, { httpStatus: 400 });
            return res.status(400).json({ error: 'Chat title required' });
        }

        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) {
            trace.finish({ error: 'CDP disconnected' }, { httpStatus: 503 });
            return;
        }
        const result = await selectChat(cdpConnection, title, trace.traceId);
        trace.finish(result);
        res.json(result);
    });

    app.post('/close-history', async (req, res) => {
        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) return;
        const result = await closeHistory(cdpConnection);
        res.json(result);
    });

    app.post('/close-tab', async (req, res) => {
        const { title } = req.body;
        const trace = createActionTrace(req, 'close-tab', { title });
        if (!title) {
            trace.finish({ error: 'Chat title required' }, { httpStatus: 400 });
            return res.status(400).json({ error: 'Chat title required' });
        }

        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) {
            trace.finish({ error: 'CDP disconnected' }, { httpStatus: 503 });
            return;
        }
        const result = await closeTab(cdpConnection, title, trace.traceId);
        trace.finish(result);
        res.json(result);
    });

    app.get('/chat-status', async (req, res) => {
        const cdpConnection = getCdpConnection();
        if (!cdpConnection) {
            return res.json({ hasChat: false, hasMessages: false, editorFound: false });
        }

        const result = await hasChatOpen(cdpConnection);
        res.json(result);
    });
}
