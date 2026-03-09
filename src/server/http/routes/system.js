import QRCode from 'qrcode';
import { inspectUI } from '../../../../ui_inspector.js';
import { setSignedAuthCookie } from '../auth.js';

const UI_INSPECT_EXPR = `(() => {
    try {
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return { error: 'Non-DOM context' };
        }

        function getCls(el) {
            if (!el) return '';
            if (typeof el.className === 'string') return el.className;
            if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
            return '';
        }

        function findAllElements(selector, root = document) {
            let results = Array.from(root.querySelectorAll(selector));
            const elements = root.querySelectorAll('*');
            for (const el of elements) {
                try {
                    if (el.shadowRoot) {
                        results = results.concat(Array.from(el.shadowRoot.querySelectorAll(selector)));
                    }
                } catch (error) { }
            }
            return results;
        }

        const url = window.location ? window.location.href : '';
        const title = document.title || '';
        const bodyLen = document.body ? document.body.innerHTML.length : 0;
        const hasCascade = !!document.getElementById('cascade') || !!document.querySelector('.cascade');

        const allLucideElements = findAllElements('svg[class*="lucide"]').map(svg => {
            const parent = svg.closest('button, [role="button"], div, span, a');
            if (!parent || parent.offsetParent === null) return null;
            const rect = parent.getBoundingClientRect();
            return {
                type: 'lucide-icon',
                tag: parent.tagName.toLowerCase(),
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                svgClasses: getCls(svg),
                className: getCls(parent).substring(0, 100),
                ariaLabel: parent.getAttribute('aria-label') || '',
                title: parent.getAttribute('title') || '',
                parentText: (parent.innerText || '').trim().substring(0, 50)
            };
        }).filter(Boolean);

        const buttons = findAllElements('button, [role="button"]').map((btn, index) => {
            const rect = btn.getBoundingClientRect();
            const svg = btn.querySelector('svg');

            return {
                type: 'button',
                index,
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                text: (btn.innerText || '').trim().substring(0, 50) || '(empty)',
                ariaLabel: btn.getAttribute('aria-label') || '',
                title: btn.getAttribute('title') || '',
                svgClasses: getCls(svg),
                className: getCls(btn).substring(0, 100),
                visible: btn.offsetParent !== null
            };
        }).filter(button => button.visible);

        return {
            url,
            title,
            bodyLen,
            hasCascade,
            buttons,
            lucideIcons: allLucideElements
        };
    } catch (error) {
        return { error: error.toString(), stack: error.stack };
    }
})()`;

function getConnectedCdp(getCdpConnection, res) {
    const cdpConnection = getCdpConnection();
    if (!cdpConnection) {
        res.status(503).json({ error: 'CDP disconnected' });
        return null;
    }
    return cdpConnection;
}

export function registerSystemRoutes(app, {
    APP_PASSWORD,
    AUTH_COOKIE_NAME,
    IS_EMBEDDED_RUNTIME,
    PORTS,
    RUNTIME_ROOT,
    SERVER_PORT,
    __dirname,
    authToken,
    certsExist,
    getCdpConnection,
    getAppState,
    getJson,
    getLocalIP,
    getSnapshot,
    hasSSL
}) {
    app.post('/login', (req, res) => {
        const { password } = req.body;
        if (password === APP_PASSWORD) {
            setSignedAuthCookie(res, { authCookieName: AUTH_COOKIE_NAME, authToken });
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, error: 'Invalid password' });
        }
    });

    app.post('/logout', (req, res) => {
        res.clearCookie(AUTH_COOKIE_NAME);
        res.json({ success: true });
    });

    app.get('/snapshot', async (req, res) => {
        const cdpConnection = getCdpConnection();
        if (!cdpConnection) {
            return res.status(503).json({ error: 'No live snapshot available' });
        }

        if (typeof getAppState === 'function') {
            try {
                const appState = await getAppState(cdpConnection);
                const hasLiveCursorView = !!(
                    appState?.hasChat
                    || appState?.editorFound
                    || (Array.isArray(appState?.chatTabs) && appState.chatTabs.length > 0)
                    || appState?.activeChatTitle
                );

                if (!hasLiveCursorView) {
                    return res.status(503).json({ error: 'No live chat available' });
                }
            } catch (error) {
                return res.status(503).json({ error: 'Live snapshot validation failed' });
            }
        }

        const snapshot = getSnapshot();
        if (!snapshot) {
            return res.status(503).json({ error: 'No snapshot available yet' });
        }

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(snapshot);
    });

    app.get('/health', (req, res) => {
        const cdpConnection = getCdpConnection();
        res.json({
            status: 'ok',
            cdpConnected: cdpConnection?.ws?.readyState === 1,
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            https: hasSSL,
            embedded: IS_EMBEDDED_RUNTIME
        });
    });

    app.get('/qr-info', async (req, res) => {
        try {
            const localIP = getLocalIP();
            const protocol = hasSSL ? 'https' : 'http';
            const connectUrl = `${protocol}://${localIP}:${SERVER_PORT}?key=${encodeURIComponent(APP_PASSWORD)}`;

            const qrDataUrl = await QRCode.toDataURL(connectUrl, {
                width: 280,
                margin: 2,
                color: {
                    dark: '#e0e0e4',
                    light: '#111215'
                }
            });

            res.json({
                qrDataUrl,
                connectUrl,
                localIP,
                port: SERVER_PORT,
                protocol
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/ssl-status', (req, res) => {
        res.json({
            enabled: hasSSL,
            certsExist,
            embedded: IS_EMBEDDED_RUNTIME,
            message: hasSSL ? 'HTTPS is active'
                : certsExist && IS_EMBEDDED_RUNTIME ? 'Embedded runtime uses local HTTP. Browser mode can still use HTTPS.'
                    : certsExist ? 'Certificates exist, restart server to enable HTTPS'
                        : 'No certificates found'
        });
    });

    app.post('/generate-ssl', async (req, res) => {
        try {
            const { execSync } = await import('child_process');
            execSync('node generate_ssl.js', {
                cwd: __dirname,
                stdio: 'pipe',
                env: {
                    ...process.env,
                    CR_RUNTIME_DIR: RUNTIME_ROOT
                }
            });

            res.json({
                success: true,
                message: 'SSL certificates generated! Restart the server to enable HTTPS.'
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    app.get('/debug-ui', async (req, res) => {
        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) return;

        const uiTree = await inspectUI(cdpConnection);
        console.log('--- UI TREE ---');
        console.log(uiTree);
        console.log('---------------');
        res.type('json').send(uiTree);
    });

    app.get('/ui-inspect', async (req, res) => {
        const cdpConnection = getConnectedCdp(getCdpConnection, res);
        if (!cdpConnection) return;

        try {
            const { frameTree } = await cdpConnection.call('Page.getFrameTree');
            const flattenFrames = (node) => {
                let list = [{
                    id: node.frame.id,
                    url: node.frame.url,
                    name: node.frame.name,
                    parentId: node.frame.parentId
                }];

                if (node.childFrames) {
                    for (const child of node.childFrames) {
                        list = list.concat(flattenFrames(child));
                    }
                }

                return list;
            };

            const allFrames = flattenFrames(frameTree);
            const contexts = cdpConnection.contexts.map((context) => ({
                id: context.id,
                name: context.name,
                origin: context.origin,
                frameId: context.auxData ? context.auxData.frameId : null,
                isDefault: context.auxData ? context.auxData.isDefault : false
            }));

            const contextResults = [];
            for (const context of contexts) {
                try {
                    const result = await cdpConnection.call('Runtime.evaluate', {
                        expression: UI_INSPECT_EXPR,
                        returnByValue: true,
                        contextId: context.id
                    });

                    if (result.result?.value) {
                        const value = result.result.value;
                        contextResults.push({
                            contextId: context.id,
                            frameId: context.frameId,
                            url: value.url,
                            title: value.title,
                            hasCascade: value.hasCascade,
                            buttonCount: value.buttons.length,
                            lucideCount: value.lucideIcons.length,
                            buttons: value.buttons,
                            lucideIcons: value.lucideIcons
                        });
                    } else if (result.exceptionDetails) {
                        contextResults.push({
                            contextId: context.id,
                            frameId: context.frameId,
                            error: `Script Exception: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''} `
                        });
                    } else {
                        contextResults.push({
                            contextId: context.id,
                            frameId: context.frameId,
                            error: 'No value returned (undefined)'
                        });
                    }
                } catch (error) {
                    contextResults.push({ contextId: context.id, error: error.message });
                }
            }

            const cascadeFrame = allFrames.find((frame) => frame.url.includes('cascade'));
            const matchingContext = contextResults.find((result) => result.frameId === cascadeFrame?.id);
            const contentContext = contextResults.sort((left, right) => (right.buttonCount || 0) - (left.buttonCount || 0))[0];
            const bestContext = matchingContext || contentContext;
            const usefulButtons = bestContext
                ? (bestContext.buttons || []).filter((button) =>
                    button.ariaLabel?.includes('New Conversation')
                    || button.title?.includes('New Conversation')
                    || button.ariaLabel?.includes('Past Conversations')
                    || button.title?.includes('Past Conversations')
                    || button.ariaLabel?.includes('History'))
                : [];

            res.json({
                summary: {
                    frameFound: !!cascadeFrame,
                    cascadeFrameId: cascadeFrame?.id,
                    contextFound: !!matchingContext,
                    bestContextId: bestContext?.contextId
                },
                frames: allFrames,
                contexts,
                scanResults: contextResults.map((result) => ({
                    id: result.contextId,
                    frameId: result.frameId,
                    url: result.url,
                    hasCascade: result.hasCascade,
                    buttons: result.buttonCount,
                    error: result.error
                })),
                usefulButtons,
                bestContextData: bestContext
            });
        } catch (error) {
            res.status(500).json({ error: error.message, stack: error.stack });
        }
    });

    app.get('/cdp-targets', async (req, res) => {
        const results = {};
        for (const port of PORTS) {
            try {
                results[port] = await getJson(`http://127.0.0.1:${port}/json/list`);
            } catch (error) {
                results[port] = error.message;
            }
        }

        res.json(results);
    });
}
