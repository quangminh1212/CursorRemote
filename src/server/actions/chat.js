import { evaluateCursor, clickAtPoint } from '../cdp-eval.js';
import { createTraceId, logTraceStep, summarizeLogText, summarizeLogValue, summarizeActionResultForLog } from '../logger.js';
import { sleep } from '../system-utils.js';

// Start New Chat - Click the + button at the TOP of the chat window (NOT the context/media + button)
async function startNewChat(cdp, traceId = null) {
    logTraceStep(traceId, 'startNewChat.request');
    const result = await evaluateCursor(cdp, `
        const newChatButton = __cr.findNewChatButton();
        if (!newChatButton) return { error: 'New chat button not found' };

        __cr.click(newChatButton);
        await new Promise(r => setTimeout(r, 250));

        const editor = __cr.findEditor();
        return {
            success: true,
            method: 'new_chat_button',
            editorFound: !!editor,
            editorText: editor ? __cr.textOf(editor) : ''
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });
    logTraceStep(traceId, 'startNewChat.complete', summarizeActionResultForLog(result));
    return result;
}
// Get Chat History - Click history button and scrape conversations
async function getChatHistory(cdp, traceId = null) {
    logTraceStep(traceId, 'getChatHistory.request');
    const opener = await evaluateCursor(cdp, `
        const historyButton = __cr.findHistoryButton();
        if (!historyButton) return { error: 'History button not found', chats: [] };
        const rect = historyButton.getBoundingClientRect();
        return {
            success: true,
            button: {
                x: rect.left + (rect.width / 2),
                y: rect.top + (rect.height / 2)
            }
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });

    if (!opener?.success || !opener.button) {
        logTraceStep(traceId, 'getChatHistory.openFailed', summarizeActionResultForLog(opener));
        return opener || { error: 'History button not found', chats: [] };
    }
    logTraceStep(traceId, 'getChatHistory.openMenu', summarizeLogValue(opener));

    await clickAtPoint(cdp, opener.button.x, opener.button.y);
    await new Promise(resolve => setTimeout(resolve, 500));

    const result = await evaluateCursor(cdp, `
        const menu = __cr.findHistoryMenu();
        const chats = __cr.getHistoryItems().slice(0, 50).map(item => ({
            title: item.title,
            section: item.section || 'Recent'
        }));
        const activeTitle = __cr.getActiveChatTitle() || '';

        return {
            success: true,
            chats,
            activeTitle,
            debug: {
                menuFound: !!menu,
                menuText: menu ? __cr.textOf(menu).slice(0, 200) : '',
                itemCount: chats.length,
                activeTitle
            }
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });

    const titlesMatch = (left, right) => {
        const a = String(left || '').replace(/[\u2026.]+$/g, '').trim().toLowerCase();
        const b = String(right || '').replace(/[\u2026.]+$/g, '').trim().toLowerCase();
        if (!a || !b) return false;
        if (a === b) return true;
        if (/(?:\u2026|\.{3})\s*$/u.test(String(left || '').trim()) && b.startsWith(a) && b.length > a.length) return true;
        if (/(?:\u2026|\.{3})\s*$/u.test(String(right || '').trim()) && a.startsWith(b) && a.length > b.length) return true;
        return false;
    };

    logTraceStep(traceId, 'getChatHistory.complete', summarizeActionResultForLog(result));
    return result;
}

async function selectChat(cdp, chatTitle, traceId = null) {
    const targetTitle = String(chatTitle || '').trim();
    if (!targetTitle) return { error: 'Chat title required' };
    logTraceStep(traceId, 'selectChat.request', {
        targetTitle
    });

    const titlesMatch = (left, right) => {
        const a = String(left || '').replace(/[\u2026.]+$/g, '').trim().toLowerCase();
        const b = String(right || '').replace(/[\u2026.]+$/g, '').trim().toLowerCase();
        if (!a || !b) return false;
        if (a === b) return true;
        if (/(?:\u2026|\.{3})\s*$/u.test(String(left || '').trim()) && b.startsWith(a) && b.length > a.length) return true;
        if (/(?:\u2026|\.{3})\s*$/u.test(String(right || '').trim()) && a.startsWith(b) && a.length > b.length) return true;
        return false;
    };

    const tabSelection = await evaluateCursor(cdp, `
        const desiredTitle = ${JSON.stringify(targetTitle)};
        const normalizeTitle = (value) => String(value || '').replace(/[\u2026.]+$/g, '').trim().toLowerCase();
        const hasExplicitTruncation = (value) => /(?:\u2026|\.{3})\s*$/u.test(String(value || '').trim());
        const titlesMatch = (left, right) => {
            const a = normalizeTitle(left);
            const b = normalizeTitle(right);
            if (!a || !b) return false;
            if (a === b) return true;
            if (hasExplicitTruncation(left) && b.startsWith(a) && b.length > a.length) return true;
            if (hasExplicitTruncation(right) && a.startsWith(b) && a.length > b.length) return true;
            return false;
        };
        const desiredLower = normalizeTitle(desiredTitle);
        const container = __cr.findChatTabsContainer();
        if (!container) return { success: false, reason: 'chat_tabs_not_found' };

        const tabs = __cr.getChatTabElements(container)
            .map((element) => ({
                element,
                title: String(element.getAttribute('aria-label') || __cr.textOf(element) || '').trim(),
                active: __cr.isTabActive(element)
            }))
            .filter((tab) => tab.title && !/^more actions(?:\\.\\.\\.)?$/i.test(tab.title));

        const target = tabs
            .filter((tab) => {
                return titlesMatch(tab.title, desiredTitle);
            })
            .sort((a, b) => {
                const aExact = normalizeTitle(a.title) === desiredLower ? 1 : 0;
                const bExact = normalizeTitle(b.title) === desiredLower ? 1 : 0;
                if (bExact !== aExact) return bExact - aExact;
                return b.title.length - a.title.length;
            })[0];

        if (!target) {
            return {
                success: false,
                reason: 'chat_tab_not_found',
                available: tabs.map((tab) => tab.title)
            };
        }

        const rect = target.element.getBoundingClientRect();
        if (!target.active) {
            __cr.click(target.element);
        }
        return {
            success: true,
            method: 'chat_tab',
            title: target.title,
            alreadyActive: target.active,
            target: {
                x: rect.left + (rect.width / 2),
                y: rect.top + (rect.height / 2)
            }
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });

    if (tabSelection?.success) {
        logTraceStep(traceId, 'selectChat.tabSelection', summarizeActionResultForLog(tabSelection));
        if (!tabSelection.alreadyActive) {
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        let activeCheck = await evaluateCursor(cdp, `
            const activeChatTitle = __cr.getActiveChatTitle() || '';
            return { activeChatTitle };
        `, {
            accept: (value) => value && typeof value === 'object'
        });

        if (!tabSelection.alreadyActive && tabSelection.target && !titlesMatch(activeCheck?.activeChatTitle, tabSelection.title)) {
            await clickAtPoint(cdp, tabSelection.target.x, tabSelection.target.y);
            await new Promise(resolve => setTimeout(resolve, 300));
            activeCheck = await evaluateCursor(cdp, `
                const activeChatTitle = __cr.getActiveChatTitle() || '';
                return { activeChatTitle };
            `, {
                accept: (value) => value && typeof value === 'object'
            });
        }

        if (tabSelection.alreadyActive || titlesMatch(activeCheck?.activeChatTitle, tabSelection.title)) {
            const finalResult = {
                success: true,
                method: tabSelection.method,
                title: activeCheck?.activeChatTitle || tabSelection.title
            };
            logTraceStep(traceId, 'selectChat.complete', summarizeActionResultForLog(finalResult));
            return finalResult;
        }
    }

    const opener = await evaluateCursor(cdp, `
        const desiredTitle = ${JSON.stringify(targetTitle)};
        let menu = __cr.findHistoryMenu();
        if (!menu) {
            const historyButton = __cr.findHistoryButton();
            if (!historyButton) return { error: 'History button not found' };
            const rect = historyButton.getBoundingClientRect();
            return {
                success: true,
                requiresOpen: true,
                desiredTitle,
                button: {
                    x: rect.left + (rect.width / 2),
                    y: rect.top + (rect.height / 2)
                }
            };
        }

        return { success: true, requiresOpen: false, desiredTitle };
    `, {
        accept: (value) => value && typeof value === 'object'
    });

    if (!opener?.success) {
        logTraceStep(traceId, 'selectChat.historyOpenFailed', summarizeActionResultForLog(opener));
        return opener || { error: 'History button not found' };
    }

    if (opener.requiresOpen && opener.button) {
        await clickAtPoint(cdp, opener.button.x, opener.button.y);
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    const selection = await evaluateCursor(cdp, `
        const desiredTitle = ${JSON.stringify(targetTitle)};
        const menu = __cr.findHistoryMenu();
        if (!menu) return { error: 'History menu not found' };

        let items = __cr.getMenuItems(menu);
        const desiredLower = desiredTitle.toLowerCase();
        items = items.filter(item => {
            const titleLower = item.title.toLowerCase();
            return titleLower === desiredLower ||
                titleLower.includes(desiredLower) ||
                desiredLower.includes(titleLower);
        });

        const target = items
            .sort((a, b) => {
                const aExact = a.title.toLowerCase() === desiredLower ? 1 : 0;
                const bExact = b.title.toLowerCase() === desiredLower ? 1 : 0;
                if (bExact !== aExact) return bExact - aExact;
                return b.title.length - a.title.length;
            })[0];

        if (!target) {
            return {
                error: 'Chat not found: ' + desiredTitle,
                available: __cr.getHistoryItems().slice(0, 20).map(item => item.title)
            };
        }

        const rect = target.element.getBoundingClientRect();
        return {
            success: true,
            method: 'history_menu',
            title: target.title,
            target: {
                x: rect.left + (rect.width / 2),
                y: rect.top + (rect.height / 2)
            }
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });

    if (!selection?.success || !selection.target) {
        logTraceStep(traceId, 'selectChat.historySelectionFailed', summarizeActionResultForLog(selection));
        return selection || { error: 'Chat not found: ' + targetTitle };
    }
    logTraceStep(traceId, 'selectChat.historySelection', summarizeActionResultForLog(selection));

    await clickAtPoint(cdp, selection.target.x, selection.target.y);
    await new Promise(resolve => setTimeout(resolve, 300));

    const finalResult = {
        success: true,
        method: selection.method,
        title: selection.title
    };
    logTraceStep(traceId, 'selectChat.complete', summarizeActionResultForLog(finalResult));
    return finalResult;
}

// Close History Panel (Escape)
async function closeHistory(cdp) {
    const EXP = `(async () => {
        try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', code: 'Escape', bubbles: true }));
            return { success: true };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Failed to close history panel' };
}

// Check if a chat is currently open (has cascade element)
async function hasChatOpen(cdp) {
    return await evaluateCursor(cdp, `
        const panel = __cr.findPanel();
        const editor = __cr.findEditor();
        const messages = __cr.collectMessageNodes();
        return {
            hasChat: !!panel,
            hasMessages: messages.length > 0,
            editorFound: !!editor
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });
}

export { startNewChat, getChatHistory, selectChat, closeHistory, hasChatOpen };
