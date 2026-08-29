const { pool } = require('../config/db');
const localDb = require('../config/localDb');
const { parse } = require('flatted');
const { parseIsoDate, parseDateRange, parseExecutionMode, validateSetting, validateRoiEntry } =
    require('../utils/validate');
const { scopeClause, canSeeWorkflow, filterVisibleWorkflows } = require('../utils/scope');
const { groupingClause } = require('../utils/grouping');
const { summariseTrace } = require('../utils/trace');
const log = require('../utils/logger').logger('API');

/**
 * Relative time bounds are computed here rather than with SQLite's
 * datetime('now', '-N days'), so they can be passed as bound parameters and the
 * indexed column stays untouched on the left of the comparison.
 * Always UTC, matching how every timestamp is written by the sync.
 */
/**
 * Authorization and the caller's own folder/tag/project filter, merged (F-16).
 *
 * The two are different things and must never be swapped: scope is what a user
 * may see, grouping is what they asked to see. Combining them in one helper is
 * what stops a call site from applying the filter and dropping the permission
 * check — a bug that would look exactly like a working feature.
 *
 * Scope always comes first, so a grouping filter can only narrow further.
 */
function restrict(req, column) {
    const scope = scopeClause(req.scope, column);
    const grouping = groupingClause(req.query, column);
    if (!grouping.ok) return grouping;
    return {
        ok: true,
        sql: scope.sql + grouping.sql,
        params: [...scope.params, ...grouping.params],
        condition: scope.condition,
        grouped: grouping.active
    };
}

const isoDaysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
const isoHoursAgo = (hours) => new Date(Date.now() - hours * 3600000).toISOString();

exports.getMetrics = async (req, res) => {
    try {
        const targetWorkflow = req.query.workflow;

        const range = parseDateRange(req.query.startDate, req.query.endDate);
        if (!range.ok) return res.status(400).json({ error: range.error });

        // F-02. Every figure on the dashboard can now be narrowed to one trigger
        // type, because a webhook failure and a schedule failure are different
        // problems and the combined rate describes neither of them.
        const mode = parseExecutionMode(req.query.mode);
        if (!mode.ok) return res.status(400).json({ error: mode.error });

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
        const scope = restrict(req, 'e."workflowId"');
        if (!scope.ok) return res.status(400).json({ error: scope.error });

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

        res.json({
            summary: { ...stats.rows[0], trend_total_pct, trend_error_pct },
            hourlyData: hourly,
            topWorkflows: topWorkflows.rows 
        });
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Database errorfetching metrics' });
    }
};


exports.getExecutions = async (req, res) => {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    // --- Filter params ---
    const { workflow, status, from, toStop, minDuration, execId } = req.query;

    const VALID_STATUSES = ['success', 'error', 'canceled', 'crashed', 'running'];
    if (status && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Invalid status filter.' });
    }

    const mode = parseExecutionMode(req.query.mode);
    if (!mode.ok) return res.status(400).json({ error: mode.error });

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
    const scope = restrict(req, 'e."workflowId"');
    if (!scope.ok) return res.status(400).json({ error: scope.error });
    if (scope.sql) {
        // ' AND a AND b' -> ['a', 'b'] would be fragile; the fragment is appended
        // whole instead, which is exactly how every other query here uses it.
        conditions.push(scope.sql.replace(/^ AND /, ''));
        params.push(...scope.params);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
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
        res.json(result.rows);
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Database error' });
    }
};

exports.getSlowest = async (req, res) => {
    try {
        const scope = scopeClause(req.scope, 'e."workflowId"');
        const query = `
            SELECT w.name, w."isArchived" AS is_archived,
                   AVG((julianday(e."stoppedAt") - julianday(e."startedAt")) * 86400) as avg_duration,
                   COUNT(e.id) as total_runs
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            WHERE e."startedAt" > ?
              AND e."stoppedAt" IS NOT NULL${scope.sql}
            GROUP BY w.id, w.name
            ORDER BY avg_duration DESC
            LIMIT 10;
        `;
        const result = await localDb.query(query, [isoDaysAgo(7), ...scope.params]);
        res.json(result.rows);
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Database error' });
    }
};

exports.getErrors = async (req, res) => {
    try {
        const scope = scopeClause(req.scope, 'e."workflowId"');
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
        res.json(result.rows);
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Database error' });
    }
};

exports.getExecutionError = async (req, res) => {
    // Left on Postgres directly since execution payloads can be megabytes/gigabytes. No ETL sync.
    try {
        const query = `
            SELECT d.data, e."workflowId" AS workflow_id 
            FROM execution_data d
            JOIN execution_entity e ON d."executionId" = e.id
            WHERE d."executionId" = $1
        `;
        const result = await pool.query(query, [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No data found' });
        }

        const workflowId = result.rows[0].workflow_id;

        // Addressed by execution id, so nothing above narrowed it to this user's
        // workflows — the check has to happen here or any authenticated user can
        // read any execution's full payload by guessing an integer. 404 rather
        // than 403: whether the execution exists is itself not their business.
        if (!(await canSeeWorkflow(req.scope, workflowId))) {
            log.warn(
                `User ${req.user && req.user.id} was refused execution ` +
                `${req.params.id} (workflow ${workflowId}).`
            );
            return res.status(404).json({ error: 'No data found' });
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
            executionId: req.params.id,
            nodeName: nodeName || "Unknown Node",
            message: errorMessage || "Unknown error detail",
            workflowId: finalWfId, 
            n8nBaseUrl: finalUrl
        };

        if (req.query.full === 'true') {
            payload.fullError = JSON.stringify(fullData, null, 2);
        }

        res.json(payload);
    } catch (err) {
        log.error('Parsing Error:', err);
        res.status(500).json({ error: 'Failed to parse error data' });
    }
};

/**
 * F-12 · GET /api/executions/:id/trace
 *
 * Where one execution actually spent its time, node by node, and how many items
 * crossed each edge.
 *
 * Read from Postgres on demand rather than mirrored. The trace is the biggest
 * object n8n stores — 33 KB on average here and 284 KB at the top end — and it
 * is only interesting for the execution someone is currently looking at. This
 * is the third and last of the three places this codebase touches Postgres, and
 * it is the same one the Inspect button already used.
 *
 * What comes back is arithmetic, never payload: durations, item counts and node
 * names. The existing `?full=true` on the error endpoint returns the raw object;
 * this one cannot, by construction — summariseTrace does not copy values out.
 */
exports.getExecutionTrace = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid execution id' });
    }

    try {
        const result = await pool.query(
            `SELECT d.data, e."workflowId" AS workflow_id, w.name AS workflow_name,
                    e.status, e."startedAt" AS started_at, e."stoppedAt" AS stopped_at
               FROM execution_data d
               JOIN execution_entity e ON d."executionId" = e.id
               LEFT JOIN workflow_entity w ON w.id = e."workflowId"
              WHERE d."executionId" = $1`,
            [id]
        );

        if (result.rows.length === 0) return res.status(404).json({ error: 'No data found' });
        const row = result.rows[0];

        // Addressed by execution id, so nothing above narrowed it to this user's
        // workflows. 404 rather than 403, matching the error endpoint: whether
        // an execution exists is itself not their business.
        if (!(await canSeeWorkflow(req.scope, row.workflow_id))) {
            log.warn(
                `User ${req.user && req.user.id} was refused the trace of execution ` +
                `${id} (workflow ${row.workflow_id}).`
            );
            return res.status(404).json({ error: 'No data found' });
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
            return res.json({
                execution_id: id, workflow_id: row.workflow_id,
                workflow_name: row.workflow_name, status: row.status,
                unreadable: true, reason: 'The stored trace could not be decoded.'
            });
        }

        res.json({
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
    } catch (err) {
        log.error('Trace fetch failed:', err);
        res.status(500).json({ error: 'Failed to read the execution trace' });
    }
};

exports.forceSync = async (req, res) => {
    const { syncData } = require('../config/syncJob');
    log.info(`Manual sync requested by user ${req.user && req.user.id}`);
    try {
        const result = await syncData();

        // Answering 200 here would be a lie: the ETL declined to run because one
        // was already in flight. 409 lets the caller retry meaningfully instead of
        // believing it just got fresh data.
        if (result.status === 'already_running') {
            return res.status(409).json({
                status: 'already_running',
                error: 'A sync is already in progress. Try again in a moment.'
            });
        }

        // Another instance owns the ETL. Saying "done" here would be a lie, and
        // saying "failed" would send someone hunting for a bug that isn't there.
        if (result.status === 'not_lock_owner') {
            return res.status(409).json({
                status: 'not_lock_owner',
                error: `Another instance is the active writer (${result.owner}). ` +
                    'This one serves reads only, so it cannot sync on demand.'
            });
        }

        if (result.status === 'failed') {
            return res.status(500).json({ status: 'failed', error: 'Force Sync Failed' });
        }

        res.json({
            status: 'ok',
            message: 'Sync Complete',
            workflows: result.workflows,
            executions: result.executions,
            errors: result.errors
        });
    } catch (err) {
        log.error('Manual Sync failed:', err);
        res.status(500).json({ error: 'Force Sync Failed' });
    }
};

// --- INSIGHTS & ROI METHODS ---

exports.getN8nHealth = async (req, res) => {
    try {
        const baseUrl = process.env.N8N_EDITOR_BASE_URL;
        if (!baseUrl) return res.status(500).json({ status: 'error', message: 'N8N_EDITOR_BASE_URL not configured' });
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3500);
        
        const response = await fetch(`${baseUrl}/healthz`, {
            method: 'GET',
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (response.ok) {
            const data = await response.json();
            if (data.status === 'ok') {
                return res.json({ status: 'ok' });
            }
        }
        res.status(500).json({ status: 'error' });
    } catch (err) {
        res.status(500).json({ status: 'error' });
    }
};

exports.getSettings = async (req, res) => {
    try {
        const scope = scopeClause(req.scope, 'w.id');
        const query = `
            SELECT 
                w.id, 
                w.name, 
                COALESCE(s.saved_time_seconds, 0) as saved_time_seconds,
                COALESCE(s.hourly_rate, 0) as hourly_rate,
                COUNT(e.id) as execution_count,
                SUM(CASE WHEN e.status = 'success' AND e."startedAt" >= ? THEN 1 ELSE 0 END) as executions_30d
            FROM workflow_entity w
            LEFT JOIN workflow_settings s ON w.id = s.workflow_id
            LEFT JOIN execution_entity e ON w.id = e."workflowId" AND e.status = 'success'
            ${scope.condition ? `WHERE ${scope.condition}` : ''}
            GROUP BY w.id, w.name, s.saved_time_seconds, s.hourly_rate
            ORDER BY w.name ASC
        `;
        // The previous bound mixed 'localtime' into a comparison against UTC
        // timestamps, so the 30-day window was off by the server's UTC offset.
        const result = await localDb.query(query, [isoDaysAgo(30), ...scope.params]);
        res.json(result.rows);
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Database error fetching settings' });
    }
};

exports.updateSettings = async (req, res) => {
    const { settings } = req.body;
    if (!settings || !Array.isArray(settings)) return res.status(400).json({ error: 'Invalid settings payload' });
    if (settings.length > 1000) return res.status(400).json({ error: 'Too many settings in one request.' });

    // Validate the whole payload before writing any of it, so a bad entry at the
    // end cannot leave the first half applied.
    const clean = [];
    for (const s of settings) {
        const check = validateRoiEntry(s);
        if (!check.ok) return res.status(400).json({ error: check.error });
        clean.push(check.value);
    }

    // Two checks in one pass. workflow_settings has a foreign key to
    // workflow_entity, but it only bites if PRAGMA foreign_keys is on — which it
    // is, and this turns the resulting 500 into a message that names the offending
    // workflow. The scope check is the other half: ROI is written per workflow, so
    // without it a member could set the saved-time figure on somebody else's.
    //
    // Out of scope and non-existent return the SAME message on purpose. Telling
    // the caller which of the two it was would turn this endpoint into a way to
    // enumerate the workflow ids of every other project.
    const ids = clean.map(c => c.workflow_id);
    if (ids.length > 0) {
        const known = await localDb.query(
            `SELECT id FROM workflow_entity WHERE id IN (${ids.map(() => '?').join(',')})`,
            ids
        );
        const knownSet = new Set(known.rows.map(r => r.id));
        const visibleSet = await filterVisibleWorkflows(req.scope, ids);
        const rejected = ids.filter(id => !knownSet.has(id) || !visibleSet.has(id));
        if (rejected.length > 0) {
            return res.status(400).json({
                error: `Unknown workflow id(s): ${rejected.slice(0, 5).join(', ')}`
            });
        }
    }

    try {
        await localDb.execute('BEGIN TRANSACTION');
        for (const s of clean) {
            await localDb.execute(
                `INSERT INTO workflow_settings (workflow_id, saved_time_seconds, hourly_rate)
                 VALUES (?, ?, ?)
                 ON CONFLICT(workflow_id) DO UPDATE SET saved_time_seconds=excluded.saved_time_seconds, hourly_rate=excluded.hourly_rate`,
                [s.workflow_id, s.saved_time_seconds, s.hourly_rate]
            );
        }
        await localDb.execute('COMMIT');
        res.json({ message: 'Settings saved' });
    } catch (err) {
        try { await localDb.execute('ROLLBACK'); } catch (e) { /* the caught error above is the one worth reporting */ }
        log.error(err);
        res.status(500).json({ error: 'Failed to update settings' });
    }
};

exports.getRoiMetrics = async (req, res) => {
    try {
        const { timeRange } = req.query;
        let timeFilter = "";
        const timeParams = [];

        if (timeRange && timeRange !== 'all') {
            const LOOKBACK_HOURS = { '24h': 24, '48h': 48, '7d': 168, '30d': 720 };
            const lookbackHours = LOOKBACK_HOURS[timeRange] || 24;
            timeFilter = ` AND e."startedAt" >= ?`;
            timeParams.push(isoHoursAgo(lookbackHours));
        }

        const scope = scopeClause(req.scope, 'e."workflowId"');
        const roiParams = [...timeParams, ...scope.params];

        const totalQuery = `
            SELECT 
                COUNT(e.id) as total_executions,
                SUM(COALESCE(s.saved_time_seconds, 0)) as total_time_saved_seconds,
                SUM((COALESCE(s.saved_time_seconds, 0) / 3600.0) * COALESCE(s.hourly_rate, 0)) as total_money_saved
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            LEFT JOIN workflow_settings s ON w.id = s.workflow_id
            WHERE e.status = 'success'${timeFilter}${scope.sql}
        `;
        
        const workflowsQuery = `
            SELECT 
                w.name,
                COUNT(e.id) as executions,
                (COUNT(e.id) * COALESCE(s.saved_time_seconds, 0)) as time_saved_seconds,
                (COUNT(e.id) * (COALESCE(s.saved_time_seconds, 0) / 3600.0) * COALESCE(s.hourly_rate, 0)) as money_saved
            FROM execution_entity e
            JOIN workflow_entity w ON e."workflowId" = w.id
            LEFT JOIN workflow_settings s ON w.id = s.workflow_id
            WHERE e.status = 'success'${timeFilter}${scope.sql}
            GROUP BY w.id, w.name, s.saved_time_seconds, s.hourly_rate
            HAVING time_saved_seconds > 0
            ORDER BY time_saved_seconds DESC
        `;
        
        const [totalStats, wfStats] = await Promise.all([
            localDb.query(totalQuery, roiParams),
            localDb.query(workflowsQuery, roiParams)
        ]);

        res.json({
            summary: totalStats.rows[0],
            topWorkflows: wfStats.rows
        });

    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Database error fetching ROI metrics' });
    }
};

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

exports.getExecutionVolume = async (req, res) => {
    try {
        const { start, end } = req.query;
        const STEP_MS = 5 * 60 * 1000;
        const scope = scopeClause(req.scope, '"workflowId"');

        const mode = parseExecutionMode(req.query.mode);
        if (!mode.ok) return res.status(400).json({ error: mode.error });

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
            if (scope.condition || mode.mode) {
                const newest = Math.floor(Date.now() / STEP_MS) * STEP_MS;
                return res.json(await volumeSeries(scope, newest - 287 * STEP_MS, 288, mode.mode));
            }
            const result = await localDb.query(`
                SELECT timestamp, started_count
                FROM execution_volume_stats
                ORDER BY timestamp ASC
                LIMIT 1000
            `);
            return res.json(result.rows);
        }

        // A specific day: the same 288 buckets, anchored at the requested start.
        const range = parseDateRange(start, end);
        if (!range.ok) return res.status(400).json({ error: range.error });

        // Counted in SQL like every other path. This used to read every execution
        // of the day into memory and then run a filter over the whole array once
        // per bucket — 288 passes to produce 288 numbers.
        res.json(await volumeSeries(scope, range.start.getTime(), 288, mode.mode));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch execution volume' });
    }
};

exports.getFirstExecutionDate = async (req, res) => {
    try {
        const scope = scopeClause(req.scope, '"workflowId"');
        // No WHERE of its own, so the scope condition has to open one.
        const query =
            'SELECT MIN("startedAt") as first_date FROM execution_entity' +
            (scope.condition ? ` WHERE ${scope.condition}` : '');
        const result = await localDb.query(query, scope.params);
        res.json({ firstDate: result.rows[0]?.first_date || null });
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch first execution date' });
    }
};

exports.getGlobalSettings = async (req, res) => {
    try {
        const result = await localDb.query('SELECT key, value FROM dashboard_settings');
        // Convert array of pairs to a cleaner object for the frontend
        const settings = result.rows.reduce((acc, curr) => {
            acc[curr.key] = curr.value;
            return acc;
        }, {});
        res.json(settings);
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
};

exports.updateGlobalSettings = async (req, res) => {
    const { key, value } = req.body;

    const check = validateSetting(key, value);
    if (!check.ok) return res.status(400).json({ error: check.error });

    try {
        await localDb.execute(
            'INSERT INTO dashboard_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            [key, value]
        );
        res.json({ message: 'Setting updated' });
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to update setting' });
    }
};

/**
 * The rows behind one bar of the execution-volume chart.
 *
 * Executions that STARTED inside the window — the same measurement the bar is.
 * It used to select executions that were RUNNING during the window: started at
 * or before the end, and either still going or stopped after the beginning. That
 * is overlap, not volume, so clicking a bar of height 12 could open a list of 30
 * rows or of 3, and neither number was wrong — they were answers to different
 * questions. The modal's own subtitle already said "Workflows started in this
 * window"; the query was the part that disagreed.
 *
 * As a side effect the predicate is now a plain range on "startedAt", so it is
 * one seek on idx_exec_started instead of a scan with an OR in it.
 */
exports.getExecutionVolumeDetails = async (req, res) => {
    const { time, window: windowMins } = req.query; // time is UTC ISO
    if (!time) return res.status(400).json({ error: 'time parameter is required' });

    // Bounded: an unbounded window turns a drill-down into a full-range scan.
    const span = Math.min(Math.max(parseInt(windowMins, 10) || 5, 1), 24 * 60);

    const windowStart = parseIsoDate(time);
    if (!windowStart) {
        return res.status(400).json({ error: 'time must be a valid ISO date' });
    }

    // The same filter the bar was drawn with. L-30 was exactly this shape of
    // bug: a bar and its drill-down answering slightly different questions, so
    // clicking one of height 12 opened a list of 30. A mode filter applied to
    // the chart and not to the modal would recreate it.
    const mode = parseExecutionMode(req.query.mode);
    if (!mode.ok) return res.status(400).json({ error: mode.error });
    // Bounds computed here rather than with a datetime() modifier in SQL, which
    // would wrap the indexed column and force a scan.
    const windowStartIso = windowStart.toISOString();
    const windowEndIso = new Date(windowStart.getTime() + span * 60000).toISOString();

    try {
        const scope = scopeClause(req.scope, 'e."workflowId"');
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

        res.json(mappedRows);
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch execution volume details' });
    }
};

// What the old static map called transient. Kept only to measure how often it
// disagrees with the observed behaviour (F-08) — nothing decides on it any more.
const STATIC_TRANSIENT = new Set(['rate_limit', 'network', 'upstream']);

// Below this many occurrences there is nothing to conclude. One failure followed
// by one success is a 100% recovery rate and means nothing at all, and a badge
// reading "transient" on that evidence is worse than no badge.
const MIN_BEHAVIOUR_OBSERVATIONS = 5;

/**
 * Transient, structural, or somewhere in between — decided by outcomes.
 *
 * Three bands rather than two, because the data has three shapes and collapsing
 * the middle one into either neighbour loses the distinction that matters. An
 * error recovering 76% of the time and one recovering 0% of the time both get
 * called "sometimes fails" under a single threshold; here the first is transient
 * (leave it to the retry), the last is structural (fix it), and the band between
 * is intermittent (watch it — this is where the flaky upstreams live).
 */
function natureOf(row) {
    const observed = row ? row.observed : 0;
    const recovered = row ? row.recovered : 0;
    if (observed < MIN_BEHAVIOUR_OBSERVATIONS) {
        return { behaviour: 'unknown', observed, recovered, recovery_rate: null };
    }
    const rate = recovered / observed;
    const behaviour = rate >= 0.7 ? 'transient' : (rate <= 0.1 ? 'structural' : 'intermittent');
    return { behaviour, observed, recovered, recovery_rate: Math.round(rate * 1000) / 10 };
}

// Exported for the tests: the banding is a judgement call expressed as numbers,
// which is exactly the kind of thing that should be pinned down by assertion
// rather than by reading it back.
exports._internal = { natureOf, STATIC_TRANSIENT, MIN_BEHAVIOUR_OBSERVATIONS };

exports.getErrorIntelligence = async (req, res) => {
    try {
        const range = parseDateRange(req.query.startDate, req.query.endDate);
        if (!range.ok) return res.status(400).json({ error: range.error });

        let startIso, endIso;

        if (range.start && range.end) {
            startIso = range.start.toISOString();
            endIso = range.end.toISOString();
        } else {
            const now = new Date();
            startIso = new Date(now.getTime() - 7 * 24 * 3600000).toISOString();
            endIso = now.toISOString();
        }

        const durationMs = new Date(endIso).getTime() - new Date(startIso).getTime();
        const prevEndIso = startIso;
        const prevStartIso = new Date(new Date(startIso).getTime() - durationMs).toISOString();

        // Three different tables key the same thing under three different names.
        const aScope = restrict(req, 'workflow_id');        // analytics, unaliased
        const aaScope = restrict(req, 'a.workflow_id');     // analytics, aliased
        const eScope = restrict(req, '"workflowId"');       // executions, unaliased
        const weScope = restrict(req, 'w.id');              // workflows, aliased
        for (const f of [aScope, aaScope, eScope, weScope]) {
            if (!f.ok) return res.status(400).json({ error: f.error });
        }

        // 1. Summary Stats
        const summaryQuery = `
            SELECT 
                COUNT(*) as total_errors,
                COUNT(DISTINCT workflow_id) as affected_workflows,
                COUNT(DISTINCT node_name) as unique_failing_nodes,
                SUM(CASE WHEN error_category IN ('rate_limit','network','upstream') THEN 1 ELSE 0 END) as transient_count,
                SUM(CASE WHEN error_category IN ('auth','config','data','logic') THEN 1 ELSE 0 END) as structural_count
            FROM execution_error_analytics
            WHERE timestamp >= ? AND timestamp <= ?${aScope.sql}
        `;

        const prevSummaryQuery = `
            SELECT COUNT(*) as total_errors
            FROM execution_error_analytics
            WHERE timestamp >= ? AND timestamp < ?${aScope.sql}
        `;

        // Total executions for error rate calculation
        const execCountQuery = `
            SELECT COUNT(*) as total
            FROM execution_entity
            WHERE "startedAt" >= ? AND "startedAt" <= ?${eScope.sql}
        `;

        // 2. Category Breakdown
        const categoryQuery = `
            SELECT error_category, COUNT(*) as count
            FROM execution_error_analytics
            WHERE timestamp >= ? AND timestamp <= ?${aScope.sql}
            GROUP BY error_category
            ORDER BY count DESC
        `;

        // 3. Trend Timeline (daily buckets)
        const trendQuery = `
            SELECT date(timestamp) as day, error_category, COUNT(*) as count
            FROM execution_error_analytics
            WHERE timestamp >= ? AND timestamp <= ?${aScope.sql}
            GROUP BY date(timestamp), error_category
            ORDER BY day ASC
        `;

        // 4. Workflow Health Scores
        const healthQuery = `
            SELECT 
                w.id, w.name,
                COUNT(CASE WHEN e.status = 'error' THEN 1 END) as error_count,
                COUNT(e.id) as total_runs,
                ROUND((1.0 - (CAST(COUNT(CASE WHEN e.status = 'error' THEN 1 END) AS REAL) / NULLIF(COUNT(e.id), 0))) * 100, 1) as health_score
            FROM workflow_entity w
            JOIN execution_entity e ON w.id = e."workflowId"
            WHERE e."startedAt" >= ? AND e."startedAt" <= ?${weScope.sql}
            GROUP BY w.id, w.name
            HAVING COUNT(CASE WHEN e.status = 'error' THEN 1 END) > 0
            ORDER BY health_score ASC
            LIMIT 15
        `;

        // 5. Error groups, keyed on fingerprint (F-07).
        //
        // This used to group on (category, node_name, first 200 characters of the
        // message), which files "Column 'remedy_id' does not exist" and "Column
        // 'receivedDateTime' does not exist" as unrelated problems. It turned
        // 14,267 errors into 1,524 groups — more rows than the table it replaced,
        // and not one of them a unit of work. The same errors produce 98
        // fingerprints.
        //
        // The old form could not use an index either: SUBSTR() on the left of a
        // comparison is a function of the column, so both the grouping and the
        // drill-down behind it scanned. `fingerprint` is indexed with timestamp.
        const groupsQuery = `
            SELECT
                a.fingerprint,
                f.normalized_message,
                f.sample_message,
                f.node_type,
                f.status,
                f.notes,
                f.first_seen as ever_first_seen,
                COUNT(*) as count,
                COUNT(DISTINCT a.workflow_id) as affected_workflows,
                MIN(a.timestamp) as first_seen,
                MAX(a.timestamp) as last_seen,
                GROUP_CONCAT(DISTINCT w.name) as workflow_names,
                GROUP_CONCAT(DISTINCT a.node_name) as node_names
            FROM execution_error_analytics a
            JOIN workflow_entity w ON a.workflow_id = w.id
            LEFT JOIN error_fingerprints f ON f.fingerprint = a.fingerprint
            WHERE a.timestamp >= ? AND a.timestamp <= ?
              AND a.fingerprint IS NOT NULL${aaScope.sql}
            GROUP BY a.fingerprint
            ORDER BY count DESC
            LIMIT 50
        `;

        // 5b. How each fingerprint actually behaves (F-08).
        //
        // "Transient" was decided by a static map: rate_limit, network and
        // upstream were transient, everything else structural. That is a guess
        // about the wording of a message, and on this instance it is wrong more
        // often than right — four of the six fingerprints with enough
        // occurrences to judge behave the opposite way from their label. The
        // clearest case is an upstream returning "service suspended", filed as
        // transient, which recovered 0 times out of 47. A service that is
        // suspended is not going to un-suspend itself.
        //
        // The measurement instead: for each failure, did the next run of the
        // same workflow succeed? That is a proxy — a different trigger could
        // succeed while the failing path stays broken — but it is a proxy made
        // of observed outcomes rather than of vocabulary, and it is the question
        // the item asks: does this fix itself, or has it never once passed.
        //
        // LEAD over (workflowId, startedAt) rather than a correlated subquery per
        // error row: idx_exec_wf_started is already in that order, so the window
        // is served by the index instead of 14,000 seeks. Deliberately NOT bounded
        // at the top of the range — an error that is the last execution in the
        // window would otherwise be counted as never recovering, purely because
        // the window ended.
        const behaviourQuery = `
            WITH ex AS (
                SELECT id, LEAD(status) OVER (
                           PARTITION BY "workflowId" ORDER BY "startedAt", id
                       ) AS next_status
                  FROM execution_entity
                 WHERE "startedAt" >= ?
            )
            SELECT a.fingerprint,
                   COUNT(*) AS observed,
                   SUM(CASE WHEN ex.next_status = 'success' THEN 1 ELSE 0 END) AS recovered
              FROM execution_error_analytics a
              JOIN ex ON ex.id = a.id
             WHERE a.timestamp >= ? AND a.timestamp <= ?
               AND a.fingerprint IS NOT NULL${aScope.sql}
             GROUP BY a.fingerprint
        `;

        // Category per fingerprint, counted rather than picked.
        //
        // The fingerprint deliberately excludes the category — the category is
        // derived by rules that carry their own version and get recomputed, and
        // folding it into the identity would mean a classifier change silently
        // renamed every historical group. The consequence is that one fingerprint
        // can span categories (the same message with different HTTP codes), so
        // the group is labelled with its most frequent one and says how many it
        // spans, instead of an arbitrary MAX() that would look decisive.
        const groupCategoryQuery = `
            SELECT a.fingerprint, a.error_category, COUNT(*) as count
            FROM execution_error_analytics a
            WHERE a.timestamp >= ? AND a.timestamp <= ?
              AND a.fingerprint IS NOT NULL${aScope.sql}
            GROUP BY a.fingerprint, a.error_category
        `;

        const [summary, prevSummary, execCount, categories, trend, health, groups, groupCategories,
            behaviour] = await Promise.all([
                localDb.query(summaryQuery, [startIso, endIso, ...aScope.params]),
                localDb.query(prevSummaryQuery, [prevStartIso, prevEndIso, ...aScope.params]),
                localDb.query(execCountQuery, [startIso, endIso, ...eScope.params]),
                localDb.query(categoryQuery, [startIso, endIso, ...aScope.params]),
                localDb.query(trendQuery, [startIso, endIso, ...aScope.params]),
                localDb.query(healthQuery, [startIso, endIso, ...weScope.params]),
                localDb.query(groupsQuery, [startIso, endIso, ...aaScope.params]),
                localDb.query(groupCategoryQuery, [startIso, endIso, ...aScope.params]),
                localDb.query(behaviourQuery, [startIso, startIso, endIso, ...aScope.params])
            ]);

        const totalErrors = summary.rows[0].total_errors || 0;
        const prevTotalErrors = prevSummary.rows[0].total_errors || 0;
        const totalExecs = execCount.rows[0].total || 0;
        let trendPct = 0;
        if (prevTotalErrors > 0) trendPct = ((totalErrors - prevTotalErrors) / prevTotalErrors) * 100;
        else if (totalErrors > 0) trendPct = 100;

        // Pivot trend data into {day, auth, rate_limit, network, ...} format
        const trendMap = {};
        for (const row of trend.rows) {
            if (!trendMap[row.day]) trendMap[row.day] = { day: row.day };
            trendMap[row.day][row.error_category] = row.count;
        }
        const trendData = Object.values(trendMap);

        // The dominant category per fingerprint, and how many it spans.
        const catsByFp = new Map();
        for (const row of groupCategories.rows) {
            if (!catsByFp.has(row.fingerprint)) catsByFp.set(row.fingerprint, []);
            catsByFp.get(row.fingerprint).push(row);
        }

        const behaviourByFp = new Map(behaviour.rows.map(r => [r.fingerprint, r]));

        const oneDayAgo = new Date(Date.now() - 24 * 3600000).toISOString();
        const enrichedGroups = groups.rows.map(g => {
            const cats = (catsByFp.get(g.fingerprint) || []).sort((x, y) => y.count - x.count);
            const nature = natureOf(behaviourByFp.get(g.fingerprint));
            const category = cats.length ? cats[0].error_category : 'unknown';
            return {
                ...g,
                ...nature,
                // Whether the old static map would have said something else. Shown
                // rather than quietly corrected: the label is what every other
                // tool reports, and the disagreement is the finding.
                label_disagrees: nature.behaviour !== 'unknown' &&
                    STATIC_TRANSIENT.has(category) !== (nature.behaviour === 'transient'),
                error_category: category,
                category_count: cats.length,
                error_summary: g.sample_message || g.normalized_message || '',
                node_name: g.node_names || '',
                workflow_names: g.workflow_names ? g.workflow_names.split(',').slice(0, 3) : [],
                // Two different states, kept apart. `activity` is derived from the
                // data — has this been seen today. `status` is what a person
                // decided about it and lives on the fingerprint row. The previous
                // version wrote 'active' into the same field a lifecycle status
                // would occupy, which is fine until there is a lifecycle.
                activity: g.last_seen >= oneDayAgo ? 'active' : 'recurring',
                status: g.status || 'open',
                // First seen ever, not first seen in this window — the difference
                // is exactly what "this is new" means, and it is the condition
                // F-13 will alert on.
                is_new: !!(g.ever_first_seen && g.ever_first_seen >= startIso)
            };
        });

        const n8nBaseUrl = process.env.N8N_EDITOR_BASE_URL || '';

        res.json({
            summary: {
                ...summary.rows[0],
                // Behaviour-derived counts, alongside the static ones the summary
                // query still produces. Both are reported because they disagree,
                // and which of them is right is the point of F-08.
                transient_observed: enrichedGroups
                    .filter(g => g.behaviour === 'transient')
                    .reduce((a, g) => a + g.count, 0),
                structural_observed: enrichedGroups
                    .filter(g => g.behaviour === 'structural')
                    .reduce((a, g) => a + g.count, 0),
                intermittent_observed: enrichedGroups
                    .filter(g => g.behaviour === 'intermittent')
                    .reduce((a, g) => a + g.count, 0),
                mislabelled_groups: enrichedGroups.filter(g => g.label_disagrees).length,
                total_executions: totalExecs,
                error_rate: totalExecs > 0 ? ((totalErrors / totalExecs) * 100).toFixed(1) : 0,
                trend_pct: Math.round(trendPct * 10) / 10
            },
            categories: categories.rows,
            trend: trendData,
            workflows: health.rows,
            errorGroups: enrichedGroups,
            // How much the fingerprinting collapsed, so the change is visible
            // rather than merely asserted in a commit message.
            grouping: { by: 'fingerprint', groups: enrichedGroups.length },
            n8nBaseUrl
        });

    } catch (err) {
        log.error('Error Analytics Intelligence Failed:', err);
        res.status(500).json({ error: 'Failed to aggregate error intelligence' });
    }
};

exports.getWorkflowErrorDrilldown = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) return res.status(400).json({ error: 'Workflow ID is required' });

        // Addressed by workflow id. Same reasoning as getExecutionError: the 404
        // below already exists for a workflow that is not there, so an invisible
        // one takes the identical answer and reveals nothing.
        if (!(await canSeeWorkflow(req.scope, id))) {
            log.warn(`User ${req.user && req.user.id} was refused workflow ${id}.`);
            return res.status(404).json({ error: 'Workflow not found' });
        }

        // 1. Node Breakdown (Pie Chart)
        const distributionQuery = `
            SELECT node_name, COUNT(*) as count
            FROM execution_error_analytics
            WHERE workflow_id = ? AND timestamp > ?
            GROUP BY node_name
            ORDER BY count DESC
        `;

        // 2. Source Breakdown (Most common path-to-error)
        const sourceQuery = `
            SELECT source_node, source_output_index, COUNT(*) as count
            FROM execution_error_analytics
            WHERE workflow_id = ? AND source_node != '' AND timestamp > ?
            GROUP BY source_node, source_output_index
            ORDER BY count DESC
            LIMIT 5
        `;

        // 3. Raw Data (Export purposes)
        const rawQuery = `
            SELECT id as exec_id, node_name, node_type, error_message, error_stack, source_node, source_output_index as branch, timestamp as started_at
            FROM execution_error_analytics
            WHERE workflow_id = ?
            ORDER BY timestamp DESC
            LIMIT 200
        `;

        // 4. Workflow Name Info
        const infoQuery = `SELECT name FROM workflow_entity WHERE id = ?`;

        const [dist, sources, raw, info] = await Promise.all([
            localDb.query(distributionQuery, [id, isoDaysAgo(7)]),
            localDb.query(sourceQuery, [id, isoDaysAgo(7)]),
            localDb.query(rawQuery, [id]),
            localDb.query(infoQuery, [id])
        ]);

        if (info.rows.length === 0) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        res.json({
            workflowName: info.rows[0].name,
            nodeDistribution: dist.rows,
            sourceDistribution: sources.rows,
            rawErrors: raw.rows
        });

    } catch (err) {
        log.error('Workflow Drilldown Failed:', err);
        res.status(500).json({ error: 'Failed to fetch workflow drilldown data' });
    }
};

exports.getErrorGroupExecutions = async (req, res) => {
    try {
        const { fingerprint, startDate, endDate } = req.body;

        // A fingerprint is 16 hex characters produced by this server. Anything
        // else is not a value a client could have got from us, and validating the
        // shape keeps a malformed one from being answered with an empty list that
        // reads as "no occurrences".
        if (typeof fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(fingerprint)) {
            return res.status(400).json({ error: 'A valid fingerprint is required' });
        }
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }

        // These go straight into a timestamp comparison. Unvalidated, a malformed
        // value simply matched nothing and the empty result read as "no errors".
        const range = parseDateRange(startDate, endDate);
        if (!range.ok) return res.status(400).json({ error: range.error });

        const scope = scopeClause(req.scope, 'a.workflow_id');

        // One indexed lookup. The previous version matched on error_category,
        // node_name and SUBSTR(error_message, 1, 200) together — three columns,
        // one of them behind a function call, so it scanned the whole table and
        // still disagreed with the grouping whenever a message differed after the
        // 200th character.
        const query = `
            SELECT a.id as exec_id, a.timestamp, a.node_name, a.error_category,
                   a.error_message, w.name as workflow_name
            FROM execution_error_analytics a
            JOIN workflow_entity w ON a.workflow_id = w.id
            WHERE a.fingerprint = ?
              AND a.timestamp >= ? AND a.timestamp <= ?${scope.sql}
            ORDER BY a.timestamp DESC
            LIMIT 30
        `;

        const result = await localDb.query(query, [
            fingerprint, range.start.toISOString(), range.end.toISOString(), ...scope.params
        ]);
        res.json({ executions: result.rows });
    } catch (err) {
        log.error('Error fetching group executions:', err);
        res.status(500).json({ error: 'Failed to fetch group executions' });
    }
};

