import { evaluateCursor } from '../cdp-eval.js';
import { createTraceId, logTraceStep, summarizeActionResultForLog } from '../logger.js';

// Click Element (Remote)
async function clickElement(cdp, { selector, index, textContent }) {
    const safeSelector = JSON.stringify(selector || '*');
    const safeText = JSON.stringify(textContent || '');
    const targetIndex = Number.isFinite(Number(index)) ? Number(index) : 0;

    return await evaluateCursor(cdp, `
        const root = __cr.findPanel() || document;
        const query = ${safeSelector};
        const filterText = ${safeText};
        let elements = Array.from(root.querySelectorAll(query)).filter(__cr.isVisible);

        if (filterText) {
            elements = elements.filter(el => {
                const text = __cr.textOf(el);
                const firstLine = text.split('\\n')[0].trim();
                return firstLine === filterText || text.includes(filterText);
            });

            elements = elements.filter(el => !elements.some(other => other !== el && el.contains(other)));
        }

        const target = elements[${targetIndex}] || null;
        if (!target) {
            return {
                error: 'Element not found',
                found: elements.length,
                indexUsed: ${targetIndex}
            };
        }

        try { target.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* ignore */ }
        if (typeof target.focus === 'function') {
            try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        }
        __cr.click(target);
        await new Promise(r => setTimeout(r, 150));

        return {
            success: true,
            found: elements.length,
            indexUsed: ${targetIndex},
            text: __cr.textOf(target).slice(0, 120)
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });
}

// Remote scroll - sync phone scroll to desktop
async function remoteScroll(cdp, { scrollTop, scrollPercent }) {
    const numericScrollTop = Number.isFinite(Number(scrollTop)) ? Number(scrollTop) : 0;
    const normalizedPercent = Number.isFinite(Number(scrollPercent)) ? Math.min(1, Math.max(0, Number(scrollPercent))) : null;

    return await evaluateCursor(cdp, `
        const target = __cr.findPanelScrollRoot();
        if (!target) return { error: 'No scrollable element found' };

        const maxScroll = Math.max(target.scrollHeight - target.clientHeight, 0);
        if (${normalizedPercent === null ? 'null' : normalizedPercent} !== null) {
            target.scrollTop = maxScroll * ${normalizedPercent === null ? 0 : normalizedPercent};
        } else {
            target.scrollTop = Math.max(0, Math.min(${numericScrollTop}, maxScroll));
        }

        target.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        return {
            success: true,
            scrollTop: target.scrollTop,
            maxScroll,
            scrollPercent: maxScroll > 0 ? target.scrollTop / maxScroll : 0
        };
    `, {
        accept: (value) => value && typeof value === 'object'
    });
}

export { clickElement, remoteScroll };
