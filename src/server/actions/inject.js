import fs from 'fs';
import { isAbsolute, resolve } from 'path';
import { evaluateCursor } from '../cdp-eval.js';
import { logTraceStep, summarizeLogText, summarizeLogValue, summarizeActionResultForLog } from '../logger.js';

// Inject message into Cursor
async function injectMessage(cdp, text, traceId = null) {
    const safeText = JSON.stringify(text);
    logTraceStep(traceId, 'injectMessage.request', {
        textLength: String(text || '').length,
        preview: summarizeLogText(text, 120)
    });
    const prepared = await evaluateCursor(cdp, `
        const editor = __cr.findEditor();
        if (!editor) return { ok: false, error: 'editor_not_found' };
        if (__cr.isBusy()) return { ok: false, reason: 'busy', status: __cr.getComposerStatus() };

        const textToInsert = ${safeText};
        __cr.setEditorText(editor, textToInsert);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const sendButton = __cr.findSendButton();
        const sendRect = sendButton ? sendButton.getBoundingClientRect() : null;

        return {
            ok: true,
            editorText: __cr.textOf(editor),
            sendButton: sendRect ? {
                x: sendRect.left + (sendRect.width / 2),
                y: sendRect.top + (sendRect.height / 2)
            } : null
        };
    `, {
        accept: (value) => value && typeof value === 'object' && !value.error
    });

    if (!prepared?.ok) {
        logTraceStep(traceId, 'injectMessage.prepareFailed', summarizeActionResultForLog(prepared));
        return prepared || { ok: false, reason: 'prepare_failed' };
    }
    logTraceStep(traceId, 'injectMessage.prepared', summarizeLogValue(prepared));

    try {
        await cdp.call('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13
        });
        await cdp.call('Input.dispatchKeyEvent', {
            type: 'char',
            key: '\r',
            code: 'Enter',
            text: '\r',
            unmodifiedText: '\r',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13
        });
        await cdp.call('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13
        });
    } catch (error) {
        console.warn('CDP Enter dispatch failed, falling back to DOM click only:', error.message);
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));

    let finalState = await evaluateCursor(cdp, `
        const editor = __cr.findEditor();
        const sendButton = __cr.findSendButton();
        const sendRect = sendButton ? sendButton.getBoundingClientRect() : null;
        return {
            editorTextAfter: editor ? __cr.textOf(editor) : '',
            hasMessagesAfter: __cr.collectMessageNodes().length > 0,
            busyAfter: __cr.isBusy(),
            sendButton: sendRect ? {
                x: sendRect.left + (sendRect.width / 2),
                y: sendRect.top + (sendRect.height / 2)
            } : null
        };
    `, {
        accept: (value) => value && typeof value === 'object' && !value.error
    });

    let method = 'cdp_enter';

    if (finalState?.editorTextAfter && finalState.sendButton) {
        logTraceStep(traceId, 'injectMessage.mouseFallback', summarizeLogValue(finalState));
        try {
            await cdp.call('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: finalState.sendButton.x,
                y: finalState.sendButton.y
            });
            await cdp.call('Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: finalState.sendButton.x,
                y: finalState.sendButton.y,
                button: 'left',
                clickCount: 1
            });
            await cdp.call('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: finalState.sendButton.x,
                y: finalState.sendButton.y,
                button: 'left',
                clickCount: 1
            });
            method = 'cdp_enter_then_mouse_send';
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
            finalState = await evaluateCursor(cdp, `
                const editor = __cr.findEditor();
                return {
                    editorTextAfter: editor ? __cr.textOf(editor) : '',
                    hasMessagesAfter: __cr.collectMessageNodes().length > 0,
                    busyAfter: __cr.isBusy()
                };
            `, {
                accept: (value) => value && typeof value === 'object'
            });
        } catch (error) {
            console.warn('CDP mouse send fallback failed:', error.message);
        }
    }

    const finalResult = {
        ok: !finalState?.editorTextAfter,
        method,
        editorTextAfter: finalState?.editorTextAfter || '',
        hasMessagesAfter: !!finalState?.hasMessagesAfter,
        busyAfter: !!finalState?.busyAfter
    };
    logTraceStep(traceId, 'injectMessage.complete', summarizeActionResultForLog(finalResult));
    return finalResult;
}

// Inject file into Cursor via CDP file chooser
async function injectFile(cdp, filePath) {
    const nativePath = isAbsolute(filePath) ? filePath : resolve(filePath);
    if (!fs.existsSync(nativePath)) {
        return { success: false, error: `File not found: ${nativePath}` };
    }

    console.log(`[UPLOAD] Injecting file via CDP: ${nativePath}`);

    try {
        await cdp.call('Page.setInterceptFileChooserDialog', { enabled: true });

        const fileChooserPromise = new Promise((resolveChooser, rejectChooser) => {
            let handled = false;

            const cleanup = () => {
                cdp.ws.removeListener('message', handler);
                clearTimeout(timeoutId);
            };

            const timeoutId = setTimeout(() => {
                if (handled) return;
                handled = true;
                cleanup();
                rejectChooser(new Error('File chooser did not open within 5s'));
            }, 5000);

            const handler = (rawMsg) => {
                try {
                    const msg = JSON.parse(String(rawMsg));
                    if (msg.method !== 'Page.fileChooserOpened' || handled) {
                        return;
                    }

                    handled = true;
                    cleanup();
                    resolveChooser(msg.params || {});
                } catch {
                    // Ignore non-JSON websocket traffic.
                }
            };

            cdp.ws.on('message', handler);
        });

        const clickResult = await clickContextPlusButton(cdp);
        console.log('[UPLOAD] Click context+ result:', clickResult);

        if (!clickResult.success) {
            try {
                await cdp.call('Page.setInterceptFileChooserDialog', { enabled: false });
            } catch {
                // Best effort cleanup only.
            }
            return { success: false, error: 'Could not find context+ button in IDE', details: clickResult };
        }

        try {
            const chooserParams = await fileChooserPromise;
            console.log(`[UPLOAD] File chooser opened, mode: ${chooserParams.mode || 'unknown'}`);

            await cdp.call('Page.handleFileChooser', {
                action: 'accept',
                files: [nativePath]
            });

            console.log(`[UPLOAD] File injected successfully: ${nativePath}`);

            try {
                await cdp.call('Page.setInterceptFileChooserDialog', { enabled: false });
            } catch {
                // Best effort cleanup only.
            }

            return { success: true, method: 'file_chooser', path: nativePath };
        } catch (error) {
            console.warn(`[UPLOAD] File chooser approach failed: ${error.message}. Trying fallback...`);
            try {
                await cdp.call('Page.setInterceptFileChooserDialog', { enabled: false });
            } catch {
                // Best effort cleanup only.
            }

            return await injectFileViaInput(cdp, nativePath);
        }
    } catch (error) {
        try {
            await cdp.call('Page.setInterceptFileChooserDialog', { enabled: false });
        } catch {
            // Best effort cleanup only.
        }
        console.error(`[UPLOAD] File injection error: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// Click the context/media "+" button in IDE (NOT the "new conversation" + button)
async function clickContextPlusButton(cdp) {
    return await evaluateCursor(cdp, `
        const editor = __cr.findEditor();
        if (!editor) return { success: false, error: 'editor_not_found' };

        const attachButton = __cr.findAttachButton();
        if (!attachButton) {
            return { success: false, error: 'attach_button_not_found' };
        }

        __cr.click(attachButton);
        await new Promise(r => setTimeout(r, 150));

        return {
            success: true,
            method: 'attach_button',
            ariaLabel: attachButton.getAttribute('aria-label') || '',
            title: attachButton.getAttribute('title') || ''
        };
    `, {
        accept: (value) => value && typeof value === 'object' && !value.error
    });
}

// Fallback: inject file via DOM file input
async function injectFileViaInput(cdp, filePath) {
    const EXP = `(() => {
        const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
        if (fileInputs.length === 0) return { found: false };
        return { found: true, count: fileInputs.length };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call('Runtime.evaluate', {
                expression: EXP,
                returnByValue: true,
                contextId: ctx.id
            });

            if (res.result?.value?.found) {
                const doc = await cdp.call('DOM.getDocument', { depth: 0 });
                const nodeResult = await cdp.call('DOM.querySelector', {
                    nodeId: doc.root.nodeId,
                    selector: 'input[type="file"]'
                });

                if (nodeResult.nodeId) {
                    await cdp.call('DOM.setFileInputFiles', {
                        files: [filePath],
                        nodeId: nodeResult.nodeId
                    });
                    return { success: true, method: 'dom_set_file_input', path: filePath };
                }
            }
        } catch (error) {
            console.warn(`DOM file input fallback failed in context ${ctx.id}:`, error.message);
        }
    }
    return { success: false, error: 'No file input found in IDE' };
}

export { injectMessage, injectFile, clickContextPlusButton, injectFileViaInput };
