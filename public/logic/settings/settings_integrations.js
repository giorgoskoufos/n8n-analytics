/**
 * Connecting the n8n documentation service, from the page.
 *
 * The whole reason this exists is that the alternative was editing an
 * environment file and restarting. The credential is personal — the service
 * issues it against the account that approves it — so it has to be something
 * each person does for themselves, and asking each person to edit a server's
 * environment is not a flow.
 *
 * The approval happens in a popup rather than by navigating away, so the
 * settings page survives with whatever else was unsaved on it. The popup posts
 * back when it is done; the page also re-checks on focus, because a popup
 * blocker turns the popup into a tab and the message never arrives.
 */

(function () {
    'use strict';

    const dot = () => document.getElementById('docsStatusDot');
    const detail = () => document.getElementById('docsStatusDetail');
    const connectBtn = () => document.getElementById('docsConnectBtn');
    const disconnectBtn = () => document.getElementById('docsDisconnectBtn');

    let popup = null;

    function paint(state) {
        const badge = dot();
        if (!badge) return;

        if (state.checking) {
            badge.className = 'badge badge-neutral';
            badge.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin badge-dot"></i>Checking';
            detail().textContent = '';
            connectBtn().hidden = true;
            disconnectBtn().hidden = true;
            return;
        }

        if (state.connected) {
            badge.className = 'badge badge-good';
            badge.innerHTML = '<i class="fa-solid fa-circle-check badge-dot"></i>Connected';
            detail().textContent = state.connected_at
                ? `since ${window.formatTime(state.connected_at, { dateStyle: 'medium' })}`
                : '';
        } else {
            badge.className = 'badge badge-neutral';
            badge.innerHTML = '<i class="fa-solid fa-circle badge-dot"></i>Not connected';
            detail().textContent = state.error || 'The assistant will answer from your data only.';
        }
        connectBtn().hidden = state.connected;
        disconnectBtn().hidden = !state.connected;
    }

    async function refresh() {
        if (!document.getElementById('docsStatusDot')) return;
        paint({ checking: true });
        try {
            const res = await window.fetchWithAuth('/api/integrations/docs');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            paint(await res.json());
        } catch (err) {
            paint({ connected: false, error: `Could not check: ${err.message}` });
        }
    }

    window.connectDocs = async function () {
        const btn = connectBtn();
        if (btn) btn.disabled = true;
        try {
            const res = await window.fetchWithAuth('/api/integrations/docs/connect', { method: 'POST' });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

            // Opened before any further await would have a chance to run: a
            // popup opened outside the click's own call stack is the one a
            // browser blocks.
            popup = window.open(body.url, 'n8n-docs-auth', 'width=520,height=720');
            if (!popup) {
                paint({ connected: false, error: 'Allow popups for this site, then try again.' });
            }
        } catch (err) {
            paint({ connected: false, error: err.message });
        } finally {
            if (btn) btn.disabled = false;
        }
    };

    window.disconnectDocs = async function () {
        const btn = disconnectBtn();
        if (btn) btn.disabled = true;
        try {
            await window.fetchWithAuth('/api/integrations/docs/disconnect', { method: 'POST' });
        } finally {
            if (btn) btn.disabled = false;
            refresh();
        }
    };

    // The popup tells us when it is done. Checked by origin, because a message
    // from anywhere else is somebody else's page talking to ours.
    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin) return;
        if (event.data === 'docs-connected') refresh();
    });

    // The belt to that braces: a blocked popup becomes a tab, and a tab closing
    // sends no message. Coming back to this page re-checks.
    window.addEventListener('focus', () => {
        if (popup && popup.closed) {
            popup = null;
            refresh();
        }
    });

    document.addEventListener('settings:section', (event) => {
        if (event.detail && event.detail.section === 'assistant') refresh();
    });

    document.addEventListener('DOMContentLoaded', () => {
        // Only if the section is the one being shown; otherwise the
        // `settings:section` event above covers it when it is opened.
        if (window.location.hash.includes('assistant')) refresh();
    });
})();
