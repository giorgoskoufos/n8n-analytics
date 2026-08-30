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
 * Money, in the currency this deployment configured.
 *
 * Here rather than in roi.js because it was in roi.js, hard-coded to USD, while
 * the settings page asked for an hourly rate with a `$` printed beside the box —
 * two files independently deciding what currency a number is in, and both
 * deciding wrong for anybody outside the United States. There is no conversion:
 * the rate somebody typed is taken to be in the configured currency, which is
 * the only honest reading available to a dashboard holding no exchange rates.
 *
 * `narrow` gives the symbol alone (€12.00) for tight places like a table cell;
 * the default gives whatever the locale thinks is unambiguous.
 */
window.formatMoney = (amount, { narrow = false, decimals = 2 } = {}) => {
    const value = Number(amount);
    const currency = (window.userSettings && window.userSettings.currency) || 'EUR';
    try {
        return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency,
            currencyDisplay: narrow ? 'narrowSymbol' : 'symbol',
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        }).format(Number.isFinite(value) ? value : 0);
    } catch {
        // An unknown code, or a browser without narrowSymbol. Better a number
        // with a code in front of it than a page that throws while rendering a
        // table cell.
        return `${currency} ${(Number.isFinite(value) ? value : 0).toFixed(decimals)}`;
    }
};

/** Just the symbol, for a label that sits beside an input rather than in it. */
window.currencySymbol = () => {
    const currency = (window.userSettings && window.userSettings.currency) || 'EUR';
    try {
        return new Intl.NumberFormat(undefined, {
            style: 'currency', currency, currencyDisplay: 'narrowSymbol',
            minimumFractionDigits: 0, maximumFractionDigits: 0
        }).formatToParts(0).find((part) => part.type === 'currency')?.value || currency;
    } catch {
        return currency;
    }
};

/**
 * Seconds as the largest two units that are not zero.
 *
 * "2d 4h", not "2d 4h 13m 6s". Somebody reading a total of saved time is asking
 * how big it is, and the third unit is never the part that answers that — while
 * four of them turn a KPI into something you have to parse rather than read.
 */
window.formatDuration = (totalSeconds) => {
    let secs = Math.max(0, Math.round(Number(totalSeconds) || 0));
    if (secs === 0) return '0m';

    const units = [
        ['d', 86400], ['h', 3600], ['m', 60], ['s', 1]
    ];
    const parts = [];
    for (const [suffix, size] of units) {
        const n = Math.floor(secs / size);
        if (n > 0 || parts.length > 0) {
            if (n > 0) parts.push(`${n}${suffix}`);
            secs -= n * size;
        }
        if (parts.length === 2) break;
    }
    return parts.length ? parts.join(' ') : '0m';
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
    'setFingerprintStatus',
    // App shell (F-24 §2)
    'toggleNavCollapse', 'openNavDrawer', 'closeNavDrawer',
    // Error intelligence (F-24 §3)
    'filterRelabelled', 'clearErrorFilters',
    // Alert channel headers and cURL (F-24 §4)
    'addAlertHeader', 'removeAlertHeader', 'importAlertCurl', 'exportAlertCurl',
    // Settings navigation (F-24 §2)
    'showSettingsSection', 'showInsightsGroup',
    // ROI: the two tabs, and the retry in a failed table row
    'showRoiSection',
    // Integrations (H-06 · the documentation service)
    'connectDocs', 'disconnectDocs',
    // The assistant's own provider credentials
    'saveAiConfig', 'clearAiKey',
    // Trace panel, now on the Slowest tab too (F-24 §5)
    'openTrace', 'closeTraceModal'
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

// `renderMarkdownSafely` lived here and had exactly one caller, the assistant.
// It is `logic/chat/render.js` now — not moved, replaced: its policy was
// `ALLOWED_ATTR: []`, which is the right setting for untrusted markdown in
// general and makes syntax highlighting unreachable in particular, since a
// highlighter's entire output is `<span class="...">`. The widened policy, and
// the argument for each thing it widens, is in that file.

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
