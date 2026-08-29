// ==========================================
// Global Utility Functions - n8n Analytics
// ==========================================

/**
 * Escapes a value for safe interpolation into an HTML template string.
 *
 * Every value that reaches the DOM through innerHTML must pass through this.
 * Workflow names, node names and error messages all originate from n8n and are
 * controlled by anyone with editor access there — an unescaped one becomes script
 * execution in this page, which can read the auth token out of localStorage.
 */
window.escapeHtml = function (unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return String(unsafe)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

// ==========================================
// Time — one clock for the whole dashboard
// ==========================================
//
// Everything the backend stores and returns is ISO-8601 UTC, without exception.
// That is not incidental: the indexes work because lexicographic order on those
// strings IS chronological order, and a timezone anywhere in the SQL would cost
// that. So the timezone setting is a *rendering* preference, applied here and
// nowhere else, and the backend never reads it.
//
// This lives in global_functions.js rather than app/app_globals.js because
// errors.html does not load app.js at all — so the setting simply did not exist
// on the one page whose whole content is timestamps. Same move escapeHtml made
// in B-05, for the same reason: one implementation, every page.

window.userSettings = { timezone: 'auto' };

/**
 * Formats a UTC timestamp in the dashboard's configured timezone.
 *
 * 'auto' means the viewer's own browser zone. Any other value is an IANA name
 * validated server-side against Intl before it was allowed to be stored.
 */
window.formatTime = (utcStr, options = {}) => {
    if (!utcStr) return 'N/A';

    // A value with no offset is UTC — that is what the API sends. Left alone, the
    // browser reads 'YYYY-MM-DDTHH:MM:SS' as LOCAL time and every timestamp on the
    // page silently shifts by the viewer's offset.
    const dateStr = (utcStr.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(utcStr)) ? utcStr : (utcStr + 'Z');
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return 'N/A';

    return date.toLocaleString('en-US', {
        timeZone: window.userSettings.timezone === 'auto' ? undefined : window.userSettings.timezone,
        hour12: false,
        hourCycle: 'h23',       // 24-hour, so 01:00 and 13:00 can never be confused
        ...options
    });
};

/**
 * Loads the dashboard settings once per page.
 *
 * Memoised and exposed as a promise: several scripts on the same page want the
 * timezone before they render, and each of them awaiting the same promise costs
 * one request instead of one per caller. A failure resolves rather than rejects
 * — an unreachable settings endpoint should fall back to the browser's zone, not
 * stop the page from rendering.
 */
let settingsPromise = null;
window.initSettings = function () {
    if (!settingsPromise) {
        settingsPromise = window.fetchWithAuth('/api/settings')
            .then((res) => (res.ok ? res.json() : null))
            .then((s) => {
                if (s && s.timezone) window.userSettings = s;
                return window.userSettings;
            })
            .catch(() => window.userSettings);
    }
    return settingsPromise;
};

// Started at load so it is almost always resolved by the time anything renders;
// callers that must be certain await window.settingsReady.
window.settingsReady = window.initSettings();

/**
 * Declarative click dispatcher.
 *
 * Replaces every inline `onclick="fn(arg)"` with `data-action="fn" data-arg="arg"`.
 * Inline handlers are what forced `script-src 'unsafe-inline'` into the CSP, and
 * that directive is exactly what makes an escaping mistake escalate into script
 * execution. With them gone the CSP can refuse inline script outright.
 *
 * Only names listed here can be dispatched, so a stray data-action in injected
 * markup cannot reach an arbitrary global.
 */
const DISPATCHABLE_ACTIONS = [
    'toggleChat', 'switchTab', 'applyPreset', 'setConcPreset', 'closeDetailsModal',
    'logout', 'forceDbSync', 'setErrorRange', 'closeWindow', 'loadRoiMetrics',
    'copyErrorMessage', 'closeErrorModal', 'clearExecFilters', 'applyExecFilters',
    'setInsightsRange', 'toggleArchived',
    // Alerts page (F-13 / F-14)
    'newAlertRule', 'editAlertRule', 'deleteAlertRule', 'toggleAlertRule',
    'newAlertChannel', 'editAlertChannel', 'deleteAlertChannel', 'toggleAlertChannel',
    'testAlertChannel', 'runAlertsNow', 'closeAlertEditor', 'saveAlertEditor',
    // Error lifecycle (F-15)
    'setFingerprintStatus'
];

window.closeWindow = function () { window.close(); };

document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el) return;

    const action = el.getAttribute('data-action');
    if (!DISPATCHABLE_ACTIONS.includes(action)) {
        console.warn(`[ACTION] Refusing to dispatch unknown action: ${action}`);
        return;
    }

    const handler = window[action];
    if (typeof handler !== 'function') {
        console.warn(`[ACTION] Handler not loaded on this page: ${action}`);
        return;
    }

    const raw = el.getAttribute('data-arg');
    if (raw === null) {
        handler();
    } else {
        // Numeric arguments (hour ranges, presets) must stay numbers — the original
        // inline handlers passed them as literals, not strings.
        const numeric = Number(raw);
        handler(raw !== '' && !Number.isNaN(numeric) ? numeric : raw);
    }
});

/**
 * Renders markdown to sanitized HTML.
 *
 * marked passes HTML in its input straight through to the output, so its result
 * must never reach innerHTML unsanitized. Falls back to plain escaped text if
 * either library failed to load, so a CDN or file error degrades to unformatted
 * text rather than to an injection point.
 */
window.renderMarkdownSafely = function (text) {
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
        console.warn('[SECURITY] marked or DOMPurify unavailable — rendering as plain text.');
        return window.escapeHtml(text);
    }
    return DOMPurify.sanitize(marked.parse(text), {
        ALLOWED_TAGS: [
            'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
            'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'span'
        ],
        ALLOWED_ATTR: [], // no href, no src, no style — nothing to hang a payload on
        FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input', 'a', 'img']
    });
};

/**
 * Global Manual Sync Trigger
 * Controls the Sync button state and triggers backend ETL.
 */
window.forceDbSync = async function() {
    const btn = document.getElementById('syncBtn');
    const icon = document.getElementById('syncIcon');
    
    // UI Feedback: Start
    if (btn) btn.disabled = true;
    if (icon) icon.classList.add('fa-spin-pulse');

    try {
        const res = await window.fetchWithAuth('/api/sync/force', { method: 'POST' });
        
        if (res.ok) {
            // Success: Reload to show fresh data
            window.location.reload();
        } else {
            const errData = await res.json().catch(() => ({}));
            alert('Sync failed: ' + (errData.error || 'Check server logs.'));
        }
    } catch (e) {
        console.error("[SYNC] Manual trigger failed:", e);
    } finally {
        // UI Feedback: End (only if reload didn't happen)
        if (btn) btn.disabled = false;
        if (icon) icon.classList.remove('fa-spin-pulse');
    }
};
