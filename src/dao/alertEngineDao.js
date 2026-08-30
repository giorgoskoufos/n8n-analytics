/**
 * The queries behind the alert rules.
 *
 * Lifted out of config/alertEngine, which held them inline inside its rule
 * switch. The split follows the same line as the other DAOs and it is worth
 * naming precisely here, because the two halves look similar:
 *
 *   this file      what the replica says — rows, counts, percentiles
 *   alertEngine    what it means — is that over the threshold, is it worth
 *                  waking somebody, what should the message read
 *
 * Only the first half moved. The mapping that turns a row into "X has stopped
 * running" stays with the engine, because that is the alerting decision rather
 * than the measurement.
 *
 * Nothing here is exposed to the AI assistant. That is a separate decision from
 * where the queries live — see the note in dao/alertsDao.
 */

const localDb = require('../config/localDb');

// The ETL treats 'crashed' as a failure; so does this.
const FAILED = "e.status IN ('error', 'crashed')";

/**
 * Fingerprints seen for the first time inside the window.
 *
 * Novelty is measured on the fingerprint's watermark, not on whether it appears
 * in this window: a problem that has been recurring for months is not new just
 * because it also happened this hour.
 *
 * Ignored and resolved fingerprints are excluded in SQL rather than filtered
 * afterwards, so "ignore" genuinely stops the alert instead of merely hiding
 * the row.
 */
async function newFingerprints({ scope, windowStart, minOccurrences }) {
    const r = await localDb.query(
        `SELECT f.fingerprint, f.normalized_message, f.sample_message, f.first_seen,
                COUNT(a.id) AS occurrences,
                COUNT(DISTINCT a.workflow_id) AS workflows
           FROM error_fingerprints f
           JOIN execution_error_analytics a ON a.fingerprint = f.fingerprint
           JOIN execution_entity e ON e.id = a.id
          WHERE f.first_seen >= ?
            AND f.status NOT IN ('ignored', 'resolved')
            AND a.timestamp >= ?${scope.sql}
          GROUP BY f.fingerprint
         HAVING occurrences >= ?`,
        [windowStart, windowStart, ...scope.params, minOccurrences]
    );
    return r.rows;
}

/** Executions and failures per workflow across the window. */
async function errorRates({ scope, windowStart, asOfIso, minExecutions }) {
    const r = await localDb.query(
        `SELECT e."workflowId" AS id, w.name,
                COUNT(*) AS total,
                SUM(CASE WHEN ${FAILED} THEN 1 ELSE 0 END) AS errors
           FROM execution_entity e
           JOIN workflow_entity w ON w.id = e."workflowId"
          WHERE e."startedAt" >= ? AND e."startedAt" <= ?
            AND IFNULL(w."isArchived", 0) = 0${scope.sql}
          GROUP BY e."workflowId"
         HAVING total >= ?`,
        [windowStart, asOfIso, ...scope.params, minExecutions]
    );
    return r.rows;
}

/**
 * Each active workflow's learned cadence and when it was last seen.
 *
 * The cadence is learned over `sinceIso` regardless of the rule's window — the
 * window says how overdue to tolerate, not how much history to learn from, and
 * a one-hour window cannot measure a daily workflow.
 */
async function cadenceAndLastRun({ scope, sinceIso, minGaps }) {
    const r = await localDb.query(
        `WITH runs AS (
             SELECT e."workflowId" AS wf,
                    (julianday(e."startedAt") - julianday(
                         LAG(e."startedAt") OVER (PARTITION BY e."workflowId"
                                                  ORDER BY e."startedAt")
                    )) * 86400.0 AS gap
               FROM execution_entity e
              WHERE e."startedAt" >= ?${scope.sql}
         ),
         g AS (SELECT wf, gap FROM runs WHERE gap IS NOT NULL AND gap > 0),
         r AS (SELECT wf, gap, ROW_NUMBER() OVER (PARTITION BY wf ORDER BY gap) rn,
                      COUNT(*) OVER (PARTITION BY wf) n FROM g),
         med AS (SELECT wf, n, MAX(CASE WHEN rn = 1 + CAST((n - 1) * 0.5 AS INTEGER)
                                        THEN gap END) AS median_gap
                   FROM r GROUP BY wf, n)
         SELECT w.id, w.name, med.median_gap, med.n AS gaps,
                (SELECT MAX(x."startedAt") FROM execution_entity x
                  WHERE x."workflowId" = w.id) AS last_run,
                (SELECT MAX(st.latest_event) FROM workflow_statistics st
                  WHERE st.workflow_id = w.id) AS last_event
           FROM workflow_entity w
           JOIN med ON med.wf = w.id
          WHERE w.active = 1 AND IFNULL(w."isArchived", 0) = 0
            AND med.n >= ?`,
        [sinceIso, ...scope.params, minGaps]
    );
    return r.rows;
}

/** The 95th-percentile wait before starting, across the window. */
async function queueLagP95({ scope, windowStart, asOfIso }) {
    const r = await localDb.query(
        `WITH v AS (
             SELECT (julianday(e."startedAt") - julianday(e."createdAt")) * 86400000.0 AS ms
               FROM execution_entity e
              WHERE e."startedAt" >= ? AND e."startedAt" <= ?
                AND e."createdAt" IS NOT NULL${scope.sql}
         ),
         r AS (SELECT ms, ROW_NUMBER() OVER (ORDER BY ms) rn, COUNT(*) OVER () n FROM v)
         SELECT n, MAX(CASE WHEN rn = 1 + CAST((n - 1) * 0.95 AS INTEGER) THEN ms END) AS p95
           FROM r GROUP BY n`,
        [windowStart, asOfIso, ...scope.params]
    );
    return r.rows[0] || null;
}

/** This window's execution count against the one before it. */
async function volumeThisWindowAndPrevious({ scope, windowStart, previousStart, asOfIso }) {
    const r = await localDb.query(
        `SELECT
             SUM(CASE WHEN e."startedAt" >= ? THEN 1 ELSE 0 END) AS current,
             SUM(CASE WHEN e."startedAt" < ? THEN 1 ELSE 0 END) AS previous
           FROM execution_entity e
          WHERE e."startedAt" >= ? AND e."startedAt" <= ?${scope.sql}`,
        [windowStart, windowStart, previousStart, asOfIso, ...scope.params]
    );
    return r.rows[0] || {};
}

/** Average payload per workflow, this window against the one before it. */
async function payloadSizes({ scope, windowStart, previousStart, asOfIso }) {
    const r = await localDb.query(
        `SELECT e."workflowId" AS id, w.name,
                AVG(CASE WHEN e."startedAt" >= ? THEN e."jsonSizeBytes" END) AS now_avg,
                AVG(CASE WHEN e."startedAt" < ? THEN e."jsonSizeBytes" END) AS then_avg,
                SUM(CASE WHEN e."startedAt" >= ? THEN 1 ELSE 0 END) AS now_n,
                SUM(CASE WHEN e."startedAt" < ? THEN 1 ELSE 0 END) AS then_n
           FROM execution_entity e
           JOIN workflow_entity w ON w.id = e."workflowId"
          WHERE e."startedAt" >= ? AND e."startedAt" <= ?
            AND e."jsonSizeBytes" IS NOT NULL${scope.sql}
          GROUP BY e."workflowId"`,
        [windowStart, windowStart, windowStart, windowStart,
            previousStart, asOfIso, ...scope.params]
    );
    return r.rows;
}

/**
 * Bytes n8n is still retaining.
 *
 * Bounded to what n8n itself still holds, for the same reason the storage panel
 * is: this replica keeps history Postgres has already pruned, and counting it
 * would report a store that appears to grow without limit.
 */
async function retainedBytes({ scope }) {
    const horizonRow = await localDb.query(
        "SELECT value FROM dashboard_settings WHERE key = 'source_oldest_execution_id'"
    );
    const raw = horizonRow.rows[0] && horizonRow.rows[0].value;
    const horizon = raw === undefined || raw === null ? NaN : Number(raw);
    // Interpolated rather than bound because it prefixes the WHERE of a query
    // whose other parameters differ; it is a number this function produced from
    // a Number() conversion, so there is nothing here a caller can reach.
    const bound = Number.isFinite(horizon) ? ` AND e.id >= ${horizon}` : '';

    const r = await localDb.query(
        `SELECT SUM(e."jsonSizeBytes") + SUM(IFNULL(e."binaryDataSizeBytes", 0)) AS bytes,
                COUNT(*) AS n
           FROM execution_entity e
          WHERE e."jsonSizeBytes" IS NOT NULL${bound}${scope.sql}`,
        scope.params
    );
    return r.rows[0] || { bytes: 0, n: 0 };
}

// ── The pass itself ──────────────────────────────────────────────────────

/** The newest execution the replica holds — the clock every rule is judged against. */
async function newestExecutionAt() {
    const r = await localDb.query('SELECT MAX("startedAt") AS newest FROM execution_entity');
    return (r.rows[0] && r.rows[0].newest) || null;
}

/** Whether this subject has already been told about recently enough. */
async function hasRecentFiring({ dedupeKey, sinceIso }) {
    const r = await localDb.query(
        `SELECT 1 FROM alert_events
          WHERE dedupe_key = ? AND fired_at >= ? AND delivery_status <> 'suppressed'
          LIMIT 1`,
        [dedupeKey, sinceIso]
    );
    return r.rows.length > 0;
}

/** Every enabled rule, with the channel it delivers through. */
async function enabledRules() {
    const r = await localDb.query(
        `SELECT r.*, c.id AS ch_id, c.enabled AS ch_enabled
           FROM alert_rules r
           LEFT JOIN alert_channels c ON c.id = r.channel_id
          WHERE r.enabled = 1`
    );
    return r.rows;
}

/**
 * Records one firing.
 *
 * `delivery_status` is 'pending' when there is somewhere to send it and
 * 'no_channel' when there is not. The second is a real outcome worth recording
 * — a rule wired to nothing still fired, and the events table is where somebody
 * finds out why they were never told.
 */
async function insertEvent({ rule, nowIso, dedupeKey, finding, deliverable }) {
    await localDb.execute(
        `INSERT INTO alert_events
            (rule_id, rule_name, fired_at, dedupe_key, subject, subject_label,
             title, body, payload, delivery_status, delivery_error, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
        [rule.id, rule.name, nowIso, dedupeKey, finding.subject,
            finding.subject_label, finding.title, finding.body,
            JSON.stringify(finding.payload || {}),
            deliverable ? 'pending' : 'no_channel']
    );
}

/** Firings still waiting to be delivered, oldest attempt budget first. */
async function pendingDeliveries({ maxAttempts, limit = 20 }) {
    const r = await localDb.query(
        `SELECT e.*, c.type AS ch_type, c.config AS ch_config, c.id AS ch_id
           FROM alert_events e
           JOIN alert_rules r ON r.id = e.rule_id
           JOIN alert_channels c ON c.id = r.channel_id
          WHERE e.delivery_status IN ('pending', 'failed')
            AND e.attempts < ? AND c.enabled = 1
          ORDER BY e.fired_at DESC
          LIMIT ?`,
        [maxAttempts, limit]
    );
    return r.rows;
}

/** Marks one event delivered or failed, and counts the attempt. */
async function markDelivery({ eventId, ok, error }) {
    await localDb.execute(
        `UPDATE alert_events
            SET delivery_status = ?, delivery_error = ?, attempts = attempts + 1
          WHERE id = ?`,
        [ok ? 'sent' : 'failed', ok ? null : String(error).slice(0, 500), eventId]
    );
}

/** Records a channel's last success or last failure. */
async function recordChannelOutcome({ channelId, ok, error }) {
    if (!channelId) return;
    const at = new Date().toISOString();
    if (ok) {
        await localDb.execute(
            'UPDATE alert_channels SET last_ok_at = ?, last_error = NULL WHERE id = ?',
            [at, channelId]
        );
    } else {
        await localDb.execute(
            'UPDATE alert_channels SET last_error = ?, last_error_at = ? WHERE id = ?',
            [String(error).slice(0, 500), at, channelId]
        );
    }
}

/** Keeps the events table to its last `keep` rows. */
async function pruneEvents({ keep }) {
    await localDb.execute(
        'DELETE FROM alert_events WHERE id <= (SELECT MAX(id) FROM alert_events) - ?',
        [keep]
    );
}

module.exports = {
    newFingerprints,
    errorRates,
    cadenceAndLastRun,
    queueLagP95,
    volumeThisWindowAndPrevious,
    payloadSizes,
    retainedBytes,
    newestExecutionAt,
    hasRecentFiring,
    enabledRules,
    insertEvent,
    pendingDeliveries,
    markDelivery,
    recordChannelOutcome,
    pruneEvents
};
