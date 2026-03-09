import cookieParser from 'cookie-parser';

const AUTH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/favicon.ico', '/logo.png']);

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

        console.log(`[REQ ${requestId}] -> ${req.method} ${requestTarget} from ${clientIp}`);

        let responseLogged = false;
        const logResponse = (eventName) => {
            if (responseLogged) return;
            responseLogged = true;
            const durationMs = Date.now() - startedAt;
            console.log(`[REQ ${requestId}] <- ${res.statusCode} ${req.method} ${requestTarget} ${durationMs}ms (${eventName})`);
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
    wss.on('connection', (ws, req) => {
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
            console.log('Unauthorized WebSocket connection attempt');
            ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
            setTimeout(() => ws.close(), 100);
            return;
        }

        console.log('Client connected (Authenticated)');

        ws.on('close', () => {
            console.log('Client disconnected');
        });
    });
}
