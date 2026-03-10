import WebSocket from 'ws';
import { getJson } from './system-utils.js';

// Find Cursor CDP endpoint (with identity verification to avoid connecting to Antigravity or other Electron apps)
async function discoverCDP(ports = [9000, 9001, 9002, 9003]) {
    const errors = [];
    for (const port of ports) {
        try {
            let isCursorApp = false;
            try {
                const versionInfo = await getJson(`http://127.0.0.1:${port}/json/version`);
                const browser = (versionInfo.Browser || '').toLowerCase();
                const userAgent = (versionInfo['User-Agent'] || '').toLowerCase();
                if (browser.includes('cursor') || userAgent.includes('cursor')) {
                    isCursorApp = true;
                } else {
                    console.log(`[INFO] Port ${port} belongs to "${versionInfo.Browser || 'unknown'}" (not Cursor); skipping`);
                    continue;
                }
            } catch {
                // /json/version failed but /json/list might still work; proceed with URL-based check.
            }

            const list = await getJson(`http://127.0.0.1:${port}/json/list`);

            const isCursorTarget = (target) => {
                if (isCursorApp) return true;
                const url = (target.url || '').toLowerCase();
                const title = (target.title || '').toLowerCase();
                if (url.includes('antigravity') || title.includes('antigravity')) return false;
                return true;
            };

            const workbench = list.find((target) => isCursorTarget(target) && (target.url?.includes('workbench.html') || (target.title && target.title.includes('workbench'))));
            if (workbench?.webSocketDebuggerUrl) {
                console.log('[INFO] Found Cursor Workbench target:', workbench.title, `(port ${port})`);
                return { port, url: workbench.webSocketDebuggerUrl };
            }

            const jetski = list.find((target) => isCursorTarget(target) && (target.url?.includes('jetski') || target.title === 'Launchpad'));
            if (jetski?.webSocketDebuggerUrl) {
                console.log('[INFO] Found Cursor Jetski/Launchpad target:', jetski.title, `(port ${port})`);
                return { port, url: jetski.webSocketDebuggerUrl };
            }

            if (isCursorApp) {
                errors.push(`${port}: Cursor running but no workbench target found`);
            }
        } catch (error) {
            errors.push(`${port}: ${error.message}`);
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
    const pendingCalls = new Map();
    const contexts = [];
    const cdpCallTimeoutMs = 30000;

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(String(msg));

            if (data.id !== undefined && pendingCalls.has(data.id)) {
                const { resolve, reject, timeoutId } = pendingCalls.get(data.id);
                clearTimeout(timeoutId);
                pendingCalls.delete(data.id);

                if (data.error) reject(data.error);
                else resolve(data.result);
            }

            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const id = data.params.executionContextId;
                const index = contexts.findIndex((context) => context.id === id);
                if (index !== -1) contexts.splice(index, 1);
            } else if (data.method === 'Runtime.executionContextsCleared') {
                contexts.length = 0;
            }
        } catch {
            // Ignore malformed websocket frames and unrelated traffic.
        }
    });

    ws.on('close', () => {
        console.warn('[WARN] CDP WebSocket closed; will auto-reconnect');
        for (const [, { reject, timeoutId }] of pendingCalls) {
            clearTimeout(timeoutId);
            reject(new Error('CDP connection closed'));
        }
        pendingCalls.clear();
    });

    ws.on('error', (err) => {
        console.error('[ERROR] CDP WebSocket error:', err.message);
    });

    const call = (method, params) => new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            reject(new Error('CDP WebSocket not open'));
            return;
        }

        const id = idCounter++;
        const timeoutId = setTimeout(() => {
            if (pendingCalls.has(id)) {
                pendingCalls.delete(id);
                reject(new Error(`CDP call ${method} timed out after ${cdpCallTimeoutMs}ms`));
            }
        }, cdpCallTimeoutMs);

        pendingCalls.set(id, { resolve, reject, timeoutId });

        try {
            ws.send(JSON.stringify({ id, method, params }));
        } catch (error) {
            clearTimeout(timeoutId);
            pendingCalls.delete(id);
            reject(new Error(`CDP send failed: ${error.message}`));
        }
    });

    await call('Runtime.enable', {});
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));

    return { ws, call, contexts };
}

export { discoverCDP, connectCDP };
