import fs from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import WebSocket from 'ws';
import { discoverCDP, connectCDP } from './cdp-connection.js';
import { captureSnapshot } from './actions/snapshot.js';
import { getAppState, hashString } from './app-state.js';
import { summarizeLogText, summarizeAppStateForLog, summarizeSnapshotForLog, summarizeChangedKeys } from './logger.js';

// --- Shared mutable state ---

export function createPollingState() {
    return {
        cdpConnection: null,
        lastSnapshot: null,
        lastSnapshotHash: null,
        lastAppState: null,
        lastAppStateHash: null,
        lastAppStateSampledAt: 0,
        appStateApiRefreshInFlight: null,
        cursorLaunchPromise: null
    };
}

export function rememberAppStateSample(state, appState) {
    if (!appState || typeof appState !== 'object') return;
    state.lastAppState = appState;
    state.lastAppStateSampledAt = Date.now();
}

export function hasFreshAppStateSample(state, maxAgeMs) {
    return !!(
        state.lastAppState &&
        typeof state.lastAppState === 'object' &&
        state.lastAppStateSampledAt > 0 &&
        (Date.now() - state.lastAppStateSampledAt) <= maxAgeMs
    );
}

export async function getAppStateForApi(state, cdp, { maxAgeMs = 1500 } = {}) {
    if (hasFreshAppStateSample(state, maxAgeMs)) {
        return { state: state.lastAppState, source: 'cache' };
    }

    if (state.appStateApiRefreshInFlight) {
        const appState = await state.appStateApiRefreshInFlight;
        return { state: appState, source: 'coalesced' };
    }

    const request = (async () => {
        const appState = await getAppState(cdp, { lastAppState: state.lastAppState });
        rememberAppStateSample(state, appState);
        return appState;
    })().finally(() => {
        if (state.appStateApiRefreshInFlight === request) {
            state.appStateApiRefreshInFlight = null;
        }
    });

    state.appStateApiRefreshInFlight = request;
    const appState = await request;
    return { state: appState, source: 'live' };
}

// --- CDP initialization ---

export async function initCDP(state, { ports } = {}) {
    console.log('Discovering Cursor CDP endpoint...');
    const cdpInfo = await discoverCDP(ports);
    console.log(`Found cursor on port ${cdpInfo.port}`);

    console.log('Connecting to CDP...');
    state.cdpConnection = await connectCDP(cdpInfo.url);
    console.log(`Connected! Found ${state.cdpConnection.contexts.length} execution contexts\n`);
}

// --- Background polling ---

export async function startPolling(state, wss, { POLL_INTERVAL = 500, ports } = {}) {
    let lastErrorLog = 0;
    let isConnecting = false;
    const activePollIntervalMs = Math.max(120, Math.floor(POLL_INTERVAL / 3));

    const broadcast = (payload) => {
        const message = JSON.stringify(payload);
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try { client.send(message); } catch (e) { /* ignore dead sockets */ }
            }
        });
    };

    const resolveNextPollInterval = () => {
        const hasActiveClient = Array.from(wss.clients).some(client => client.readyState === WebSocket.OPEN);
        return hasActiveClient ? activePollIntervalMs : POLL_INTERVAL;
    };

    const poll = async () => {
        if (!state.cdpConnection || (state.cdpConnection.ws && state.cdpConnection.ws.readyState !== WebSocket.OPEN)) {
            if (!isConnecting) {
                console.log('Looking for Cursor CDP connection...');
                isConnecting = true;
            }
            if (state.cdpConnection) {
                console.log('CDP connection lost. Attempting to reconnect...');
                state.cdpConnection = null;
            }
            try {
                await initCDP(state, { ports });
                if (state.cdpConnection) {
                    console.log('CDP Connection established from polling loop');
                    isConnecting = false;
                }
            } catch (err) {
                // Not found yet, just wait for next cycle
            }
            setTimeout(poll, 2000);
            return;
        }

        try {
            const appState = await getAppState(state.cdpConnection, { lastAppState: state.lastAppState });
            if (appState && typeof appState === 'object') {
                const previousAppState = state.lastAppState;
                rememberAppStateSample(state, appState);
                const appStateHash = hashString(JSON.stringify(appState));
                if (appStateHash !== state.lastAppStateHash) {
                    const changedKeys = summarizeChangedKeys(previousAppState || {}, appState);
                    state.lastAppStateHash = appStateHash;
                    console.log('[POLL] App state changed', {
                        hash: appStateHash,
                        changedKeys,
                        state: summarizeAppStateForLog(appState)
                    });
                    broadcast({
                        type: 'app_state_update',
                        hash: appStateHash,
                        state: appState
                    });
                }
            }

            const snapshot = await captureSnapshot(state.cdpConnection);
            if (snapshot && !snapshot.error) {
                const hash = hashString(JSON.stringify({
                    html: snapshot.html,
                    activeChatTitle: snapshot.activeChatTitle || '',
                    chatTabs: snapshot.chatTabs || []
                }));
                state.lastSnapshot = {
                    ...snapshot,
                    hash,
                    capturedAt: new Date().toISOString()
                };

                if (hash !== state.lastSnapshotHash) {
                    state.lastSnapshotHash = hash;
                    broadcast({
                        type: 'snapshot_update',
                        hash: hash
                    });
                    console.log('[POLL] Snapshot updated', summarizeSnapshotForLog(state.lastSnapshot));
                    console.log(`Snapshot updated(hash: ${hash})`);
                }
            } else {
                const now = Date.now();
                if (!lastErrorLog || now - lastErrorLog > 10000) {
                    const errorMsg = snapshot?.error || 'No valid snapshot captured (check contexts)';
                    console.warn('[POLL] Snapshot capture issue', {
                        error: summarizeLogText(errorMsg, 160),
                        contextCount: Array.isArray(state.cdpConnection?.contexts) ? state.cdpConnection.contexts.length : 0
                    });
                    console.warn(`Snapshot capture issue: ${errorMsg}`);
                    if (errorMsg.includes('container not found')) {
                        console.log('   (Tip: Ensure an active chat is open in cursor)');
                    }
                    if (state.cdpConnection.contexts.length === 0) {
                        console.log('   (Tip: No active execution contexts found. Try interacting with the Cursor window)');
                    }
                    lastErrorLog = now;
                }
            }
        } catch (err) {
            console.error('Poll error:', err.message);
        }

        setTimeout(poll, resolveNextPollInterval());
    };

    poll();
}

// --- HTTPS certificates ---

export function ensureHttpsCertificates({ RUNTIME_ROOT, IS_EMBEDDED_RUNTIME, __dirname }) {
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
