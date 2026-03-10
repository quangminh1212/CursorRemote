import { evaluateCursor } from '../cdp-eval.js';

// Capture chat snapshot
async function captureSnapshot(cdp) {
    const result = await evaluateCursor(cdp, `
        const panel = __cr.findPanel();
        const editor = __cr.findEditor();
        const chatTabs = __cr.getChatTabs();
        const activeChatTitle = __cr.getActiveChatTitle();

        if (!panel || !editor) {
            return {
                error: 'chat panel not found',
                debug: {
                    hasPanel: !!panel,
                    hasEditor: !!editor,
                    knownIds: Array.from(document.querySelectorAll('[id]')).slice(0, 80).map(el => el.id)
                }
            };
        }

        const composerSelector = '.composer-input-blur-wrapper, .ai-input-full-input-box';
        const composerPlaceholderHeight = Array.from(panel.querySelectorAll(composerSelector))
            .reduce((maxHeight, container) => {
                const rect = container.getBoundingClientRect();
                const nextHeight = Number.isFinite(rect.height) ? rect.height : 0;
                return Math.max(maxHeight, nextHeight);
            }, 0);
        const panelRect = panel.getBoundingClientRect();
        const notificationSelector = [
            '.announcement-modal',
            '[role="alert"]',
            '[aria-live="assertive"]',
            '[aria-live="polite"]',
            '.ui-toast',
            '.toast',
            '.notification',
            '[class*="notification"]',
            '[class*="announcement"]',
            '[class*="toast"]'
        ].join(', ');
        const notificationKeywordPattern = /connection\\s+error|free\\s+plans\\s+can\\s+only\\s+use\\s+auto|copy\\s+request|upgrade\\s+plans|\\berror\\b|\\bwarning\\b|\\bfailed\\b/i;

        const clone = panel.cloneNode(true);
        const preservedAlerts = [];
        const preservedAlertKeys = new Set();
        const toNormalizedAlertText = (node) => String(node?.innerText || node?.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
        const preserveAlertNode = (alertNode) => {
            if (!alertNode || typeof alertNode.cloneNode !== 'function') return;

            const alertText = toNormalizedAlertText(alertNode);
            const role = String(alertNode.getAttribute?.('role') || '').toLowerCase();
            const ariaLive = String(alertNode.getAttribute?.('aria-live') || '').toLowerCase();
            const className = String(alertNode.className || '').toLowerCase();
            const semanticHint = /alert|announcement|notification|toast|error|warning/.test(className) || role === 'alert' || !!ariaLive;

            if (!alertText && !semanticHint) return;
            if (!alertText && !notificationKeywordPattern.test(className)) return;

            const dedupeKey = [
                role,
                ariaLive,
                className.slice(0, 180),
                alertText.slice(0, 180)
            ].join('|');
            if (preservedAlertKeys.has(dedupeKey)) return;
            preservedAlertKeys.add(dedupeKey);

            const alertClone = alertNode.cloneNode(true);
            alertClone.classList.add('cr-preserved-alert');
            if (!alertClone.getAttribute('role') && notificationKeywordPattern.test(alertText)) {
                alertClone.setAttribute('role', 'alert');
            }
            preservedAlerts.push(alertClone);
        };

        clone.querySelectorAll(composerSelector).forEach(container => {
            container.querySelectorAll(notificationSelector).forEach(preserveAlertNode);
        });

        Array.from(document.querySelectorAll(notificationSelector)).forEach((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const hasBox = Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0;
            const overlapsPanelX = rect.right >= (panelRect.left - 32) && rect.left <= (panelRect.right + 32);
            const overlapsPanelY = rect.bottom >= (panelRect.top - 160) && rect.top <= (panelRect.bottom + 220);
            const closeToPanel = overlapsPanelX && overlapsPanelY;
            const candidateText = toNormalizedAlertText(candidate);
            if (!hasBox && !notificationKeywordPattern.test(candidateText)) return;
            if (!closeToPanel && !notificationKeywordPattern.test(candidateText)) return;
            preserveAlertNode(candidate);
        });

        clone.querySelectorAll('.composite.title, .title-actions, .simple-find-part-wrapper, .compact-agent-history-react-menu-content, .ui-menu__content, .context-view').forEach(el => el.remove());
        clone.querySelectorAll(composerSelector).forEach(el => el.remove());

        if (composerPlaceholderHeight > 0) {
            const spacer = document.createElement('div');
            spacer.className = 'cr-composer-spacer';
            spacer.style.height = Math.round(composerPlaceholderHeight) + 'px';
            spacer.style.minHeight = Math.round(composerPlaceholderHeight) + 'px';
            spacer.style.width = '100%';
            spacer.style.pointerEvents = 'none';
            spacer.setAttribute('aria-hidden', 'true');
            clone.appendChild(spacer);
        }

        if (preservedAlerts.length) {
            const mountPoint = clone.querySelector('.pane-body') || clone;
            const alertContainer = document.createElement('div');
            alertContainer.className = 'cr-preserved-alerts';
            preservedAlerts.forEach(alertNode => alertContainer.appendChild(alertNode));
            mountPoint.appendChild(alertContainer);
        }

        const scrollTarget = __cr.findPanelScrollRoot() || panel;
        const bodyStyles = getComputedStyle(document.body);
        const panelStyles = getComputedStyle(panel);
        const rootStyles = getComputedStyle(document.documentElement);

        const themeVars = {};
        [
            '--vscode-editor-background', '--vscode-editor-foreground',
            '--vscode-sideBar-background', '--vscode-panel-background',
            '--vscode-input-background', '--vscode-input-foreground',
            '--vscode-foreground', '--vscode-descriptionForeground',
            '--vscode-textLink-foreground', '--vscode-button-background',
            '--vscode-badge-background', '--vscode-badge-foreground',
            '--vscode-list-activeSelectionBackground',
            '--vscode-editorWidget-background',
            '--vscode-activityBar-background',
            '--vscode-tab-activeBackground'
        ].forEach(name => {
            const value = rootStyles.getPropertyValue(name).trim();
            if (value) themeVars[name] = value;
        });

        const html = clone.outerHTML;

        return {
            html,
            css: '',
            backgroundColor: panelStyles.backgroundColor || bodyStyles.backgroundColor,
            bodyBackgroundColor: bodyStyles.backgroundColor,
            color: panelStyles.color || bodyStyles.color,
            bodyColor: bodyStyles.color,
            fontFamily: panelStyles.fontFamily || bodyStyles.fontFamily,
            chatTabs,
            activeChatTitle,
            themeVars,
            scrollInfo: {
                scrollTop: scrollTarget.scrollTop || 0,
                scrollHeight: scrollTarget.scrollHeight || 0,
                clientHeight: scrollTarget.clientHeight || 0,
                scrollPercent: scrollTarget.scrollHeight > scrollTarget.clientHeight
                    ? (scrollTarget.scrollTop / (scrollTarget.scrollHeight - scrollTarget.clientHeight))
                    : 0
            },
            stats: {
                nodes: clone.getElementsByTagName('*').length,
                htmlSize: html.length,
                cssSize: 0
            }
        };
    `, {
        accept: (value) => value && !value.error && !!value.html
    });

    return result && !result.error ? result : null;
}

export { captureSnapshot };
