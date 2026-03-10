import fs from 'fs';
import { evaluateCursor, clickAtPoint } from '../cdp-eval.js';
import { createTraceId, logTraceStep, summarizeLogText, summarizeLogValue, summarizeActionResultForLog } from '../logger.js';

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

    await new Promise(resolve => setTimeout(resolve, 200));

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
            await new Promise(resolve => setTimeout(resolve, 250));
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
    // Normalize to absolute Windows path for CDP
    const absolutePath = filePath.startsWith('/') ? filePath : join(__dirname, filePath).replace(/\\/g, '/');
    const winPath = absolutePath.replace(/\//g, '\\');

    console.log(`Ã°Å¸â€œâ€š Injecting file via CDP: ${winPath}`);

    try {
        // Step 1: Enable file chooser interception
        await cdp.call("Page.setInterceptFileChooserDialog", { enabled: true });

        // Step 2: Set up a promise to wait for the file chooser event
        const fileChooserPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cdp.ws.removeListener('message', handler);
                reject(new Error('File chooser did not open within 5s'));
            }, 5000);

            const handler = (rawMsg) => {
                try {
                    const msg = JSON.parse(rawMsg);
                    if (msg.method === 'Page.fileChooserOpened') {
                        clearTimeout(timeout);
                        cdp.ws.removeListener('message', handler);
                        resolve(msg.params);
                    }
                } catch (e) { /* ignore parse errors */ }
            };
            cdp.ws.on('message', handler);
        });

        // Step 3: Click the context/media "+" button in IDE (bottom-left, near editor)
        const clickResult = await clickContextPlusButton(cdp);
        console.log(`Ã°Å¸â€“Â±Ã¯Â¸Â Click context+ result:`, clickResult);

        if (!clickResult.success) {
            // Disable interception before returning
            try { await cdp.call("Page.setInterceptFileChooserDialog", { enabled: false }); } catch (e) { }
            return { success: false, error: 'Could not find context+ button in IDE', details: clickResult };
        }

        // Step 4: Wait for file chooser to open, then accept with our file
        try {
            const chooserParams = await fileChooserPromise;
            console.log(`Ã°Å¸â€œÂ File chooser opened, mode: ${chooserParams.mode}`);

            await cdp.call("Page.handleFileChooser", {
                action: "accept",
                files: [winPath]
            });

            console.log(`Ã¢Å“â€¦ File injected successfully: ${winPath}`);

            // Disable interception
            try { await cdp.call("Page.setInterceptFileChooserDialog", { enabled: false }); } catch (e) { }

            return { success: true, method: 'file_chooser', path: winPath };
        } catch (e) {
            // File chooser didn't open - perhaps the button doesn't open file dialog
            // Try fallback: drag-and-drop via CDP Input events
            console.warn(`Ã¢Å¡Â Ã¯Â¸Â File chooser approach failed: ${e.message}. Trying fallback...`);
            try { await cdp.call("Page.setInterceptFileChooserDialog", { enabled: false }); } catch (e2) { }

            // Fallback: Use DOM.setFileInputFiles if there's a file input
            return await injectFileViaInput(cdp, winPath);
        }
    } catch (e) {
        try { await cdp.call("Page.setInterceptFileChooserDialog", { enabled: false }); } catch (e2) { }
        console.error(`Ã¢ÂÅ’ File injection error: ${e.message}`);
        return { success: false, error: e.message };
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
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                contextId: ctx.id
            });

            if (res.result?.value?.found) {
                // Use DOM.setFileInputFiles to set files on the input
                // First get the document
                const doc = await cdp.call("DOM.getDocument", { depth: 0 });
                const nodeResult = await cdp.call("DOM.querySelector", {
                    nodeId: doc.root.nodeId,
                    selector: 'input[type="file"]'
                });

                if (nodeResult.nodeId) {
                    await cdp.call("DOM.setFileInputFiles", {
                        files: [filePath],
                        nodeId: nodeResult.nodeId
                    });
                    return { success: true, method: 'dom_set_file_input' };
                }
            }
        } catch (e) {
            console.warn(`DOM file input fallback failed in context ${ctx.id}:`, e.message);
        }
    }
    return { success: false, error: 'No file input found in IDE' };
}

export { injectMessage, injectFile, clickContextPlusButton, injectFileViaInput };
