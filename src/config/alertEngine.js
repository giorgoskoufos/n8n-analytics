const localDb = require('./localDb');
const dao = require('../dao/alertEngineDao');
const { ALERT_SOURCE, RULE_TYPES, readHeaders } = require('../utils/alertValidation');
const { groupingClause } = require('../utils/grouping');
const log = require('../utils/logger').logger('ALERT');

/**
 * Evaluates the standing rules and delivers what fires (F-13, F-14).
 *
 * Runs after each ETL cycle, and on its own timer as well, because every rule
 * here reads the replica and nothing else — an instance whose Postgres is
 * unreachable should still be able to tell you that its workflows stopped.
 *
 * Three properties this has to hold, and each is a way people stop trusting
 * alerting:
 *
 *   It must not fire on a stalled pipeline. Every rule measures against the
 *   freshest data actually synced, not against the wall clock, and the whole
 *   pass is skipped when the replica is too far behind to judge. The alternative
 *   is every scheduled workflow reported dead the moment the ETL hiccups.
 *
 *   It must not repeat itself. One alert per subject per cooldown, enforced on a
 *   dedupe key rather than on the rule, so two workflows breaching the same rule
 *   are told separately while one workflow breaching it a thousand times is told
 *   once.
 *
 *   It must not fire on noise. Every rule carries a minimum sample size, because
 *   one failure out of two is a 50% error rate and is not news.
 */

// Beyond this the data is too old to judge anything by, and firing on it would
// describe a snapshot rather than the present. The pass records why it skipped.
const MAX_STALENESS_MS = Number(process.env.ALERT_MAX_STALENESS_MS) || 30 * 60 * 1000;

// Delivery gets one attempt per firing plus retries on later passes, bounded so
// a permanently broken channel does not accumulate work forever.
const MAX_DELIVERY_ATTEMPTS = Number(process.env.ALERT_MAX_ATTEMPTS) || 4;
const DELIVERY_TIMEOUT_MS = Number(process.env.ALERT_TIMEOUT_MS) || 10000;

// The event log is a feed, not an archive.
const EVENT_HISTORY = Number(process.env.ALERT_EVENT_HISTORY) || 2000;

let isRunning = false;

// ==========================================================================
// Evaluation
// ==========================================================================

/** The rule's own scope, as a SQL fragment over a workflow-id column. */
function ruleScope(rule, column) {
    const parts = [];
    const params = [];
    if (rule.workflow_id) {
        parts.push(`${column} = ?`);
        params.push(rule.workflow_id);
    }
    const grouping = groupingClause(
        { folder: rule.folder_id || '', tag: rule.tag_id || '' }, column
    );
    // A rule whose scope no longer validates is a rule pointing at something
    // that was deleted; it matches nothing rather than matching everything,
    // which is the safe direction for a filter to fail in.
    if (!grouping.ok) return { sql: ' AND 1 = 0', params: [] };
    return {
        sql: (parts.length ? ` AND ${parts.join(' AND ')}` : '') + grouping.sql,
        params: [...params, ...grouping.params]
    };
}


/**
 * A link straight into the n8n editor, when the dashboard has been told where
 * n8n lives. An alert that names a workflow but does not say how to reach it
 * sends the reader looking for it, and the reader is by definition in a hurry.
 *
 * Null when `N8N_EDITOR_BASE_URL` is unset: a broken link in an alert is worse
 * than no link, because it is tried first.
 */
function workflowLink(id) {
    const base = (process.env.N8N_EDITOR_BASE_URL || '').replace(/\/+$/, '');
    return base && id ? `${base}/workflow/${encodeURIComponent(id)}` : null;
}


/**
 * One rule against the current data. Returns zero or more findings, each of
 * which becomes at most one alert after deduplication.
 *
 * Every branch returns the numbers it judged on, not just a verdict — an alert
 * that cannot show its working is one nobody acts on.
 */
async function evaluateRule(rule, asOfIso) {
    const asOfMs = Date.parse(asOfIso);
    const windowStart = new Date(asOfMs - rule.window_minutes * 60000).toISOString();
    const previousStart = new Date(asOfMs - 2 * rule.window_minutes * 60000).toISOString();
    const scope = ruleScope(rule, 'e."workflowId"');

    switch (rule.type) {
    case 'new_fingerprint': {
        // Novelty is measured on the fingerprint's watermark, not on whether it
        // appears in this window: a problem that has been recurring for months
        // is not new just because it also happened this hour.
        //
        // Ignored fingerprints are excluded here rather than filtered later, so
        // "ignore" genuinely stops the alert instead of merely hiding the row.
        const rows = { rows: await dao.newFingerprints({
            scope, windowStart, minOccurrences: rule.min_executions
        }) };
        return rows.rows.map((r) => ({
            subject: r.fingerprint,
            subject_label: (r.normalized_message || '').slice(0, 120),
            title: 'A failure nobody has seen before',
            body: `${r.occurrences} occurrence(s) across ${r.workflows} workflow(s): ` +
                `${(r.sample_message || r.normalized_message || '').slice(0, 200)}`,
            payload: {
                fingerprint: r.fingerprint,
                first_seen: r.first_seen,
                occurrences: r.occurrences,
                workflows: r.workflows
            }
        }));
    }

    case 'error_rate': {
        const rows = { rows: await dao.errorRates({
            scope, windowStart, asOfIso, minExecutions: rule.min_executions
        }) };
        return rows.rows
            .map((r) => ({ ...r, rate: (r.errors / r.total) * 100 }))
            .filter((r) => r.rate >= rule.threshold)
            .map((r) => ({
                subject: r.id,
                subject_label: r.name,
                title: `${r.name} is failing ${r.rate.toFixed(1)}% of the time`,
                body: `${r.errors} of ${r.total} executions failed in the last ` +
                    `${rule.window_minutes} minutes (threshold ${rule.threshold}%).`,
                payload: {
                    workflow_id: r.id, total: r.total, errors: r.errors,
                    rate: r.rate, url: workflowLink(r.id)
                }
            }));
    }

    case 'silent_death': {
        // The cadence is learned over a month regardless of the rule's window —
        // the window here says how overdue to tolerate, not how much history to
        // learn from, and a one-hour window cannot measure a daily workflow.
        const since = new Date(asOfMs - 30 * 86400000).toISOString();
        const rows = { rows: await dao.cadenceAndLastRun({
            scope, sinceIso: since, minGaps: rule.min_executions
        }) };
        return rows.rows
            .map((r) => {
                const last = [r.last_run, r.last_event].filter(Boolean).sort().pop();
                const silentFor = last ? (asOfMs - Date.parse(last)) / 1000 : null;
                return { ...r, last, silentFor, ratio: silentFor && r.median_gap
                    ? silentFor / r.median_gap : 0 };
            })
            .filter((r) => r.last && r.ratio >= rule.threshold)
            .map((r) => ({
                subject: r.id,
                subject_label: r.name,
                title: `${r.name} has stopped running`,
                body: `It usually runs every ${Math.round(r.median_gap / 60)} minutes and has been ` +
                    `silent for ${(r.silentFor / 3600).toFixed(1)} hours — ` +
                    `${r.ratio.toFixed(0)}× its usual gap. No error was raised.`,
                payload: {
                    workflow_id: r.id, median_gap_s: r.median_gap,
                    silent_for_s: r.silentFor, ratio: r.ratio, last_run: r.last,
                    url: workflowLink(r.id)
                }
            }));
    }

    case 'queue_lag': {
                const row = await dao.queueLagP95({ scope, windowStart, asOfIso });
        if (!row || row.n < rule.min_executions || row.p95 === null) return [];
        if (row.p95 < rule.threshold) return [];
        return [{
            subject: 'instance',
            subject_label: 'Queue',
            title: `Executions are waiting ${Math.round(row.p95)} ms to start`,
            body: `The 95th percentile wait over the last ${rule.window_minutes} minutes is ` +
                `${Math.round(row.p95)} ms across ${row.n} executions (threshold ${rule.threshold} ms).`,
            payload: { p95_ms: row.p95, samples: row.n }
        }];
    }

    case 'volume_drop': {
        const volume = await dao.volumeThisWindowAndPrevious({
            scope, windowStart, previousStart, asOfIso
        });
        const { current, previous } = volume;
        // The comparison is meaningless without a baseline worth comparing to.
        if (!previous || previous < rule.min_executions) return [];
        const pct = (current / previous) * 100;
        if (pct >= rule.threshold) return [];
        return [{
            subject: 'instance',
            subject_label: 'Volume',
            title: `Executions dropped to ${pct.toFixed(0)}% of the previous window`,
            body: `${current} executions in the last ${rule.window_minutes} minutes against ` +
                `${previous} in the ${rule.window_minutes} before that. Nothing failed — ` +
                'the calls simply stopped arriving.',
            payload: { current, previous, pct }
        }];
    }

    case 'payload_spike': {
        const rows = { rows: await dao.payloadSizes({
            scope, windowStart, previousStart, asOfIso
        }) };
        return rows.rows
            .filter((r) => r.now_n >= rule.min_executions && r.then_n >= rule.min_executions &&
                r.then_avg > 0)
            .map((r) => ({ ...r, ratio: r.now_avg / r.then_avg }))
            .filter((r) => r.ratio >= rule.threshold)
            .map((r) => ({
                subject: r.id,
                subject_label: r.name,
                title: `${r.name} is returning ${r.ratio.toFixed(1)}× more data per run`,
                body: `Average payload went from ${(r.then_avg / 1024).toFixed(0)} KB to ` +
                    `${(r.now_avg / 1024).toFixed(0)} KB per execution.`,
                payload: {
                    workflow_id: r.id, now_avg: r.now_avg, then_avg: r.then_avg,
                    ratio: r.ratio, url: workflowLink(r.id)
                }
            }));
    }

    case 'db_growth': {
        // Reuses the same reasoning as the storage panel: bounded to what n8n is
        // still holding, so the replica's own longer history does not read as
        // unbounded growth.
        const retained = await dao.retainedBytes({ scope });
        const bytes = retained.bytes || 0;
        const limit = rule.threshold * 1073741824;
        if (bytes < limit) return [];
        return [{
            subject: 'instance',
            subject_label: 'Storage',
            title: `n8n is retaining ${(bytes / 1073741824).toFixed(2)} GB of execution data`,
            body: `Past the ${rule.threshold} GB you asked to be told about, across ` +
                `${retained.n} retained executions.`,
            payload: { bytes, threshold_bytes: limit, executions: retained.n }
        }];
    }

    default:
        return [];
    }
}

// ==========================================================================
// Delivery
// ==========================================================================

/**
 * Sends one alert. Returns { ok } or { ok: false, error }.
 *
 * Uses fetch with an AbortController rather than leaving the timeout to the
 * platform: a channel pointed at a host that accepts the connection and never
 * answers would otherwise hold the pass open indefinitely, and the pass runs on
 * the same interval as the ETL.
 */
async function deliver(channel, event) {
    const config = JSON.parse(channel.config || '{}');
    const data = event.payload ? JSON.parse(event.payload) : null;
    const link = (data && data.url) || null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    try {
        if (channel.type === 'telegram') {
            const text = `*${event.title}*\n${event.body || ''}` +
                (link ? `\n${link}` : '');
            const res = await fetch(
                `https://api.telegram.org/bot${encodeURIComponent(config.bot_token)}/sendMessage`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: config.chat_id, text, parse_mode: 'Markdown'
                    }),
                    signal: controller.signal
                }
            );
            if (!res.ok) {
                // Telegram puts the useful part in the body, not the status.
                const detail = await res.text().catch(() => '');
                return { ok: false, error: `Telegram ${res.status}: ${detail.slice(0, 200)}` };
            }
            return { ok: true };
        }

        // webhook and n8n_workflow are the same wire format on purpose. The
        // difference is what is on the other end, and naming them separately is
        // what makes the n8n one discoverable.
        // F-24 §4 · custom headers are a list now, not one pair.
        //
        // Read through `readHeaders`, which also understands the legacy
        // header_name/header_value shape — so a channel created before that
        // change keeps delivering with its header, without a data migration
        // that could drop a secret on the way.
        //
        // Content-Type is applied AFTER the custom ones, not before: it is the
        // one header this format depends on, and validation already refuses it
        // by name. Two defences, because losing this one silently turns every
        // alert into a body the receiver will not parse.
        const headers = {};
        for (const h of readHeaders(config)) headers[h.name] = h.value;
        headers['Content-Type'] = 'application/json';
        const res = await fetch(config.url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                source: ALERT_SOURCE,
                rule: event.rule_name,
                title: event.title,
                body: event.body,
                subject: event.subject,
                subject_label: event.subject_label,
                fired_at: event.fired_at,
                link,
                data
            }),
            signal: controller.signal
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.name === 'AbortError'
            ? `Timed out after ${DELIVERY_TIMEOUT_MS} ms` : err.message };
    } finally {
        clearTimeout(timer);
    }
}

// ==========================================================================
// The pass
// ==========================================================================

/**
 * How fresh the data is. Everything is judged against this rather than the
 * clock, for the reason spelled out at the top of the file.
 */
async function dataAsOf() {
    return dao.newestExecutionAt();
}

/** Whether this subject has already been told about recently enough. */
async function isSuppressed(dedupeKey, cooldownMinutes, nowIso) {
    if (!cooldownMinutes) return false;
    const sinceIso = new Date(Date.parse(nowIso) - cooldownMinutes * 60000).toISOString();
    return dao.hasRecentFiring({ dedupeKey, sinceIso });
}

/**
 * One alert pass: judge, record, then deliver.
 *
 * Split in two on purpose, and the split is not cosmetic.
 *
 * Judging and recording both write to the replica, and this process has one
 * SQLite connection shared with the ETL. A write issued while the ETL has a
 * transaction open silently becomes part of it — so an alert recorded during a
 * pass that later rolls back would vanish after having already been delivered,
 * the cooldown would forget it fired, and the next pass would send it again.
 * That half therefore runs inside localDb.exclusive().
 *
 * Delivery is HTTP to somebody else's server, with a ten-second timeout. It must
 * NOT hold that gate: a slow webhook would stall the ETL for as long as it took
 * to give up. So events are written as 'pending' first and sent afterwards,
 * which also means a crash between the two leaves a durable record the next pass
 * picks up rather than an alert nobody will ever hear about again.
 *
 * Deliberately NOT guarded by the ETL instance lock: alerting reads the replica
 * and writes only its own event log, so a read-only instance evaluating rules is
 * harmless — and a deployment whose writer has died is exactly when someone
 * should still be told.
 */
async function runAlertPass({ force = false } = {}) {
    if (isRunning) return { status: 'already_running' };
    isRunning = true;
    try {
        await localDb.ready;
        const judged = await localDb.exclusive(() => recordFirings(force));
        if (judged.status !== 'ok') return judged;

        const delivery = await flushDeliveries();
        return { ...judged, ...delivery };
    } catch (err) {
        log.error('Alert pass failed:', err.message);
        return { status: 'failed', error: err.message };
    } finally {
        isRunning = false;
    }
}

/**
 * Evaluates every enabled rule and writes what fired. No network, no delivery.
 * Always called with the write gate held.
 */
async function recordFirings(force) {
    const asOf = await dataAsOf();
    if (!asOf) return { status: 'no_data', fired: 0 };

    const staleness = Date.now() - Date.parse(asOf);
    if (!force && staleness > MAX_STALENESS_MS) {
        // Silence rather than a storm. Everything scheduled would look dead.
        log.warn(
            `Skipping alert pass: the replica is ${Math.round(staleness / 60000)} minutes ` +
            'behind, which would make every scheduled workflow look silent.'
        );
        return { status: 'stale', staleness_ms: staleness, fired: 0 };
    }

    const rules = { rows: await dao.enabledRules() };

    const nowIso = new Date().toISOString();
    let fired = 0;
    let suppressed = 0;

    for (const rule of rules.rows) {
        let findings;
        try {
            findings = await evaluateRule(rule, asOf);
        } catch (err) {
            // One malformed rule must not stop the others.
            log.error(`Rule "${rule.name}" failed to evaluate:`, err.message);
            continue;
        }

        for (const finding of findings) {
            const dedupeKey = `${rule.id}:${finding.subject}`;
            if (await isSuppressed(dedupeKey, rule.cooldown_minutes, nowIso)) {
                suppressed++;
                continue;
            }

            // 'pending' when there is somewhere to send it, 'no_channel' when
            // there is not. The second is a real outcome worth recording — a
            // rule wired to nothing still fired, and the events table is where
            // someone finds out why they were never told.
            const deliverable = Boolean(rule.ch_id && rule.ch_enabled);
            await dao.insertEvent({ rule, nowIso, dedupeKey, finding, deliverable });
            fired++;
        }
    }

    await pruneEvents();

    if (fired > 0) log.info(`Alert pass: ${fired} fired, ${suppressed} suppressed.`);
    return { status: 'ok', rules: rules.rows.length, fired, suppressed };
}

/**
 * Sends everything waiting to go out, including what failed on an earlier pass.
 *
 * A channel is usually down for minutes, not forever, and losing an alert to a
 * transient outage is the same as not having alerting. Attempts are bounded, so
 * a channel that is genuinely gone stops consuming the pass.
 *
 * Runs OUTSIDE the write gate — the deliver() calls are network — and takes it
 * only for the two short writes that record each outcome.
 */
async function flushDeliveries() {
    const waiting = { rows: await dao.pendingDeliveries({ maxAttempts: MAX_DELIVERY_ATTEMPTS }) };

    let delivered = 0;
    let failed = 0;

    for (const event of waiting.rows) {
        const result = await deliver({ type: event.ch_type, config: event.ch_config }, event);
        if (result.ok) delivered++; else failed++;
        await localDb.exclusive(async () => {
            await dao.recordChannelOutcome({
                channelId: event.ch_id, ok: result.ok, error: result.error
            });
            await dao.markDelivery({ eventId: event.id, ok: result.ok, error: result.error });
        });
    }

    return { delivered, undelivered: failed };
}

async function pruneEvents() {
    await dao.pruneEvents({ keep: EVENT_HISTORY });
}

module.exports = {
    runAlertPass,
    evaluateRule,
    deliver,
    dataAsOf,
    RULE_TYPES,
    MAX_STALENESS_MS
};
