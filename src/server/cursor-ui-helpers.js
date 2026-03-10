// Cursor UI helpers - injected into browser via CDP Runtime.evaluate
// This is a template literal containing browser-side JavaScript
const CURSOR_UI_HELPERS = String.raw`
const __cr = (() => {
    const getClassName = (el) => {
        if (!el) return '';
        if (typeof el.className === 'string') return el.className;
        if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
        return '';
    };

    const isVisible = (el) => {
        if (!el || !el.isConnected || typeof el.getBoundingClientRect !== 'function') return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        return el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
    };

    const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const escapeRegExp = (value) => String(value || '').replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

    const queryAllVisible = (selector, root = document) => Array.from(root.querySelectorAll(selector)).filter(isVisible);
    const uniqueElements = (elements) => elements.filter((el, index, arr) => el && arr.indexOf(el) === index);
    const getArea = (el) => {
        const rect = el?.getBoundingClientRect?.();
        return rect ? Math.max(rect.width, 0) * Math.max(rect.height, 0) : 0;
    };
    const getLeafTexts = (el) => {
        if (!el) return [];
        const seen = new Set();
        return [el, ...Array.from(el.querySelectorAll('*'))]
            .filter(node => node === el || !node.children.length)
            .map(node => normalizeText(node.textContent || ''))
            .filter(text => {
                if (!text) return false;
                if (/^[\u2039\u203a\u25be\u2304\u2193]+$/u.test(text)) return false;
                const key = text.toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    };
    const MODE_TEXT_MATCHER = /^(agent|plan|debug|ask|fast|planning|manual)\b/i;
    const MODEL_TEXT_HINT_MATCHER = /(?:\bauto\b|gpt|claude|sonnet|opus|composer|gemini|\d\.\d)/i;
    const getBestLeafTextMatch = (el, matcher, { maxLength = 80 } = {}) => {
        if (!el || !matcher) return '';
        return getLeafTexts(el)
            .map(normalizeText)
            .filter(text => text && text.length <= maxLength && matcher.test(text))
            .sort((a, b) => a.length - b.length || a.localeCompare(b))[0] || '';
    };
    const isPlausibleModeText = (value) => {
        const text = normalizeText(value);
        return !!text && text.length <= 24 && MODE_TEXT_MATCHER.test(text);
    };
    const isPlausibleModelText = (value) => {
        const text = normalizeText(value);
        if (!text || text.length > 48) return false;
        if (/[{};]/.test(text) || /\.monaco-|cursorremote|upgrade to pro|launchpad|ctrl\+|https?:|\.png\b/i.test(text)) return false;
        return /^(auto|composer\s+\d+(?:\.\d+)*|gpt-\d+(?:\.\d+)*(?:\s+codex)?|sonnet\s+\d+(?:\.\d+)*|opus\s+\d+(?:\.\d+)*|gemini\s+\d+(?:\s+flash)?|claude(?:\s+[\w.-]+)?|o\d(?:\s+[\w.-]+)?)$/i.test(text);
    };
    const getModeHintText = () => {
        const panel = findPanel() || document;
        const hints = queryAllVisible('.aislash-editor-placeholder, [data-placeholder]', panel)
            .map(textOf)
            .map(normalizeText);
        for (const hint of hints) {
            const match = hint.match(/^(agent|plan|debug|ask|fast|planning|manual)\b/i);
            if (match) return match[1];
        }
        return '';
    };
    const pickModeName = (value) => {
        const normalized = normalizeText(value);
        if (!normalized) return '';
        const match = normalized.match(/(agent|plan|debug|ask|fast|planning|manual)/i);
        return match ? match[1] : normalized;
    };

    const isTabActive = (el) => {
        if (!el) return false;
        const ariaSelected = (el.getAttribute?.('aria-selected') || '').toLowerCase();
        const ariaCurrent = (el.getAttribute?.('aria-current') || '').toLowerCase();
        if (ariaSelected === 'true') return true;
        if (ariaCurrent && ariaCurrent !== 'false') return true;

        const cls = getClassName(el).toLowerCase();
        return cls.includes('checked') || cls.includes('active') || cls.includes('selected') || cls.includes('current');
    };

    const findPanel = () => {
        const candidates = uniqueElements([
            ...queryAllVisible('[id^="workbench.panel.aichat"]'),
            document.getElementById('conversation'),
            document.getElementById('chat'),
            document.getElementById('cascade')
        ].filter(isVisible));

        candidates.sort((a, b) => {
            const aScore = getArea(a) +
                (a.querySelector('.composer-bar, [data-composer-id]') ? 500000 : 0) +
                (a.querySelector('[data-lexical-editor="true"], [contenteditable="true"]') ? 250000 : 0);
            const bScore = getArea(b) +
                (b.querySelector('.composer-bar, [data-composer-id]') ? 500000 : 0) +
                (b.querySelector('[data-lexical-editor="true"], [contenteditable="true"]') ? 250000 : 0);
            return bScore - aScore;
        });

        return candidates[0] || null;
    };

    const normalizeChatTitleMatchKey = (value) => normalizeText(value)
        .replace(/[\u2026.]+$/g, '')
        .trim()
        .toLowerCase();

    const hasExplicitChatTitleTruncation = (value) => /(?:\u2026|\.{3})\s*$/u.test(String(value || '').trim());

    const chatTitlesMatch = (left, right) => {
        const a = normalizeChatTitleMatchKey(left);
        const b = normalizeChatTitleMatchKey(right);
        if (!a || !b) return false;
        if (a === b) return true;
        if (hasExplicitChatTitleTruncation(left) && b.startsWith(a) && b.length > a.length) return true;
        if (hasExplicitChatTitleTruncation(right) && a.startsWith(b) && a.length > b.length) return true;
        return false;
    };

    const getChatTabScore = (tab, activeTitle = '') => {
        const title = normalizeText(tab?.title);
        if (!title) return -1;

        let score = title.length;
        if (tab?.active) score += 1000;
        if (activeTitle) {
            const normalizedActiveTitle = normalizeText(activeTitle);
            if (title.toLowerCase() === normalizedActiveTitle.toLowerCase()) score += 240;
            else if (chatTitlesMatch(title, normalizedActiveTitle)) score += 120;
        }
        return score;
    };

    const normalizeChatTabs = (tabs, activeTitle = '') => {
        const deduped = [];
        const resolvedActiveTitle = normalizeText(activeTitle);

        for (const tab of Array.isArray(tabs) ? tabs : []) {
            const candidate = {
                title: normalizeText(tab?.title),
                active: !!tab?.active
            };
            if (!candidate.title) continue;

            const existingIndex = deduped.findIndex((item) => item.title.toLowerCase() === candidate.title.toLowerCase());
            if (existingIndex === -1) {
                deduped.push(candidate);
                continue;
            }

            if (getChatTabScore(candidate, resolvedActiveTitle) > getChatTabScore(deduped[existingIndex], resolvedActiveTitle)) {
                deduped[existingIndex] = candidate;
            }
        }

        let preferredIndex = -1;
        deduped.forEach((tab, index) => {
            const isCandidate = !!tab.active || (!!resolvedActiveTitle && chatTitlesMatch(tab.title, resolvedActiveTitle));
            if (!isCandidate) return;

            if (preferredIndex === -1 || getChatTabScore(tab, resolvedActiveTitle) > getChatTabScore(deduped[preferredIndex], resolvedActiveTitle)) {
                preferredIndex = index;
            }
        });

        return deduped.map((tab, index) => ({
            ...tab,
            active: index === preferredIndex
        }));
    };

    const normalizeChatTabElement = (el) => {
        if (!el) return null;
        const rootTab = el.closest?.('[role="tab"]');
        return rootTab && isVisible(rootTab) ? rootTab : el;
    };

    const getChatTabElements = (container = findChatTabsContainer()) => {
        if (!container) return [];
        return uniqueElements(
            Array.from(container.querySelectorAll('[role="tab"], .composite-bar-action-tab'))
                .filter(isVisible)
                .map(normalizeChatTabElement)
                .filter(isVisible)
        );
    };

    const findChatTabsContainer = () => {
        const panel = findPanel();
        const panelRect = panel?.getBoundingClientRect?.() || null;
        const containers = uniqueElements(
            queryAllVisible('[role="tab"], .composite-bar-action-tab', document)
                .map(tab => tab.closest?.('.composite.title.has-composite-bar, .composite-bar-container, .composite-bar, .monaco-action-bar, [class*="auxiliary-bar-title"]'))
                .filter(isVisible)
        );

        containers.sort((a, b) => {
            const score = (container) => {
                if (!container) return -Infinity;
                const rect = container.getBoundingClientRect();
                const tabs = uniqueElements(Array.from(container.querySelectorAll('[role="tab"], .composite-bar-action-tab')).filter(isVisible));
                if (!tabs.length) return -Infinity;

                let value = tabs.length * 6;
                if (tabs.some(isTabActive)) value += 20;
                if (rect.height <= 56) value += 10;
                if (rect.width >= 180) value += 6;

                if (panelRect) {
                    const overlap = Math.max(0, Math.min(rect.right, panelRect.right) - Math.max(rect.left, panelRect.left));
                    if (overlap > 0) {
                        value += Math.min(12, (overlap / Math.max(Math.min(rect.width, panelRect.width), 1)) * 12);
                    }

                    const gap = panelRect.top >= rect.bottom
                        ? panelRect.top - rect.bottom
                        : rect.top >= panelRect.bottom
                            ? rect.top - panelRect.bottom
                            : 0;
                    value += Math.max(0, 10 - (gap / 12));
                    if (rect.top <= panelRect.top) value += 6;
                }

                return value;
            };

            return score(b) - score(a);
        });

        return containers[0] || null;
    };

    const getChatTabs = () => {
        const container = findChatTabsContainer();
        if (!container) return [];

        const tabs = getChatTabElements(container)
            .map((el) => {
                const title = normalizeText(el.getAttribute?.('aria-label') || textOf(el));
                if (!title || title.length > 120) return null;

                const lower = title.toLowerCase();
                if (lower === 'more actions' || lower === 'more actions...') return null;

                return {
                    title,
                    active: isTabActive(el)
                };
            })
            .filter(Boolean);

        const activeTitle = tabs.find(tab => tab.active)?.title || '';
        return normalizeChatTabs(tabs, activeTitle);
    };

    const getActiveChatTitle = () => {
        const tabs = getChatTabs();
        const activeTab = tabs.find(tab => tab.active);
        if (activeTab?.title) return activeTab.title;

        const panel = findPanel();
        const paneHeader = panel?.closest?.('.pane')?.querySelector?.('.pane-header, .pane-header .title, .pane-header h3');
        const rawTitle = normalizeText(paneHeader?.getAttribute?.('aria-label') || textOf(paneHeader));
        if (rawTitle) {
            return rawTitle.replace(/\s+section$/i, '').trim();
        }

        return '';
    };

    const findEditor = () => {
        const panel = findPanel();
        const candidates = [];
        if (panel) candidates.push(...queryAllVisible('[data-lexical-editor="true"], [contenteditable="true"]', panel));
        candidates.push(...queryAllVisible('[data-lexical-editor="true"], [contenteditable="true"]'));
        return candidates
            .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)
            .at(-1) || null;
    };

    const findComposerBar = () => {
        const panel = findPanel() || document;
        return uniqueElements(queryAllVisible('.composer-bar, [data-composer-id]', panel))
            .sort((a, b) => {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                return (bRect.bottom - aRect.bottom) || (aRect.left - bRect.left);
            })[0] || null;
    };

    const getComposerAnchorRect = () => {
        return findComposerBar()?.getBoundingClientRect?.() || findEditor()?.getBoundingClientRect?.() || null;
    };

    const POPUP_CONTAINER_SELECTOR = '[role="menu"], [role="dialog"], [role="listbox"], .ui-menu__content, .context-view, [data-radix-popper-content-wrapper], .monaco-menu-container, .monaco-select-box-dropdown-container';

    const isInsidePopupContainer = (el) => {
        if (!el?.closest) return false;
        const popup = el.closest(POPUP_CONTAINER_SELECTOR);
        if (!popup || !isVisible(popup)) return false;

        const composer = findComposerBar();
        return !composer || !popup.contains(composer);
    };

    const scoreComposerChipCandidate = (el, {
        matcher,
        excludeMatcher = null,
        maxTextLength,
        minWidth,
        maxWidth,
        minHeight = 18,
        maxHeight = 44,
        maxContainerTextLength = Math.max(maxTextLength * 2, 72),
        horizontalWeight = 0.03
    } = {}) => {
        if (!el || !isVisible(el)) return -Infinity;
        if (isInsidePopupContainer(el)) return -Infinity;

        const role = String(el.getAttribute?.('role') || '').toLowerCase();
        if (role === 'menuitem' || role === 'option') return -Infinity;

        const rect = el.getBoundingClientRect();
        const leafText = getBestLeafTextMatch(el, matcher, { maxLength: maxTextLength });
        const containerText = normalizeText(textOf(el));
        if (!leafText || !containerText) return -Infinity;
        if (excludeMatcher) {
            const excludedText = getBestLeafTextMatch(el, excludeMatcher, { maxLength: 48 });
            if (excludedText && excludedText.toLowerCase() !== leafText.toLowerCase()) return -Infinity;
        }
        if (containerText.length > maxContainerTextLength) return -Infinity;
        if (rect.width < minWidth || rect.width > maxWidth || rect.height < minHeight || rect.height > maxHeight) return -Infinity;

        const anchorRect = getComposerAnchorRect();
        if (!anchorRect) return 100 - containerText.length;

        const verticalDistance = Math.abs(rect.bottom - anchorRect.bottom);
        if (verticalDistance > 120) return -Infinity;

        const horizontalPenalty = Math.abs(rect.left - anchorRect.left) * horizontalWeight;
        return 100 - verticalDistance - horizontalPenalty - containerText.length;
    };

    const findPanelScrollRoot = () => {
        const panel = findPanel();
        if (!panel) return null;

        const candidates = [
            ...queryAllVisible('.pane-body .monaco-scrollable-element, .composer-bar .monaco-scrollable-element, .scrollable-div-container, .ui-scroll-area__viewport, .ui-scroll-area', panel),
            ...queryAllVisible('.monaco-scrollable-element, [class*="scroll"], [style*="overflow"]', panel)
        ].filter(el => el.scrollHeight > el.clientHeight + 12);

        candidates.sort((a, b) => {
            const sizeDiff = b.clientHeight - a.clientHeight;
            if (sizeDiff) return sizeDiff;
            return a.getBoundingClientRect().y - b.getBoundingClientRect().y;
        });

        return candidates[0] || panel;
    };

    const click = (el) => {
        if (!el) return false;
        const target = el.closest?.('.anysphere-icon-button, .send-with-mode, button, [role="button"], a, .cursor-pointer') || el;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            try {
                target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            } catch (e) { /* ignore */ }
        }
        try { target.click?.(); } catch (e) { /* ignore */ }
        return true;
    };

    const resolveTrigger = (el) => el?.closest?.(
        '.composer-unified-dropdown, .composer-unified-dropdown-model, .anysphere-icon-button, .send-with-mode, button, [role="button"], a, .cursor-pointer'
    ) || el || null;

    const focusEditor = (editor) => {
        if (!editor) return;
        editor.focus();
        const selection = window.getSelection?.();
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    };

    const setEditorText = (editor, text) => {
        if (!editor) return false;
        focusEditor(editor);
        try { document.execCommand?.('selectAll', false, null); } catch (e) { /* ignore */ }
        try { document.execCommand?.('delete', false, null); } catch (e) { /* ignore */ }

        let inserted = false;
        try { inserted = !!document.execCommand?.('insertText', false, text); } catch (e) { /* ignore */ }

        if (!inserted) {
            editor.textContent = text;
            try { editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: text })); } catch (e) { /* ignore */ }
            try { editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); } catch (e) { /* ignore */ }
        }

        return true;
    };

    const findByAria = (needle) => Array.from(document.querySelectorAll('button, [role="button"], a, div')).find(el => {
        if (!isVisible(el)) return false;
        return (el.getAttribute('aria-label') || '').toLowerCase().includes(needle);
    });

    const findNewChatButton = () => {
        const legacy = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
        if (legacy && isVisible(legacy)) return legacy;
        return findByAria('new chat') ||
            Array.from(document.querySelectorAll('button, [role="button"], a')).find(el => isVisible(el) && /\bnew chat\b/i.test(textOf(el))) ||
            null;
    };

    const findHistoryButton = () => {
        return findByAria('chat history') ||
            document.querySelector('[data-tooltip-id*="history"], [data-tooltip-id*="past"], [data-tooltip-id*="recent"], [data-tooltip-id*="conversation-history"]') ||
            null;
    };

    const findAttachButton = () => {
        const icon = queryAllVisible('.codicon-image-two, .codicon-paperclip, .codicon-attach, svg.lucide-paperclip, svg.lucide-plus', document)
            .find(candidate => {
                const trigger = resolveTrigger(candidate);
                if (!trigger || !isVisible(trigger)) return false;
                const aria = (trigger.getAttribute('aria-label') || '').toLowerCase();
                const title = (trigger.getAttribute('title') || '').toLowerCase();
                return !aria.includes('new chat') && !title.includes('new chat');
            });
        if (icon) return resolveTrigger(icon);

        const editor = findEditor();
        if (!editor) return null;
        const editorRect = editor.getBoundingClientRect();
        const candidates = queryAllVisible('button, [role="button"], a, div', document)
            .map(resolveTrigger)
            .filter((el, index, arr) => el && arr.indexOf(el) === index);

        return candidates.find(button => {
            const rect = button.getBoundingClientRect();
            const aria = (button.getAttribute('aria-label') || '').toLowerCase();
            const title = (button.getAttribute('title') || '').toLowerCase();
            const cls = getClassName(button).toLowerCase();
            const nearEditor = Math.abs(rect.top - editorRect.top) < 160 || Math.abs(rect.bottom - editorRect.bottom) < 160;
            return nearEditor && (
                aria.includes('context') || aria.includes('attach') || aria.includes('file') || aria.includes('image') ||
                title.includes('context') || title.includes('attach') || title.includes('file') || title.includes('image') ||
                cls.includes('attach') || cls.includes('image')
            );
        }) || null;
    };

    const findHistoryMenu = () => {
        const candidates = queryAllVisible('[id^="composer-history-menu"], .compact-agent-history-react-menu-content, .ui-menu__content, [role="menu"], .context-view', document);
        candidates.sort((a, b) => {
            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            return (bRect.width * bRect.height) - (aRect.width * aRect.height);
        });
        return candidates[0] || null;
    };

    const MENU_TEXT_MARKERS = [
        /^auto(?:\b|\s)/i,
        /^max mode(?:\b|\s)/i,
        /^use multiple models?(?:\b|\s)/i,
        /^search models?$/i,
        /^add models?$/i,
        /^(agent|plan|debug|ask|fast|planning|manual)\b/i
    ];

    const findPopupAncestor = (el) => {
        let current = el;
        while (current && current !== document.body) {
            if (isVisible(current)) {
                const rect = current.getBoundingClientRect();
                const text = normalizeText(textOf(current));
                if (
                    text &&
                    MENU_TEXT_MARKERS.some(marker => marker.test(text)) &&
                    rect.width >= 120 &&
                    rect.width <= 420 &&
                    rect.height >= 24 &&
                    rect.height <= Math.min(window.innerHeight * 0.92, 560)
                ) {
                    return current;
                }
            }
            current = current.parentElement;
        }
        return null;
    };

    const findMenuContainers = () => {
        const selectorContainers = queryAllVisible('[role="menu"], [role="dialog"], [role="listbox"], .ui-menu__content, .context-view, [data-radix-popper-content-wrapper], [data-radix-popper-content-wrapper] > div, .monaco-menu-container, .monaco-select-box-dropdown-container', document);
        const inferredContainers = uniqueElements(
            Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"], [role="button"], a, div, span'))
                .filter(isVisible)
                .filter((el) => {
                    const text = normalizeText(textOf(el));
                    return text && MENU_TEXT_MARKERS.some(marker => marker.test(text));
                })
                .map(findPopupAncestor)
                .filter(Boolean)
        );
        const containers = uniqueElements([...selectorContainers, ...inferredContainers]);
        containers.sort((a, b) => {
            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            return (bRect.width * bRect.height) - (aRect.width * aRect.height);
        });
        return containers;
    };

    const getMenuItems = (container) => {
        if (!container) return [];

        const seen = new Set();
        const items = [];
        const candidates = Array.from(container.querySelectorAll('[role="menuitem"], [role="option"], button, [role="button"], a, div, span')).filter(isVisible);

        for (const el of candidates) {
            const text = textOf(el);
            const lower = text.toLowerCase();
            if (!text || text.length > 140) continue;
            if (lower === 'archived' || lower === 'no matching agent') continue;
            if (lower.startsWith('show ')) continue;
            if (lower.endsWith(' ago') || /^\d+\s*(sec|min|hr|day|wk|mo|yr)/i.test(lower)) continue;
            if (seen.has(lower)) continue;

            const clickable = resolveTrigger(el);
            if (!clickable || !isVisible(clickable)) continue;

            seen.add(lower);
            items.push({ title: text, element: clickable });
        }

        return items;
    };

    const getMenuItemTexts = (containers = findMenuContainers()) => {
        const seen = new Set();
        const texts = [];
        for (const container of containers) {
            for (const item of getMenuItems(container)) {
                const key = item.title.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                texts.push(item.title);
            }
        }
        return texts;
    };

    const findModelSearchInput = (root = document) => Array.from(root.querySelectorAll('input, textarea, [role="textbox"]')).find(el => {
        if (!isVisible(el)) return false;
        const placeholder = normalizeText(el.getAttribute('placeholder') || el.getAttribute('aria-label') || '');
        return /search/i.test(placeholder);
    }) || null;

    const MODEL_MENU_MARKERS = [
        /^auto(?:\b|\s)/i,
        /^max mode(?:\b|\s)/i,
        /^use multiple models?(?:\b|\s)/i,
        /^search models?$/i,
        /^add models?$/i
    ];

    const getHorizontalOverlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));

    const scoreModelMenuContainer = (container) => {
        if (!container || !isVisible(container)) return -Infinity;

        const rect = container.getBoundingClientRect();
        if (rect.width < 150 || rect.width > 420 || rect.height < 40 || rect.height > Math.min(window.innerHeight * 0.9, 560)) {
            return -Infinity;
        }

        const text = normalizeText(textOf(container));
        let score = 0;

        if (findModelSearchInput(container)) score += 5;
        score += MODEL_MENU_MARKERS.reduce((count, marker) => count + (marker.test(text) ? 1 : 0), 0) * 3;

        const modelButton = findModelButton();
        if (modelButton) {
            const buttonRect = modelButton.getBoundingClientRect();
            const overlap = getHorizontalOverlap(rect, buttonRect);
            if (overlap > 0) score += Math.min(4, overlap / Math.max(buttonRect.width, 1));

            const verticalGap = rect.top >= buttonRect.bottom
                ? rect.top - buttonRect.bottom
                : buttonRect.top >= rect.bottom
                    ? buttonRect.top - rect.bottom
                    : 0;
            score += Math.max(0, 3 - verticalGap / 80);
            if (rect.bottom <= buttonRect.top + 80) score += 1;
        }

        if (rect.width >= 180 && rect.width <= 320) score += 1;
        if (rect.height >= 120 && rect.height <= 440) score += 1;
        return score;
    };

    const findModelMenuRoot = () => {
        const searchInput = findModelSearchInput(document);
        if (searchInput) {
            const nearestContainer = searchInput.closest('[role="menu"], [role="dialog"], [role="listbox"], .ui-menu__content, .context-view, [data-radix-popper-content-wrapper]');
            if (nearestContainer && isVisible(nearestContainer)) {
                return nearestContainer;
            }

            const owningContainer = findMenuContainers().find(container => container.contains(searchInput));
            if (owningContainer) {
                return owningContainer;
            }
        }

        const scoredContainers = findMenuContainers()
            .map(container => ({ container, score: scoreModelMenuContainer(container) }))
            .filter(item => Number.isFinite(item.score))
            .sort((a, b) => b.score - a.score);

        if (scoredContainers[0]?.score > 0) {
            return scoredContainers[0].container;
        }

        return findMenuContainers().find(container => !!findModelSearchInput(container)) || null;
    };

    const getSwitchState = (el) => {
        const switchEl =
            el?.querySelector?.('[role="switch"], input[type="checkbox"], [aria-checked], [aria-pressed]') ||
            el?.closest?.('[role="switch"], [aria-checked], [aria-pressed]');

        if (!switchEl) return false;

        const ariaChecked = switchEl.getAttribute?.('aria-checked');
        if (ariaChecked != null) return ariaChecked === 'true';

        const ariaPressed = switchEl.getAttribute?.('aria-pressed');
        if (ariaPressed != null) return ariaPressed === 'true';

        if (typeof switchEl.checked === 'boolean') {
            return !!switchEl.checked;
        }

        const cls = getClassName(switchEl).toLowerCase();
        return cls.includes('checked') || cls.includes('enabled') || cls.includes('active') || cls.includes('on');
    };

    const isSelectableRowActive = (el) => {
        if (!el) return false;
        const candidates = [
            el,
            ...Array.from(el.querySelectorAll('[aria-selected], [aria-current], [aria-checked], [aria-pressed], .checked, .active, .selected, .current'))
        ];

        return candidates.some((candidate) => {
            if (!candidate) return false;

            const ariaSelected = candidate.getAttribute?.('aria-selected');
            if (ariaSelected === 'true') return true;

            const ariaCurrent = candidate.getAttribute?.('aria-current');
            if (ariaCurrent && ariaCurrent !== 'false') return true;

            const ariaChecked = candidate.getAttribute?.('aria-checked');
            if (ariaChecked === 'true') return true;

            const ariaPressed = candidate.getAttribute?.('aria-pressed');
            if (ariaPressed === 'true') return true;

            const cls = getClassName(candidate).toLowerCase();
            return cls.includes('checked') || cls.includes('active') || cls.includes('selected') || cls.includes('current');
        });
    };

    const setInputValue = (input, value) => {
        if (!input) return false;

        input.focus?.();
        try { input.select?.(); } catch (e) { /* ignore */ }

        const inputSetter = typeof HTMLInputElement !== 'undefined'
            ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            : null;
        const textAreaSetter = typeof HTMLTextAreaElement !== 'undefined'
            ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
            : null;

        if (typeof HTMLTextAreaElement !== 'undefined' && input instanceof HTMLTextAreaElement && textAreaSetter) {
            textAreaSetter.call(input, value);
        } else if (typeof HTMLInputElement !== 'undefined' && input instanceof HTMLInputElement && inputSetter) {
            inputSetter.call(input, value);
        } else {
            input.value = value;
        }

        try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* ignore */ }
        try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { /* ignore */ }
        return true;
    };

    const getModelMenuRows = (root = findModelMenuRoot()) => {
        if (!root) return [];

        return Array.from(root.querySelectorAll('button, [role="menuitem"], [role="option"], [role="button"], label, a, div'))
            .filter(isVisible)
            .map(resolveTrigger)
            .filter((el, index, arr) => el && root.contains(el) && arr.indexOf(el) === index)
            .map(el => ({
                element: el,
                text: normalizeText(textOf(el)),
                rect: el.getBoundingClientRect()
            }))
            .filter(item => item.text && item.rect.width > 50 && item.rect.height >= 16 && item.rect.height <= 120)
            .sort((a, b) => {
                const yDiff = a.rect.top - b.rect.top;
                return Math.abs(yDiff) > 1 ? yDiff : a.rect.left - b.rect.left;
            });
    };

    const getSelectedModelMenuOption = (root = findModelMenuRoot()) => {
        const rows = getModelMenuRows(root)
            .filter((row) => isPlausibleModelText(row.text));

        const explicitSelection = rows
            .filter((row) => isSelectableRowActive(row.element))
            .sort((a, b) => (b.text.length - a.text.length) || (a.rect.top - b.rect.top))[0];
        if (explicitSelection) return explicitSelection.text;

        const checkmarkSelection = rows
            .filter((row) => /\bcheck(mark)?\b/i.test(getClassName(row.element)))
            .sort((a, b) => (b.text.length - a.text.length) || (a.rect.top - b.rect.top))[0];
        if (checkmarkSelection) return checkmarkSelection.text;

        return '';
    };

    const findModelToggleRow = (label, root = findModelMenuRoot()) => {
        const matcher = new RegExp('^' + escapeRegExp(label) + '(?:\\\\b|\\\\s)', 'i');
        return getModelMenuRows(root).find(row => matcher.test(row.text))?.element || null;
    };

    const getModelMenuState = () => {
        const root = findModelMenuRoot();
        const current = getModelText() || 'Unknown';
        if (!root) {
            return {
                current,
                searchPlaceholder: '',
                toggles: [],
                options: current && current !== 'Unknown' && !/^auto$/i.test(current) ? [current] : [],
                footerLabel: '',
                targets: []
            };
        }

        const searchInput = findModelSearchInput(root);
        const searchPlaceholder = normalizeText(searchInput?.getAttribute('placeholder') || searchInput?.getAttribute('aria-label') || '');
        const rows = getModelMenuRows(root);
        const targets = [];
        const toggleDefs = [
            { key: 'auto', label: 'Auto', matcher: /^auto(?:\b|\s)/i },
            { key: 'max-mode', label: 'MAX Mode', matcher: /^max mode(?:\b|\s)/i },
            { key: 'multi-model', label: 'Use Multiple Models', matcher: /^use multiple models?(?:\b|\s)/i }
        ];

        const toggles = toggleDefs.map(def => {
            const otherMatchers = toggleDefs.filter(other => other.key !== def.key).map(other => other.matcher);
            const row = rows
                .filter(item => def.matcher.test(item.text))
                .filter(item => !otherMatchers.some(matcher => matcher.test(item.text)))
                .sort((a, b) => (a.rect.height - b.rect.height) || (a.text.length - b.text.length))[0] ||
                rows
                    .filter(item => def.matcher.test(item.text))
                    .sort((a, b) => (a.rect.height - b.rect.height) || (a.text.length - b.text.length))[0];
            if (!row) return null;

            const description = normalizeText(row.text.replace(new RegExp('^(?:' + escapeRegExp(def.label) + '\\\\s*)+', 'i'), ''));
            targets.push({
                kind: 'toggle',
                key: def.key,
                label: def.label,
                title: def.label,
                x: Math.round(row.rect.left + (row.rect.width / 2)),
                y: Math.round(row.rect.top + (row.rect.height / 2))
            });
            return {
                key: def.key,
                label: def.label,
                description,
                enabled: getSwitchState(row.element) || (def.key === 'auto' && /^auto$/i.test(current))
            };
        }).filter(Boolean);

        const blockedMatchers = [
            /^search models?$/i,
            /^add models?$/i,
            ...toggleDefs.map(def => def.matcher)
        ];
        const seen = new Set();
        const options = [];

        for (const row of rows) {
            const title = row.text;
            const key = title.toLowerCase();
            if (!title || title.length > 80) continue;
            if (blockedMatchers.some(matcher => matcher.test(title))) continue;
            if (!isPlausibleModelText(title)) continue;
            if (seen.has(key)) continue;
            seen.add(key);
            options.push(title);
            targets.push({
                kind: 'option',
                title,
                x: Math.round(row.rect.left + (row.rect.width / 2)),
                y: Math.round(row.rect.top + (row.rect.height / 2))
            });
        }

        if (!options.length && current && current !== 'Unknown' && !/^auto$/i.test(current)) {
            options.push(current);
        }

        return {
            current,
            searchPlaceholder,
            toggles,
            options,
            footerLabel: rows.some(row => /^add models?$/i.test(row.text)) ? 'Add Models' : '',
            targets
        };
    };

    const getHistoryItems = () => {
        const menu = findHistoryMenu();
        if (!menu) return [];

        const seen = new Set();
        const items = [];
        const elements = Array.from(menu.querySelectorAll('button, [role="menuitem"], [role="button"], a, div, span')).filter(isVisible);
        let currentSection = 'Recent';

        for (const el of elements) {
            const text = textOf(el);
            const lower = text.toLowerCase();
            if (!text || text.length < 2 || text.length > 140) continue;
            if (lower === 'today' || lower === 'yesterday' || lower === 'recent' || lower === 'archived') {
                currentSection = text;
                continue;
            }
            if (lower === 'no matching agent') continue;
            if (lower.startsWith('show ')) continue;
            if (lower.endsWith(' ago') || /^\d+\s*(sec|min|hr|day|wk|mo|yr)/i.test(lower)) continue;
            if (seen.has(text)) continue;

            const clickable = el.closest('button, [role="menuitem"], [role="button"], a, div');
            if (!clickable || !isVisible(clickable)) continue;

            seen.add(text);
            items.push({ title: text, section: currentSection });
        }

        return items;
    };

    const findSendButton = () => {
        const icon = queryAllVisible('.codicon-arrow-up-two, .codicon-arrow-right, svg.lucide-arrow-right', document)[0];
        if (!icon) return null;
        const button = icon.closest('.anysphere-icon-button, .send-with-mode, button, [role="button"], div');
        return isVisible(button) ? button : null;
    };

    const findStopButton = () => {
        const panel = findPanel() || document;
        const controls = queryAllVisible('[data-click-ready="true"], button, [role="button"], a, div', panel)
            .map(resolveTrigger)
            .filter((el, index, arr) => el && arr.indexOf(el) === index);

        const textButton = controls
            .map(el => ({
                el,
                text: textOf(el),
                aria: (el.getAttribute('aria-label') || '').toLowerCase(),
                rect: el.getBoundingClientRect()
            }))
            .filter(item => /^stop$/i.test(item.text) || item.aria.includes('stop') || item.aria.includes('cancel'))
            .sort((a, b) => b.rect.y - a.rect.y)[0];
        if (textButton) return textButton.el;

        const legacy = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (legacy && isVisible(legacy)) return legacy;

        const icons = queryAllVisible('.codicon-debug-stop, .codicon-sync, .codicon-loading, .codicon-debug-pause, .codicon-primitive-square, .codicon-circle-slash, .lucide-square, .lucide-loader', document);
        for (const icon of icons) {
            const button = icon.closest('.anysphere-icon-button, .send-with-mode, button, [role="button"], div');
            if (isVisible(button)) return button;
        }
        return null;
    };

    const getComposerStatus = () => {
        const panel = findPanel();
        const composer = panel ? panel.querySelector('.composer-bar[data-composer-status]') : null;
        return (composer?.getAttribute('data-composer-status') || '').trim().toLowerCase();
    };

    const isBusy = () => {
        const status = getComposerStatus();
        return ['generating', 'running', 'streaming', 'working', 'loading'].includes(status);
    };

    const getDropdownText = (selector) => {
        const panel = findPanel() || document;
        const el = uniqueElements(queryAllVisible(selector, panel).map(resolveTrigger))[0] || null;
        if (!el) return '';
        const leafText = getLeafTexts(el)
            .map(normalizeText)
            .filter(text => text && text.length <= 64)
            .sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
        return leafText || textOf(el);
    };

    const getModeText = () => {
        const button = findModeButton();
        const dataMode = pickModeName(button?.getAttribute?.('data-mode') || '');
        if (isPlausibleModeText(dataMode)) return dataMode;

        const leafText = getBestLeafTextMatch(button, MODE_TEXT_MATCHER, { maxLength: 24 });
        if (isPlausibleModeText(leafText)) return pickModeName(leafText);

        const hintedMode = getModeHintText();
        if (isPlausibleModeText(hintedMode)) return pickModeName(hintedMode);

        const fallback = pickModeName(getDropdownText('.composer-unified-dropdown'));
        return isPlausibleModeText(fallback) ? fallback : '';
    };

    const getModelText = () => {
        const button = findModelButton();
        if (button) {
            const preferred = getBestLeafTextMatch(button, MODEL_TEXT_HINT_MATCHER, { maxLength: 48 });
            if (isPlausibleModelText(preferred)) return preferred;

            const fallback = getDropdownText('.composer-unified-dropdown-model');
            if (isPlausibleModelText(fallback)) return fallback;
        }

        const selectedFromMenu = getSelectedModelMenuOption();
        return isPlausibleModelText(selectedFromMenu) ? selectedFromMenu : '';
    };

    const findDropdownMenuItem = (targetText, containers = findMenuContainers()) => {
        const normalized = targetText.trim().toLowerCase();
        const items = containers.flatMap(getMenuItems);
        return items.find(item => item.title.toLowerCase() === normalized)?.element ||
            items.find(item => item.title.toLowerCase().includes(normalized))?.element ||
            items.find(item => normalized.includes(item.title.toLowerCase()))?.element ||
            null;
    };

    const findModeButton = () => {
        const panel = findPanel() || document;
        const composer = findComposerBar() || panel;
        return uniqueElements([
            ...queryAllVisible('.composer-unified-dropdown, [data-mode]', composer),
            ...queryAllVisible('button, [role="button"], a, div', composer),
            ...queryAllVisible('.composer-unified-dropdown, [data-mode]', document)
        ].map(resolveTrigger).filter(isVisible))
            .map(el => ({
                el,
                score: scoreComposerChipCandidate(el, {
                    matcher: MODE_TEXT_MATCHER,
                    excludeMatcher: MODEL_TEXT_HINT_MATCHER,
                    maxTextLength: 24,
                    minWidth: 44,
                    maxWidth: 180,
                    maxHeight: 40,
                    maxContainerTextLength: 56,
                    horizontalWeight: 0.08
                })
            }))
            .filter(item => Number.isFinite(item.score))
            .sort((a, b) => b.score - a.score)[0]?.el || null;
    };

    const findModelButton = () => {
        const panel = findPanel() || document;
        const composer = findComposerBar() || panel;
        const directMatch = uniqueElements([
            ...queryAllVisible('.composer-unified-dropdown-model, [id*="unifiedmodeldropdown"]', composer),
            ...queryAllVisible('button, [role="button"], a, div', composer),
            ...queryAllVisible('.composer-unified-dropdown-model, [id*="unifiedmodeldropdown"]', document)
        ].map(resolveTrigger).filter(isVisible))
            .map(el => ({
                el,
                score: scoreComposerChipCandidate(el, {
                    matcher: MODEL_TEXT_HINT_MATCHER,
                    excludeMatcher: MODE_TEXT_MATCHER,
                    maxTextLength: 48,
                    minWidth: 56,
                    maxWidth: 240,
                    maxHeight: 40,
                    maxContainerTextLength: 72,
                    horizontalWeight: 0.04
                })
            }))
            .filter(item => Number.isFinite(item.score))
            .sort((a, b) => b.score - a.score)[0]?.el || null;
        if (directMatch) return directMatch;

        const modeButton = findModeButton();
        if (!modeButton) return null;

        const modeRect = modeButton.getBoundingClientRect();
        return uniqueElements([
            ...queryAllVisible('button, [role="button"], a, div', composer),
            ...queryAllVisible('button, [role="button"], a, div', document)
        ].map(resolveTrigger).filter(isVisible))
            .filter(el => el !== modeButton)
            .map((el) => {
                const rect = el.getBoundingClientRect();
                const centerY = rect.top + (rect.height / 2);
                const modeCenterY = modeRect.top + (modeRect.height / 2);
                const horizontalGap = rect.left - modeRect.right;
                const leafText = getBestLeafTextMatch(el, MODEL_TEXT_HINT_MATCHER, { maxLength: 48 });
                const ariaText = normalizeText(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '');
                const combinedText = normalizeText([leafText, ariaText, textOf(el)].filter(Boolean).join(' '));
                const cls = getClassName(el).toLowerCase();

                if (rect.width < 40 || rect.width > 260 || rect.height < 18 || rect.height > 44) return { el, score: -Infinity };
                if (horizontalGap < -8 || horizontalGap > 220) return { el, score: -Infinity };
                if (Math.abs(centerY - modeCenterY) > 24) return { el, score: -Infinity };
                if (/^(send|stop|new chat|attach|more actions)/i.test(combinedText)) return { el, score: -Infinity };
                if (MODE_TEXT_MATCHER.test(combinedText) && !MODEL_TEXT_HINT_MATCHER.test(combinedText)) return { el, score: -Infinity };

                let score = 40 - Math.abs(centerY - modeCenterY) - Math.max(0, horizontalGap);
                if (isPlausibleModelText(leafText)) score += 35;
                if (isPlausibleModelText(ariaText)) score += 28;
                if (MODEL_TEXT_HINT_MATCHER.test(combinedText)) score += 14;
                if (cls.includes('dropdown') || cls.includes('chip') || cls.includes('composer')) score += 6;
                if (el.querySelector?.('svg, .codicon-chevron-down, .codicon-chevron-up, .codicon-chevron-small-down')) score += 4;
                return { el, score };
            })
            .filter(item => Number.isFinite(item.score) && item.score > 0)
            .sort((a, b) => b.score - a.score)[0]?.el || null;
    };

    const collectMessageNodes = () => {
        const panel = findPanel();
        if (!panel) return [];

        const candidates = Array.from(panel.querySelectorAll('.composer-message-group, .relative.composer-rendered-message, .composer-tool-former-message, .markdown-root, [class*="message"]')).filter(isVisible);
        const nodes = [];

        for (const el of candidates) {
            if (el.closest('.composer-input-blur-wrapper, .ai-input-full-input-box, .simple-find-part-wrapper, .compact-agent-history-react-menu-content, .ui-menu__content')) continue;
            if (nodes.some(existing => existing.contains(el))) continue;
            nodes.push(el);
        }

        return nodes;
    };

    return {
        getClassName,
        isVisible,
        isTabActive,
        textOf,
        queryAllVisible,
        findPanel,
        findEditor,
        findPanelScrollRoot,
        findChatTabsContainer,
        getChatTabElements,
        click,
        focusEditor,
        setEditorText,
        getChatTabs,
        getActiveChatTitle,
        findNewChatButton,
        findHistoryButton,
        findAttachButton,
        findHistoryMenu,
        findMenuContainers,
        getMenuItems,
        getMenuItemTexts,
        findModelSearchInput,
        findModelMenuRoot,
        getSwitchState,
        setInputValue,
        getModelMenuRows,
        findModelToggleRow,
        getModelMenuState,
        getHistoryItems,
        findSendButton,
        findStopButton,
        getComposerStatus,
        isBusy,
        getModeText,
        getModelText,
        findDropdownMenuItem,
        findModeButton,
        findModelButton,
        collectMessageNodes
    };
})();
`;

export { CURSOR_UI_HELPERS };
