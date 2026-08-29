/**
 * What an alert rule and an alert channel are allowed to say (F-13, F-14).
 *
 * Pure — no I/O — so the same definitions drive the API validation, the
 * evaluation engine and the form the user fills in. That last part is the point:
 * the UI reads this vocabulary rather than restating it, so a rule type cannot
 * exist in the engine and be missing from the form, or appear in the form with
 * the wrong units next to it.
 */

/**
 * Every rule type, with what its threshold means and what it is measured on.
 *
 * `unit` and `hint` are shipped to the front end verbatim. A threshold field
 * labelled just "Threshold" is a trap — 5 could be five percent, five seconds or
 * five executions, and the difference between those is an alert that never fires
 * and one that fires every minute.
 */
const RULE_TYPES = {
    new_fingerprint: {
        label: 'A failure nobody has seen before',
        description: 'Fires the first time a distinct kind of error appears. ' +
            'Everything else on the error page has been happening for a while; this has not.',
        // No threshold: novelty is not a quantity.
        threshold: null,
        subject: 'fingerprint',
        defaults: { window_minutes: 60, cooldown_minutes: 1440, min_executions: 1 }
    },
    error_rate: {
        label: 'Error rate above a percentage',
        description: 'Fires when a workflow fails more often than this over the window. ' +
            'Measured on first attempts, so retries do not flatter or inflate it.',
        threshold: { unit: '%', min: 0.1, max: 100, hint: 'percent of executions that failed' },
        subject: 'workflow',
        defaults: { window_minutes: 60, cooldown_minutes: 120, min_executions: 20 }
    },
    silent_death: {
        label: 'An active workflow stopped running',
        description: 'Fires when a workflow is overdue by this many times its own usual interval. ' +
            'Measured against the freshest synced data, never the clock, so a stalled sync ' +
            'cannot make every scheduled workflow look dead.',
        threshold: { unit: '×', min: 1.5, max: 100, hint: 'multiples of its usual gap between runs' },
        subject: 'workflow',
        defaults: { window_minutes: 60, cooldown_minutes: 720, min_executions: 5 }
    },
    queue_lag: {
        label: 'Executions waiting too long to start',
        description: 'Fires when the 95th percentile wait between an execution being created ' +
            'and starting exceeds this. The first thing to move when workers run short.',
        threshold: { unit: 'ms', min: 1, max: 3600000, hint: 'p95 wait in milliseconds' },
        subject: 'instance',
        defaults: { window_minutes: 60, cooldown_minutes: 120, min_executions: 50 }
    },
    volume_drop: {
        label: 'Traffic fell off a cliff',
        description: 'Fires when executions in the window drop below this percentage of the ' +
            'preceding window. Catches an upstream that stopped calling, which no error ever reports.',
        threshold: { unit: '%', min: 1, max: 99, hint: 'percent of the previous window, below which to fire' },
        subject: 'instance',
        defaults: { window_minutes: 60, cooldown_minutes: 180, min_executions: 50 }
    },
    payload_spike: {
        label: 'Executions suddenly got much larger',
        description: 'Fires when the average payload per execution grows to this multiple of ' +
            'the preceding window. Usually means a workflow started returning far more than it should.',
        threshold: { unit: '×', min: 1.2, max: 100, hint: 'multiples of the previous window average' },
        subject: 'workflow',
        defaults: { window_minutes: 1440, cooldown_minutes: 1440, min_executions: 20 }
    },
    db_growth: {
        label: 'The n8n database is heading past a size',
        description: 'Fires when the projected settling point of the execution data exceeds this. ' +
            'Uses the measured retention horizon, so a store that is pruning is not reported as growing.',
        threshold: { unit: 'GB', min: 0.1, max: 10000, hint: 'gigabytes of retained execution payload' },
        subject: 'instance',
        defaults: { window_minutes: 1440, cooldown_minutes: 1440, min_executions: 1 }
    }
};

/**
 * Every channel type, with the fields it needs.
 *
 * `secret: true` marks a field the API must never read back. The front end shows
 * a placeholder for those and only sends a new value when the user types one, so
 * editing a channel's name cannot wipe its token.
 */
const CHANNEL_TYPES = {
    webhook: {
        label: 'Webhook (JSON POST)',
        description: 'Posts the alert as JSON to any URL. Works with everything.',
        fields: [
            { key: 'url', label: 'URL', type: 'url', required: true },
            { key: 'header_name', label: 'Extra header name', type: 'text', required: false },
            { key: 'header_value', label: 'Extra header value', type: 'text', required: false, secret: true }
        ]
    },
    n8n_workflow: {
        label: 'Trigger an n8n workflow',
        description: 'Posts to an n8n webhook so n8n decides what to do with it — ' +
            'send an email, open a ticket, message a channel. No new dependency here, ' +
            'and every integration n8n already has becomes an alert channel.',
        fields: [
            { key: 'url', label: 'n8n webhook URL', type: 'url', required: true },
            { key: 'header_name', label: 'Auth header name', type: 'text', required: false },
            { key: 'header_value', label: 'Auth header value', type: 'text', required: false, secret: true }
        ]
    },
    telegram: {
        label: 'Telegram',
        description: 'Sends a message through a Telegram bot.',
        fields: [
            { key: 'bot_token', label: 'Bot token', type: 'text', required: true, secret: true },
            { key: 'chat_id', label: 'Chat ID', type: 'text', required: true }
        ]
    }
};

const MAX_NAME = 80;
const MAX_WINDOW_MINUTES = 60 * 24 * 30;
const MAX_COOLDOWN_MINUTES = 60 * 24 * 30;

function isPlainString(v, max) {
    return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function intIn(value, min, max, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) return null;
    return n;
}

/**
 * Validates a rule as submitted by the form.
 *
 * Returns { ok: true, value } with every field normalised, or { ok: false,
 * error } naming the field and why. The threshold check is per type, because a
 * percentage and a multiplier have different sane ranges and a rule with a
 * nonsense threshold is worse than no rule: it either never fires, or fires
 * constantly and teaches everyone to ignore it.
 */
function validateRule(input) {
    if (!input || typeof input !== 'object') return { ok: false, error: 'A rule object is required.' };

    if (!isPlainString(input.name, MAX_NAME)) {
        return { ok: false, error: `name is required and must be at most ${MAX_NAME} characters.` };
    }
    const spec = RULE_TYPES[input.type];
    if (!spec) {
        return {
            ok: false,
            error: `Unknown rule type "${String(input.type).slice(0, 40)}". ` +
                `Allowed: ${Object.keys(RULE_TYPES).join(', ')}.`
        };
    }

    let threshold = null;
    if (spec.threshold) {
        const n = Number(input.threshold);
        if (!Number.isFinite(n) || n < spec.threshold.min || n > spec.threshold.max) {
            return {
                ok: false,
                error: `threshold for ${input.type} must be between ${spec.threshold.min} and ` +
                    `${spec.threshold.max} ${spec.threshold.unit} (${spec.threshold.hint}).`
            };
        }
        threshold = n;
    }

    const windowMinutes = intIn(input.window_minutes, 1, MAX_WINDOW_MINUTES, spec.defaults.window_minutes);
    if (windowMinutes === null) {
        return { ok: false, error: `window_minutes must be between 1 and ${MAX_WINDOW_MINUTES}.` };
    }
    const cooldown = intIn(input.cooldown_minutes, 0, MAX_COOLDOWN_MINUTES, spec.defaults.cooldown_minutes);
    if (cooldown === null) {
        return { ok: false, error: `cooldown_minutes must be between 0 and ${MAX_COOLDOWN_MINUTES}.` };
    }
    const minExecutions = intIn(input.min_executions, 1, 1000000, spec.defaults.min_executions);
    if (minExecutions === null) {
        return { ok: false, error: 'min_executions must be a positive whole number.' };
    }

    // Scope ids come from pickers populated by this server, so anything that is
    // not a plain n8n id is a mistake rather than a choice.
    const ID = /^[A-Za-z0-9_-]{1,64}$/;
    for (const key of ['workflow_id', 'folder_id', 'tag_id']) {
        const v = input[key];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v !== 'string' || !ID.test(v)) {
            return { ok: false, error: `${key} is not a valid id.` };
        }
    }

    const channelId = input.channel_id === undefined || input.channel_id === null ||
        input.channel_id === '' ? null : Number(input.channel_id);
    if (channelId !== null && !Number.isInteger(channelId)) {
        return { ok: false, error: 'channel_id must be a channel.' };
    }

    return {
        ok: true,
        value: {
            name: input.name.trim(),
            type: input.type,
            enabled: input.enabled === false || input.enabled === 0 ? 0 : 1,
            workflow_id: input.workflow_id || null,
            folder_id: input.folder_id || null,
            tag_id: input.tag_id || null,
            threshold,
            window_minutes: windowMinutes,
            min_executions: minExecutions,
            channel_id: channelId,
            cooldown_minutes: cooldown
        }
    };
}

// Where an outbound alert may not be sent.
//
// A channel URL is a request this server makes on behalf of whoever configured
// it. Only owners and admins can configure one, so this is not a privilege
// boundary — it is a guard against the obvious misuse and against a typo that
// turns an alert into a request at something that should never receive one.
//
// Link-local is refused unconditionally: 169.254.169.254 is the cloud metadata
// endpoint on every major provider, and there is no deployment in which an alert
// legitimately goes there.
const ALWAYS_BLOCKED = [
    /^169\.254\./,
    /^\[?fe80:/i
];

// Everything else private — loopback included — is refused by DEFAULT and
// allowed by configuration. n8n very often runs on the same host or the same
// private network as this dashboard, so posting to it is the single most useful
// channel there is; refusing 127.0.0.1 outright would break a legitimate
// single-host deployment to prevent nothing in particular.
const PRIVATE_RANGES = [
    /^localhost$/i,
    /^127\./,
    /^0\.0\.0\.0$/,
    /^\[?::1\]?$/,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./
];

/**
 * Validates a delivery URL.
 *
 * n8n very often lives on the same private network as this dashboard, so
 * refusing private addresses outright would break the single most useful
 * channel — posting to an n8n webhook. ALERT_ALLOW_PRIVATE_TARGETS=true is the
 * documented way to allow it, and loopback and link-local stay refused either
 * way because neither is ever a legitimate destination for an alert.
 */
function validateUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    } catch {
        return { ok: false, error: 'That is not a valid URL.' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, error: 'Only http and https URLs can receive alerts.' };
    }
    const host = url.hostname;

    if (ALWAYS_BLOCKED.some((re) => re.test(host))) {
        return {
            ok: false,
            error: `${host} is a link-local address and can never receive an alert.`
        };
    }
    // Read per call rather than captured at import, so a test or a restart-free
    // config change takes effect without reloading the module.
    if (process.env.ALERT_ALLOW_PRIVATE_TARGETS !== 'true' &&
        PRIVATE_RANGES.some((re) => re.test(host))) {
        return {
            ok: false,
            error: `${host} is a private or loopback address. If your n8n is on the same ` +
                'host or network, set ALERT_ALLOW_PRIVATE_TARGETS=true to allow it.'
        };
    }
    return { ok: true, value: url.toString() };
}

/**
 * Validates a channel and its type-specific config.
 *
 * `existingConfig` is merged in for secret fields the caller left blank, so
 * renaming a channel does not silently erase its token — the front end never
 * receives the token to send back.
 */
function validateChannel(input, existingConfig = {}) {
    if (!input || typeof input !== 'object') return { ok: false, error: 'A channel object is required.' };
    if (!isPlainString(input.name, MAX_NAME)) {
        return { ok: false, error: `name is required and must be at most ${MAX_NAME} characters.` };
    }
    const spec = CHANNEL_TYPES[input.type];
    if (!spec) {
        return {
            ok: false,
            error: `Unknown channel type "${String(input.type).slice(0, 40)}". ` +
                `Allowed: ${Object.keys(CHANNEL_TYPES).join(', ')}.`
        };
    }

    const submitted = (input.config && typeof input.config === 'object') ? input.config : {};
    const config = {};

    for (const field of spec.fields) {
        let value = submitted[field.key];

        // A blank secret means "leave it as it was", not "clear it". The form
        // cannot send back what it was never given.
        if (field.secret && (value === undefined || value === null || value === '')) {
            value = existingConfig[field.key];
        }

        if (value === undefined || value === null || value === '') {
            if (field.required) return { ok: false, error: `${field.label} is required.` };
            continue;
        }
        if (typeof value !== 'string' || value.length > 2000) {
            return { ok: false, error: `${field.label} must be text of at most 2000 characters.` };
        }
        if (field.type === 'url') {
            const check = validateUrl(value);
            if (!check.ok) return { ok: false, error: `${field.label}: ${check.error}` };
            value = check.value;
        }
        config[field.key] = value;
    }

    return {
        ok: true,
        value: {
            name: input.name.trim(),
            type: input.type,
            enabled: input.enabled === false || input.enabled === 0 ? 0 : 1,
            config
        }
    };
}

/** Strips every field marked secret, for anything travelling back to a browser. */
function redactConfig(type, config) {
    const spec = CHANNEL_TYPES[type];
    if (!spec) return {};
    const out = {};
    for (const field of spec.fields) {
        const value = config ? config[field.key] : undefined;
        if (value === undefined || value === null || value === '') continue;
        // Present-but-hidden rather than absent, so the form can show that a
        // token exists without ever holding it.
        out[field.key] = field.secret ? '••••••••' : value;
    }
    return out;
}

module.exports = {
    RULE_TYPES,
    CHANNEL_TYPES,
    validateRule,
    validateChannel,
    validateUrl,
    redactConfig
};
