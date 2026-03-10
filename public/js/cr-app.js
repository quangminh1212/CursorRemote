// =============================================
// CursorRemote - App Init & Event Handlers
// =============================================

chatContainer.addEventListener('click', async (e) => {
    // Strategy: Check if the clicked element OR its parent contains "Thought" or "Thinking" text.
    // This handles both opening (collapsed) and closing (expanded) states.

    // 1. Find the nearest container that might be the "Thought" block
    const target = e.target.closest('div, span, p, summary, button, details');
    if (!target) return;

    const text = target.innerText || '';

    // Check if this looks like a thought toggle (matches "Thought for Xs" or "Thinking" patterns)
    // Also match the header of expanded thoughts which may have more content
    const isThoughtToggle = /Thought|Thinking/i.test(text) && text.length < 500;

    if (isThoughtToggle) {
        // Visual feedback - briefly dim the clicked element
        target.style.opacity = '0.5';
        setTimeout(() => target.style.opacity = '1', 300);

        // Extract just the first line for matching (e.g., "Thought for 3s")
        const firstLine = text.split('\n')[0].trim();

        // Determine which occurrence of this text the user tapped
        // This handles multiple Thought blocks with identical labels
        const allElements = chatContainer.querySelectorAll(target.tagName.toLowerCase());
        let tapIndex = 0;
        for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i];
            const elText = el.innerText || '';
            const elFirstLine = elText.split('\n')[0].trim();

            // Only count if it looks like a thought toggle and matches the first line exactly
            if (/Thought|Thinking/i.test(elText) && elText.length < 500 && elFirstLine === firstLine) {
                // If this is our target (or contains it), we've found the correct index
                if (el === target || el.contains(target)) {
                    break;
                }
                tapIndex++;
            }
        }

        try {
            const response = await fetchWithAuth('/remote-click', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    selector: target.tagName.toLowerCase(),
                    index: tapIndex,
                    textContent: firstLine  // Use first line for more reliable matching
                })
            });

            queueSnapshotReload({ delays: FAST_ACTION_SNAPSHOT_DELAYS });
        } catch (e) {
            console.error('Remote click failed:', e);
        }
        return;
    }

    // --- Command Action Buttons (Run / Reject) ---
    const btn = e.target.closest('button');
    if (btn) {
        const btnText = (btn.innerText || '').trim();
        // Match "Run", "Run Alt+âŽ", "Reject"
        const isRun = /^Run/i.test(btnText);
        const isReject = /^Reject$/i.test(btnText);

        if (isRun || isReject) {
            btn.style.opacity = '0.5';
            setTimeout(() => btn.style.opacity = '1', 300);

            // Determine which occurrence of this button text the user tapped
            const label = isRun ? 'Run' : 'Reject';
            const allButtons = Array.from(chatContainer.querySelectorAll('button'));

            // Filter to only those that match our specific label (to handle multiple commands)
            const matchingButtons = allButtons.filter(b => (b.innerText || '').includes(label));
            const btnIndex = matchingButtons.indexOf(btn);

            try {
                await fetchWithAuth('/remote-click', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        selector: 'button',
                        index: btnIndex >= 0 ? btnIndex : 0,
                        textContent: label
                    })
                });
                queueSnapshotReload({ delays: COMMAND_ACTION_SNAPSHOT_DELAYS });
            } catch (err) {
                console.error('Remote command click failed:', err);
            }
        }
    }
});

// --- Init ---
updateWorkspaceChrome();
connectWebSocket();
// Sync state periodically to guard against missed WS events.
fetchAppState();
setInterval(fetchAppState, APP_STATE_REVALIDATE_INTERVAL);
setInterval(() => {
    queueSnapshotReload({ delays: [0] });
}, SNAPSHOT_REVALIDATE_INTERVAL);

// Check chat status initially and periodically
checkChatStatus();
setInterval(checkChatStatus, CHAT_STATUS_REVALIDATE_INTERVAL);

// --- QR Code Modal ---
const qrBtn = document.getElementById('qrBtn');
const qrOverlay = document.getElementById('qrOverlay');
const qrCloseBtn = document.getElementById('qrCloseBtn');
const qrImage = document.getElementById('qrImage');
const qrUrl = document.getElementById('qrUrl');
const qrLoading = document.getElementById('qrLoading');

if (qrBtn) {
    qrBtn.addEventListener('click', async () => {
        qrOverlay.classList.add('open');
        qrImage.style.display = 'none';
        qrUrl.textContent = '';
        qrLoading.style.display = 'flex';

        try {
            const res = await fetchWithAuth('/qr-info');
            const data = await res.json();

            qrImage.src = data.qrDataUrl;
            qrImage.style.display = 'block';
            qrUrl.textContent = data.connectUrl;
            qrLoading.style.display = 'none';
        } catch (e) {
            qrLoading.innerHTML = '<p style="color: var(--error)">Failed to generate QR code</p>';
            console.error('[QR] Error:', e);
        }
    });
}

if (qrCloseBtn) {
    qrCloseBtn.addEventListener('click', () => {
        qrOverlay.classList.remove('open');
    });
}

if (qrOverlay) {
    qrOverlay.addEventListener('click', (e) => {
        if (e.target === qrOverlay) qrOverlay.classList.remove('open');
    });
}

// Copy URL on click
if (qrUrl) {
    qrUrl.addEventListener('click', async () => {
        const url = qrUrl.textContent;
        if (url) {
            const ok = await copyToClipboard(url);
            if (ok) {
                const orig = qrUrl.textContent;
                qrUrl.textContent = 'âœ“ Copied!';
                setTimeout(() => { qrUrl.textContent = orig; }, 1500);
            }
        }
    });
}
