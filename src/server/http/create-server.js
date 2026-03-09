import compression from 'compression';
import cookieParser from 'cookie-parser';
import express from 'express';
import fs from 'fs';
import http from 'http';
import https from 'https';
import { join } from 'path';
import { WebSocketServer } from 'ws';
import {
    bindAuthenticatedWebSocketServer,
    registerAuthMiddleware,
    registerNgrokBypass,
    registerRequestLogging
} from './auth.js';
import { registerCursorRoutes } from './routes/cursor.js';
import { registerSystemRoutes } from './routes/system.js';

export async function createServer({
    APP_PASSWORD,
    AUTH_COOKIE_NAME,
    IS_EMBEDDED_RUNTIME,
    SERVER_PORT,
    __dirname,
    ensureHttpsCertificates,
    hashString,
    isLocalRequest,
    killPortProcess,
    sanitizeLogUrl,
    ...deps
}) {
    const app = express();
    const { keyPath, certPath, certsExist } = ensureHttpsCertificates();

    if (!IS_EMBEDDED_RUNTIME && !certsExist) {
        throw new Error('HTTPS certificates could not be prepared.');
    }

    const hasSSL = certsExist && !IS_EMBEDDED_RUNTIME;
    let server;

    if (certsExist && IS_EMBEDDED_RUNTIME) {
        console.log('[EMBEDDED] SSL certificates detected, but embedded runtime will use local HTTP for webview compatibility.');
    }

    if (hasSSL) {
        const sslOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
        };

        server = https.createServer(sslOptions, app);

        const redirectApp = express();
        redirectApp.use((req, res) => {
            const httpsUrl = `https://${req.hostname}:${SERVER_PORT}${req.url}`;
            res.redirect(301, httpsUrl);
        });

        const httpRedirectServer = http.createServer(redirectApp);
        const httpRedirectPort = Number(SERVER_PORT) + 1;
        await killPortProcess(httpRedirectPort);
        httpRedirectServer.listen(httpRedirectPort, '0.0.0.0', () => {
            console.log(`HTTP redirect: http://localhost:${httpRedirectPort} -> https://localhost:${SERVER_PORT}`);
        }).on('error', () => {
            // HTTPS remains the primary listener.
        });
    } else {
        server = http.createServer(app);
    }

    const wss = new WebSocketServer({ server });
    const authSalt = process.env.AUTH_SALT || 'cursor_default_salt_99';
    const authToken = hashString(APP_PASSWORD + authSalt);
    const sessionSecret = process.env.SESSION_SECRET || 'cursor_secret_key_1337';

    app.use(compression());
    app.use(express.json());
    app.use(cookieParser(sessionSecret));

    registerRequestLogging(app, { sanitizeLogUrl });
    registerNgrokBypass(app);
    registerAuthMiddleware(app, {
        authCookieName: AUTH_COOKIE_NAME,
        authToken,
        appPassword: APP_PASSWORD,
        isLocalRequest
    });

    app.use(express.static(join(__dirname, 'public')));

    registerSystemRoutes(app, {
        ...deps,
        APP_PASSWORD,
        AUTH_COOKIE_NAME,
        IS_EMBEDDED_RUNTIME,
        SERVER_PORT,
        __dirname,
        authToken,
        certsExist,
        hasSSL
    });

    registerCursorRoutes(app, deps);

    bindAuthenticatedWebSocketServer(wss, {
        authCookieName: AUTH_COOKIE_NAME,
        authToken,
        isLocalRequest,
        sessionSecret
    });

    return { server, wss, app, hasSSL };
}
