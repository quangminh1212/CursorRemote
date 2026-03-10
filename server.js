#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { setupLogging, sanitizeLogUrl } from './src/server/logger.js';
import { createServer } from './src/server/http/create-server.js';
import { killPortProcess, getLocalIP, getJson } from './src/server/system-utils.js';
import { launchcursorWithCDP } from './src/server/cursor-process.js';
import { captureSnapshot } from './src/server/actions/snapshot.js';
import { injectMessage, injectFile } from './src/server/actions/inject.js';
import { setMode, setModel, setModelToggle, getDropdownOptions, stopGeneration } from './src/server/actions/mode-model.js';
import { clickElement, remoteScroll } from './src/server/actions/ui-actions.js';
import { startNewChat, getChatHistory, selectChat, closeHistory, hasChatOpen } from './src/server/actions/chat.js';
import { getAppState, hashString, isLocalRequest } from './src/server/app-state.js';
import {
    createPollingState, initCDP, startPolling, ensureHttpsCertificates,
    getAppStateForApi, rememberAppStateSample
} from './src/server/polling.js';

// --- Path setup ---
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

// --- Initialize logging (intercepts console.*) ---
setupLogging(RUNTIME_ROOT);

console.log('========================================');
console.log('Cursor Remote starting...');
console.log(`   PID: ${process.pid}`);
console.log(`   Node: ${process.version}`);
console.log(`   Time: ${new Date().toISOString()}`);
console.log(`   Runtime root: ${RUNTIME_ROOT}`);
console.log(`   Runtime mode: ${IS_EMBEDDED_RUNTIME ? 'embedded-webview' : 'browser-server'}`);
console.log('========================================');

// --- Constants ---
const PORTS = [9000, 9001, 9002, 9003];
const PRIMARY_CDP_PORT = PORTS[0];
const POLL_INTERVAL = 500;
const APP_STATE_CACHE_MAX_AGE_MS = 1500;
const SERVER_PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD || 'Cursor';
const AUTH_COOKIE_NAME = 'cr_auth_token';
const AUTO_LAUNCH_cursor = process.env.CR_SKIP_AUTO_LAUNCH !== '1';
const FORCE_VISIBLE_CURSOR = process.env.CR_VISIBLE_CURSOR === '1';

// --- Shared mutable state ---
const state = createPollingState();

// --- Main ---
async function main() {
    let initialCdpError = null;

    try {
        await initCDP(state, { ports: PORTS });
    } catch (err) {
        initialCdpError = err;
        const launchResult = await launchcursorWithCDP({
            AUTO_LAUNCH: AUTO_LAUNCH_cursor,
            PRIMARY_CDP_PORT,
            FORCE_VISIBLE: FORCE_VISIBLE_CURSOR
        });
        if (launchResult?.ready) {
            try {
                await initCDP(state, { ports: PORTS });
            } catch (retryErr) {
                initialCdpError = retryErr;
            }
        }

        if (!state.cdpConnection) {
            console.warn(`Initial CDP discovery failed: ${err.message}`);
            console.log('Start Cursor with --remote-debugging-port=9000 to connect.');
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
            ensureHttpsCertificates: () => ensureHttpsCertificates({ RUNTIME_ROOT, IS_EMBEDDED_RUNTIME, __dirname }),
            getAppState,
            getAppStateForApi: (cdp, opts) => getAppStateForApi(state, cdp, opts),
            getCdpConnection: () => state.cdpConnection,
            getChatHistory,
            getDropdownOptions,
            getJson,
            getLocalIP,
            getSnapshot: () => state.lastSnapshot,
            hasChatOpen,
            hashString,
            injectFile,
            injectMessage,
            isLocalRequest,
            killPortProcess,
            launchcursorWithCDP: () => launchcursorWithCDP({ AUTO_LAUNCH: AUTO_LAUNCH_cursor, PRIMARY_CDP_PORT, FORCE_VISIBLE: FORCE_VISIBLE_CURSOR }),
            remoteScroll,
            sanitizeLogUrl,
            selectChat,
            setMode,
            setModel,
            setModelToggle,
            startNewChat,
            stopGeneration
        });

        startPolling(state, wss, { POLL_INTERVAL, ports: PORTS });

        // Kill any existing process on the port before starting
        await killPortProcess(SERVER_PORT);

        // Start server with EADDRINUSE retry
        const localIP = getLocalIP();
        const protocol = hasSSL ? 'https' : 'http';
        let listenRetries = 0;
        const MAX_LISTEN_RETRIES = 3;

        const startListening = () => {
            server.listen(SERVER_PORT, '0.0.0.0', () => {
                console.log(`Server running on ${protocol}://${localIP}:${SERVER_PORT}`);
                if (hasSSL) {
                    console.log('First time on phone? Accept the security warning to proceed.');
                }
            });
        };

        server.on('error', async (err) => {
            if (err.code === 'EADDRINUSE' && listenRetries < MAX_LISTEN_RETRIES) {
                listenRetries++;
                console.warn(`Port ${SERVER_PORT} busy, retry ${listenRetries}/${MAX_LISTEN_RETRIES}...`);
                await killPortProcess(SERVER_PORT);
                setTimeout(startListening, 1000);
            } else if (err.code === 'EADDRINUSE') {
                console.error(`Port ${SERVER_PORT} still in use after ${MAX_LISTEN_RETRIES} retries. Exiting.`);
                process.exit(1);
            } else {
                console.error('Server error:', err.message);
            }
        });

        startListening();

        // Graceful shutdown handlers
        const gracefulShutdown = (signal) => {
            console.log(`\nReceived ${signal}. Shutting down gracefully...`);
            wss.close(() => {
                console.log('   WebSocket server closed');
            });
            server.close(() => {
                console.log('   HTTP server closed');
            });
            if (state.cdpConnection?.ws) {
                state.cdpConnection.ws.close();
                console.log('   CDP connection closed');
            }
            setTimeout(() => process.exit(0), 1000);
        };

        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    } catch (err) {
        console.error('Fatal error:', err.message);
        process.exit(1);
    }
}

main();
