/**
 * Alert rules, channels, events and fingerprint triage.
 *
 * Same rule as the other DAOs — domain values in, data out, no `req`, no status
 * codes — and here for the same reason: the SQL should live in one place
 * whoever is asking.
 *
 * Nothing in this file is exposed to the AI assistant. Alert channels hold
 * delivery secrets and the triage tables record who decided what; neither is
 * analytics. That is a decision about which DAOs the assistant may call, kept
 * separate from where the queries live.
 */

const localDb = require('../config/localDb');
const alertEngine = require('../config/alertEngine');
const {
    ALERT_SOURCE, validateRule, validateChannel, redactConfig, readHeaders, SECRET_MASK
} = require('../utils/alertValidation');
const { toCurl } = require('../utils/curl');
const { daoError } = require('./shared');

async function channelExists(id) {
    const r = await localDb.query('SELECT 1 FROM alert_channels WHERE id = ?', [id]);
    return r.rows.length > 0;
}

const LIFECYCLE_ACTIONS = {
    acknowledge: 'acknowledged',
    resolve: 'resolved',
    ignore: 'ignored',
    reopen: 'open'
};


/** Alert rules with their channel and firing history. */
async function listRules() {
    const rows = await localDb.query(
        `SELECT r.*, c.name AS channel_name, c.type AS channel_type, c.enabled AS channel_enabled,
                (SELECT MAX(e.fired_at) FROM alert_events e WHERE e.rule_id = r.id) AS last_fired,
                (SELECT COUNT(*) FROM alert_events e WHERE e.rule_id = r.id) AS times_fired
           FROM alert_rules r
           LEFT JOIN alert_channels c ON c.id = r.channel_id
          ORDER BY r.enabled DESC, r.name COLLATE NOCASE`
    );
    return (rows.rows);
}

/** Creates one alert rule. */
async function createRule({ id, body, actorEmail }) {
    const check = validateRule(body);
    if (!check.ok) throw daoError(400, check.error);
    const v = check.value;
    if (v.channel_id !== null && !(await channelExists(v.channel_id))) {
        throw daoError(400, 'That channel does not exist.');
    }
    const now = new Date().toISOString();
    const r = await localDb.execute(
        `INSERT INTO alert_rules
            (name, type, enabled, workflow_id, folder_id, tag_id, threshold,
             window_minutes, min_executions, channel_id, cooldown_minutes,
             created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [v.name, v.type, v.enabled, v.workflow_id, v.folder_id, v.tag_id, v.threshold,
            v.window_minutes, v.min_executions, v.channel_id, v.cooldown_minutes,
            now, now, actorEmail]
    );
    return ({ id: r.lastID });
}

/** Updates one alert rule. */
async function updateRule({ id, body }) {
    if (!Number.isInteger(id)) throw daoError(400, 'Invalid rule id');
    const check = validateRule(body);
    if (!check.ok) throw daoError(400, check.error);
    const v = check.value;
    if (v.channel_id !== null && !(await channelExists(v.channel_id))) {
        throw daoError(400, 'That channel does not exist.');
    }
    const r = await localDb.execute(
        `UPDATE alert_rules
            SET name = ?, type = ?, enabled = ?, workflow_id = ?, folder_id = ?, tag_id = ?,
                threshold = ?, window_minutes = ?, min_executions = ?, channel_id = ?,
                cooldown_minutes = ?, updated_at = ?
          WHERE id = ?`,
        [v.name, v.type, v.enabled, v.workflow_id, v.folder_id, v.tag_id, v.threshold,
            v.window_minutes, v.min_executions, v.channel_id, v.cooldown_minutes,
            new Date().toISOString(), id]
    );
    if (r.changes === 0) throw daoError(404, 'Rule not found');
    return ({ message: 'Rule updated' });
}

/** Deletes one alert rule. */
async function deleteRule({ id }) {
    if (!Number.isInteger(id)) throw daoError(400, 'Invalid rule id');
    const r = await localDb.execute('DELETE FROM alert_rules WHERE id = ?', [id]);
    if (r.changes === 0) throw daoError(404, 'Rule not found');
    // The events it produced are deliberately kept. "Why was I told this?"
    // has to remain answerable after the rule is gone; alert_events carries
    // the rule's name for exactly that reason.
    return ({ message: 'Rule deleted' });
}

/** Notification channels, with secrets redacted. */
async function listChannels() {
    const rows = await localDb.query(
        `SELECT c.*, (SELECT COUNT(*) FROM alert_rules r WHERE r.channel_id = c.id) AS rules
           FROM alert_channels c ORDER BY c.name COLLATE NOCASE`
    );
    return (rows.rows.map((c) => ({
        ...c,
        // Never the real value. The form shows dots and only sends a
        // replacement when one is typed.
        config: redactConfig(c.type, JSON.parse(c.config || '{}'))
    })));
}

/** Creates one notification channel. */
async function createChannel({ id, body }) {
    const check = validateChannel(body);
    if (!check.ok) throw daoError(400, check.error);
    const v = check.value;
    const now = new Date().toISOString();
    const r = await localDb.execute(
        `INSERT INTO alert_channels (name, type, config, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [v.name, v.type, JSON.stringify(v.config), v.enabled, now, now]
    );
    return ({ id: r.lastID });
}

/** Updates one channel, carrying over secrets left blank. */
async function updateChannel({ id, body, caller }) {
    if (!Number.isInteger(id)) throw daoError(400, 'Invalid channel id');
    const existing = await localDb.query('SELECT config FROM alert_channels WHERE id = ?', [id]);
    if (existing.rows.length === 0) throw daoError(404, 'Channel not found');

    // Secrets the caller left blank are carried over. Without this, renaming
    // a channel would wipe its token — the form never had the token to
    // send back, so a blank field means "unchanged", not "empty".
    const check = validateChannel(body, JSON.parse(existing.rows[0].config || '{}'));
    if (!check.ok) throw daoError(400, check.error);

    const v = check.value;
    await localDb.execute(
        `UPDATE alert_channels
            SET name = ?, type = ?, config = ?, enabled = ?, updated_at = ?
          WHERE id = ?`,
        [v.name, v.type, JSON.stringify(v.config), v.enabled, new Date().toISOString(), id]
    );
    return ({ message: 'Channel updated' });
}

/** One channel as a cURL command, with values masked. */
async function exportChannelCurl({ id, body }) {
    if (!Number.isInteger(id)) throw daoError(400, 'Invalid channel id');
    const r = await localDb.query('SELECT * FROM alert_channels WHERE id = ?', [id]);
    if (r.rows.length === 0) throw daoError(404, 'Channel not found');
    const channel = r.rows[0];
    const config = JSON.parse(channel.config || '{}');

    if (channel.type === 'telegram') {
        throw daoError(400, 'Telegram channels are delivered through the Telegram API, not a plain webhook, ' +
                'so there is no equivalent command. Use Test to send a real message.');
    }

    const headers = readHeaders(config).map((h) => ({ name: h.name, value: SECRET_MASK }));
    const command = toCurl({
        url: config.url,
        headers,
        method: 'POST',
        body: {
            source: ALERT_SOURCE,
            rule: 'Example rule',
            title: 'Example alert',
            body: 'This is the shape of what this channel receives.',
            subject: 'workflow',
            subject_label: 'Example workflow',
            fired_at: new Date().toISOString(),
            link: null,
            data: {}
        }
    });

    return ({
        command,
        redacted: headers.length > 0,
        note: headers.length
            ? 'Header values are masked. Replace them before running this — the dashboard never ' +
              'reads a stored secret back. To check the channel end to end, use Test instead.'
            : 'This channel sends no custom headers, so the command is complete as written.'
    });
}

/** Deletes one notification channel. */
async function deleteChannel({ id }) {
    if (!Number.isInteger(id)) throw daoError(400, 'Invalid channel id');
    const r = await localDb.execute('DELETE FROM alert_channels WHERE id = ?', [id]);
    if (r.changes === 0) throw daoError(404, 'Channel not found');
    // Rules pointing at it survive with channel_id NULL — they keep
    // evaluating and their events are recorded as 'no_channel', which is
    // visible in the feed. Deleting the rules too would be a surprising
    // amount of destruction from one click.
    return ({ message: 'Channel deleted' });
}

/** Sends a test notification to one channel. */
async function testChannel({ id, body, caller }) {
    if (!Number.isInteger(id)) throw daoError(400, 'Invalid channel id');
    const rows = await localDb.query('SELECT * FROM alert_channels WHERE id = ?', [id]);
    if (rows.rows.length === 0) throw daoError(404, 'Channel not found');
    const channel = rows.rows[0];

    const result = await alertEngine.deliver(channel, {
        rule_name: 'Test',
        title: 'Test alert from the n8n dashboard',
        body: 'If you are reading this, the channel works. Nothing is wrong.',
        subject: 'test',
        subject_label: 'Test',
        fired_at: new Date().toISOString(),
        payload: JSON.stringify({ test: true })
    });

    await localDb.execute(
        result.ok
            ? 'UPDATE alert_channels SET last_ok_at = ?, last_error = NULL WHERE id = ?'
            : 'UPDATE alert_channels SET last_error = ?, last_error_at = ? WHERE id = ?',
        result.ok
            ? [new Date().toISOString(), id]
            : [String(result.error).slice(0, 500), new Date().toISOString(), id]
    );

    // A failed test is a successful request that reports a failure — the
    // caller asked whether it works and got an answer.
    return ({ ok: result.ok, error: result.ok ? null : result.error });
}

/** Recent alert firings. */
async function listEvents({ limit }) {
    const rows = await localDb.query(
        'SELECT * FROM alert_events ORDER BY fired_at DESC, id DESC LIMIT ?', [limit]
    );
    return (rows.rows.map((e) => ({
        ...e,
        payload: e.payload ? JSON.parse(e.payload) : null
    })));
}

/** Alerting subsystem status. */
async function getStatus() {
    const asOf = await alertEngine.dataAsOf();
    const lag = asOf ? Date.now() - Date.parse(asOf) : null;
    const counts = await localDb.query(
        `SELECT
             (SELECT COUNT(*) FROM alert_rules WHERE enabled = 1) AS active_rules,
             (SELECT COUNT(*) FROM alert_channels WHERE enabled = 1) AS active_channels,
             (SELECT COUNT(*) FROM alert_events WHERE fired_at >= ?) AS fired_24h,
             (SELECT COUNT(*) FROM alert_events
               WHERE delivery_status IN ('failed', 'pending')) AS undelivered`,
        [new Date(Date.now() - 86400000).toISOString()]
    );
    return ({
        data_as_of: asOf,
        replica_lag_ms: lag,
        // Alerting deliberately goes quiet rather than firing on stale data.
        paused_by_staleness: lag !== null && lag > alertEngine.MAX_STALENESS_MS,
        max_staleness_ms: alertEngine.MAX_STALENESS_MS,
        ...counts.rows[0]
    });
}

/** F-15 · Triages one error fingerprint. */
async function setFingerprintStatus({ route, body, actorEmail }) {
    const { fingerprint } = route;
    const { action, note } = body || {};
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(fingerprint)) {
        throw daoError(400, 'A valid fingerprint is required');
    }
    const status = LIFECYCLE_ACTIONS[action];
    if (!status) {
        throw daoError(400, `Unknown action. Allowed: ${Object.keys(LIFECYCLE_ACTIONS).join(', ')}.`);
    }
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 2000)) {
        throw daoError(400, 'note must be text of at most 2000 characters.');
    }
    const now = new Date().toISOString();
    const actor = (actorEmail) || null;

    const r = await localDb.execute(
        `UPDATE error_fingerprints
            SET status = ?, notes = COALESCE(?, notes), status_by = ?, status_at = ?
          WHERE fingerprint = ?`,
        [status, note || null, actor, now, fingerprint]
    );
    if (r.changes === 0) throw daoError(404, 'Fingerprint not found');

    await localDb.execute(
        'INSERT INTO fingerprint_events (fingerprint, at, action, actor, note) VALUES (?, ?, ?, ?, ?)',
        [fingerprint, now, action === 'reopen' ? 'reopened' : status, actor, note || null]
    );

    return ({ fingerprint, status, status_at: now, status_by: actor });
}

/** F-15 · The triage history of one fingerprint. */
async function getFingerprintHistory({ route }) {
    const { fingerprint } = route;
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(fingerprint)) {
        throw daoError(400, 'A valid fingerprint is required');
    }
    const [meta, events] = await Promise.all([
        localDb.query('SELECT * FROM error_fingerprints WHERE fingerprint = ?', [fingerprint]),
        localDb.query(
            'SELECT * FROM fingerprint_events WHERE fingerprint = ? ORDER BY at ASC', [fingerprint]
        )
    ]);
    if (meta.rows.length === 0) throw daoError(404, 'Fingerprint not found');
    return ({ fingerprint: meta.rows[0], events: events.rows });
}

module.exports = {
    listRules,
    createRule,
    updateRule,
    deleteRule,
    listChannels,
    createChannel,
    updateChannel,
    exportChannelCurl,
    deleteChannel,
    testChannel,
    listEvents,
    getStatus,
    setFingerprintStatus,
    getFingerprintHistory
};
