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

export function registerCursorRoutes(app, {
    RUNTIME_ROOT,
    getCdpConnection,
    clickElement,
    closeHistory,
    getAppState,
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
    startNewChat,
    stopGeneration
}) {
    app.post('/set-mode', async (req, res) => {
        const { mode } = req.body;
        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) return;
        const result = await setMode(cdpConnection, mode);
        res.json(result);
    });

    app.post('/set-model', async (req, res) => {
        const { model } = req.body;
        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) return;
        const result = await setModel(cdpConnection, model);
        res.json(result);
    });

    app.post('/set-model-toggle', async (req, res) => {
        const { key, enabled } = req.body || {};
        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) return;
        const result = await setModelToggle(cdpConnection, key, enabled);
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

        if (!message) {
            return res.status(400).json({ error: 'Message required' });
        }

        const cdpConnection = getConnectedCdp(getCdpConnection, res, 'CDP not connected');
        if (!cdpConnection) return;

        const result = await injectMessage(cdpConnection, message);
        res.json({
            success: result.ok !== false,
            method: result.method || 'attempted',
            details: result
        });
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
        if (!req.file) {
            return res.status(400).json({ error: 'No file provided' });
        }

        const cdpConnection = getConnectedCdp(getCdpConnection, res, 'CDP not connected');
        if (!cdpConnection) return;

        const filePath = req.file.path.replace(/\\/g, '/');
        console.log(`File uploaded: ${req.file.originalname} (${req.file.size} bytes) -> ${filePath}`);

        try {
            const result = await injectFile(cdpConnection, filePath);
            res.json({
                success: result.success !== false,
                file: req.file.originalname,
                size: req.file.size,
                details: result
            });
        } catch (error) {
            console.error('File inject error:', error);
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
        const cdpConnection = getCdpConnection();
        if (!cdpConnection) {
            return res.json({ mode: 'Unknown', model: 'Unknown', isRunning: false, hasChat: false, hasMessages: false, editorFound: false, activeChatTitle: '', chatTabs: [] });
        }

        const result = await getAppState(cdpConnection);
        res.json(result);
    });

    app.get('/dropdown-options', async (req, res) => {
        const kind = req.query.kind === 'model' ? 'model' : 'mode';
        const cdpConnection = getCdpConnection();
        if (!cdpConnection) {
            return res.json({ error: 'CDP disconnected', kind, options: [] });
        }

        const result = await getDropdownOptions(cdpConnection, kind);
        res.json(result);
    });

    app.post('/new-chat', async (req, res) => {
        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) return;
        const result = await startNewChat(cdpConnection);
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
        const cdpConnection = getCdpConnection();
        if (!cdpConnection) {
            return res.json({ error: 'CDP disconnected', chats: [] });
        }

        const result = await getChatHistory(cdpConnection);
        res.json(result);
    });

    app.post('/select-chat', async (req, res) => {
        const { title } = req.body;
        if (!title) {
            return res.status(400).json({ error: 'Chat title required' });
        }

        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) return;
        const result = await selectChat(cdpConnection, title);
        res.json(result);
    });

    app.post('/close-history', async (req, res) => {
        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) return;
        const result = await closeHistory(cdpConnection);
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
