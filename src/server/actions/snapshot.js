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

        const clone = panel.cloneNode(true);
        clone.querySelectorAll('.composite.title, .title-actions, .simple-find-part-wrapper, .composer-input-blur-wrapper, .ai-input-full-input-box, .compact-agent-history-react-menu-content, .ui-menu__content, .context-view').forEach(el => el.remove());

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
