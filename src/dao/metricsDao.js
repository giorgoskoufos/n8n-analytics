/**
 * Dashboard metrics — the SQL behind the main page.
 *
 * Lifted out of metricsController. See dao/shared.js for why, and for the rule
 * this layer follows: domain values in, data out, never a `req` and never a
 * status code. Validation that could only run next to the data throws
 * `daoError`, which the controller translates.
 */

const localDb = require('../config/localDb');
const { pool } = require('../config/db');
const { parse } = require('flatted');
// No `scopeClause` here any more: every query in this file narrows through
// `filterFor`, which applies the caller's scope AND whatever they asked to
// filter by. Importing the half that only does the first is how a call site
// ends up silently dropping the second — which is exactly what four functions
// in this file were doing: taking a `grouping` argument and never reading it.
const { canSeeWorkflow } = require('../utils/scope');
const { parseIsoDate, parseDateRange, parseExecutionMode } = require('../utils/validate');
const { summariseTrace } = require('../utils/trace');
const { filterFor, daoError, isoDaysAgo, isoHoursAgo } = require('./shared');
const log = require('../utils/logger').logger('DAO');

/**
 * A dense 288-bucket series of execution STARTS, counted in SQL.
 *
 * One helper for both callers below, and for the ETL's own version of the same
 * arithmetic, so a scoped user, an unscoped user and the cached series all land
 * their counts on exactly the same five-minute grid. Empty buckets are present
 * as zero rather than omitted — a sparse result would let the chart close the
 * gaps and draw a quiet night as a straight line between two busy hours.
 */
async function volumeSeries(scope, originMs, buckets = 288, mode = null) {
    const STEP_MS = 5 * 60 * 1000;
    const originIso = new Date(originMs).toISOString();
    const endIso = new Date(originMs + buckets * STEP_MS).toISOString();
    const scoped = scope || { sql: '', params: [] };
    const modeSql = mode ? ' AND mode = ?' : '';
    const modeParams = mode ? [mode] : [];

    const rows = await localDb.query(
        `SELECT CAST((julianday("startedAt") - julianday(?)) * 86400.0 / 300 AS INTEGER) AS bucket_idx,
                COUNT(*) AS started_count
           FROM execution_entity
          WHERE "startedAt" >= ? AND "startedAt" < ?${modeSql}${scoped.sql}
          GROUP BY bucket_idx`,
        [originIso, originIso, endIso, ...modeParams, ...scoped.params]
    );

    const byIndex = new Map(rows.rows.map(r => [r.bucket_idx, r.started_count]));
    const series = [];
    for (let i = 0; i < buckets; i++) {
        series.push({
            timestamp: new Date(originMs + i * STEP_MS).toISOString(),
            started_count: byIndex.get(i) || 0
        });
    }
    return series;
}



/** The dashboard KPIs and their bucketed series. */
async function getMetrics({ scope: caller, grouping, filters = {} }) {
    const targetWorkflow = filters.workflow;

    const range = parseDateRange(filters.startDate, filters.endDate);
    if (!range.ok) throw daoError(400, range.error);

    // F-02. Every figure on the dashboard can now be narrowed to one trigger
    // type, because a webhook failure and a schedule failure are different
    // problems and the combined rate describes neither of them.
    const mode = parseExecutionMode(filters.mode);
    if (!mode.ok) throw daoError(400, mode.error);

    let startIso, endIso, prevStartIso, prevEndIso;
    const isCustom = true;
    let bucketUnit = 'hour';
    let durationMs;

    if (range.start && range.end) {
        startIso = range.start.toISOString();
        endIso = range.end.toISOString();
        durationMs = range.end.getTime() - range.start.getTime();

        // Range Cap: 60 days
        const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
        if (durationMs > SIXTY_DAYS_MS) {
            durationMs = SIXTY_DAYS_MS;
            startIso = new Date(range.end.getTime() - SIXTY_DAYS_MS).toISOString();
        }

        prevEndIso = startIso;
        prevStartIso = new Date(new Date(startIso).getTime() - durationMs).toISOString();

        if (durationMs > 4 * 24 * 60 * 60 * 1000) {
            bucketUnit = 'day';
        }
    } else {
        // Robust Fallback: Default to 7 days
        const now = new Date();
        durationMs = 7 * 24 * 3600000;
        startIso = new Date(now.getTime() - durationMs).toISOString();
        endIso = now.toISOString();
        prevEndIso = startIso;
        prevStartIso = new Date(new Date(startIso).getTime() - durationMs).toISOString();
        bucketUnit = 'day';
    }

    // Standardize filters for all queries.
    // Date bounds are bound parameters and the column is compared directly
    // rather than through datetime(), so these can use idx_exec_started.
    const wfFilterClause = targetWorkflow ? 'AND w.name = ?' : '';
    const wfJoinClause = targetWorkflow ? 'JOIN workflow_entity w ON e."workflowId" = w.id' : '';
    const wfParam = targetWorkflow ? [targetWorkflow] : [];

    // Rows without a mode are rows the backfill could not reach, so a mode
    // filter necessarily excludes them. That is correct — they are not
    // "mode X" — and it is also why the filter is opt-in rather than a
    // default: unfiltered, the dashboard still counts every execution.
    const modeFilterClause = mode.mode ? 'AND e.mode = ?' : '';
    const modeParam = mode.mode ? [mode.mode] : [];

    // Appended last in every WHERE below, so its parameters are always last too.
    const scope = filterFor({ scope: caller, grouping }, 'e."workflowId"');

    // Order matters: the date bounds appear in the WHERE clause before the
    // optional workflow filter that wfFilterClause appends after them, then
    // the mode filter, and the scope filter last.
    const currentParams = [startIso, endIso, ...wfParam, ...modeParam, ...scope.params];
    const prevParams = [prevStartIso, prevEndIso, ...wfParam, ...modeParam, ...scope.params];

    const statsQuery = `
        SELECT COUNT(*) as total,
               SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error,
               AVG((julianday("stoppedAt") - julianday("startedAt")) * 86400) as avg_duration
        FROM execution_entity e
        ${wfJoinClause}
        WHERE e."startedAt" >= ? AND e."startedAt" <= ?
        ${wfFilterClause} ${modeFilterClause}${scope.sql};
    `;

    const prevStatsQuery = `
        SELECT COUNT(*) as total,
               SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error
        FROM execution_entity e
        ${wfJoinClause}
        WHERE e."startedAt" >= ? AND e."startedAt" < ?
        ${wfFilterClause} ${modeFilterClause}${scope.sql};
    `;

    const topWorkflowsQuery = `
        SELECT w.name AS workflow_name, w.id AS workflow_id,
               w."isArchived" AS is_archived,
               COUNT(e.id) AS execution_count,
               ROUND((COUNT(e.id) * 100.0 / NULLIF(SUM(COUNT(e.id)) OVER (), 0)), 2) AS percentage
        FROM execution_entity e
        JOIN workflow_entity w ON e."workflowId" = w.id
        WHERE e."startedAt" >= ? AND e."startedAt" <= ?
        ${wfFilterClause} ${modeFilterClause}${scope.sql}
        GROUP BY w.id, w.name
        ORDER BY execution_count DESC;
    `;

    // Bucket boundaries. Computed here because the SQL below derives its bucket
    // index from the same origin, which keeps the grouping identical to the
    // previous JavaScript implementation (including local-midnight day starts).
    const stepMs = bucketUnit === 'day' ? 86400000 : 3600000;
    const startPoint = new Date(new Date(startIso).getTime());
    const endPointFull = new Date(new Date(endIso).getTime());
    if (bucketUnit === 'day') startPoint.setHours(0, 0, 0, 0);
    else startPoint.setMinutes(0, 0, 0);

    const buckets = [];
    for (let t = startPoint.getTime(); t <= endPointFull.getTime(); t += stepMs) {
        buckets.push(new Date(t).toISOString());
    }

    // Counting happens in SQL. This used to pull every execution in the range
    // into memory — over 140k rows for a 60 day window — and bucket them with a
    // nested filter per bucket. Now it returns one row per bucket.
    const bucketQuery = `
        SELECT CAST((julianday(e."startedAt") - julianday(?)) * 86400.0 / ? AS INTEGER) AS bucket_idx,
               SUM(CASE WHEN e.status = 'success' THEN 1 ELSE 0 END) AS success_count,
               SUM(CASE WHEN e.status <> 'success' THEN 1 ELSE 0 END) AS error_count
        FROM execution_entity e
        ${wfJoinClause}
        WHERE e."startedAt" >= ? AND e."startedAt" <= ?
        ${wfFilterClause} ${modeFilterClause}${scope.sql}
        GROUP BY bucket_idx
    `;

    const [stats, prevStats, bucketRows, topWorkflows] = await Promise.all([
        localDb.query(statsQuery, currentParams),
        localDb.query(prevStatsQuery, prevParams),
        localDb.query(bucketQuery, [
            startPoint.toISOString(), stepMs / 1000, startIso, endIso,
            ...wfParam, ...modeParam, ...scope.params
        ]),
        localDb.query(topWorkflowsQuery, currentParams)
    ]);

    // Expand the sparse SQL result back into a dense series so empty buckets
    // still render as zero rather than being dropped from the chart.
    const countsByIndex = new Map(
        bucketRows.rows.map(r => [r.bucket_idx, r])
    );
    const hourly = buckets.map((bTime, idx) => {
        const row = countsByIndex.get(idx);
        return {
            time_val: bTime,
            success_count: row ? row.success_count : 0,
            error_count: row ? row.error_count : 0
        };
    });

    const currentTotal = stats.rows[0].total || 0;
    const currentError = stats.rows[0].error || 0;
    const prevTotal = prevStats.rows[0].total || 0;
    const prevError = prevStats.rows[0].error || 0;

    let trend_total_pct = 0;
    let trend_error_pct = 0;

    if (prevTotal > 0) trend_total_pct = ((currentTotal - prevTotal) / prevTotal) * 100;
    if (prevTotal === 0 && currentTotal > 0) trend_total_pct = 100;
    
    if (prevError > 0) trend_error_pct = ((currentError - prevError) / prevError) * 100;
    if (prevError === 0 && currentError > 0) trend_error_pct = 100;

    // Smart Extrapolation: prevent 'cliff' on incomplete final intervals
    if (hourly.length > 2) {
        const lastRow = hourly[hourly.length - 1];
        const p1 = hourly[hourly.length - 2].success_count || 0;
        const p2 = hourly[hourly.length - 3].success_count || 0;
        const avgPrevious = (p1 + p2) / 2.0;
        const now = new Date();

        // Check if the range ends within the current interval
        const rangeEndMs = isCustom && range.end ? range.end.getTime() : now.getTime();
        const lastBucketStartMs = new Date(lastRow.time_val).getTime();
        const isLatestBucket = (rangeEndMs > lastBucketStartMs && rangeEndMs <= lastBucketStartMs + stepMs);

        if (isLatestBucket) {
            if (bucketUnit === 'day') {
                const hoursPassed = (rangeEndMs - lastBucketStartMs) / 3600000;
                if (hoursPassed > 1 && hoursPassed < 23) {
                    const factor = 24.0 / hoursPassed;
                    lastRow.success_count = Math.round(((lastRow.success_count * factor) + avgPrevious) / 2);
                }
            } else {
                const minsPassed = ((rangeEndMs - lastBucketStartMs) / 60000) % 60;
                if (minsPassed > 5 && minsPassed < 58) {
                    const factor = 60.0 / minsPassed;
                    lastRow.success_count = Math.round(((lastRow.success_count * factor) + avgPrevious) / 2);
                }
            }
        }
    }

    return ({
        summary: { ...stats.rows[0], trend_total_pct, trend_error_pct },
        hourlyData: hourly,
        topWorkflows: topWorkflows.rows 
    });
}

/** The execution list, filtered and paged. */
async function getExecutions({ scope: caller, grouping, filters = {} }) {
    const limit = Math.max(1, Math.min(100, parseInt(filters.limit) || 20));
    const offset = Math.max(0, parseInt(filters.offset) || 0);
    // --- Filter params ---
    const { workflow, status, from, toStop, minDuration, execId } = filters;
    const VALID_STATUSES = ['success', 'error', 'canceled', 'crashed', 'running'];
    if (status && !VALID_STATUSES.includes(status)) {
        throw daoError(400, 'Invalid status filter.');
    }
    const mode = parseExecutionMode(filters.mode);
    if (!mode.ok) throw daoError(400, mode.error);
    const conditions = [
        'e."startedAt" IS NOT NULL',
        'e."stoppedAt" IS NOT NULL'
    ];
    const params = [];
    if (execId && !isNaN(parseInt(execId))) {
        conditions.push('e.id = ?');
        params.push(parseInt(execId));
    }
    if (workflow) {
        conditions.push('w.name = ?');
        params.push(workflow);
    }
    if (status) {
        conditions.push('e.status = ?');
        params.push(status);
    }
    if (from) {
        conditions.push('e."startedAt" >= ?');
        params.push(new Date(from).toISOString());
    }
    if (toStop) {
        conditions.push('e."startedAt" <= ?');
        params.push(new Date(toStop).toISOString());
    }
    if (minDuration && parseFloat(minDuration) > 0) {
        conditions.push('(julianday(e."stoppedAt") - julianday(e."startedAt")) * 86400 >= ?');
        params.push(parseFloat(minDuration));
    }
    if (mode.mode) {
        conditions.push('e.mode = ?');
        params.push(mode.mode);
    }
    // Last condition, so its parameter sits after every filter above and before
    // the LIMIT/OFFSET pair appended at execution time.
    // Authorization plus the caller's folder/tag/project filter. Pushed as raw
    // conditions here because this endpoint builds its WHERE from a list.
    const scope = filterFor({ scope: caller, grouping }, 'e."workflowId"');
    if (scope.sql) {
        // ' AND a AND b' -> ['a', 'b'] would be fragile; the fragment is appended
        // whole instead, which is exactly how every other query here uses it.
        conditions.push(scope.sql.replace(/^ AND /, ''));
        params.push(...scope.params);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `
        SELECT w.name, w."isArchived" AS is_archived,
               e.status, e."startedAt", e."stoppedAt", e.id as exec_id, e.mode,
               (julianday(e."stoppedAt") - julianday(e."startedAt")) * 86400 as duration,
               CASE WHEN e."createdAt" IS NULL THEN NULL
                    ELSE (julianday(e."startedAt") - julianday(e."createdAt")) * 86400000.0
               END AS queue_lag_ms
        FROM execution_entity e
        JOIN workflow_entity w ON e."workflowId" = w.id
        ${whereClause}
        ORDER BY e."startedAt" DESC
        LIMIT ? OFFSET ?;
    `;
    const result = await localDb.query(query, [...params, limit, offset]);
    return (result.rows);
}

/** Slowest workflows by average duration, with each one's worst run. */
async function getSlowest({ scope: caller, grouping }) {
    const scope = filterFor({ scope: caller, grouping }, 'e."workflowId"');

    // F-24 §5 · "Where the time went" belongs on this tab too.
    //
    // The trace renderer and `GET /api/executions/:id/trace` (F-12) both
    // already exist, and the item is right that this is where they are more
    // use: a slow execution has no error message to show — only time. But
    // the tab listed workflows, and a trace is a property of one execution,
    // so there was nothing to open.
    //
    // So the row carries its own worst run. Not the most recent one: the
    // question behind this tab is "why is this workflow slow", and the run
    // that best answers it is the slowest one, not whichever happened last.
    // `max_duration` ships alongside it so the row can say how far that run
    // sits from the average it is listed by — a 9s average made of 9s runs
    // and one made of a 200s outlier are different problems.
    const query = `
        SELECT w.name, w."isArchived" AS is_archived,
               AVG((julianday(e."stoppedAt") - julianday(e."startedAt")) * 86400) as avg_duration,
               MAX((julianday(e."stoppedAt") - julianday(e."startedAt")) * 86400) as max_duration,
               COUNT(e.id) as total_runs,
               (SELECT e2.id
                  FROM execution_entity e2
                 WHERE e2."workflowId" = w.id
                   AND e2."startedAt" > ?
                   AND e2."stoppedAt" IS NOT NULL
                 ORDER BY (julianday(e2."stoppedAt") - julianday(e2."startedAt")) DESC
                 LIMIT 1) as slowest_exec_id
        FROM execution_entity e
        JOIN workflow_entity w ON e."workflowId" = w.id
        WHERE e."startedAt" > ?
          AND e."stoppedAt" IS NOT NULL${scope.sql}
        GROUP BY w.id, w.name
        ORDER BY avg_duration DESC
        LIMIT 10;
    `;
    // The correlated subquery is bound first — it appears earlier in the
    // statement text, which is the order SQLite numbers the placeholders in.
    const result = await localDb.query(query, [isoDaysAgo(7), isoDaysAgo(7), ...scope.params]);
    return (result.rows);
}

/** Failure counts per workflow. */
async function getErrors({ scope: caller, grouping }) {
    const scope = filterFor({ scope: caller, grouping }, 'e."workflowId"');
    const query = `
        SELECT w.name, w."isArchived" AS is_archived,
               SUM(CASE WHEN e.status = 'error' THEN 1 ELSE 0 END) as error_count,
               COUNT(e.id) as total_runs
        FROM execution_entity e
        JOIN workflow_entity w ON e."workflowId" = w.id
        WHERE e."startedAt" > ?${scope.sql}
        GROUP BY w.id, w.name
        HAVING SUM(CASE WHEN e.status = 'error' THEN 1 ELSE 0 END) > 0
        ORDER BY error_count DESC
        LIMIT 10;
    `;
    const result = await localDb.query(query, [isoDaysAgo(7), ...scope.params]);
    return (result.rows);
}

/** One execution's error detail. */
async function getExecutionError({ scope: caller, grouping, filters = {}, route = {}, userId }) {
    // Left on Postgres directly since execution payloads can be megabytes/gigabytes. No ETL sync.
    const query = `
        SELECT d.data, e."workflowId" AS workflow_id 
        FROM execution_data d
        JOIN execution_entity e ON d."executionId" = e.id
        WHERE d."executionId" = $1
    `;
    const result = await pool.query(query, [route.id]);

    if (result.rows.length === 0) {
        throw daoError(404, 'No data found');
    }

    const workflowId = result.rows[0].workflow_id;

    // Addressed by execution id, so nothing above narrowed it to this user's
    // workflows — the check has to happen here or any authenticated user can
    // read any execution's full payload by guessing an integer. 404 rather
    // than 403: whether the execution exists is itself not their business.
    if (!(await canSeeWorkflow(caller, workflowId))) {
        log.warn(
            `User ${userId} was refused execution ` +
            `${route.id} (workflow ${workflowId}).`
        );
        throw daoError(404, 'No data found');
    }

    const fullData = parse(result.rows[0].data);
    
    let errorMessage = "Unknown error detail";
    let nodeName = "Unknown Node";

    if (fullData && fullData.resultData) {
        errorMessage = fullData.resultData.error?.description || fullData.resultData.error?.message;
        nodeName = fullData.resultData.lastNodeExecuted || fullData.resultData.error?.node?.name;
    } else if (fullData && fullData[0]) {
        const root = fullData[0];
        errorMessage = 
            (root.resultData?.error?.description) || 
            (root.resultData?.error?.message) || 
            (root.error?.description) ||
            (root.error?.message) ||
            (root.message);
        nodeName = root.resultData?.lastNodeExecuted || root.resultData?.error?.node?.name || root.error?.node?.name;
    }

    const finalUrl = process.env.N8N_EDITOR_BASE_URL || 'MISSING_ENV';
    const finalWfId = workflowId || 'MISSING_ID';

    const payload = { 
        executionId: route.id,
        nodeName: nodeName || "Unknown Node",
        message: errorMessage || "Unknown error detail",
        workflowId: finalWfId, 
        n8nBaseUrl: finalUrl
    };

    if (filters.full === 'true') {
        payload.fullError = JSON.stringify(fullData, null, 2);
    }

    return (payload);
}

/** F-12 · One execution's per-node timing. */
async function getExecutionTrace({ scope: caller, grouping, route = {}, userId }) {
    const id = Number(route.id);
    if (!Number.isInteger(id) || id <= 0) {
        throw daoError(400, 'Invalid execution id');
    }
    const result = await pool.query(
        `SELECT d.data, e."workflowId" AS workflow_id, w.name AS workflow_name,
                e.status, e."startedAt" AS started_at, e."stoppedAt" AS stopped_at
           FROM execution_data d
           JOIN execution_entity e ON d."executionId" = e.id
           LEFT JOIN workflow_entity w ON w.id = e."workflowId"
          WHERE d."executionId" = $1`,
        [id]
    );

    if (result.rows.length === 0) throw daoError(404, 'No data found');
    const row = result.rows[0];

    // Addressed by execution id, so nothing above narrowed it to this user's
    // workflows. 404 rather than 403, matching the error endpoint: whether
    // an execution exists is itself not their business.
    if (!(await canSeeWorkflow(caller, row.workflow_id))) {
        log.warn(
            `User ${userId} was refused the trace of execution ` +
            `${id} (workflow ${row.workflow_id}).`
        );
        throw daoError(404, 'No data found');
    }

    const wallMs = row.started_at && row.stopped_at
        ? new Date(row.stopped_at).getTime() - new Date(row.started_at).getTime()
        : null;

    let summary;
    try {
        summary = summariseTrace(parse(row.data), wallMs);
    } catch (err) {
        // A payload this process cannot parse is a fact about that
        // execution, not a server fault. 200 with the reason beats 500 with
        // a stack trace in the log and nothing on screen.
        log.warn(`Execution ${id} trace could not be parsed:`, err.message);
        return ({
            execution_id: id, workflow_id: row.workflow_id,
            workflow_name: row.workflow_name, status: row.status,
            unreadable: true, reason: 'The stored trace could not be decoded.'
        });
    }

    return ({
        execution_id: id,
        workflow_id: row.workflow_id,
        workflow_name: row.workflow_name,
        status: row.status,
        started_at: row.started_at,
        n8n_url: process.env.N8N_EDITOR_BASE_URL
            ? `${process.env.N8N_EDITOR_BASE_URL.replace(/\/+$/, '')}` +
              `/workflow/${encodeURIComponent(row.workflow_id)}/executions/${id}`
            : null,
        ...summary
    });
}

/** F-21 · Time and money saved. */
async function getRoiMetrics({ scope: caller, grouping, filters = {} }) {
    const { timeRange } = filters;
    let timeFilter = "";
    const timeParams = [];

    if (timeRange && timeRange !== 'all') {
        const LOOKBACK_HOURS = { '24h': 24, '48h': 48, '7d': 168, '30d': 720 };
        const lookbackHours = LOOKBACK_HOURS[timeRange] || 24;
        timeFilter = ` AND e."startedAt" >= ?`;
        timeParams.push(isoHoursAgo(lookbackHours));
    }

    const scope = filterFor({ scope: caller, grouping }, 'e."workflowId"');

    // One pass over the executions, not two.
    //
    // This was a pair of queries that each scanned every successful execution —
    // half a million rows on the instance this was built against — and joined
    // the workflow and its settings onto every one of them, only to collapse
    // the lot back down to 164 groups. Measured at 488ms and 1,201ms; and
    // because both run on the one shared SQLite connection they queue rather
    // than overlap, so the page waited for their sum.
    //
    // Grouping FIRST turns the join into 164 rows against 164 rows. Same
    // answers, and the per-workflow query dropped from 1,201ms to 452ms.
    //
    // The INNER JOIN to workflow_entity is load-bearing and survives the
    // rewrite: it is what drops executions whose workflow no longer exists, so
    // a deleted workflow's history stops counting toward a total attributed to
    // workflows you can still see.
    const query = `
        SELECT
            w.name,
            x.executions,
            COALESCE(s.saved_time_seconds, 0) as saved_time_seconds,
            COALESCE(s.hourly_rate, 0) as hourly_rate
        FROM (
            SELECT e."workflowId" as wf, COUNT(*) as executions
            FROM execution_entity e
            WHERE e.status = 'success'${timeFilter}${scope.sql}
            GROUP BY e."workflowId"
        ) x
        JOIN workflow_entity w ON w.id = x.wf
        LEFT JOIN workflow_settings s ON w.id = s.workflow_id
    `;

    const { rows } = await localDb.query(query, [...timeParams, ...scope.params]);

    // The totals are summed from the same rows the list is built from, rather
    // than by a second query over the same table. Two queries could disagree —
    // they ran at different moments against a replica the ETL writes to — and
    // "the total does not match the list under it" is the kind of wrong that
    // costs a reader their trust in the whole page.
    const summary = rows.reduce((acc, r) => {
        const executions = Number(r.executions) || 0;
        const seconds = Number(r.saved_time_seconds) || 0;
        acc.total_executions += executions;
        acc.total_time_saved_seconds += executions * seconds;
        acc.total_money_saved += executions * (seconds / 3600) * (Number(r.hourly_rate) || 0);
        return acc;
    }, { total_executions: 0, total_time_saved_seconds: 0, total_money_saved: 0 });

    const topWorkflows = rows
        .map((r) => {
            const executions = Number(r.executions) || 0;
            const seconds = Number(r.saved_time_seconds) || 0;
            return {
                name: r.name,
                executions,
                time_saved_seconds: executions * seconds,
                money_saved: executions * (seconds / 3600) * (Number(r.hourly_rate) || 0)
            };
        })
        .filter((r) => r.time_saved_seconds > 0)
        .sort((a, b) => b.time_saved_seconds - a.time_saved_seconds);

    return { summary, topWorkflows };
}

/** The five-minute volume series. */
async function getExecutionVolume({ scope: caller, grouping, filters = {} }) {
    const { start, end } = filters;
    const STEP_MS = 5 * 60 * 1000;
    const scope = filterFor({ scope: caller, grouping }, '"workflowId"');

    const mode = parseExecutionMode(filters.mode);
    if (!mode.ok) throw daoError(400, mode.error);

    // Default: the rolling 24 hours.
    if (!start || !end) {
        // execution_volume_stats is a single instance-wide series written by
        // the ETL — there is no per-project version of it to read, and handing
        // a scoped user the global counts would leak the shape of every other
        // project's traffic. For them the same buckets are computed live; it
        // is one indexed range scan over their own workflows.
        //
        // A mode filter takes the same live path, and for a related reason:
        // the cached series counts every execution regardless of how it was
        // triggered, so serving it for ?mode=webhook would answer a
        // different question than the one asked — and answer it fast, which
        // is worse than answering slowly.
        // `scope.grouped` joins the two conditions that were already here for
        // the same reason: the cached series is instance-wide and answers "how
        // much traffic is there", so serving it for a question narrowed to one
        // workflow answers a different question — and answers it fast, which is
        // worse than answering slowly.
        if (scope.condition || scope.grouped || mode.mode) {
            const newest = Math.floor(Date.now() / STEP_MS) * STEP_MS;
            return (await volumeSeries(scope, newest - 287 * STEP_MS, 288, mode.mode));
        }
        const result = await localDb.query(`
            SELECT timestamp, started_count
            FROM execution_volume_stats
            ORDER BY timestamp ASC
            LIMIT 1000
        `);
        if (result.rows.length) return (result.rows);

        // Nothing cached yet. Only the ETL writes that table, so it is empty on
        // every install until the first sync reaches its volume stage, and again
        // after a replica is rebuilt. Returning [] there renders a blank panel
        // with no explanation, at exactly the moment a new user is deciding
        // whether the thing works — so compute the same 288 buckets live from
        // executions that are already synced. Once the stage runs, the cached
        // path takes over and this never fires again.
        const newest = Math.floor(Date.now() / STEP_MS) * STEP_MS;
        return (await volumeSeries(scope, newest - 287 * STEP_MS, 288, mode.mode));
    }

    // A specific day: the same 288 buckets, anchored at the requested start.
    const range = parseDateRange(start, end);
    if (!range.ok) throw daoError(400, range.error);

    // Counted in SQL like every other path. This used to read every execution
    // of the day into memory and then run a filter over the whole array once
    // per bucket — 288 passes to produce 288 numbers.
    return (await volumeSeries(scope, range.start.getTime(), 288, mode.mode));
}

/** The oldest execution the replica holds. */
async function getFirstExecutionDate({ scope: caller, grouping }) {
    const scope = filterFor({ scope: caller, grouping }, '"workflowId"');
    // No WHERE of its own, and now two fragments that both want to attach to
    // one — so it opens a WHERE that is always true and lets both append in the
    // ` AND ...` form every other call site here uses. Cheaper than teaching the
    // filter builder about a caller with no conditions of its own.
    const query =
        'SELECT MIN("startedAt") as first_date FROM execution_entity WHERE 1=1' +
        scope.sql;
    const result = await localDb.query(query, scope.params);
    return ({ firstDate: result.rows[0]?.first_date || null });
}

/** Drill-down for one point on the volume chart. */
async function getExecutionVolumeDetails({ scope: caller, grouping, filters = {} }) {
    const { time, window: windowMins } = filters; // time is UTC ISO
    if (!time) throw daoError(400, 'time parameter is required');
    // Bounded: an unbounded window turns a drill-down into a full-range scan.
    const span = Math.min(Math.max(parseInt(windowMins, 10) || 5, 1), 24 * 60);
    const windowStart = parseIsoDate(time);
    if (!windowStart) {
        throw daoError(400, 'time must be a valid ISO date');
    }
    // The same filter the bar was drawn with. L-30 was exactly this shape of
    // bug: a bar and its drill-down answering slightly different questions, so
    // clicking one of height 12 opened a list of 30. A mode filter applied to
    // the chart and not to the modal would recreate it.
    const mode = parseExecutionMode(filters.mode);
    if (!mode.ok) throw daoError(400, mode.error);
    // Bounds computed here rather than with a datetime() modifier in SQL, which
    // would wrap the indexed column and force a scan.
    const windowStartIso = windowStart.toISOString();
    const windowEndIso = new Date(windowStart.getTime() + span * 60000).toISOString();
    const scope = filterFor({ scope: caller, grouping }, 'e."workflowId"');
    const query = `
        SELECT w.name as workflow_name, w.id as workflow_id, w."isArchived" AS is_archived,
               e.id as exec_id, e.status, e."startedAt", e."stoppedAt", e.mode,
               (julianday(IFNULL(e."stoppedAt", ?)) - julianday(e."startedAt")) * 86400 as current_duration
        FROM execution_entity e
        JOIN workflow_entity w ON e."workflowId" = w.id
        WHERE e."startedAt" >= ? AND e."startedAt" < ?${mode.mode ? ' AND e.mode = ?' : ''}${scope.sql}
        ORDER BY e."startedAt" DESC
        LIMIT 50
    `;
    const result = await localDb.query(query, [
        new Date().toISOString(), windowStartIso, windowEndIso,
        ...(mode.mode ? [mode.mode] : []), ...scope.params
    ]);

    const finalUrl = process.env.N8N_EDITOR_BASE_URL || '';
    const mappedRows = result.rows.map(row => ({
        ...row,
        n8nBaseUrl: finalUrl
    }));

    return (mappedRows);
}

module.exports = {
    getMetrics,
    getExecutions,
    getSlowest,
    getErrors,
    getExecutionError,
    getExecutionTrace,
    getRoiMetrics,
    getExecutionVolume,
    getFirstExecutionDate,
    getExecutionVolumeDetails
};
