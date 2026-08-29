const localDb = require('../config/localDb');
const alertEngine = require('../config/alertEngine');
const {
    RULE_TYPES, CHANNEL_TYPES, validateRule, validateChannel, redactConfig
} = require('../utils/alertValidation');
const log = require('../utils/logger').logger('API');

/**
 * Managing alert rules and channels (F-13, F-14).
 *
 * Everything here is instance-wide: a rule created by one person alerts
 * everyone the channel reaches, so writes take the same gate as forcing a sync
 * or changing a global setting. Reads are open to any authenticated user,
 * because seeing what the instance is watching is not a privileged act — but a
 * channel's secret never leaves this process.
 */

/**
 * The vocabulary the form is built from.
 *
 * Served rather than duplicated in the front end. The units matter: a threshold
 * field labelled only "Threshold" is a trap, because 5 could be five percent,
 * five milliseconds or five multiples, and the difference is between an alert
 * that never fires and one that fires every minute. Shipping the definitions
 * means the form cannot drift from the engine.
 */
exports.getSchema = (req, res) => {
    res.json({
        ruleTypes: Object.entries(RULE_TYPES).map(([key, spec]) => ({
            type: key,
            label: spec.label,
            description: spec.description,
            threshold: spec.threshold,
            subject: spec.subject,
            defaults: spec.defaults
        })),
        channelTypes: Object.entries(CHANNEL_TYPES).map(([key, spec]) => ({
            type: key,
            label: spec.label,
            description: spec.description,
            // `secret` travels too, so the form knows which fields to leave
            // blank on edit rather than showing a masked value it would send back.
            fields: spec.fields
        }))
    });
};

// ------------------------------------------------------------------- rules

exports.listRules = async (req, res) => {
    try {
        const rows = await localDb.query(
            `SELECT r.*, c.name AS channel_name, c.type AS channel_type, c.enabled AS channel_enabled,
                    (SELECT MAX(e.fired_at) FROM alert_events e WHERE e.rule_id = r.id) AS last_fired,
                    (SELECT COUNT(*) FROM alert_events e WHERE e.rule_id = r.id) AS times_fired
               FROM alert_rules r
               LEFT JOIN alert_channels c ON c.id = r.channel_id
              ORDER BY r.enabled DESC, r.name COLLATE NOCASE`
        );
        res.json(rows.rows);
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to list alert rules' });
    }
};

exports.createRule = async (req, res) => {
    const check = validateRule(req.body);
    if (!check.ok) return res.status(400).json({ error: check.error });

    try {
        const v = check.value;
        if (v.channel_id !== null && !(await channelExists(v.channel_id))) {
            return res.status(400).json({ error: 'That channel does not exist.' });
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
                now, now, req.user && req.user.email]
        );
        res.status(201).json({ id: r.lastID });
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to create alert rule' });
    }
};

exports.updateRule = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid rule id' });

    const check = validateRule(req.body);
    if (!check.ok) return res.status(400).json({ error: check.error });

    try {
        const v = check.value;
        if (v.channel_id !== null && !(await channelExists(v.channel_id))) {
            return res.status(400).json({ error: 'That channel does not exist.' });
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
        if (r.changes === 0) return res.status(404).json({ error: 'Rule not found' });
        res.json({ message: 'Rule updated' });
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to update alert rule' });
    }
};

exports.deleteRule = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid rule id' });
    try {
        const r = await localDb.execute('DELETE FROM alert_rules WHERE id = ?', [id]);
        if (r.changes === 0) return res.status(404).json({ error: 'Rule not found' });
        // The events it produced are deliberately kept. "Why was I told this?"
        // has to remain answerable after the rule is gone; alert_events carries
        // the rule's name for exactly that reason.
        res.json({ message: 'Rule deleted' });
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to delete alert rule' });
    }
};

// ---------------------------------------------------------------- channels

async function channelExists(id) {
    const r = await localDb.query('SELECT 1 FROM alert_channels WHERE id = ?', [id]);
    return r.rows.length > 0;
}

exports.listChannels = async (req, res) => {
    try {
        const rows = await localDb.query(
            `SELECT c.*, (SELECT COUNT(*) FROM alert_rules r WHERE r.channel_id = c.id) AS rules
               FROM alert_channels c ORDER BY c.name COLLATE NOCASE`
        );
        res.json(rows.rows.map((c) => ({
            ...c,
            // Never the real value. The form shows dots and only sends a
            // replacement when one is typed.
            config: redactConfig(c.type, JSON.parse(c.config || '{}'))
        })));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to list channels' });
    }
};

exports.createChannel = async (req, res) => {
    const check = validateChannel(req.body);
    if (!check.ok) return res.status(400).json({ error: check.error });
    try {
        const v = check.value;
        const now = new Date().toISOString();
        const r = await localDb.execute(
            `INSERT INTO alert_channels (name, type, config, enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [v.name, v.type, JSON.stringify(v.config), v.enabled, now, now]
        );
        res.status(201).json({ id: r.lastID });
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to create channel' });
    }
};

exports.updateChannel = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid channel id' });
    try {
        const existing = await localDb.query('SELECT config FROM alert_channels WHERE id = ?', [id]);
        if (existing.rows.length === 0) return res.status(404).json({ error: 'Channel not found' });

        // Secrets the caller left blank are carried over. Without this, renaming
        // a channel would wipe its token — the form never had the token to
        // send back, so a blank field means "unchanged", not "empty".
        const check = validateChannel(req.body, JSON.parse(existing.rows[0].config || '{}'));
        if (!check.ok) return res.status(400).json({ error: check.error });

        const v = check.value;
        await localDb.execute(
            `UPDATE alert_channels
                SET name = ?, type = ?, config = ?, enabled = ?, updated_at = ?
              WHERE id = ?`,
            [v.name, v.type, JSON.stringify(v.config), v.enabled, new Date().toISOString(), id]
        );
        res.json({ message: 'Channel updated' });
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to update channel' });
    }
};

exports.deleteChannel = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid channel id' });
    try {
        const r = await localDb.execute('DELETE FROM alert_channels WHERE id = ?', [id]);
        if (r.changes === 0) return res.status(404).json({ error: 'Channel not found' });
        // Rules pointing at it survive with channel_id NULL — they keep
        // evaluating and their events are recorded as 'no_channel', which is
        // visible in the feed. Deleting the rules too would be a surprising
        // amount of destruction from one click.
        res.json({ message: 'Channel deleted' });
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to delete channel' });
    }
};

/**
 * Sends a real message through a channel.
 *
 * The single most valuable button on the page. A channel that is misconfigured
 * is indistinguishable from one that has had nothing to say, and the first time
 * anyone finds out is the incident they built it for.
 */
exports.testChannel = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid channel id' });
    try {
        const rows = await localDb.query('SELECT * FROM alert_channels WHERE id = ?', [id]);
        if (rows.rows.length === 0) return res.status(404).json({ error: 'Channel not found' });
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
        res.json({ ok: result.ok, error: result.ok ? null : result.error });
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to test channel' });
    }
};

// ------------------------------------------------------------------ events

exports.listEvents = async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    try {
        const rows = await localDb.query(
            'SELECT * FROM alert_events ORDER BY fired_at DESC, id DESC LIMIT ?', [limit]
        );
        res.json(rows.rows.map((e) => ({
            ...e,
            payload: e.payload ? JSON.parse(e.payload) : null
        })));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to list alert events' });
    }
};

/**
 * Runs the rules now, without waiting for the next cycle.
 *
 * `force` skips the staleness guard, because the person clicking the button can
 * see the staleness warning next to it and has decided to look anyway.
 */
exports.runNow = async (req, res) => {
    try {
        const result = await alertEngine.runAlertPass({ force: req.query.force === 'true' });
        res.json(result);
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Alert pass failed' });
    }
};

/** How stale the data is, so the page can say whether alerting is currently paused. */
exports.getStatus = async (req, res) => {
    try {
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
        res.json({
            data_as_of: asOf,
            replica_lag_ms: lag,
            // Alerting deliberately goes quiet rather than firing on stale data.
            paused_by_staleness: lag !== null && lag > alertEngine.MAX_STALENESS_MS,
            max_staleness_ms: alertEngine.MAX_STALENESS_MS,
            ...counts.rows[0]
        });
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to read alert status' });
    }
};

// ==========================================================================
// F-15 · Error lifecycle
// ==========================================================================

const LIFECYCLE_ACTIONS = {
    acknowledge: 'acknowledged',
    resolve: 'resolved',
    ignore: 'ignored',
    reopen: 'open'
};

/**
 * Records a decision about a fingerprint.
 *
 * A fingerprint is not only "it exists"; it is something a person has or has not
 * dealt with. Without this the error page is a list that never gets shorter,
 * which is the same as a list nobody reads.
 *
 * Ignored and resolved fingerprints stop producing alerts — that is the whole
 * point of saying so — but they keep being counted, because the error rate is a
 * measurement and a decision does not change what happened.
 */
exports.setFingerprintStatus = async (req, res) => {
    const { fingerprint } = req.params;
    const { action, note } = req.body || {};

    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(fingerprint)) {
        return res.status(400).json({ error: 'A valid fingerprint is required' });
    }
    const status = LIFECYCLE_ACTIONS[action];
    if (!status) {
        return res.status(400).json({
            error: `Unknown action. Allowed: ${Object.keys(LIFECYCLE_ACTIONS).join(', ')}.`
        });
    }
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 2000)) {
        return res.status(400).json({ error: 'note must be text of at most 2000 characters.' });
    }

    try {
        const now = new Date().toISOString();
        const actor = (req.user && req.user.email) || null;

        const r = await localDb.execute(
            `UPDATE error_fingerprints
                SET status = ?, notes = COALESCE(?, notes), status_by = ?, status_at = ?
              WHERE fingerprint = ?`,
            [status, note || null, actor, now, fingerprint]
        );
        if (r.changes === 0) return res.status(404).json({ error: 'Fingerprint not found' });

        await localDb.execute(
            'INSERT INTO fingerprint_events (fingerprint, at, action, actor, note) VALUES (?, ?, ?, ?, ?)',
            [fingerprint, now, action === 'reopen' ? 'reopened' : status, actor, note || null]
        );

        res.json({ fingerprint, status, status_at: now, status_by: actor });
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to update fingerprint status' });
    }
};

/** The decisions taken about one fingerprint, oldest first. */
exports.getFingerprintHistory = async (req, res) => {
    const { fingerprint } = req.params;
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(fingerprint)) {
        return res.status(400).json({ error: 'A valid fingerprint is required' });
    }
    try {
        const [meta, events] = await Promise.all([
            localDb.query('SELECT * FROM error_fingerprints WHERE fingerprint = ?', [fingerprint]),
            localDb.query(
                'SELECT * FROM fingerprint_events WHERE fingerprint = ? ORDER BY at ASC', [fingerprint]
            )
        ]);
        if (meta.rows.length === 0) return res.status(404).json({ error: 'Fingerprint not found' });
        res.json({ fingerprint: meta.rows[0], events: events.rows });
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to read fingerprint history' });
    }
};
