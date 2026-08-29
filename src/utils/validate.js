// Request validation helpers.
//
// `new Date('foo').toISOString()` throws a RangeError, so a single mistyped
// query string turned into a 500 and a stack trace in the logs. These endpoints
// are driven by a date picker, but nothing stops anyone from calling them
// directly — and a malformed input is the caller's mistake, not a server fault.

// Outside this range the value is not a date anyone meant to send. Catching it
// here stops a typo like "202-01-01" from being silently accepted as year 202
// and quietly returning nothing.
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/**
 * Returns a Date, or null if the value is not a usable date.
 * Never throws — that is the whole point.
 */
function parseIsoDate(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' && !(value instanceof Date)) return null;

    const str = typeof value === 'string' ? value.trim() : value;
    if (str === '') return null;

    const d = new Date(str);
    if (Number.isNaN(d.getTime())) return null;

    const year = d.getUTCFullYear();
    if (year < MIN_YEAR || year > MAX_YEAR) return null;

    return d;
}

/**
 * Validates an optional start/end pair.
 *
 * Returns { ok: true, start, end } when both are present and sane, or
 * { ok: true, start: null, end: null } when neither is given, so the caller can
 * apply its own default. Returns { ok: false, error } when the input is wrong,
 * with a message that says which field and why.
 */
function parseDateRange(startValue, endValue) {
    const hasStart = startValue !== undefined && startValue !== null && startValue !== '';
    const hasEnd = endValue !== undefined && endValue !== null && endValue !== '';

    if (!hasStart && !hasEnd) return { ok: true, start: null, end: null };

    if (hasStart !== hasEnd) {
        return { ok: false, error: 'startDate and endDate must be provided together.' };
    }

    const start = parseIsoDate(startValue);
    const end = parseIsoDate(endValue);

    if (!start) return { ok: false, error: `startDate is not a valid date: ${String(startValue).slice(0, 60)}` };
    if (!end) return { ok: false, error: `endDate is not a valid date: ${String(endValue).slice(0, 60)}` };

    // A reversed range is not an error the database can report — it just returns
    // nothing, which reads as "no data" instead of "you asked backwards".
    if (start.getTime() > end.getTime()) {
        return { ok: false, error: 'startDate must be before endDate.' };
    }

    return { ok: true, start, end };
}

// --- Execution mode ---
//
// n8n's ExecutionMode union. Every endpoint that accepts a ?mode= filter
// validates against this rather than binding the value straight into the query.
// It is a bound parameter either way, so this is not about injection: an
// unrecognised mode matches nothing, and an empty chart looks exactly like a
// quiet day. A 400 says which of the two it is.
const EXECUTION_MODES = [
    'cli', 'error', 'evaluation', 'integrated', 'internal', 'manual', 'retry', 'trigger', 'webhook'
];

/**
 * Validates an optional ?mode= filter.
 *
 * Absent is valid and means "every mode" — the filter is optional on every
 * endpoint that takes it.
 */
function parseExecutionMode(value) {
    if (value === undefined || value === null || value === '') return { ok: true, mode: null };
    if (typeof value !== 'string' || !EXECUTION_MODES.includes(value)) {
        return {
            ok: false,
            error: `Unknown execution mode "${String(value).slice(0, 32)}". ` +
                `Allowed: ${EXECUTION_MODES.join(', ')}.`
        };
    }
    return { ok: true, mode: value };
}

// --- Global dashboard settings ---
//
// POST /api/settings used to write any key with any value. The table is small
// and read at boot by every page, so an unbounded key/value store behind a
// single authenticated call is both a storage hole and a way to poison what the
// frontend reads back. An allowlist also documents what settings exist, which
// nothing else in the codebase did.

function isValidTimeZone(tz) {
    if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
    try {
        // The only authoritative check available: ask Intl to use it.
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * n8n's own concurrency ceiling, if the operator chooses to tell us.
 *
 * It lives in N8N_CONCURRENCY_PRODUCTION_LIMIT on a different process, so the
 * dashboard cannot read it and will not pretend to. Given it, F-06 can say how
 * much headroom is left; without it, it reports the peak and stops there.
 * An empty string clears it — otherwise a limit set once could never be unset.
 */
function isValidConcurrencyLimit(v) {
    if (v === '') return true;
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 10000;
}

const ALLOWED_SETTINGS = {
    timezone: {
        check: isValidTimeZone,
        hint: 'an IANA time zone name, for example Europe/Athens'
    },
    concurrency_limit: {
        check: isValidConcurrencyLimit,
        hint: 'a whole number of concurrent executions between 1 and 10000, or empty to clear'
    }
};

/**
 * Validates one global setting. Returns { ok } or { ok: false, error }.
 */
function validateSetting(key, value) {
    if (typeof key !== 'string' || key === '') {
        return { ok: false, error: 'A setting key is required.' };
    }
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_SETTINGS, key)) {
        return {
            ok: false,
            error: `Unknown setting "${key}". Allowed: ${Object.keys(ALLOWED_SETTINGS).join(', ')}.`
        };
    }
    const spec = ALLOWED_SETTINGS[key];
    if (!spec.check(value)) {
        return { ok: false, error: `Invalid value for "${key}" — expected ${spec.hint}.` };
    }
    return { ok: true };
}

// --- ROI settings ---

// Upper bounds are sanity limits, not policy: 24h of saved time per run and a
// five-figure hourly rate are already far past anything real, and without them a
// typo silently turns into a nonsense ROI figure on the dashboard.
const MAX_SAVED_SECONDS = 24 * 3600;
const MAX_HOURLY_RATE = 100000;

function validateRoiEntry(entry) {
    if (!entry || typeof entry !== 'object') {
        return { ok: false, error: 'Each ROI setting must be an object.' };
    }
    if (typeof entry.workflow_id !== 'string' || entry.workflow_id === '') {
        return { ok: false, error: 'workflow_id is required on every ROI setting.' };
    }

    const seconds = Number(entry.saved_time_seconds);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_SAVED_SECONDS) {
        return {
            ok: false,
            error: `saved_time_seconds for ${entry.workflow_id} must be between 0 and ${MAX_SAVED_SECONDS}.`
        };
    }

    const rate = entry.hourly_rate === undefined || entry.hourly_rate === null
        ? 0 : Number(entry.hourly_rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > MAX_HOURLY_RATE) {
        return {
            ok: false,
            error: `hourly_rate for ${entry.workflow_id} must be between 0 and ${MAX_HOURLY_RATE}.`
        };
    }

    return { ok: true, value: { workflow_id: entry.workflow_id, saved_time_seconds: seconds, hourly_rate: rate } };
}

module.exports = {
    parseIsoDate,
    parseDateRange,
    parseExecutionMode,
    validateSetting,
    validateRoiEntry,
    ALLOWED_SETTINGS,
    EXECUTION_MODES
};
