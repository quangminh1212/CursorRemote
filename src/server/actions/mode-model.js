import { evaluateCursor } from '../cdp-eval.js';
import { createTraceId, logTraceStep, summarizeLogText, summarizeLogValue, summarizeActionResultForLog, summarizeDropdownStateForLog } from '../logger.js';
import { sleep } from '../system-utils.js';

function getModeRequestCandidates(mode) {
    const normalized = String(mode || '').trim();
    if (!normalized) return [];

    const lower = normalized.toLowerCase();
    if (lower === 'agent' || lower === 'fast') return ['Agent', 'Fast'];
    if (lower === 'plan' || lower === 'planning') return ['Plan', 'Planning'];
    if (lower === 'debug' || lower === 'manual') return ['Debug', 'Manual'];
    if (lower === 'ask') return ['Ask'];
    return [normalized];
}

// Set functionality mode (Fast vs Planning)
async function setMode(cdp, mode, traceId = null) {
    const targetMode = String(mode || '').trim();
    if (!targetMode) return { error: 'Invalid mode' };
    const requestedCandidates = getModeRequestCandidates(targetMode);
    logTraceStep(traceId, 'setMode.request', {
        targetMode,
        requestedCandidates
    });
    const verifyModeState = async (fallbackAvailable = []) => {
        const verifiedState = await getDropdownOptions(cdp, 'mode', traceId);
        const verifiedCurrent = String(verifiedState?.current || '').trim();
        if (verifiedCurrent && requestedCandidates.some(candidate => verifiedCurrent.toLowerCase() === candidate.toLowerCase())) {
            logTraceStep(traceId, 'setMode.verified', {
                verifiedCurrent,
                availableCount: Array.isArray(verifiedState?.options) ? verifiedState.options.length : fallbackAvailable.length
            });
            return {
                success: true,
                currentMode: verifiedCurrent,
                available: verifiedState?.options || fallbackAvailable
            };
        }

        logTraceStep(traceId, 'setMode.verifyMismatch', {
            verifiedCurrent,
            fallbackAvailableCount: Array.isArray(fallbackAvailable) ? fallbackAvailable.length : 0
        });
        return {
            error: 'mode_apply_mismatch',
            currentMode: verifiedCurrent || 'Unknown',
            available: verifiedState?.options || fallbackAvailable
        };
    };

    const menuState = await getDropdownOptions(cdp, 'mode', traceId);
    logTraceStep(traceId, 'setMode.menuState', summarizeDropdownStateForLog(menuState));
    const currentMode = String(menuState?.current || '').trim();
    if (currentMode && requestedCandidates.some((candidate) => currentMode.toLowerCase() === candidate.toLowerCase())) {
        logTraceStep(traceId, 'setMode.alreadySet', { currentMode });
        return { success: true, alreadySet: true, currentMode };
    }

    if (!menuState?.buttonPoint) {
        logTraceStep(traceId, 'setMode.buttonMissing', summarizeDropdownStateForLog(menuState));
        return { error: 'mode_button_not_found' };
    }

    const directTarget = Array.isArray(menuState.targets)
        ? menuState.targets.find((target) => requestedCandidates.some((candidate) => String(target?.title || '').toLowerCase() === candidate.toLowerCase()))
        : null;
    if (!directTarget) {
        logTraceStep(traceId, 'setMode.targetMissing', {
            available: menuState.options || [],
            requestedCandidates
        });
        return {
            error: 'mode_option_not_found',
            currentMode: currentMode || 'Unknown',
            available: menuState.options || []
        };
    }

    logTraceStep(traceId, 'setMode.directClick', {
        target: directTarget.title,
        x: directTarget.x,
        y: directTarget.y
    });
    await clickAtPoint(cdp, menuState.buttonPoint.x, menuState.buttonPoint.y);
    await new Promise((resolve) => setTimeout(resolve, 260));
    await clickAtPoint(cdp, directTarget.x, directTarget.y);
    await new Promise((resolve) => setTimeout(resolve, 260));

    const verified = await verifyModeState(menuState.options || []);
    if (verified?.success) return verified;
    logTraceStep(traceId, 'setMode.fallbackNeeded', summarizeActionResultForLog(verified));

    const fallback = await evaluateCursor(cdp, `
        const requestedMode = ${JSON.stringify(targetMode)};
        const requestedCandidates = ${JSON.stringify(requestedCandidates)};
        let menus = __cr.findMenuContainers();
        const matchingMenus = menus.filter(menu => requestedCandidates.some(candidate => __cr.textOf(menu).toLowerCase().includes(candidate.toLowerCase())));
        if (matchingMenus.length) menus = matchingMenus;

        let option = null;
        for (const candidate of requestedCandidates) {
            option = __cr.findDropdownMenuItem(candidate, menus);
            if (option) break;
        }

        const available = __cr.getMenuItemTexts(menus).slice(0, 30);
        const closeMenu = () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
        };

        if (!option) {
            closeMenu();
            return {
                error: 'mode_option_not_found',
                currentMode: __cr.getModeText() || requestedMode,
                available
            };
        }

        __cr.click(option);
        await new Promise(r => setTimeout(r, 250));
        const appliedMode = __cr.getModeText() || requestedMode;
        closeMenu();

        if (!requestedCandidates.some(candidate => appliedMode.toLowerCase() === candidate.toLowerCase())) {
            return {
                error: 'mode_apply_mismatch',
                currentMode: appliedMode,
                available
            };
        }

        return {
            success: true,
            currentMode: appliedMode,
            available
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });

    if (fallback?.success) {
        logTraceStep(traceId, 'setMode.fallbackDomSuccess', summarizeActionResultForLog(fallback));
        const fallbackVerified = await verifyModeState(fallback.available || []);
        if (fallbackVerified?.success) return fallbackVerified;
    }

    logTraceStep(traceId, 'setMode.complete', summarizeActionResultForLog(fallback || verified));
    return fallback || verified;
}

// Stop Generation
async function stopGeneration(cdp) {
    return await evaluateCursor(cdp, `
        if (!__cr.isBusy()) return { error: 'No active generation found to stop', status: __cr.getComposerStatus() || 'idle' };

        const stopButton = __cr.findStopButton();
        if (!stopButton) return { error: 'No active generation found to stop', status: __cr.getComposerStatus() || 'unknown' };
        __cr.click(stopButton);
        await new Promise(r => setTimeout(r, 300));
        return { success: true, status: __cr.getComposerStatus() || 'unknown' };
    `, {
        accept: (value) => value && typeof value === 'object'
    });
}

// Set AI Model
async function setModel(cdp, modelName, traceId = null) {
    const targetModel = String(modelName || '').trim();
    if (!targetModel) return { error: 'Invalid model' };
    logTraceStep(traceId, 'setModel.request', {
        targetModel
    });

    const result = await evaluateCursor(cdp, `
        const requestedModel = ${JSON.stringify(targetModel)};
        let rootMenu = __cr.findModelMenuRoot();
        const modelButton = __cr.findModelButton();
        if (!modelButton && !rootMenu) return { error: 'model_button_not_found' };
        const escapeRegExp = (value) => String(value || '').replace(/[-/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
        const optionMatcher = new RegExp('^' + escapeRegExp(requestedModel) + '(?:\\\\b|\\\\s|$)', 'i');
        const waitForMenu = async () => {
            await new Promise(r => setTimeout(r, 250));
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        };
        const findOptionAnywhere = () => {
            const selector = 'button, [role="menuitem"], [role="option"], [role="button"], label, a, div';
            const seen = new Set();
            return Array.from(document.querySelectorAll(selector))
                .filter(el => __cr.isVisible(el))
                .map(el => el.closest(selector) || el)
                .filter(el => {
                    if (!el || seen.has(el)) return false;
                    seen.add(el);
                    return true;
                })
                .map(el => ({
                    element: el,
                    text: String(__cr.textOf(el) || '').replace(/\\s+/g, ' ').trim(),
                    rect: el.getBoundingClientRect()
                }))
                .filter(item =>
                    item.text &&
                    optionMatcher.test(item.text) &&
                    item.rect.width > 50 &&
                    item.rect.height >= 16 &&
                    item.rect.height <= 120
                )
                .sort((a, b) => {
                    const yDiff = a.rect.top - b.rect.top;
                    return Math.abs(yDiff) > 1 ? yDiff : a.rect.left - b.rect.left;
                })[0]?.element || null;
        };

        const currentModel = __cr.getModelText();
        if (currentModel && currentModel.toLowerCase() === requestedModel.toLowerCase()) {
            return { success: true, alreadySet: true, currentModel };
        }

        let menus = rootMenu ? [rootMenu] : __cr.findMenuContainers();
        let option = __cr.findDropdownMenuItem(requestedModel, menus) || findOptionAnywhere();
        let searchSubmitUsed = false;

        if (!option && modelButton) {
            __cr.click(modelButton);
            await waitForMenu();
            rootMenu = __cr.findModelMenuRoot();
            menus = rootMenu ? [rootMenu] : __cr.findMenuContainers();
            option = __cr.findDropdownMenuItem(requestedModel, menus) || findOptionAnywhere();
        }

        if (!option) {
            const searchInput = __cr.findModelSearchInput(rootMenu || document);
            if (searchInput) {
                __cr.setInputValue(searchInput, requestedModel);
                await new Promise(r => setTimeout(r, 180));
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                rootMenu = __cr.findModelMenuRoot();
                menus = rootMenu ? [rootMenu] : __cr.findMenuContainers();
                option = __cr.findDropdownMenuItem(requestedModel, menus) || findOptionAnywhere();
            }
        }

        if (!option && /^auto$/i.test(requestedModel)) {
            option = __cr.findModelToggleRow('Auto') || findOptionAnywhere();
        }

        if (!option && modelButton) {
            // Retry once in case the first click closed a menu that was already open.
            __cr.click(modelButton);
            await waitForMenu();
            rootMenu = __cr.findModelMenuRoot();
            menus = rootMenu ? [rootMenu] : __cr.findMenuContainers();
            option = __cr.findDropdownMenuItem(requestedModel, menus) || __cr.findModelToggleRow('Auto') || findOptionAnywhere();
            if (!option) {
                const searchInput = __cr.findModelSearchInput(rootMenu || document);
                if (searchInput) {
                    __cr.setInputValue(searchInput, requestedModel);
                    await new Promise(r => setTimeout(r, 180));
                    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                    rootMenu = __cr.findModelMenuRoot();
                    menus = rootMenu ? [rootMenu] : __cr.findMenuContainers();
                    option = __cr.findDropdownMenuItem(requestedModel, menus) || __cr.findModelToggleRow('Auto') || findOptionAnywhere();
                }
            }
        }

        const menuState = __cr.getModelMenuState();
        const available = Array.isArray(menuState.options) && menuState.options.length
            ? menuState.options.slice(0, 80)
            : __cr.getMenuItemTexts(menus).slice(0, 40);
        const toggleLabels = Array.isArray(menuState.toggles) ? menuState.toggles.map(toggle => toggle.label) : [];
        const availableWithToggles = [...new Set([...toggleLabels, ...available])];

        if (!option) {
            const searchInput = __cr.findModelSearchInput(rootMenu || document);
            if (searchInput) {
                searchInput.focus();
                __cr.setInputValue(searchInput, requestedModel);
                await new Promise(r => setTimeout(r, 180));
                const dispatchKey = (key) => {
                    const payload = { key, code: key, bubbles: true };
                    try { searchInput.dispatchEvent(new KeyboardEvent('keydown', payload)); } catch (e) { /* ignore */ }
                    try { searchInput.dispatchEvent(new KeyboardEvent('keyup', payload)); } catch (e) { /* ignore */ }
                    try { document.dispatchEvent(new KeyboardEvent('keydown', payload)); } catch (e) { /* ignore */ }
                    try { document.dispatchEvent(new KeyboardEvent('keyup', payload)); } catch (e) { /* ignore */ }
                };
                dispatchKey('ArrowDown');
                await new Promise(r => setTimeout(r, 80));
                dispatchKey('Enter');
                await new Promise(r => setTimeout(r, 260));
                searchSubmitUsed = true;
            }
        }

        if (!option && searchSubmitUsed) {
            const currentAfterSearchSubmit = __cr.getModelText();
            if (currentAfterSearchSubmit && currentAfterSearchSubmit.toLowerCase() === requestedModel.toLowerCase()) {
                return {
                    success: true,
                    currentModel: currentAfterSearchSubmit,
                    available: availableWithToggles,
                    via: 'search-submit'
                };
            }
        }

        if (!option) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
            return { error: 'model_option_not_found', currentModel, available: availableWithToggles };
        }

        __cr.click(option);
        await new Promise(r => setTimeout(r, 250));
        const appliedModel = __cr.getModelText() || requestedModel;
        if (appliedModel.toLowerCase() !== requestedModel.toLowerCase()) {
            return {
                error: 'model_apply_mismatch',
                currentModel: appliedModel,
                available: availableWithToggles
            };
        }

        return {
            success: true,
            currentModel: appliedModel,
            available: availableWithToggles
        };
    `, {
        accept: (value) => value && typeof value === 'object' && !value.error
    });

    if (result?.success) {
        logTraceStep(traceId, 'setModel.domSuccess', summarizeActionResultForLog(result));
        return result;
    }

    logTraceStep(traceId, 'setModel.domFallbackNeeded', summarizeActionResultForLog(result));
    const menuState = await getDropdownOptions(cdp, 'model', traceId);
    logTraceStep(traceId, 'setModel.menuState', summarizeDropdownStateForLog(menuState));
    const currentModel = String(menuState?.current || result?.currentModel || '').trim();
    if (currentModel && currentModel.toLowerCase() === targetModel.toLowerCase()) {
        logTraceStep(traceId, 'setModel.alreadySet', { currentModel });
        return { success: true, alreadySet: true, currentModel };
    }

    const targets = Array.isArray(menuState?.targets) ? menuState.targets : [];
    const targetEntry = /^auto$/i.test(targetModel)
        ? targets.find((target) => target.kind === 'toggle' && target.key === 'auto')
        : targets.find((target) => target.kind === 'option' && String(target.title || '').trim().toLowerCase() === targetModel.toLowerCase());

    if (menuState?.buttonPoint && !targetEntry) {
        logTraceStep(traceId, 'setModel.searchFallback', {
            targetModel,
            optionCount: Array.isArray(menuState?.options) ? menuState.options.length : 0
        });
        await clickAtPoint(cdp, menuState.buttonPoint.x, menuState.buttonPoint.y);
        await new Promise((resolve) => setTimeout(resolve, 260));

        const searchFallback = await evaluateCursor(cdp, `
            const requestedModel = ${JSON.stringify(targetModel)};
            const waitForUi = async (delay = 180) => {
                await new Promise(r => setTimeout(r, delay));
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            };
            const dispatchKey = (target, key) => {
                const payload = { key, code: key, bubbles: true };
                try { target.dispatchEvent(new KeyboardEvent('keydown', payload)); } catch (e) { /* ignore */ }
                try { target.dispatchEvent(new KeyboardEvent('keyup', payload)); } catch (e) { /* ignore */ }
                try { document.dispatchEvent(new KeyboardEvent('keydown', payload)); } catch (e) { /* ignore */ }
                try { document.dispatchEvent(new KeyboardEvent('keyup', payload)); } catch (e) { /* ignore */ }
            };
            const closeMenu = () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
                document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
            };

            const searchInput = __cr.findModelSearchInput(__cr.findModelMenuRoot() || document) || __cr.findModelSearchInput(document);
            if (!searchInput) {
                closeMenu();
                return { error: 'model_search_input_not_found', currentModel: __cr.getModelText() || 'Unknown' };
            }

            __cr.setInputValue(searchInput, requestedModel);
            await waitForUi(180);

            let option = __cr.findDropdownMenuItem(requestedModel, __cr.findMenuContainers());
            if (option) {
                __cr.click(option);
                await waitForUi(260);
            } else {
                dispatchKey(searchInput, 'ArrowDown');
                await new Promise(r => setTimeout(r, 80));
                dispatchKey(searchInput, 'Enter');
                await waitForUi(260);
            }

            const currentModel = __cr.getModelText() || 'Unknown';
            closeMenu();
            if (currentModel.toLowerCase() !== requestedModel.toLowerCase()) {
                return { error: 'model_search_submit_failed', currentModel };
            }

            return {
                success: true,
                currentModel,
                via: 'search-fallback'
            };
        `, {
            accept: (value) => value && typeof value === 'object'
        });

        if (searchFallback?.success) {
            logTraceStep(traceId, 'setModel.searchFallbackSuccess', summarizeActionResultForLog(searchFallback));
            return {
                success: true,
                currentModel: searchFallback.currentModel || targetModel,
                available: menuState.options || []
            };
        }
    }

    if (!menuState?.buttonPoint || !targetEntry) {
        logTraceStep(traceId, 'setModel.targetMissing', {
            targetModel,
            targetFound: !!targetEntry,
            buttonPoint: !!menuState?.buttonPoint
        });
        return result;
    }

    logTraceStep(traceId, 'setModel.directClick', {
        target: targetEntry.title || targetModel,
        x: targetEntry.x,
        y: targetEntry.y
    });
    await clickAtPoint(cdp, menuState.buttonPoint.x, menuState.buttonPoint.y);
    await new Promise((resolve) => setTimeout(resolve, 260));
    await clickAtPoint(cdp, targetEntry.x, targetEntry.y);
    await new Promise((resolve) => setTimeout(resolve, 320));

    const refreshedMenuState = await getDropdownOptions(cdp, 'model', traceId);
    const finalResult = {
        success: true,
        currentModel: refreshedMenuState.current || targetModel,
        available: refreshedMenuState.options || []
    };
    logTraceStep(traceId, 'setModel.complete', summarizeActionResultForLog(finalResult));
    return finalResult;
}

async function setModelToggle(cdp, toggleKey, enabled, traceId = null) {
    const requestedToggle = String(toggleKey || '').trim().toLowerCase();
    if (!requestedToggle) return { error: 'Invalid toggle' };

    const toggleLabel = ({
        auto: 'Auto',
        'max-mode': 'MAX Mode',
        'multi-model': 'Use Multiple Models'
    })[requestedToggle] || toggleKey;
    logTraceStep(traceId, 'setModelToggle.request', {
        requestedToggle,
        toggleLabel,
        enabled: enabled === undefined ? null : !!enabled
    });

    const directMenuState = await getDropdownOptions(cdp, 'model', traceId);
    logTraceStep(traceId, 'setModelToggle.directMenuState', summarizeDropdownStateForLog(directMenuState));
    const directCurrentModel = String(directMenuState?.current || '').trim();
    const directCurrentToggle = Array.isArray(directMenuState?.toggles)
        ? directMenuState.toggles.find((toggle) =>
            toggle?.key === requestedToggle ||
            String(toggle?.label || '').trim().toLowerCase() === toggleLabel.toLowerCase()
        )
        : null;

    if (
        requestedToggle === 'auto'
        && enabled !== undefined
        && (
            (!!enabled && /^auto$/i.test(directCurrentModel))
            || (!enabled && directCurrentModel && !/^auto$/i.test(directCurrentModel))
        )
    ) {
        logTraceStep(traceId, 'setModelToggle.alreadySatisfiedByModel', {
            directCurrentModel,
            enabled: !!enabled
        });
        return {
            success: true,
            toggles: directMenuState.toggles || [],
            currentModel: directCurrentModel || 'Unknown',
            options: directMenuState.options || [],
            searchPlaceholder: directMenuState.searchPlaceholder || '',
            footerLabel: directMenuState.footerLabel || '',
            alreadySet: true
        };
    }

    if (directCurrentToggle && enabled !== undefined && directCurrentToggle.enabled === !!enabled) {
        logTraceStep(traceId, 'setModelToggle.alreadySet', {
            directCurrentModel,
            toggleKey: directCurrentToggle.key,
            toggleEnabled: directCurrentToggle.enabled
        });
        return {
            success: true,
            toggles: directMenuState.toggles || [],
            currentModel: directCurrentModel || 'Unknown',
            options: directMenuState.options || [],
            searchPlaceholder: directMenuState.searchPlaceholder || '',
            footerLabel: directMenuState.footerLabel || '',
            alreadySet: true
        };
    }

    const directTargetEntry = Array.isArray(directMenuState?.targets)
        ? directMenuState.targets.find((target) => target.kind === 'toggle' && target.key === requestedToggle)
        : null;

    if (directMenuState?.buttonPoint && directTargetEntry) {
        logTraceStep(traceId, 'setModelToggle.directClick', {
            target: directTargetEntry.title || directTargetEntry.key || requestedToggle,
            x: directTargetEntry.x,
            y: directTargetEntry.y
        });
        await clickAtPoint(cdp, directMenuState.buttonPoint.x, directMenuState.buttonPoint.y);
        await new Promise((resolve) => setTimeout(resolve, 240));
        await clickAtPoint(cdp, directTargetEntry.x, directTargetEntry.y);
        await new Promise((resolve) => setTimeout(resolve, 320));

        const verifiedDirectMenuState = await getDropdownOptions(cdp, 'model', traceId);
        const verifiedDirectCurrentModel = String(verifiedDirectMenuState?.current || '').trim();
        const verifiedDirectToggle = Array.isArray(verifiedDirectMenuState?.toggles)
            ? verifiedDirectMenuState.toggles.find((toggle) =>
                toggle?.key === requestedToggle ||
                String(toggle?.label || '').trim().toLowerCase() === toggleLabel.toLowerCase()
            )
            : null;

        if (
            requestedToggle === 'auto'
            && enabled !== undefined
            && (
                (!!enabled && /^auto$/i.test(verifiedDirectCurrentModel))
                || (!enabled && verifiedDirectCurrentModel && !/^auto$/i.test(verifiedDirectCurrentModel))
            )
        ) {
            logTraceStep(traceId, 'setModelToggle.directVerifiedByModel', {
                verifiedDirectCurrentModel,
                enabled: !!enabled
            });
            return {
                success: true,
                toggles: verifiedDirectMenuState.toggles || [],
                currentModel: verifiedDirectCurrentModel || 'Unknown',
                options: verifiedDirectMenuState.options || [],
                searchPlaceholder: verifiedDirectMenuState.searchPlaceholder || '',
                footerLabel: verifiedDirectMenuState.footerLabel || ''
            };
        }

        if (verifiedDirectToggle && (enabled === undefined || verifiedDirectToggle.enabled === !!enabled)) {
            logTraceStep(traceId, 'setModelToggle.directVerifiedByToggle', {
                verifiedDirectCurrentModel,
                toggleKey: verifiedDirectToggle.key,
                toggleEnabled: verifiedDirectToggle.enabled
            });
            return {
                success: true,
                toggles: verifiedDirectMenuState.toggles || [],
                currentModel: verifiedDirectCurrentModel || 'Unknown',
                options: verifiedDirectMenuState.options || [],
                searchPlaceholder: verifiedDirectMenuState.searchPlaceholder || '',
                footerLabel: verifiedDirectMenuState.footerLabel || ''
            };
        }
    }

    logTraceStep(traceId, 'setModelToggle.domFallbackNeeded', {
        requestedToggle,
        enabled: enabled === undefined ? null : !!enabled
    });
    const result = await evaluateCursor(cdp, `
        const requestedToggle = ${JSON.stringify(toggleLabel)};
        const desiredEnabled = ${enabled === undefined ? 'null' : JSON.stringify(!!enabled)};
        let rootMenu = __cr.findModelMenuRoot();
        const modelButton = __cr.findModelButton();
        if (!modelButton && !rootMenu) return { error: 'model_button_not_found' };
        const escapeRegExp = (value) => String(value || '').replace(/[-/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
        const toggleMatcher = new RegExp('^' + escapeRegExp(requestedToggle) + '(?:\\\\b|\\\\s)', 'i');

        const waitForMenu = async () => {
            await new Promise(r => setTimeout(r, 250));
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        };
        const findToggleRowAnywhere = () => {
            const selector = 'button, [role="menuitem"], [role="option"], [role="button"], label, a, div';
            const seen = new Set();
            return Array.from(document.querySelectorAll(selector))
                .filter(el => __cr.isVisible(el))
                .map(el => el.closest(selector) || el)
                .filter(el => {
                    if (!el || seen.has(el)) return false;
                    seen.add(el);
                    return true;
                })
                .map(el => ({
                    element: el,
                    text: String(__cr.textOf(el) || '').replace(/\\s+/g, ' ').trim(),
                    rect: el.getBoundingClientRect()
                }))
                .filter(item =>
                    item.text &&
                    toggleMatcher.test(item.text) &&
                    item.rect.width > 50 &&
                    item.rect.height >= 16 &&
                    item.rect.height <= 120 &&
                    !!(item.element.querySelector('[role="switch"], input[type="checkbox"], [aria-checked], [aria-pressed]') ||
                        item.element.closest('[role="switch"], [aria-checked], [aria-pressed]'))
                )
                .sort((a, b) => {
                    const yDiff = a.rect.top - b.rect.top;
                    return Math.abs(yDiff) > 1 ? yDiff : a.rect.left - b.rect.left;
                })[0]?.element || null;
        };

        let toggleRow = __cr.findModelToggleRow(requestedToggle, rootMenu) || findToggleRowAnywhere();
        if (!toggleRow && modelButton) {
            __cr.click(modelButton);
            await waitForMenu();
            rootMenu = __cr.findModelMenuRoot();
            toggleRow = __cr.findModelToggleRow(requestedToggle, rootMenu) || findToggleRowAnywhere();
        }

        if (!toggleRow && modelButton) {
            // If the menu was already open, the first click can close it. Retry once.
            __cr.click(modelButton);
            await waitForMenu();
            rootMenu = __cr.findModelMenuRoot();
            toggleRow = __cr.findModelToggleRow(requestedToggle, rootMenu) || findToggleRowAnywhere();
        }

        const menuState = __cr.getModelMenuState();
        if (!toggleRow) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
            return {
                error: 'model_toggle_not_found',
                requestedToggle,
                toggles: menuState.toggles || []
            };
        }

        const wasEnabled = __cr.getSwitchState(toggleRow);
        if (desiredEnabled === null || wasEnabled !== desiredEnabled) {
            __cr.click(toggleRow);
            await new Promise(r => setTimeout(r, 220));
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        }

        const updatedState = __cr.getModelMenuState();
        const updatedToggle = Array.isArray(updatedState.toggles)
            ? updatedState.toggles.find((toggle) =>
                toggle?.key === requestedToggle.toLowerCase().replace(/\s+/g, '-')
                || String(toggle?.label || '').trim().toLowerCase() === requestedToggle.toLowerCase()
            )
            : null;
        const updatedCurrentModel = String(updatedState.current || __cr.getModelText() || 'Unknown').trim();
        const autoToggleSatisfied =
            requestedToggle === 'auto'
            && (
                (desiredEnabled === true && /^auto$/i.test(updatedCurrentModel))
                || (desiredEnabled === false && updatedCurrentModel && !/^auto$/i.test(updatedCurrentModel))
            );
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));

        if (autoToggleSatisfied) {
            return {
                success: true,
                toggles: updatedState.toggles || [],
                currentModel: updatedCurrentModel || 'Unknown',
                options: updatedState.options || [],
                searchPlaceholder: updatedState.searchPlaceholder || '',
                footerLabel: updatedState.footerLabel || ''
            };
        }

        if (desiredEnabled !== null && (!updatedToggle || updatedToggle.enabled !== desiredEnabled)) {
            return {
                error: 'model_toggle_apply_mismatch',
                toggles: updatedState.toggles || [],
                currentModel: updatedCurrentModel || 'Unknown'
            };
        }

        return {
            success: true,
            toggles: updatedState.toggles || [],
            currentModel: updatedState.current || __cr.getModelText() || 'Unknown',
            options: updatedState.options || [],
            searchPlaceholder: updatedState.searchPlaceholder || '',
            footerLabel: updatedState.footerLabel || ''
        };
    `, {
        accept: (value) => value && typeof value === 'object' && !value.error
    });

    if (result?.success) {
        logTraceStep(traceId, 'setModelToggle.domSuccess', summarizeActionResultForLog(result));
        return result;
    }

    logTraceStep(traceId, 'setModelToggle.domResult', summarizeActionResultForLog(result));
    const menuState = await getDropdownOptions(cdp, 'model', traceId);
    const currentToggle = Array.isArray(menuState?.toggles)
        ? menuState.toggles.find((toggle) =>
            toggle?.key === requestedToggle ||
            String(toggle?.label || '').trim().toLowerCase() === toggleLabel.toLowerCase()
        )
        : null;
    const currentModelState = String(menuState?.current || result?.currentModel || '').trim();

    if (
        requestedToggle === 'auto'
        && enabled !== undefined
        && (
            (!!enabled && /^auto$/i.test(currentModelState))
            || (!enabled && currentModelState && !/^auto$/i.test(currentModelState))
        )
    ) {
        logTraceStep(traceId, 'setModelToggle.verifiedByModelAfterFallback', {
            currentModelState,
            enabled: !!enabled
        });
        return {
            success: true,
            toggles: menuState.toggles || [],
            currentModel: currentModelState || 'Unknown',
            options: menuState.options || [],
            searchPlaceholder: menuState.searchPlaceholder || '',
            footerLabel: menuState.footerLabel || ''
        };
    }

    if (currentToggle && enabled !== undefined && currentToggle.enabled === !!enabled) {
        logTraceStep(traceId, 'setModelToggle.verifiedByToggleAfterFallback', {
            currentModelState,
            toggleKey: currentToggle.key,
            toggleEnabled: currentToggle.enabled
        });
        return {
            success: true,
            toggles: menuState.toggles || [],
            currentModel: currentModelState || 'Unknown',
            options: menuState.options || [],
            searchPlaceholder: menuState.searchPlaceholder || '',
            footerLabel: menuState.footerLabel || '',
            alreadySet: true
        };
    }

    if (requestedToggle === 'auto' && enabled === true) {
        logTraceStep(traceId, 'setModelToggle.autoDelegatingToSetModel');
        const autoResult = await setModel(cdp, 'Auto', traceId);
        if (autoResult?.success) {
            const refreshedMenuState = await getDropdownOptions(cdp, 'model', traceId);
            return {
                success: true,
                toggles: refreshedMenuState.toggles || [],
                currentModel: autoResult.currentModel || refreshedMenuState.current || 'Auto'
            };
        }
    }

    const targetEntry = Array.isArray(menuState?.targets)
        ? menuState.targets.find((target) => target.kind === 'toggle' && target.key === requestedToggle)
        : null;

    if (menuState?.buttonPoint && targetEntry) {
        logTraceStep(traceId, 'setModelToggle.coordinateFallback', {
            target: targetEntry.title || targetEntry.key || requestedToggle,
            x: targetEntry.x,
            y: targetEntry.y
        });
        await clickAtPoint(cdp, menuState.buttonPoint.x, menuState.buttonPoint.y);
        await new Promise((resolve) => setTimeout(resolve, 260));
        await clickAtPoint(cdp, targetEntry.x, targetEntry.y);
        await new Promise((resolve) => setTimeout(resolve, 320));

        const refreshedMenuState = await getDropdownOptions(cdp, 'model', traceId);
        const refreshedToggle = Array.isArray(refreshedMenuState?.toggles)
            ? refreshedMenuState.toggles.find((toggle) => toggle?.key === requestedToggle)
            : null;

        if ((enabled === undefined && refreshedToggle) || (refreshedToggle && refreshedToggle.enabled === !!enabled)) {
            logTraceStep(traceId, 'setModelToggle.coordinateFallbackVerified', {
                currentModel: refreshedMenuState.current || result?.currentModel || 'Unknown',
                toggleKey: refreshedToggle?.key || requestedToggle,
                toggleEnabled: refreshedToggle?.enabled
            });
            return {
                success: true,
                toggles: refreshedMenuState.toggles || [],
                currentModel: refreshedMenuState.current || result?.currentModel || 'Unknown'
            };
        }
    }

    logTraceStep(traceId, 'setModelToggle.complete', summarizeActionResultForLog(result));
    return result;
}

async function getDropdownOptions(cdp, kind, traceId = null) {
    const normalizedKind = kind === 'model' ? 'model' : 'mode';
    logTraceStep(traceId, 'getDropdownOptions.request', { kind: normalizedKind });
    const buttonState = await evaluateCursor(cdp, `
        const kind = ${JSON.stringify(normalizedKind)};
        const button = kind === 'model' ? __cr.findModelButton() : __cr.findModeButton();
        const current = kind === 'model' ? (__cr.getModelText() || 'Unknown') : (__cr.getModeText() || 'Unknown');
        const menuAlreadyOpen = kind === 'model' && !!__cr.findModelMenuRoot();
        if (!button && !menuAlreadyOpen) return { error: kind + '_button_not_found', options: [] };
        if (!button) {
            return {
                success: true,
                kind,
                current,
                menuAlreadyOpen,
                buttonPoint: null
            };
        }

        const buttonRect = button.getBoundingClientRect();
        return {
            success: true,
            kind,
            current,
            menuAlreadyOpen,
            buttonPoint: {
                x: kind === 'mode'
                    ? Math.round(buttonRect.left + Math.max(14, Math.min(buttonRect.width * 0.35, buttonRect.width / 2)))
                    : Math.round(buttonRect.left + (buttonRect.width / 2)),
                y: Math.round(buttonRect.top + (buttonRect.height / 2))
            }
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });
    if (!buttonState || buttonState.error) {
        logTraceStep(traceId, 'getDropdownOptions.buttonStateError', buttonState);
        return buttonState;
    }
    logTraceStep(traceId, 'getDropdownOptions.buttonState', summarizeLogValue(buttonState));

    if (buttonState.buttonPoint && !buttonState.menuAlreadyOpen) {
        await clickAtPoint(cdp, buttonState.buttonPoint.x, buttonState.buttonPoint.y);
        await new Promise((resolve) => setTimeout(resolve, 260));
    }

    const result = await evaluateCursor(cdp, `
        const kind = ${JSON.stringify(normalizedKind)};
        const current = kind === 'model' ? (__cr.getModelText() || 'Unknown') : (__cr.getModeText() || 'Unknown');
        const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const menus = __cr.findMenuContainers();

        let normalizedOptions;
        let searchPlaceholder = '';
        let autoAvailable = false;
        let autoEnabled = false;
        let autoLabel = 'Auto';
        let autoDescription = '';
        let toggles = [];
        let footerLabel = '';
        let targets = [];

        if (kind === 'model') {
            const modelMenuState = __cr.getModelMenuState();
            searchPlaceholder = modelMenuState.searchPlaceholder || '';
            toggles = Array.isArray(modelMenuState.toggles) ? modelMenuState.toggles : [];
            footerLabel = modelMenuState.footerLabel || '';
            targets = Array.isArray(modelMenuState.targets) ? modelMenuState.targets : [];

            const autoToggle = toggles.find(toggle => toggle.key === 'auto' || /^auto$/i.test(toggle.label || ''));
            if (autoToggle) {
                autoAvailable = true;
                autoEnabled = !!autoToggle.enabled;
                autoLabel = autoToggle.label || 'Auto';
                autoDescription = autoToggle.description || '';
            } else if (/auto/i.test(current)) {
                autoAvailable = true;
                autoEnabled = true;
                autoDescription = 'Balanced quality and speed, recommended for most tasks';
            }

            normalizedOptions = Array.isArray(modelMenuState.options) && modelMenuState.options.length
                ? modelMenuState.options.slice(0, 80)
                : (current && current !== 'Unknown' && !/auto/i.test(current) ? [current] : []);
        } else {
            const collectModeItems = (menuList) => menuList
                .flatMap(menu => __cr.getMenuItems(menu))
                .map(item => ({
                    title: normalizeText(item.title),
                    rect: item.element?.getBoundingClientRect?.() || null
                }))
                .filter(item => item.rect && /^(agent|plan|debug|ask|fast|planning|manual)$/i.test(item.title));

            const matchingMenus = current
                ? menus.filter(menu => __cr.textOf(menu).toLowerCase().includes(current.toLowerCase()))
                : [];
            const allModeItems = collectModeItems(menus);
            const matchingModeItems = collectModeItems(matchingMenus);
            const modeItems = matchingModeItems.length >= 2 ? matchingModeItems : allModeItems;
            const seen = new Set();

            normalizedOptions = [];
            targets = [];
            for (const item of modeItems) {
                const key = item.title.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                normalizedOptions.push(item.title);
                targets.push({
                    kind: 'option',
                    title: item.title,
                    x: Math.round(item.rect.left + (item.rect.width / 2)),
                    y: Math.round(item.rect.top + (item.rect.height / 2))
                });
            }

            normalizedOptions = normalizedOptions.length
                ? normalizedOptions
                : (current && current !== 'Unknown' ? [current] : []);
        }

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));

        return {
            success: true,
            kind,
            current,
            options: normalizedOptions,
            searchPlaceholder,
            toggles,
            autoAvailable,
            autoEnabled,
            autoLabel,
            autoDescription,
            footerLabel,
            targets
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });
    if (result && !result.error) {
        result.buttonPoint = buttonState.buttonPoint;
    }

    if (normalizedKind === 'model' && result && !result.error) {
        const fallbackAutoDescription = 'Balanced quality and speed, recommended for most tasks';
        const knownModelItems = [
            { value: 'Composer 1.5', icon: 'cloud' },
            { value: 'GPT-5.4', icon: 'cloud' },
            { value: 'GPT-5.3 Codex', icon: 'cloud' },
            { value: 'Sonnet 4.6', icon: 'cloud' },
            { value: 'Opus 4.6', icon: 'cloud' },
            { value: 'Gemini 3 Flash', icon: 'cloud' },
            { value: 'gpt-4', icon: '' }
        ];
        const iconByValue = new Map(knownModelItems.map((item) => [item.value.toLowerCase(), item.icon]));
        const mergeLiveModelItems = (...lists) => {
            const seen = new Set();
            const merged = [];

            lists.flat().forEach((entry) => {
                const value = String(
                    typeof entry === 'string'
                        ? entry
                        : (entry?.value || entry?.name || '')
                ).trim();

                if (!value || /^auto$/i.test(value)) return;

                const key = value.toLowerCase();
                if (seen.has(key)) return;
                seen.add(key);

                const explicitIcon = typeof entry === 'object' && entry ? String(entry.icon || '').trim() : '';
                merged.push({
                    value,
                    icon: explicitIcon || iconByValue.get(key) || ''
                });
            });

            return merged;
        };
        const normalizedCurrent = String(result.current || '').trim();
        const fallbackCurrent = normalizedCurrent && normalizedCurrent !== 'Unknown' ? normalizedCurrent : 'Auto';
        const liveToggles = Array.isArray(result.toggles)
            ? result.toggles
                .map((toggle) => ({
                    key: String(toggle?.key || toggle?.label || '')
                        .trim()
                        .toLowerCase()
                        .replace(/\s+/g, '-'),
                    label: String(toggle?.label || toggle?.key || '').trim(),
                    description: String(toggle?.description || '').trim(),
                    enabled: !!toggle?.enabled
                }))
                .filter((toggle) => toggle.key && toggle.label)
            : [];
        const autoToggle = liveToggles.find((toggle) => toggle.key === 'auto') || null;
        const currentItem = fallbackCurrent && !/^auto$/i.test(fallbackCurrent)
            ? [{ value: fallbackCurrent, icon: iconByValue.get(fallbackCurrent.toLowerCase()) || '' }]
            : [];
        const mergedItems = mergeLiveModelItems(
            currentItem,
            Array.isArray(result.items) ? result.items : [],
            Array.isArray(result.options) ? result.options : []
        );

        result.current = fallbackCurrent;
        result.searchPlaceholder = String(result.searchPlaceholder || '').trim();
        result.toggles = liveToggles;
        result.items = mergedItems;
        result.options = mergedItems.map((item) => item.value);
        result.autoAvailable = !!autoToggle || /^auto$/i.test(fallbackCurrent);
        result.autoEnabled = autoToggle ? autoToggle.enabled : /^auto$/i.test(fallbackCurrent);
        result.autoLabel = autoToggle?.label || result.autoLabel || 'Auto';
        result.autoDescription = String(autoToggle?.description || result.autoDescription || fallbackAutoDescription || '')
            .replace(/^(?:auto\s*)+/i, '')
            .trim() || fallbackAutoDescription;
        result.footerLabel = String(result.footerLabel || '').trim();
        result.live = true;
        result.compactAuto = /^auto$/i.test(fallbackCurrent) && result.autoAvailable && !result.options.length;
    }

    if (normalizedKind === 'mode' && result && !result.error) {
        const fallbackModeOptions = ['Agent', 'Plan', 'Debug', 'Ask'];
        const aliasMap = {
            agent: 'Agent',
            fast: 'Agent',
            plan: 'Plan',
            planning: 'Plan',
            debug: 'Debug',
            manual: 'Debug',
            ask: 'Ask'
        };
        const normalizedCurrent = String(result.current || '').trim();
        const displayCurrent = aliasMap[normalizedCurrent.toLowerCase()] || normalizedCurrent;

        if (displayCurrent && displayCurrent !== 'Unknown') {
            result.current = displayCurrent;
        }

        const normalizedOptions = Array.isArray(result.options)
            ? result.options
                .map(option => aliasMap[String(option || '').trim().toLowerCase()] || String(option || '').trim())
                .filter(Boolean)
            : [];

        result.options = normalizedOptions.length >= 2
            ? Array.from(new Set(normalizedOptions))
            : (displayCurrent && displayCurrent !== 'Unknown'
                ? Array.from(new Set([displayCurrent, ...fallbackModeOptions]))
                : fallbackModeOptions);
    }

    logTraceStep(traceId, 'getDropdownOptions.complete', summarizeDropdownStateForLog(result));
    return result;
}

export { getModeRequestCandidates, setMode, stopGeneration, setModel, setModelToggle, getDropdownOptions };
