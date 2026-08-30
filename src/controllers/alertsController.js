const alertEngine = require('../config/alertEngine');
// What is left here is the vocabulary the form is built from and the paste
// endpoint's own validation. Everything that touched the database moved into
// dao/alertsDao with its queries.
const { RULE_TYPES, CHANNEL_TYPES, validateUrl } = require('../utils/alertValidation');
const log = require('../utils/logger').logger('API');
const alertsDao = require('../dao/alertsDao');
const { parseCurl } = require('../utils/curl');

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
        res.json(await alertsDao.listRules());
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to list alert rules' });
    }
};

exports.createRule = async (req, res) => {
    try {
        res.status(201).json(await alertsDao.createRule({ id: Number(req.params.id), body: req.body, actorEmail: req.user && req.user.email }));
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to create alert rule' });
    }
};

exports.updateRule = async (req, res) => {
    try {
        res.json(await alertsDao.updateRule({ id: Number(req.params.id), body: req.body }));
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to update alert rule' });
    }
};

exports.deleteRule = async (req, res) => {
    try {
        res.json(await alertsDao.deleteRule({ id: Number(req.params.id) }));
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to delete alert rule' });
    }
};

// ---------------------------------------------------------------- channels

exports.listChannels = async (req, res) => {
    try {
        res.json(await alertsDao.listChannels());
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to list channels' });
    }
};

exports.createChannel = async (req, res) => {
    try {
        res.status(201).json(await alertsDao.createChannel({ id: Number(req.params.id), body: req.body }));
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to create channel' });
    }
};

exports.updateChannel = async (req, res) => {
    try {
        res.json(await alertsDao.updateChannel({ id: Number(req.params.id), body: req.body, caller: req.scope }));
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to update channel' });
    }
};

/**
 * Reads a pasted cURL command into the shape the channel form holds — F-24 §4.
 *
 * Parsed on the server, not in the browser, for the reason §7 exists: a second
 * implementation of this in front-end JavaScript would be a second thing to
 * keep correct, and this one has security-relevant edge cases. `src/utils/curl`
 * is a pure parser that cannot execute anything.
 *
 * The URL is run through the ordinary channel validation before it comes back,
 * so a paste pointing at a link-local or private address is refused HERE, where
 * the person can see why, rather than silently at save time — and by the same
 * `validateUrl` every hand-typed URL passes through, so the two cannot drift.
 */
exports.parseChannelCurl = (req, res) => {
    const parsed = parseCurl(req.body && req.body.command);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const urlCheck = validateUrl(parsed.value.url);
    if (!urlCheck.ok) return res.status(400).json({ error: urlCheck.error });

    // Content-Type is ours to set on every delivery, so a pasted one is dropped
    // rather than rejected — it is the single most common header in a curl
    // command and refusing the paste over it would be obtuse.
    const headers = parsed.value.headers.filter(
        (h) => h.name.toLowerCase() !== 'content-type'
    );

    const notes = [];
    if (parsed.value.method && parsed.value.method !== 'POST') {
        notes.push(`The command uses ${parsed.value.method}. Alerts are always delivered as POST.`);
    }
    if (parsed.value.body) {
        notes.push('The request body was ignored — the dashboard sends its own alert payload.');
    }
    if (headers.length !== parsed.value.headers.length) {
        notes.push('Content-Type was dropped; the dashboard always sends application/json.');
    }

    res.json({ url: urlCheck.value, headers, notes });
};

/**
 * Renders a channel as a cURL command.
 *
 * Secret values come out MASKED, and that is deliberate rather than an
 * oversight. This API has never read a stored secret back to a browser — that
 * is what `redactConfig` is for, and it is the reason a stolen session cannot
 * be used to harvest every webhook token the dashboard holds. Handing them out
 * through a second endpoint because the output is shaped like a shell command
 * would undo it.
 *
 * So this answers "what request does this channel actually make", which is what
 * the shape is useful for. For "does this channel work", the Test button sends
 * a real message through the real config and reports what came back — a better
 * answer than a command line anyway, because it exercises the delivery path
 * this dashboard will actually use.
 */
exports.exportChannelCurl = async (req, res) => {
    try {
        res.json(await alertsDao.exportChannelCurl({ id: Number(req.params.id), body: req.body }));
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to render the channel as a command' });
    }
};

exports.deleteChannel = async (req, res) => {
    try {
        res.json(await alertsDao.deleteChannel({ id: Number(req.params.id) }));
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
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
    try {
        res.json(await alertsDao.testChannel({ id: Number(req.params.id), body: req.body, caller: req.scope }));
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to test channel' });
    }
};

// ------------------------------------------------------------------ events

exports.listEvents = async (req, res) => {
    try {
        res.json(await alertsDao.listEvents({ limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200) }));
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
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
        res.json(await alertsDao.getStatus());
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to read alert status' });
    }
};

// ==========================================================================
// F-15 · Error lifecycle
// ==========================================================================

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
    try {
        res.json(await alertsDao.setFingerprintStatus({ route: req.params, body: req.body, actorEmail: req.user && req.user.email }));
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to update fingerprint status' });
    }
};

/** The decisions taken about one fingerprint, oldest first. */
exports.getFingerprintHistory = async (req, res) => {
    try {
        res.json(await alertsDao.getFingerprintHistory({ route: req.params }));
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to read fingerprint history' });
    }
};
