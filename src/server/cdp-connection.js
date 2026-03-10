import WebSocket from 'ws';
import { getJson, sleep } from './system-utils.js';
import { getOrderedContexts } from './cdp-eval.js';

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

export { discoverCDP, connectCDP };
