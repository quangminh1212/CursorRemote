import { CURSOR_UI_HELPERS } from './cursor-ui-helpers.js';

function getOrderedContexts(cdp) {
    return [...(cdp?.contexts || [])].sort((a, b) => Number(!!b?.auxData?.isDefault) - Number(!!a?.auxData?.isDefault));
}

function getExceptionMessage(exceptionDetails) {
    return exceptionDetails?.exception?.description ||
        exceptionDetails?.text ||
        exceptionDetails?.exception?.value ||
        'Runtime.evaluate failed';
}

function buildCursorExpression(body) {
    return `(async () => { ${CURSOR_UI_HELPERS}\n${body}\n})()`;
}

async function evaluateCursor(cdp, body, {
    accept = (value) => value !== undefined && value !== null && !value?.error,
    awaitPromise = true,
    returnByValue = true
} = {}) {
    const contexts = getOrderedContexts(cdp);
    if (!contexts.length) {
        return { error: 'No execution contexts available' };
    }

    let lastError = null;
    let lastValue = null;

    for (const ctx of contexts) {
        try {
            const result = await cdp.call('Runtime.evaluate', {
                expression: buildCursorExpression(body),
                returnByValue,
                awaitPromise,
                contextId: ctx.id
            });

            if (result.exceptionDetails) {
                lastError = getExceptionMessage(result.exceptionDetails);
                continue;
            }

            const value = result.result?.value;
            if (accept(value)) {
                return value;
            }

            if (value !== undefined) {
                lastValue = value;
                if (value?.error) lastError = value.error;
            }
        } catch (error) {
            lastError = error.message;
        }
    }

    return lastValue ?? { error: lastError || 'No matching DOM context' };
}

async function clickAtPoint(cdp, x, y) {
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

export { getOrderedContexts, getExceptionMessage, buildCursorExpression, evaluateCursor, clickAtPoint };
