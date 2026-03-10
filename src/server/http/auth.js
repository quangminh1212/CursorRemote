import cookieParser from 'cookie-parser';

const AUTH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/favicon.ico', '/logo.png']);

function summarizeLogText(value, maxLength = 120) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.length > maxLength
        ? `${normalized.slice(0, Math.max(0, maxLength - 1))}…`
        : normalized;
}

export function setSignedAuthCookie(res, { authCookieName, authToken }) {
    res.cookie(authCookieName, authToken, {
        httpOnly: true,
        signed: true,
        maxAge: AUTH_COOKIE_MAX_AGE_MS
    });
}

export function registerRequestLogging(app, { sanitizeLogUrl }) {
    let requestLogCounter = 0;

    app.use((req, res, next) => {
        const requestId = ++requestLogCounter;
        const startedAt = Date.now();
        const requestTarget = sanitizeLogUrl(req.originalUrl || req.url);
        const forwardedFor = req.headers['x-forwarded-for'];
        const clientIp = typeof forwardedFor === 'string'
            ? forwardedFor.split(',')[0].trim()
            : req.socket?.remoteAddress || req.ip || 'unknown';
        const userAgent = summarizeLogText(req.headers['user-agent'] || '', 160);
        const contentLength = Number(req.headers['content-length'] || 0) || 0;

        req.requestId = requestId;
        req.requestStartedAt = startedAt;
        req.requestTarget = requestTarget;
        res.locals.requestId = requestId;

        console.log(`[REQ ${requestId}] -> ${req.method} ${requestTarget} from ${clientIp}`, {
            userAgent: userAgent || undefined,
            contentLength: contentLength || undefined
        });

        let responseLogged = false;
        const logResponse = (eventName) => {
            if (responseLogged) return;
            responseLogged = true;
            const durationMs = Date.now() - startedAt;
            console.log(`[REQ ${requestId}] <- ${res.statusCode} ${req.method} ${requestTarget} ${durationMs}ms (${eventName})`, {
                contentType: summarizeLogText(res.getHeader('content-type') || '', 96) || undefined
            });
        };

        res.once('finish', () => logResponse('finish'));
        res.once('close', () => logResponse(res.writableEnded ? 'close' : 'aborted'));
        next();
    });
}

export function registerNgrokBypass(app) {
    app.use((req, res, next) => {
        res.setHeader('ngrok-skip-browser-warning', 'true');
        next();
    });
}

export function registerAuthMiddleware(app, {
    authCookieName,
    authToken,
    appPassword,
    isLocalRequest
}) {
    app.use((req, res, next) => {
        if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/css/')) {
            return next();
        }

        if (isLocalRequest(req)) {
            return next();
        }

        if (req.query.key === appPassword) {
            setSignedAuthCookie(res, { authCookieName, authToken });
            return res.redirect('/');
        }

        const token = req.signedCookies[authCookieName];
        if (token === authToken) {
            return next();
        }

        if (req.xhr || req.headers.accept?.includes('json') || req.path.startsWith('/snapshot') || req.path.startsWith('/send')) {
            res.status(401).json({ error: 'Unauthorized' });
        } else {
            res.redirect('/login.html');
        }
    });
}

export function bindAuthenticatedWebSocketServer(wss, {
    authCookieName,
    authToken,
    isLocalRequest,
    sessionSecret
}) {
    let wsConnectionCounter = 0;

    wss.on('connection', (ws, req) => {
        const clientId = ++wsConnectionCounter;
        const connectedAt = Date.now();
        const forwardedFor = req.headers['x-forwarded-for'];
        const clientIp = typeof forwardedFor === 'string'
            ? forwardedFor.split(',')[0].trim()
            : req.socket?.remoteAddress || req.ip || 'unknown';
        const userAgent = summarizeLogText(req.headers['user-agent'] || '', 160);
        const rawCookies = req.headers.cookie || '';
        const parsedCookies = {};

        rawCookies.split(';').forEach((cookieEntry) => {
            const [key, value] = cookieEntry.trim().split('=');
            if (!key || !value) return;

            try {
                parsedCookies[key] = decodeURIComponent(value);
            } catch {
                parsedCookies[key] = value;
            }
        });

        const signedToken = parsedCookies[authCookieName];
        let isAuthenticated = false;

        if (isLocalRequest(req)) {
            isAuthenticated = true;
        } else if (signedToken) {
            const token = cookieParser.signedCookie(signedToken, sessionSecret);
            if (token === authToken) {
                isAuthenticated = true;
            }
        }

        if (!isAuthenticated) {
            console.log(`[WS ${clientId}] Unauthorized connection attempt`, {
                clientIp,
                userAgent: userAgent || undefined
            });
            ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
            setTimeout(() => ws.close(), 100);
            return;
        }

        console.log(`[WS ${clientId}] Client connected`, {
            authenticated: true,
            clientIp,
            userAgent: userAgent || undefined
        });

        ws.on('error', (error) => {
            console.warn(`[WS ${clientId}] Error`, {
                clientIp,
                message: error?.message || String(error)
            });
        });

        ws.on('close', (code, reasonBuffer) => {
            const durationMs = Date.now() - connectedAt;
            const reason = summarizeLogText(Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString('utf8') : String(reasonBuffer || ''), 120);
            console.log(`[WS ${clientId}] Client disconnected`, {
                clientIp,
                durationMs,
                code,
                reason: reason || undefined
            });
        });
    });
}
