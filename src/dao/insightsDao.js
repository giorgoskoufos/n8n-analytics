/**
 * Insights analytics — the SQL behind the eleven panels.
 *
 * Lifted out of insightsController, which held these queries inline and could
 * therefore only be reached over HTTP. See dao/shared.js for why that had to
 * change and where the line between this layer and the controller falls.
 *
 * Every function here takes validated domain values and returns data. None has
 * an opinion about status codes, and none may read `req` — the moment one does,
 * this is a second controller.
 *
 * The constants and helpers below moved with the queries because they are
 * domain logic rather than transport: `sweepConcurrency` is the concurrency
 * algorithm, `forecast` is the growth model, `SYNC_OK` is a value stored in the
 * replica. They lived in the controller only because that is where the SQL was.
 */

const localDb = require('../config/localDb');
const {
    msBetween, bucketExpr, bucketParams, filterFor, densify, coverageOf
} = require('./shared');

// What counts as a failure.
//
// The ETL has always treated 'crashed' as an error — syncJob queues both for
// analytics — while the KPI queries in metricsController count only 'error'.
// One crashed execution exists here, so the two answers differ by one: invisible
// in practice, and still two definitions of the same word. This file uses the
// ETL's, written once so it cannot drift again.
const FAILED = "e.status IN ('error', 'crashed')";

const FAILED_SUM = `SUM(CASE WHEN ${FAILED} THEN 1 ELSE 0 END)`;

const GB = 1073741824;

// How far before the window to look for executions that were already running
// when it opened. The longest execution ever recorded on this instance is 336
// seconds and nothing in thirty days exceeded five minutes, so an hour is two
// orders of magnitude of headroom — and it is what keeps the query an indexed
// range scan instead of an open-ended one. Anything that outlived it is counted
// and reported rather than silently dropped.
const CONCURRENCY_LOOKBACK_MS = Number(process.env.CONCURRENCY_LOOKBACK_MS) || 3600000;

// Concurrency is the one metric here that cannot be answered by aggregation —
// it needs every interval — so its window is capped harder than the others.

const TARGET_BUCKETS = 1440;

// How many multiples of a workflow's own cadence it has to miss before it counts
// as silent. Three is forgiving enough to survive one skipped run and a slow one.
const DEFAULT_SILENCE_K = 3;

// Fewer gaps than this and there is no cadence to speak of — two runs a week
// apart give a "median interval" of exactly one number.
const MIN_GAPS_FOR_CADENCE = 5;

// How far back to learn the cadence from.
const CADENCE_WINDOW_DAYS = 30;

// An active workflow with no measurable rhythm that has not run in this long is
// not "fine, just irregular" — it is dormant. Without this, three workflows on
// this instance that last ran three months ago sat in the healthy list purely
// because they never ran often enough to be late against anything.
const DORMANT_DAYS = 30;

/**
 * The status recordSyncRun writes for a pass that worked.
 *
 * Named rather than spelled out at each of the three places that compare
 * against it, because the first version of this panel compared against
 * 'success' — a word that appears nowhere in the ETL — and so reported every
 * one of eighteen healthy passes as a failure, with an eighteen-deep failure
 * streak to match. A health panel that is wrong in the alarming direction is
 * worse than no health panel: it sends someone to fix a pipeline that was fine.
 */
const SYNC_OK = 'ok';

// An execution still holds a slot only while it is genuinely in flight. These
// are the statuses n8n uses for that; everything else has finished, whatever
// its `stoppedAt` says.
const RUNNING_STATUSES = new Set(['new', 'running', 'waiting']);

/**
 * The oldest execution n8n itself still holds, as the ETL last observed it.
 *
 * Everything in the storage panel is scoped to this. The tempting shortcut is
 * "every local row that carries a payload size", and it is right only while the
 * backfill has just finished: this replica keeps history Postgres has already
 * pruned, and keeps those rows' sizes with it. A month from now today's
 * executions are gone from n8n while their bytes are still counted here, and the
 * panel would report a store twice the real size, apparently growing without
 * limit — the exact false alarm F-04 exists to prevent.
 *
 * Absent means the ETL has not completed a cycle since this shipped. The panel
 * then measures everything it has and says so, rather than silently switching
 * between two definitions of the same number.
 */
async function sourceHorizon() {
    const r = await localDb.query(
        "SELECT value FROM dashboard_settings WHERE key = 'source_oldest_execution_id'"
    );
    const raw = r.rows[0] && r.rows[0].value;
    const id = raw === undefined || raw === null ? NaN : Number(raw);
    return Number.isFinite(id) ? id : null;
}

/**
 * Growth, and whether it is actually growth.
 *
 * The naive reading of "180 MB a day" is 5 GB a month and a crisis by autumn.
 * That reading is wrong here, and the reason is in the same data: n8n is
 * pruning. A store that prunes converges — it settles at roughly one retention
 * window of daily volume — so a runaway projection for it would be alarming and
 * false.
 *
 * Two days have to be excluded before any of this can be measured, and both were
 * getting in:
 *
 *   The last day is still being written. Including a partial day drags every
 *   average down by however much of it has not happened yet.
 *
 *   The oldest days have already been half removed. This instance retains a
 *   thin tail — eight or so executions a day going back a further week past the
 *   real horizon, where a current day holds four and a half thousand. Averaging
 *   across them reported 127 MB/day against an actual 183, a 30% understatement,
 *   and made the trend line mostly a picture of the prune ramp.
 *
 * So the rate is measured over *full* days only, and the tail is accounted for
 * separately rather than averaged away. The model is then checkable against a
 * number it did not use: daily rate × retention window + tail should come back
 * to the bytes actually retained. On this instance it does, within 1%.
 */
function forecast(daily, totals, retainedBytes) {
    const bytesOf = (d) => (d.json_bytes || 0) + (d.binary_bytes || 0);

    // Today is partial by definition.
    const complete = daily.slice(0, -1);
    if (complete.length < 3) {
        return { known: false, reason: 'needs at least three complete days' };
    }

    // A day the retention sweep has already been through holds a fraction of the
    // executions an untouched one does. Half the median is a wide margin — real
    // weekday/weekend variation does not come close to it.
    const counts = complete.map((d) => d.executions).slice().sort((a, b) => a - b);
    const median = counts[Math.floor(counts.length / 2)] || 0;
    const isFull = (d) => median > 0 && d.executions >= median * 0.5;
    const full = complete.filter(isFull);
    const trimmed = complete.filter((d) => !isFull(d));

    if (full.length < 3) {
        return { known: false, reason: 'needs at least three complete, unpruned days' };
    }

    const perDay = full.map(bytesOf);
    const dailyBytes = perDay.reduce((a, b) => a + b, 0) / perDay.length;

    // Least squares on (day index, bytes) over the full days only. The slope is
    // the honest version of "is it accelerating" — an average alone cannot tell
    // a steady 180 MB/day from one that was 120 last week.
    const meanX = (perDay.length - 1) / 2;
    let num = 0;
    let den = 0;
    perDay.forEach((y, x) => {
        num += (x - meanX) * (y - dailyBytes);
        den += (x - meanX) * (x - meanX);
    });
    const slope = den ? num / den : 0;

    // The retention horizon, read off the data rather than off an
    // EXECUTIONS_DATA_MAX_AGE this app cannot see. Measured from the oldest day
    // the sweep has NOT reached — the surviving tail beyond it is not the
    // horizon, it is what got past it.
    const newest = totals.newest ? new Date(totals.newest).getTime() : Date.now();
    const horizonStart = new Date(`${full[0].day}T00:00:00.000Z`).getTime();
    const retentionDays = Math.max(1, (newest - horizonStart) / 86400000);

    const tailBytes = trimmed.reduce((a, d) => a + bytesOf(d), 0);
    const equilibrium = dailyBytes * retentionDays + tailBytes;

    return {
        known: true,
        daily_bytes: dailyBytes,
        trend_bytes_per_day: slope,
        days_measured: full.length,
        retention_days: retentionDays,
        pruning: trimmed.length > 0,
        // Bytes surviving past the horizon: a handful of executions a day, but
        // large ones. Broken out because otherwise they look like an error in
        // the equilibrium figure rather than a real part of the store.
        tail_bytes: tailBytes,
        // Where the store settles if today's volume and today's horizon hold.
        equilibrium_bytes: equilibrium,
        // Positive means it is still filling toward that; negative means the
        // recent days are lighter than what is being pruned and it is shrinking.
        headroom_bytes: equilibrium - retainedBytes,
        // Only meaningful when nothing is trimming the far end. With pruning,
        // bytes leave as fast as they arrive and a linear projection is fiction.
        projection: trimmed.length > 0 ? null : {
            in_30_days: retainedBytes + dailyBytes * 30,
            in_90_days: retainedBytes + dailyBytes * 90,
            days_to_5gb: dailyBytes > 0 && retainedBytes < 5 * GB
                ? Math.ceil((5 * GB - retainedBytes) / dailyBytes) : null
        }
    };
}

/**
 * The sweep itself. Pure, so the arithmetic can be tested without a database.
 *
 * Two numbers per bucket, because they answer different questions. `peak` is the
 * highest simultaneous count reached — what a concurrency limit is compared
 * against. `avg` is time-weighted occupancy: total execution-seconds in the
 * bucket divided by its length, which is utilisation and is usually far below
 * the peak. Reporting only one of them is how a system that is idle 99% of the
 * time and briefly saturated looks either fine or overloaded, depending which
 * you picked.
 */
function sweepConcurrency(rows, w0, w1, stepMs, buckets) {
    const nowMs = Date.now();
    const events = [];
    const starts = new Array(buckets).fill(0);
    let openEnded = 0;
    let unresolved = 0;

    for (const r of rows) {
        const s = Date.parse(r.started);
        if (!Number.isFinite(s)) continue;

        let e;
        if (r.stopped) {
            e = Date.parse(r.stopped);
        } else if (RUNNING_STATUSES.has(r.status)) {
            // Genuinely in flight: it is holding a slot right now.
            e = nowMs;
            openEnded++;
        } else {
            // Finished, but nobody recorded when — a row that vanished from
            // Postgres mid-run and was written off as 'unknown', or a crash. It
            // is NOT still running, and treating it as open-ended would add a
            // permanent +1 to every bucket from its start date onwards. One such
            // row exists here, from May. Skipped, and counted so the omission is
            // visible instead of being a quiet undercount.
            unresolved++;
            continue;
        }
        if (!Number.isFinite(e) || e <= s) e = s + 1;   // zero-length still occupied a moment
        if (e <= w0 || s >= w1) continue;

        events.push([s, 1], [e, -1]);
        if (s >= w0 && s < w1) starts[Math.floor((s - w0) / stepMs)]++;
    }

    // Ends before starts at an equal timestamp: an execution finishing at the
    // instant another begins was never simultaneous with it. Sorted the other
    // way, a busy instance reports a phantom extra slot on every handover.
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const peak = new Array(buckets).fill(0);
    const area = new Array(buckets).fill(0);

    // Between two consecutive events the level is constant, so each flat stretch
    // is credited to every bucket it covers in one step.
    const credit = (from, to, level) => {
        if (level <= 0) return;
        const a = Math.max(from, w0);
        const b = Math.min(to, w1);
        if (b <= a) return;
        for (let i = Math.floor((a - w0) / stepMs); i < buckets; i++) {
            const b0 = w0 + i * stepMs;
            if (b0 >= b) break;
            const overlap = Math.min(b, b0 + stepMs) - Math.max(a, b0);
            if (overlap > 0) {
                area[i] += level * overlap;
                if (level > peak[i]) peak[i] = level;
            }
        }
    };

    let level = 0;
    let cursor = events.length ? events[0][0] : w0;
    for (const [at, delta] of events) {
        credit(cursor, at, level);
        level += delta;
        cursor = at;
    }
    credit(cursor, w1, level);

    const series = [];
    for (let i = 0; i < buckets; i++) {
        const span = Math.min(w1, w0 + (i + 1) * stepMs) - (w0 + i * stepMs);
        series.push({
            time_val: new Date(w0 + i * stepMs).toISOString(),
            peak: peak[i],
            avg: span > 0 ? Math.round((area[i] / span) * 1000) / 1000 : 0,
            started: starts[i]
        });
    }

    const busyMs = area.reduce((a, b) => a + b, 0);
    const windowMs = w1 - w0;
    const peakAt = peak.reduce((best, v, i) => (v > peak[best] ? i : best), 0);
    const totalStarts = starts.reduce((a, b) => a + b, 0);

    return {
        series,
        summary: {
            peak: peak.length ? Math.max(...peak) : 0,
            peak_at: peak.length && peak[peakAt] > 0 ? series[peakAt].time_val : null,
            // Time-weighted, over the whole window: what one "always-on worker"
            // would have been doing.
            avg: windowMs > 0 ? Math.round((busyMs / windowMs) * 10000) / 10000 : 0,
            busy_ms: busyMs,
            busy_pct: windowMs > 0 ? Math.round((busyMs / windowMs) * 10000) / 100 : 0,
            executions: totalStarts,
            // Currently in flight and counted as such.
            open_ended: openEnded,
            // Finished at an unknown time and therefore left out entirely.
            unresolved
        }
    };
}

/**
 * Each version's outcome, and how it compares with the one it replaced.
 *
 * The comparison is the point of F-11 and it is easy to get wrong: the versions
 * have to be paired within a single workflow, ordered by time. Comparing two
 * rows that merely sit next to each other in a list sorted globally by date
 * compares two unrelated workflows — which is exactly what an earlier version of
 * this did, and it read as a convincing regression that never happened.
 */
function withVersionDeltas(rows, byVersion) {
    const stats = (id) => {
        const ran = byVersion.get(id);
        if (!ran || !ran.executions) {
            return { executions: 0, errors: 0, error_rate: null, first_run: null, last_run: null };
        }
        return {
            executions: ran.executions,
            errors: ran.errors,
            error_rate: Math.round((ran.errors / ran.executions) * 10000) / 100,
            first_run: ran.first_run,
            last_run: ran.last_run
        };
    };

    // Oldest first, per workflow, so each version can look back at its
    // predecessor within the same workflow and nowhere else.
    const byWorkflow = new Map();
    for (const d of rows) {
        if (!byWorkflow.has(d.workflow_id)) byWorkflow.set(d.workflow_id, []);
        byWorkflow.get(d.workflow_id).push(d);
    }
    for (const list of byWorkflow.values()) {
        list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    }

    const deltas = new Map();
    for (const list of byWorkflow.values()) {
        let previous = null;
        for (const d of list) {
            const own = stats(d.version_id);
            if (previous && previous.error_rate !== null && own.error_rate !== null) {
                deltas.set(d.version_id, {
                    previous_version_id: previous.version_id,
                    previous_error_rate: previous.error_rate,
                    error_rate_delta: Math.round((own.error_rate - previous.error_rate) * 100) / 100
                });
            }
            // Only versions that actually ran can be a baseline; one deployed and
            // immediately replaced tells the next version nothing.
            if (own.error_rate !== null) previous = { version_id: d.version_id, ...own };
        }
    }

    return rows.map((d) => ({ ...d, ...stats(d.version_id), ...(deltas.get(d.version_id) || {}) }));
}

function expectedIntervalMs() {
    const minutes = Number(process.env.SYNC_INTERVAL_MINUTES) || 5;
    return minutes * 60000;
}

/**
 * Growth of the replica file, measured across the sync_runs history.
 *
 * Deliberately a first-to-last slope rather than a regression: the series is not
 * smooth. Retention nulls out columns and a VACUUM can drop the file by
 * hundreds of megabytes in one step, and a least-squares line through that
 * describes the maintenance, not the data. The window is reported alongside the
 * number for the same reason F-04 reports its own — sync_runs keeps a bounded
 * history (SYNC_RUN_HISTORY, 500 runs), so at a five-minute cadence this can
 * only ever see about 42 hours, and a "bytes per day" from 42 hours must say so.
 */
function growthFrom(rows) {
    const sized = rows.filter((r) => r.replica_bytes !== null && r.replica_bytes !== undefined);
    if (sized.length < 2) return { bytes_per_day: null, span_hours: null, samples: sized.length };

    const first = sized[0];
    const last = sized[sized.length - 1];
    const spanMs = Date.parse(last.started_at) - Date.parse(first.started_at);
    if (!(spanMs > 0)) return { bytes_per_day: null, span_hours: null, samples: sized.length };

    return {
        bytes_per_day: Math.round(((last.replica_bytes - first.replica_bytes) / spanMs) * 86400000),
        span_hours: +(spanMs / 3600000).toFixed(1),
        samples: sized.length,
        first_bytes: first.replica_bytes,
        last_bytes: last.replica_bytes
    };
}

/** F-02 · Executions split by how they were triggered. */
async function getTriggerBreakdown({ window: win, scope: caller, grouping }) {

    const scope = filterFor({ scope: caller, grouping }, 'e."workflowId"');
    const range = [win.startIso, win.endIso];

    const breakdownQuery = `
        SELECT e.mode,
               COUNT(*) AS total,
               ${FAILED_SUM} AS errors,
               AVG((julianday(e."stoppedAt") - julianday(e."startedAt")) * 86400) AS avg_duration,
               AVG(CASE WHEN e."createdAt" IS NOT NULL
                        THEN ${msBetween('e."startedAt"', 'e."createdAt"')} END) AS avg_lag_ms,
               COUNT(DISTINCT e."workflowId") AS workflows
          FROM execution_entity e
         WHERE e."startedAt" >= ? AND e."startedAt" <= ?
           AND e.mode IS NOT NULL${scope.sql}
         GROUP BY e.mode
         ORDER BY total DESC`;

    const seriesQuery = `
        SELECT ${bucketExpr} AS bucket_idx, e.mode,
               COUNT(*) AS total,
               ${FAILED_SUM} AS errors
          FROM execution_entity e
         WHERE e."startedAt" >= ? AND e."startedAt" <= ?
           AND e.mode IS NOT NULL${scope.sql}
         GROUP BY bucket_idx, e.mode`;

    const [breakdown, seriesRows, coverage] = await Promise.all([
        localDb.query(breakdownQuery, [...range, ...scope.params]),
        localDb.query(seriesQuery, [...bucketParams(win), ...range, ...scope.params]),
        coverageOf(scope, win, 'mode')
    ]);

    const modes = breakdown.rows.map((r) => ({
        mode: r.mode,
        total: r.total,
        errors: r.errors || 0,
        error_rate: r.total ? Math.round(((r.errors || 0) / r.total) * 10000) / 100 : 0,
        avg_duration: r.avg_duration,
        avg_lag_ms: r.avg_lag_ms,
        workflows: r.workflows
    }));

    // One dense series per mode, so the chart can stack them without having
    // to reconcile differing bucket sets between datasets.
    const series = {};
    for (const { mode } of modes) {
        const own = seriesRows.rows.filter((r) => r.mode === mode);
        series[mode] = densify(win, own, (row) => ({
            total: row ? row.total : 0,
            errors: row ? row.errors || 0 : 0
        }));
    }

    return ({
        window: { start: win.startIso, end: win.endIso, step_ms: win.stepMs },
        coverage,
        modes,
        series
    });
}

/** F-04 · Database growth, forecast from observed daily bytes. */
async function getStorageForecast({ scope: caller, grouping, days = 30 }) {
    const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
    const scope = filterFor({ scope: caller, grouping }, 'e."workflowId"');
    const horizon = await sourceHorizon();
    // Interpolated rather than bound because it prefixes three queries whose
    // other parameters differ; it is a number this function produced from a
    // Number() conversion, so there is nothing here a caller can reach.
    const sized = 'e."jsonSizeBytes" IS NOT NULL' +
        (horizon === null ? '' : ` AND e.id >= ${horizon}`);

    const totalsQuery = `
        SELECT COUNT(*) AS executions,
               SUM(e."jsonSizeBytes") AS json_bytes,
               SUM(e."binaryDataSizeBytes") AS binary_bytes,
               AVG(e."jsonSizeBytes") AS avg_json_bytes,
               MIN(e."startedAt") AS oldest,
               MAX(e."startedAt") AS newest
          FROM execution_entity e
         WHERE ${sized}${scope.sql}`;

    const byWorkflowQuery = `
        SELECT w.id AS workflow_id, w.name, w."isArchived" AS is_archived,
               COUNT(*) AS runs,
               SUM(e."jsonSizeBytes") AS json_bytes,
               SUM(e."binaryDataSizeBytes") AS binary_bytes,
               AVG(e."jsonSizeBytes") AS avg_json_bytes,
               MAX(e."startedAt") AS last_run
          FROM execution_entity e
          JOIN workflow_entity w ON w.id = e."workflowId"
         WHERE ${sized}${scope.sql}
         GROUP BY w.id
         ORDER BY SUM(e."jsonSizeBytes") DESC
         LIMIT 25`;

    const dailyQuery = `
        SELECT substr(e."startedAt", 1, 10) AS day,
               COUNT(*) AS executions,
               SUM(e."jsonSizeBytes") AS json_bytes,
               SUM(e."binaryDataSizeBytes") AS binary_bytes
          FROM execution_entity e
         WHERE ${sized} AND e."startedAt" >= ?${scope.sql}
         GROUP BY day
         ORDER BY day ASC`;

    const [totals, byWorkflow, daily] = await Promise.all([
        localDb.query(totalsQuery, scope.params),
        localDb.query(byWorkflowQuery, scope.params),
        localDb.query(dailyQuery, [sinceIso, ...scope.params])
    ]);

    const t = totals.rows[0] || {};
    const totalJson = t.json_bytes || 0;
    const retained = totalJson + (t.binary_bytes || 0);

    const workflows = byWorkflow.rows.map((r) => ({
        ...r,
        pct: totalJson ? Math.round(((r.json_bytes || 0) / totalJson) * 1000) / 10 : 0,
        bytes: (r.json_bytes || 0) + (r.binary_bytes || 0)
    }));

    return ({
        // Whether the figures below are bounded by what n8n still holds, or
        // by everything this replica happens to know a size for. The two
        // agree today and drift apart the moment n8n prunes again.
        source_bounded: horizon !== null,
        totals: {
            executions: t.executions || 0,
            json_bytes: totalJson,
            binary_bytes: t.binary_bytes || 0,
            retained_bytes: retained,
            avg_json_bytes: t.avg_json_bytes || 0,
            oldest: t.oldest || null,
            newest: t.newest || null
        },
        byWorkflow: workflows,
        daily: daily.rows,
        forecast: forecast(daily.rows, t, retained)
    });
}

/** F-05 · Retry-aware error rate — raw vs effective. */
async function getReliability({ window: win, scope: caller, grouping }) {

    const scope = filterFor({ scope: caller, grouping }, 'e."workflowId"');
    const range = [win.startIso, win.endIso];
    const inWindow = 'e."startedAt" >= ? AND e."startedAt" <= ?';

    // A retry is an execution of its own. Counting it in the denominator
    // would mean a workflow that retries twice as often looks more reliable
    // for no other reason, so the rates are taken over first attempts only.
    //
    // CAST on e.id rather than on r."retryOf": the column is TEXT here (it
    // is varchar in n8n) and idx_exec_retry_of is on it, so casting that
    // side would make the index unusable for the lookup.
    const selfHealed = `(e."retrySuccessId" IS NOT NULL
          OR EXISTS (SELECT 1 FROM execution_entity r
                      WHERE r."retryOf" = CAST(e.id AS TEXT) AND r.status = 'success'))`;

    const summaryQuery = `
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN e."retryOf" IS NULL THEN 1 ELSE 0 END) AS first_attempts,
               SUM(CASE WHEN e."retryOf" IS NOT NULL THEN 1 ELSE 0 END) AS retry_attempts,
               SUM(CASE WHEN e."retryOf" IS NULL AND ${FAILED} THEN 1 ELSE 0 END) AS failures,
               SUM(CASE WHEN e."retryOf" IS NULL AND ${FAILED} AND ${selfHealed}
                        THEN 1 ELSE 0 END) AS self_healed,
               SUM(CASE WHEN e."waitTill" IS NOT NULL THEN 1 ELSE 0 END) AS waiting
          FROM execution_entity e
         WHERE ${inWindow}${scope.sql}`;

    // A retry storm is many retries concentrated on one workflow: the
    // symptom of a problem being ridden out rather than fixed.
    const stormQuery = `
        SELECT w.name, w.id AS workflow_id, w."isArchived" AS is_archived,
               COUNT(*) AS retries,
               SUM(CASE WHEN e.status = 'success' THEN 1 ELSE 0 END) AS recovered,
               MAX(e."startedAt") AS last_retry
          FROM execution_entity e
          JOIN workflow_entity w ON w.id = e."workflowId"
         WHERE ${inWindow} AND e."retryOf" IS NOT NULL${scope.sql}
         GROUP BY w.id
         ORDER BY retries DESC
         LIMIT 10`;

    // `finished` earns its place by what it rules out, not by what it finds.
    // Every row here has finished = 0 exactly when the status is not
    // 'success', so today it is a restatement of the status column rather
    // than a second signal. Reported anyway, so that stays visible if it
    // ever stops being true — a stopped-but-not-failed execution is a real
    // state in n8n and nothing else here would show it.
    const finishedQuery = `
        SELECT SUM(CASE WHEN e.finished = 0 THEN 1 ELSE 0 END) AS unfinished,
               SUM(CASE WHEN e.finished = 0 AND e.status = 'success' THEN 1 ELSE 0 END)
                   AS unfinished_success,
               SUM(CASE WHEN e.finished = 1 AND ${FAILED} THEN 1 ELSE 0 END) AS finished_failure
          FROM execution_entity e
         WHERE ${inWindow} AND e.finished IS NOT NULL${scope.sql}`;

    const [summary, storms, finished, coverage] = await Promise.all([
        localDb.query(summaryQuery, [...range, ...scope.params]),
        localDb.query(stormQuery, [...range, ...scope.params]),
        localDb.query(finishedQuery, [...range, ...scope.params]),
        coverageOf(scope, win, 'mode')
    ]);

    const s = summary.rows[0] || {};
    const firstAttempts = s.first_attempts || 0;
    const failures = s.failures || 0;
    const healed = s.self_healed || 0;
    const rate = (x) => (firstAttempts ? Math.round((x / firstAttempts) * 10000) / 100 : 0);

    return ({
        window: { start: win.startIso, end: win.endIso },
        coverage,
        total: s.total || 0,
        first_attempts: firstAttempts,
        retry_attempts: s.retry_attempts || 0,
        waiting: s.waiting || 0,
        raw: { failures, rate: rate(failures) },
        effective: { failures: failures - healed, rate: rate(failures - healed) },
        self_healed: healed,
        recovery_rate: failures ? Math.round((healed / failures) * 10000) / 100 : 0,
        storms: storms.rows,
        finished: finished.rows[0] || { unfinished: 0, unfinished_success: 0, finished_failure: 0 }
    });
}

/** F-06 · Real concurrency by sweep line, separate from volume. */
async function getConcurrency({ window: win, scope: caller, grouping }) {

    const w0 = Date.parse(win.startIso);
    const w1 = Date.parse(win.endIso);

    // Bucket size is chosen from the span rather than inherited, because this
    // series is drawn from intervals and a coarse bucket hides exactly the
    // spike it exists to show. Five minutes for a day, wider only as needed
    // to stay under a renderable number of points.
    const stepMs = Math.max(300000, Math.ceil((w1 - w0) / TARGET_BUCKETS / 300000) * 300000);
    const buckets = Math.max(1, Math.ceil((w1 - w0) / stepMs));

    const scope = filterFor({ scope: caller, grouping }, 'e."workflowId"');
    const rows = await localDb.query(
        `SELECT e."startedAt" AS started, e."stoppedAt" AS stopped, e.status
           FROM execution_entity e
          WHERE e."startedAt" >= ? AND e."startedAt" < ?
            AND (e."stoppedAt" IS NULL OR e."stoppedAt" > ?)${scope.sql}`,
        [new Date(w0 - CONCURRENCY_LOOKBACK_MS).toISOString(), win.endIso, win.startIso,
            ...scope.params]
    );

    const result = sweepConcurrency(rows.rows, w0, w1, stepMs, buckets);

    // A ceiling to compare against, if the operator has told us what n8n's
    // is. There is no way to read N8N_CONCURRENCY_PRODUCTION_LIMIT from here
    // — it belongs to a different process — so it is a dashboard setting.
    const limitRow = await localDb.query(
        "SELECT value FROM dashboard_settings WHERE key = 'concurrency_limit'"
    );
    const rawLimit = limitRow.rows[0] && limitRow.rows[0].value;
    const limit = rawLimit ? Number(rawLimit) : null;

    return ({
        window: { start: win.startIso, end: win.endIso, step_ms: stepMs },
        limit: Number.isFinite(limit) && limit > 0 ? limit : null,
        ...result,
        // The assumption the numbers rest on, stated rather than buried.
        lookback_ms: CONCURRENCY_LOOKBACK_MS
    });
}

/** F-09 · Workflows that stopped running without failing. */
async function getSilentWorkflows({ scope: caller, grouping, k = DEFAULT_SILENCE_K }) {
    const sinceIso = new Date(Date.now() - CADENCE_WINDOW_DAYS * 86400000).toISOString();
    const scope = filterFor({ scope: caller, grouping }, 'e."workflowId"');
    const wScope = filterFor({ scope: caller, grouping }, 'w.id');

    // The clock this endpoint runs on. Everything downstream compares against
    // it rather than against Date.now().
    const freshRow = await localDb.query(
        `SELECT MAX(e."startedAt") AS newest FROM execution_entity e
          WHERE 1 = 1${scope.sql}`,
        scope.params
    );
    const dataAsOf = freshRow.rows[0] && freshRow.rows[0].newest;
    if (!dataAsOf) {
        return ({
            data_as_of: null, replica_lag_ms: null, k,
            silent: [], dormant: [], running: [], never_observed: [],
            note: 'No executions in the replica yet.'
        });
    }
    const asOfMs = Date.parse(dataAsOf);

    // Median interval between consecutive runs, per workflow. LAG over
    // (workflowId, startedAt) is served directly by idx_exec_wf_started.
    const cadenceQuery = `
        WITH runs AS (
            SELECT e."workflowId" AS wf,
                   (julianday(e."startedAt") - julianday(
                        LAG(e."startedAt") OVER (PARTITION BY e."workflowId"
                                                 ORDER BY e."startedAt")
                   )) * 86400.0 AS gap
              FROM execution_entity e
             WHERE e."startedAt" >= ?${scope.sql}
        ),
        g AS (SELECT wf, gap FROM runs WHERE gap IS NOT NULL AND gap > 0),
        r AS (SELECT wf, gap,
                     ROW_NUMBER() OVER (PARTITION BY wf ORDER BY gap) rn,
                     COUNT(*) OVER (PARTITION BY wf) n
                FROM g)
        SELECT wf, n AS gaps,
               MAX(CASE WHEN rn = 1 + CAST((n - 1) * 0.5 AS INTEGER) THEN gap END) AS median_gap,
               MAX(CASE WHEN rn = 1 + CAST((n - 1) * 0.9 AS INTEGER) THEN gap END) AS p90_gap
          FROM r GROUP BY wf, n
    `;

    // Only workflows n8n is actually supposed to be running. Archived ones
    // are excluded outright: not running is what archived means.
    const workflowQuery = `
        SELECT w.id, w.name, w."updatedAt" AS updated_at, w."triggerCount" AS trigger_count,
               (SELECT MAX(e."startedAt") FROM execution_entity e
                 WHERE e."workflowId" = w.id) AS last_run,
               (SELECT MAX(st.latest_event) FROM workflow_statistics st
                 WHERE st.workflow_id = w.id) AS last_event
          FROM workflow_entity w
         WHERE w.active = 1 AND IFNULL(w."isArchived", 0) = 0${wScope.sql}
    `;

    const [cadence, workflows] = await Promise.all([
        localDb.query(cadenceQuery, [sinceIso, ...scope.params]),
        localDb.query(workflowQuery, wScope.params)
    ]);

    const cadenceById = new Map(cadence.rows.map((r) => [r.wf, r]));
    const silent = [];
    const dormant = [];
    const running = [];
    const neverObserved = [];

    for (const w of workflows.rows) {
        // n8n's own counter can be newer than anything in the replica, because
        // it outlives pruning. Taking the later of the two is what stops a
        // pruned-clean workflow from reading as dead.
        const lastKnown = [w.last_run, w.last_event].filter(Boolean).sort().pop() || null;

        if (!lastKnown) {
            neverObserved.push({
                id: w.id, name: w.name, updated_at: w.updated_at,
                trigger_count: w.trigger_count
            });
            continue;
        }

        const c = cadenceById.get(w.id);
        const entry = {
            id: w.id,
            name: w.name,
            last_run: lastKnown,
            // Which source knew about it most recently. When they disagree it
            // means the replica is missing runs n8n has counted.
            last_run_source: w.last_event && (!w.last_run || w.last_event > w.last_run)
                ? 'n8n counter' : 'execution',
            updated_at: w.updated_at,
            gaps: c ? c.gaps : 0,
            median_gap_s: c ? c.median_gap : null,
            p90_gap_s: c ? c.p90_gap : null,
            silent_for_s: Math.max(0, (asOfMs - Date.parse(lastKnown)) / 1000),
            // Someone edited the workflow after its last run. That is the
            // difference between "it died" and "somebody turned it off", and
            // it is the one signal that separates them without asking anyone.
            changed_since_last_run: !!(w.updated_at && w.updated_at > lastKnown)
        };

        if (!c || c.gaps < MIN_GAPS_FOR_CADENCE || !c.median_gap) {
            // No rhythm to be late against, so lateness cannot be computed.
            // That is not the same as "fine": an active workflow that last
            // ran three months ago is worth seeing whether or not it had a
            // schedule, and three of them were hiding in the healthy list
            // for exactly that reason.
            entry.verdict = entry.silent_for_s > DORMANT_DAYS * 86400
                ? 'dormant' : 'no-cadence';
            (entry.verdict === 'dormant' ? dormant : running).push(entry);
            continue;
        }

        entry.overdue_ratio = Math.round((entry.silent_for_s / c.median_gap) * 10) / 10;
        if (entry.overdue_ratio > k) {
            entry.verdict = entry.changed_since_last_run ? 'stopped-after-change' : 'silent';
            silent.push(entry);
        } else {
            entry.verdict = 'running';
            running.push(entry);
        }
    }

    silent.sort((a, b) => b.overdue_ratio - a.overdue_ratio);
    dormant.sort((a, b) => b.silent_for_s - a.silent_for_s);

    return ({
        // The clock everything above was measured against, and how far behind
        // the wall clock it is. A large lag means this answer is about a
        // snapshot, and the panel says so instead of reporting phantom deaths.
        data_as_of: dataAsOf,
        replica_lag_ms: Date.now() - asOfMs,
        k,
        // Four states, because the data has four and collapsing any of them
        // either hides a problem or invents one.
        //   silent  — has a cadence and has missed it
        //   dormant — active, has run before, nothing for a month, no cadence
        //   running — on schedule, or recently enough not to matter
        //   never   — active and has never been observed running at all
        silent,
        dormant,
        running,
        never_observed: neverObserved
    });
}

/** The workflow picker list. */
async function getWorkflows({ scope: caller, grouping }) {
    const scope = filterFor({ scope: caller, grouping }, 'w.id');
    const rows = await localDb.query(
        `SELECT w.id, w.name, w.active, w."isArchived" AS is_archived,
                w."parentFolderId" AS folder_id, w."triggerCount" AS trigger_count,
                w.description, w."updatedAt" AS updated_at,
                (SELECT MAX(e."startedAt") FROM execution_entity e
                  WHERE e."workflowId" = w.id) AS last_run
           FROM workflow_entity w
          WHERE 1 = 1${scope.sql}
          ORDER BY w."isArchived" ASC, w.name COLLATE NOCASE ASC`,
        scope.params
    );
    return (rows.rows);
}

/** F-16 · Folders, tags and projects. */
async function getOrganisation({ window: win, scope: caller, grouping }) {

    const scope = filterFor({ scope: caller, grouping }, 'e."workflowId"');
    const wScope = filterFor({ scope: caller, grouping }, 'w.id');
    const range = [win.startIso, win.endIso];

    // Executions and failures per workflow, once. Everything below is this
    // rolled up a different way.
    const perWorkflowQuery = `
        SELECT e."workflowId" AS workflow_id, COUNT(*) AS total, ${FAILED_SUM} AS errors
          FROM execution_entity e
         WHERE e."startedAt" >= ? AND e."startedAt" <= ?${scope.sql}
         GROUP BY e."workflowId"
    `;

    const [folders, tags, workflowTags, workflows, perWorkflow, projects] = await Promise.all([
        localDb.query('SELECT id, name, parent_folder_id, project_id FROM folder'),
        localDb.query('SELECT id, name FROM tag_entity'),
        localDb.query('SELECT workflow_id, tag_id FROM workflows_tags'),
        localDb.query(
            `SELECT w.id, w.name, w."parentFolderId" AS folder_id, w.active,
                    w."isArchived" AS is_archived
               FROM workflow_entity w WHERE 1 = 1${wScope.sql}`, wScope.params),
        localDb.query(perWorkflowQuery, [...range, ...scope.params]),
        localDb.query('SELECT id, name, type FROM project')
    ]);

    const statsById = new Map(perWorkflow.rows.map((r) => [r.workflow_id, r]));
    const stat = (id) => statsById.get(id) || { total: 0, errors: 0 };

    // Direct totals first, then rolled up the tree. Two passes rather than a
    // recursive query because the tree is fifteen nodes and this is clearer
    // than the SQL that would replace it.
    const byFolder = new Map(folders.rows.map((f) => [f.id, {
        id: f.id, name: f.name, parent_folder_id: f.parent_folder_id,
        project_id: f.project_id, workflows: 0, executions: 0, errors: 0,
        total_workflows: 0, total_executions: 0, total_errors: 0
    }]));
    const unfiled = {
        id: null, name: 'No folder', parent_folder_id: null, project_id: null,
        workflows: 0, executions: 0, errors: 0,
        total_workflows: 0, total_executions: 0, total_errors: 0
    };

    for (const w of workflows.rows) {
        if (w.is_archived) continue;
        const bucket = (w.folder_id && byFolder.get(w.folder_id)) || unfiled;
        const st = stat(w.id);
        bucket.workflows++;
        bucket.executions += st.total;
        bucket.errors += st.errors;
    }

    // Roll each folder's own numbers up to every ancestor. Depth-bounded so a
    // cycle in the data — which should be impossible, and would otherwise
    // hang the request — cannot spin forever.
    for (const f of byFolder.values()) {
        let node = f;
        let depth = 0;
        while (node && depth++ < 32) {
            node.total_workflows += f.workflows;
            node.total_executions += f.executions;
            node.total_errors += f.errors;
            node = node.parent_folder_id ? byFolder.get(node.parent_folder_id) : null;
        }
    }

    const tagsById = new Map(tags.rows.map((t) => [t.id, {
        id: t.id, name: t.name, workflows: 0, executions: 0, errors: 0
    }]));
    const visible = new Set(workflows.rows.map((w) => w.id));
    for (const wt of workflowTags.rows) {
        const t = tagsById.get(wt.tag_id);
        if (!t || !visible.has(wt.workflow_id)) continue;
        const st = stat(wt.workflow_id);
        t.workflows++;
        t.executions += st.total;
        t.errors += st.errors;
    }

    const withRate = (x) => ({
        ...x,
        error_rate: x.total_executions
            ? Math.round((x.total_errors / x.total_executions) * 10000) / 100
            : (x.executions ? Math.round((x.errors / x.executions) * 10000) / 100 : 0)
    });

    return ({
        window: { start: win.startIso, end: win.endIso },
        folders: [...byFolder.values(), unfiled]
            .filter((f) => f.total_workflows > 0)
            .map(withRate)
            .sort((a, b) => b.total_executions - a.total_executions),
        tags: [...tagsById.values()].map((t) => ({
            ...t,
            error_rate: t.executions ? Math.round((t.errors / t.executions) * 10000) / 100 : 0
        })).sort((a, b) => b.workflows - a.workflows),
        projects: projects.rows
    });
}

/** F-10 · Blast radius — what each credential and sub-workflow reaches. */
async function getDependencies({ window: win, scope: caller, grouping }) {

    const scope = filterFor({ scope: caller, grouping }, 'e."workflowId"');
    const dScope = filterFor({ scope: caller, grouping }, 'd.workflow_id');
    const range = [win.startIso, win.endIso];

    // Error rate per workflow over the window, joined onto each dependency so
    // "which credential is involved in the most failures" is answerable
    // rather than just "which is most used".
    const health = `
        SELECT e."workflowId" AS wf, COUNT(*) AS total, ${FAILED_SUM} AS errors
          FROM execution_entity e
         WHERE e."startedAt" >= ? AND e."startedAt" <= ?${scope.sql}
         GROUP BY e."workflowId"
    `;

    const credentialsQuery = `
        WITH h AS (${health})
        SELECT d.dependency_key AS id,
               COALESCE(c.name, '(unknown credential)') AS name,
               c.type,
               COUNT(DISTINCT d.workflow_id) AS workflows,
               SUM(COALESCE(h.total, 0)) AS executions,
               SUM(COALESCE(h.errors, 0)) AS errors,
               GROUP_CONCAT(DISTINCT w.name) AS workflow_names
          FROM workflow_dependency d
          LEFT JOIN credentials_entity c ON c.id = d.dependency_key
          LEFT JOIN workflow_entity w ON w.id = d.workflow_id
          LEFT JOIN h ON h.wf = d.workflow_id
         WHERE d.dependency_type = 'credentialId'${dScope.sql}
         GROUP BY d.dependency_key
         ORDER BY workflows DESC
         LIMIT 50
    `;

    const nodeTypesQuery = `
        SELECT d.dependency_key AS node_type,
               COUNT(DISTINCT d.workflow_id) AS workflows
          FROM workflow_dependency d
         WHERE d.dependency_type = 'nodeType'${dScope.sql}
         GROUP BY d.dependency_key
         ORDER BY workflows DESC
         LIMIT 50
    `;

    // Sub-workflow calls and error workflows: one broken child takes N
    // parents with it, and nothing in n8n draws that edge.
    const callsQuery = `
        SELECT d.dependency_type AS kind,
               parent.name AS parent_name, d.workflow_id AS parent_id,
               d.dependency_key AS child_id,
               child.name AS child_name
          FROM workflow_dependency d
          LEFT JOIN workflow_entity parent ON parent.id = d.workflow_id
          LEFT JOIN workflow_entity child ON child.id = d.dependency_key
         WHERE d.dependency_type IN ('workflowCall', 'errorWorkflow')${dScope.sql}
         ORDER BY d.dependency_type, parent.name
    `;

    const [credentials, nodeTypes, calls] = await Promise.all([
        localDb.query(credentialsQuery, [...range, ...scope.params, ...dScope.params]),
        localDb.query(nodeTypesQuery, dScope.params),
        localDb.query(callsQuery, dScope.params)
    ]);

    return ({
        window: { start: win.startIso, end: win.endIso },
        credentials: credentials.rows.map((r) => ({
            ...r,
            workflow_names: r.workflow_names ? r.workflow_names.split(',').slice(0, 5) : [],
            error_rate: r.executions
                ? Math.round((r.errors / r.executions) * 10000) / 100 : 0
        })),
        nodeTypes: nodeTypes.rows,
        calls: calls.rows
    });
}

/** F-11 · Deploys, and the error rate on either side of them. */
async function getDeploys({ window: win, scope: caller, grouping, includeAutosaves = false }) {

    const scope = filterFor({ scope: caller, grouping }, 'e."workflowId"');
    const hScope = filterFor({ scope: caller, grouping }, 'h.workflow_id');

    const deploysQuery = `
        SELECT h.version_id, h.workflow_id, h.authors, h.created_at, h.autosaved,
               -- The workflow's name, not the version's. n8n stores a label
               -- like "Version 228d1b6b" in workflow_history.name, so
               -- COALESCE(h.name, w.name) picked the label and threw away the
               -- one piece of information a reader needs: which workflow.
               w.name AS workflow_name,
               h.name AS version_name
          FROM workflow_history h
          LEFT JOIN workflow_entity w ON w.id = h.workflow_id
         WHERE h.created_at >= ? AND h.created_at <= ?
           ${includeAutosaves ? '' : 'AND IFNULL(h.autosaved, 0) = 0'}${hScope.sql}
         ORDER BY h.created_at DESC
         LIMIT 200
    `;

    // What each version actually ran, and how it went. workflowVersionId is
    // mirrored on the execution (F-01), so this is a plain group-by rather
    // than a guess from timestamps.
    const perVersionQuery = `
        SELECT e."workflowVersionId" AS version_id,
               COUNT(*) AS executions,
               ${FAILED_SUM} AS errors,
               MIN(e."startedAt") AS first_run,
               MAX(e."startedAt") AS last_run
          FROM execution_entity e
         WHERE e."startedAt" >= ? AND e."startedAt" <= ?
           AND e."workflowVersionId" IS NOT NULL${scope.sql}
         GROUP BY e."workflowVersionId"
    `;

    const [deploys, perVersion, coverage] = await Promise.all([
        localDb.query(deploysQuery, [win.startIso, win.endIso, ...hScope.params]),
        localDb.query(perVersionQuery, [win.startIso, win.endIso, ...scope.params]),
        coverageOf(scope, win, 'workflowVersionId')
    ]);

    const byVersion = new Map(perVersion.rows.map((r) => [r.version_id, r]));

    return ({
        window: { start: win.startIso, end: win.endIso },
        coverage,
        includes_autosaves: includeAutosaves,
        deploys: withVersionDeltas(deploys.rows, byVersion),
        // Versions that ran but have no history row — n8n prunes workflow
        // history too, so an execution can outlive the version that produced
        // it. Reported rather than dropped, because otherwise the totals in
        // this panel would quietly fall short of the dashboard's.
        orphan_versions: perVersion.rows.filter(
            (r) => !deploys.rows.some((d) => d.version_id === r.version_id)
        ).length
    });
}

/** F-18 · Business metadata keys (never their values). */
async function getMetadataKeys({ scope: caller, grouping }) {
    const scope = filterFor({ scope: caller, grouping }, 'e."workflowId"');
    const MAX_VALUES_PER_KEY = 50;

    const keys = await localDb.query(
        `SELECT m.key,
                COUNT(*) AS occurrences,
                COUNT(DISTINCT m.value) AS distinct_values,
                SUM(CASE WHEN m.truncated = 1 THEN 1 ELSE 0 END) AS truncated,
                MAX(LENGTH(m.value)) AS max_length
           FROM execution_metadata m
           JOIN execution_entity e ON e.id = m.execution_id
          WHERE 1 = 1${scope.sql}
          GROUP BY m.key
          ORDER BY occurrences DESC`,
        scope.params
    );

    // Only for keys that behave like a dimension. A key with thousands of
    // distinct values is a payload field, not a facet, and listing it would
    // be both useless as a filter and a way to page the whole column out
    // through an endpoint that looks like a schema query.
    const facetKeys = keys.rows
        .filter((k) => k.distinct_values > 0 && k.distinct_values <= MAX_VALUES_PER_KEY)
        .map((k) => k.key);

    let values = [];
    if (facetKeys.length > 0) {
        const placeholders = facetKeys.map(() => '?').join(',');
        const r = await localDb.query(
            `SELECT m.key, m.value, COUNT(*) AS n
               FROM execution_metadata m
               JOIN execution_entity e ON e.id = m.execution_id
              WHERE m.key IN (${placeholders})${scope.sql}
              GROUP BY m.key, m.value
              ORDER BY m.key, n DESC`,
            [...facetKeys, ...scope.params]
        );
        values = r.rows;
    }

    return ({
        keys: keys.rows,
        values,
        // So the front end can say why a key has no filter offered.
        max_values_per_key: MAX_VALUES_PER_KEY
    });
}

/** F-12 · Where the time goes, per node. */
async function getNodeProfile({ scope: caller, grouping, workflowId = null }) {
    const restriction = filterFor({ scope: caller, grouping }, 'p.workflow_id');
    const focus = workflowId ? ' AND p.workflow_id = ?' : '';
    const focusParams = workflowId ? [workflowId] : [];

    const [nodes, workflows, edges, coverage] = await Promise.all([
        localDb.query(
            `SELECT p.workflow_id, w.name AS workflow_name, IFNULL(w."isArchived", 0) AS is_archived,
                    p.node_name, p.node_type, p.samples, p.runs, p.total_ms, p.max_ms,
                    p.items_out, p.failed_runs, p.is_sub_node,
                    ROUND(CAST(p.total_ms AS REAL) / p.samples, 1) AS ms_per_execution,
                    ROUND(CAST(p.runs AS REAL) / p.samples, 2) AS runs_per_execution,
                    CASE WHEN p.items_out IS NULL THEN NULL
                         ELSE ROUND(CAST(p.items_out AS REAL) / p.samples, 1) END AS items_per_execution,
                    s.sampled_at
               FROM workflow_node_profile p
               JOIN workflow_entity w ON w.id = p.workflow_id
               LEFT JOIN workflow_profile_state s ON s.workflow_id = p.workflow_id
              WHERE p.samples > 0${focus}${restriction.sql}
              ORDER BY ms_per_execution DESC
              LIMIT ?`,
            [...focusParams, ...restriction.params, workflowId ? 200 : 30]
        ),

        // Per workflow: how much time the sample accounts for, and how much
        // of it one node owns. Concentration is the actionable part — a
        // workflow spending 90% in one node has somewhere to start, one
        // spread evenly across eight does not.
        localDb.query(
            `WITH n AS (
                 SELECT p.workflow_id,
                        SUM(p.total_ms) AS total_ms,
                        MAX(p.total_ms) AS top_ms,
                        COUNT(*) AS nodes,
                        MAX(p.samples) AS samples,
                        SUM(p.failed_runs) AS failed_runs
                   FROM workflow_node_profile p
                  WHERE 1 = 1${restriction.sql}
                  GROUP BY p.workflow_id
             )
             SELECT n.*, w.name AS workflow_name, IFNULL(w."isArchived", 0) AS is_archived,
                    s.sampled_at, s.executions_sampled, s.executions_unreadable,
                    s.total_wall_ms,
                    (SELECT p2.node_name FROM workflow_node_profile p2
                      WHERE p2.workflow_id = n.workflow_id
                      ORDER BY p2.total_ms DESC LIMIT 1) AS top_node,
                    ROUND(CAST(n.top_ms AS REAL) / NULLIF(n.total_ms, 0) * 100, 1) AS top_share,
                    ROUND(CAST(n.total_ms AS REAL) / NULLIF(n.samples, 0), 1) AS ms_per_execution
               FROM n
               JOIN workflow_entity w ON w.id = n.workflow_id
               LEFT JOIN workflow_profile_state s ON s.workflow_id = n.workflow_id
              ORDER BY ms_per_execution DESC
              LIMIT 40`,
            restriction.params
        ),

        // Item flow. Only edges where the count actually changes — an edge
        // that passes items straight through is the overwhelming majority
        // (11 of 16 measured) and listing them buries the five that matter.
        localDb.query(
            `SELECT e.workflow_id, w.name AS workflow_name, e.from_node, e.to_node,
                    e.samples, e.runs, e.items_in, e.items_out,
                    ROUND(CAST(e.items_out AS REAL) / NULLIF(e.items_in, 0), 3) AS ratio
               FROM workflow_edge_profile e
               JOIN workflow_entity w ON w.id = e.workflow_id
              WHERE e.items_in <> e.items_out
                AND e.items_in > 0${focus.replace('p.workflow_id', 'e.workflow_id')}${
restriction.sql.split('p.workflow_id').join('e.workflow_id')}
              ORDER BY ABS(e.items_in - e.items_out) DESC
              LIMIT 25`,
            [...focusParams, ...restriction.params]
        ),

        localDb.query(
            `SELECT
                 (SELECT COUNT(*) FROM workflow_profile_state) AS profiled,
                 (SELECT COUNT(*) FROM workflow_entity
                   WHERE IFNULL("isArchived", 0) = 0) AS workflows,
                 (SELECT MIN(sampled_at) FROM workflow_profile_state) AS oldest_sample,
                 (SELECT MAX(sampled_at) FROM workflow_profile_state) AS newest_sample,
                 (SELECT SUM(executions_unreadable) FROM workflow_profile_state) AS unreadable`
        )
    ]);

    const c = coverage.rows[0] || {};
    return ({
        focus: workflowId || null,
        nodes: nodes.rows,
        workflows: workflows.rows,
        flow: edges.rows,
        coverage: {
            profiled_workflows: c.profiled || 0,
            active_workflows: c.workflows || 0,
            oldest_sample: c.oldest_sample || null,
            newest_sample: c.newest_sample || null,
            unreadable_executions: c.unreadable || 0,
            // Said out loud rather than left to be inferred from two
            // numbers that happen to be printed next to each other.
            note: (c.profiled || 0) < (c.workflows || 0)
                ? `${c.profiled || 0} of ${c.workflows || 0} active workflows have been ` +
                  'profiled so far; the rest are sampled a few per sync cycle.'
                : 'Every active workflow has a profile.'
        }
    });
}

/** F-19 · The dashboard observing itself. */
/**
 * The denominator for the catch-up percentage.
 *
 * A backlog on its own is a count going down, and a count going down is not
 * progress — "84,000 rows to go" tells somebody nothing about whether to wait
 * or come back tomorrow. The baseline is the backlog when the catch-up started,
 * written once and cleared when it reaches zero, so the percentage only ever
 * moves forward and means what it appears to mean.
 *
 * Recorded by the reader rather than by the sync, which looks backwards and is
 * deliberate: the sync would have to know it is *starting* a catch-up, and the
 * only honest way to know that is to compare against the previous value — which
 * is what this does anyway, once, in the place that needs the number.
 */
const { syncBacklog, CATCHUP_BASELINE_KEY } = require('./syncDao');

/**
 * Turns a backlog into something a person can act on.
 *
 * Three states, and the difference between them is what somebody should do:
 *
 *   `first_run`  — nothing has been synced yet, or the first pass is still
 *                  going. The pages are empty and that is not a fault. Wait.
 *   `catching_up`— there is data on the pages and it is INCOMPLETE. This is the
 *                  dangerous one: every figure reads as authoritative and every
 *                  one of them is a floor. Wait, and distrust totals until it
 *                  finishes.
 *   `null`       — nothing owed. Say nothing.
 *
 * A stale replica is NOT one of these. "The pipeline has not run for an hour"
 * is a different problem with a different remedy, and it is already reported by
 * `pipeline.status`; folding the two together would tell somebody to wait for a
 * catch-up that is not happening.
 */
function catchUpState(backlog, baseline, { passes, hasData }) {
    const total = backlog ? backlog.total : 0;

    if (total <= 0) {
        return {
            active: false,
            // Said explicitly rather than left to be inferred from `active`,
            // because "the first sync has never run" and "everything is up to
            // date" are opposite situations that both have an empty backlog.
            phase: passes === 0 ? 'never_run' : 'complete',
            remaining: 0,
            pct: passes === 0 ? 0 : 100
        };
    }

    const from = Math.max(baseline, total);
    return {
        active: true,
        phase: (!hasData || passes <= 1) ? 'first_run' : 'catching_up',
        remaining: total,
        baseline: from,
        // Floored at 1 while there is anything left, so a catch-up in its first
        // seconds does not display as the 100% it is nearly at by rounding.
        pct: Math.min(99, Math.max(1, Math.round(((from - total) / from) * 100))),
        stage: backlog.stage,
        breakdown: {
            executions: backlog.executions,
            details: backlog.mirrored,
            errors: backlog.analytics,
            grouping: backlog.fingerprints
        }
    };
}

async function getSystemHealth({ brief = false }) {
    const nowMs = Date.now();
    const dayAgo = new Date(nowMs - 86400000).toISOString();

    // ?brief=1 answers only "is it running and how old is the data". The
    // header asks this on every page load of every page, and the full
    // version counts half a million rows and returns several hundred run
    // records to do it — a cost worth paying once on a settings panel and
    // never worth paying for a five-word status line.
    if (brief) {
        const [run, fresh, backlog, baseline, passes] = await Promise.all([
            localDb.query(
                'SELECT finished_at, status, error_message FROM sync_runs ORDER BY id DESC LIMIT 1'
            ),
            localDb.query('SELECT MAX("startedAt") AS newest FROM execution_entity'),
            syncBacklog(),
            localDb.query(
                'SELECT value FROM dashboard_settings WHERE key = ?', [CATCHUP_BASELINE_KEY]
            ),
            localDb.query('SELECT COUNT(*) AS n FROM sync_runs')
        ]);
        const r = run.rows[0] || null;
        const newestIso = fresh.rows[0].newest;
        const sinceMs = r ? nowMs - Date.parse(r.finished_at) : null;
        const every = expectedIntervalMs();

        return ({
            brief: true,
            pipeline: {
                status: sinceMs === null ? 'unknown'
                    : sinceMs > every * 3 ? 'stalled'
                        : sinceMs > every * 1.5 ? 'late' : 'ok',
                expected_interval_ms: every,
                last_run_at: r ? r.finished_at : null,
                since_last_run_ms: sinceMs,
                last_status: r ? r.status : null,
                last_error: r ? r.error_message : null
            },
            data: {
                newest_execution: newestIso,
                data_age_ms: newestIso ? nowMs - Date.parse(newestIso) : null
            },
            catching_up: catchUpState(backlog, Number(baseline.rows[0]?.value) || 0, {
                // "Has this replica ever been filled?" A count of passes rather
                // than a flag, because it is already recorded and a flag would be
                // a second thing to keep true.
                passes: Number(passes.rows[0].n) || 0,
                hasData: Boolean(newestIso)
            })
        });
    }

    const [runs, last, day, freshness, queue, oldestPending, fingerprints, settings, pragmas] =
        await Promise.all([
            // Ascending, because growthFrom and the sparkline both read it in
            // time order and reversing it in two places is how they drift.
            localDb.query(
                `SELECT started_at, duration_ms, status, executions, errors,
                        analytics_done, analytics_failed, analytics_queued, replica_bytes
                   FROM sync_runs ORDER BY started_at ASC`
            ),
            localDb.query('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1'),
            localDb.query(
                `SELECT COUNT(*) AS total,
                        SUM(CASE WHEN status = '${SYNC_OK}' THEN 1 ELSE 0 END) AS ok,
                        SUM(CASE WHEN status <> '${SYNC_OK}' THEN 1 ELSE 0 END) AS failed,
                        SUM(executions) AS executions,
                        MAX(duration_ms) AS max_ms
                   FROM sync_runs WHERE started_at >= ?`,
                [dayAgo]
            ),
            localDb.query(
                `SELECT MAX("startedAt") AS newest_execution,
                        COUNT(*) AS executions FROM execution_entity`
            ),
            localDb.query(
                `SELECT analytics_status AS status, COUNT(*) AS n
                   FROM execution_entity
                  WHERE analytics_status IS NOT NULL
                  GROUP BY analytics_status`
            ),
            localDb.query(
                `SELECT MIN("startedAt") AS oldest FROM execution_entity
                  WHERE analytics_status = 'pending'`
            ),
            localDb.query(
                `SELECT (SELECT COUNT(*) FROM error_fingerprints) AS groups,
                        (SELECT COUNT(*) FROM execution_error_analytics
                          WHERE fingerprint IS NULL) AS unfingerprinted,
                        (SELECT COUNT(*) FROM error_fingerprints
                          WHERE status <> 'open') AS triaged`
            ),
            localDb.query(
                `SELECT key, value FROM dashboard_settings
                  WHERE key IN ('last_vacuum_at', 'source_oldest_execution_id',
                                'backfill_009_cursor', 'fingerprint_cursor',
                                'fingerprint_version', 'classifier_version')`
            ),
            // Page counts are header reads, not scans.
            Promise.all([
                localDb.query('PRAGMA page_count'),
                localDb.query('PRAGMA page_size'),
                localDb.query('PRAGMA freelist_count')
            ])
        ]);

    const setting = (key) => {
        const row = settings.rows.find((r) => r.key === key);
        return row ? row.value : null;
    };

    const pageCount = pragmas[0].rows[0].page_count;
    const pageSize = pragmas[1].rows[0].page_size;
    const freelist = pragmas[2].rows[0].freelist_count;

    const lastRun = last.rows[0] || null;
    const lastSuccess = [...runs.rows].reverse().find((r) => r.status === SYNC_OK) || null;

    // Consecutive failures, newest first. A single failed cycle is noise —
    // Postgres restarts, locks time out — and a streak is an outage. The two
    // must not read the same, so the number is given rather than a boolean.
    let streak = 0;
    for (let i = runs.rows.length - 1; i >= 0; i--) {
        if (runs.rows[i].status === SYNC_OK) break;
        streak++;
    }

    const durations = runs.rows
        .map((r) => r.duration_ms)
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
    const at = (p) => (durations.length
        ? durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * p))]
        : null);

    const newest = freshness.rows[0].newest_execution;
    const interval = expectedIntervalMs();
    const sinceSyncMs = lastRun ? nowMs - Date.parse(lastRun.finished_at) : null;

    // Three states, not two. "Stalled" is a claim worth making only when the
    // scheduler has had several chances and taken none of them; one missed
    // tick is a slow cycle, and calling that an outage is how a health
    // indicator gets ignored.
    let pipeline = 'unknown';
    if (sinceSyncMs !== null) {
        if (sinceSyncMs > interval * 3) pipeline = 'stalled';
        else if (sinceSyncMs > interval * 1.5) pipeline = 'late';
        else pipeline = 'ok';
    }

    const byStatus = Object.fromEntries(queue.rows.map((r) => [r.status, r.n]));

    return ({
        generated_at: new Date(nowMs).toISOString(),
        pipeline: {
            status: pipeline,
            expected_interval_ms: interval,
            last_run_at: lastRun ? lastRun.finished_at : null,
            since_last_run_ms: sinceSyncMs,
            last_success_at: lastSuccess ? lastSuccess.started_at : null,
            last_status: lastRun ? lastRun.status : null,
            last_error: lastRun ? lastRun.error_message : null,
            consecutive_failures: streak
        },
        data: {
            // Freshness of the data, which is a different question from
            // freshness of the pipeline, and every silence-based feature in
            // this codebase is measured against this one.
            newest_execution: newest,
            data_age_ms: newest ? nowMs - Date.parse(newest) : null,
            executions: freshness.rows[0].executions,
            source_oldest_execution_id: setting('source_oldest_execution_id')
        },
        runs: {
            window_hours: 24,
            total: day.rows[0].total || 0,
            ok: day.rows[0].ok || 0,
            failed: day.rows[0].failed || 0,
            executions: day.rows[0].executions || 0,
            duration_ms: { p50: at(0.5), p95: at(0.95), max: day.rows[0].max_ms || null },
            // The whole retained history, for the sparkline. Bounded by
            // SYNC_RUN_HISTORY, so this is a few hundred points at most.
            history: runs.rows
        },
        queue: {
            pending: byStatus.pending || 0,
            failed: byStatus.failed || 0,
            done: byStatus.done || 0,
            oldest_pending_at: oldestPending.rows[0].oldest || null
        },
        fingerprints: {
            groups: fingerprints.rows[0].groups,
            unfingerprinted: fingerprints.rows[0].unfingerprinted,
            triaged: fingerprints.rows[0].triaged,
            version: setting('fingerprint_version'),
            classifier_version: setting('classifier_version'),
            cursor: setting('fingerprint_cursor')
        },
        storage: {
            bytes: pageCount * pageSize,
            page_size: pageSize,
            free_pages: freelist,
            // What a VACUUM would give back. This is the number the "when
            // was the last VACUUM" question was really asking.
            reclaimable_bytes: freelist * pageSize,
            last_vacuum_at: setting('last_vacuum_at'),
            growth: growthFrom(runs.rows)
        },
        backfills: {
            // Null cursor means the pass has finished and dropped its
            // scaffold index; it is not an error state.
            mirror_cursor: setting('backfill_009_cursor'),
            fingerprint_cursor: setting('fingerprint_cursor')
        }
    });
}

module.exports = {
    getTriggerBreakdown,
    getStorageForecast,
    getReliability,
    getConcurrency,
    getSilentWorkflows,
    getWorkflows,
    getOrganisation,
    getDependencies,
    getDeploys,
    getMetadataKeys,
    getNodeProfile,
    getSystemHealth,

    // Exported so the controller can clamp `?k=` against the same default this
    // file uses, rather than restating it as a literal and letting the two
    // drift.
    DEFAULT_SILENCE_K,

    // The pure arithmetic the tests assert on directly. Re-exported through
    // insightsController._internal as well, so the suite keeps its existing
    // entry point while there goes on being one implementation.
    _internal: {
        forecast, sweepConcurrency, growthFrom, withVersionDeltas, expectedIntervalMs, catchUpState
    }
};
