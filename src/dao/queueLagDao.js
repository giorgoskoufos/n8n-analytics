/**
 * F-03 · Queue lag — how long an execution waited before it started.
 *
 * The reference DAO. Everything the old handler did that was *analysis* is here;
 * everything it did that was *HTTP* stayed behind. The split is worth stating
 * once, because the other 105 queries follow it:
 *
 *   controller   reads req.query, validates it, answers 400, calls this, sends JSON
 *   DAO (here)   takes domain values, runs SQL, derives, returns data
 *
 * `detectBackpressure` lives here rather than in the controller for a reason
 * that decides where the line falls generally: it is not presentation. "Lag is
 * climbing while throughput is not" is a claim about the instance, and the
 * assistant needs the same claim the chart does. Anything a second caller would
 * otherwise have to recompute belongs on this side of the line — that is the
 * whole point of moving it.
 */

const localDb = require('../config/localDb');
const {
    msBetween, bucketExpr, bucketParams, percentileColumns,
    filterFor, densify, coverageOf, modeClause
} = require('./shared');

/**
 * @param {object}  opts
 * @param {object}  opts.window    from resolveWindow — startIso, endIso, originIso, originMs, stepMs, count
 * @param {?string} opts.mode      validated execution mode, or null for all
 * @param {?object} opts.scope     the caller's scope; null only for unrestricted
 * @param {object} [opts.grouping] validated { folder, tag, project }
 */
async function getQueueLag({ window: win, mode = null, scope, grouping }) {
    const filter = filterFor({ scope, grouping }, 'e."workflowId"');
    const m = modeClause(mode);

    const base = `
          FROM execution_entity e
         WHERE e."startedAt" >= ? AND e."startedAt" <= ?
           AND e."createdAt" IS NOT NULL${m.sql}${filter.sql}`;
    const params = [win.startIso, win.endIso, ...m.params, ...filter.params];
    const lag = msBetween('e."startedAt"', 'e."createdAt"');

    // Negative lag is impossible — an execution cannot start before it is
    // created — so any is clock skew between whatever wrote the two columns.
    // Counted and reported rather than clamped away: a silent MAX(0, ...) would
    // turn a real infrastructure fault into a clean-looking chart.
    const summaryQuery = `
        WITH v AS (SELECT ${lag} AS ms ${base}),
             r AS (SELECT ms, ROW_NUMBER() OVER (ORDER BY ms) rn, COUNT(*) OVER () n FROM v)
        SELECT n, ${percentileColumns('ms')}, MAX(ms) AS max_ms, AVG(ms) AS avg_ms,
               SUM(CASE WHEN ms < 0 THEN 1 ELSE 0 END) AS negative
          FROM r GROUP BY n`;

    const byModeQuery = `
        WITH v AS (SELECT e.mode AS mode, ${lag} AS ms ${base} AND e.mode IS NOT NULL),
             r AS (SELECT mode, ms,
                          ROW_NUMBER() OVER (PARTITION BY mode ORDER BY ms) rn,
                          COUNT(*) OVER (PARTITION BY mode) n
                     FROM v)
        SELECT mode, n, ${percentileColumns('ms')}, MAX(ms) AS max_ms
          FROM r GROUP BY mode, n ORDER BY n DESC`;

    const seriesQuery = `
        WITH v AS (SELECT ${bucketExpr} AS bucket_idx, ${lag} AS ms ${base}),
             r AS (SELECT bucket_idx, ms,
                          ROW_NUMBER() OVER (PARTITION BY bucket_idx ORDER BY ms) rn,
                          COUNT(*) OVER (PARTITION BY bucket_idx) n
                     FROM v)
        SELECT bucket_idx, n, ${percentileColumns('ms')}, MAX(ms) AS max_ms
          FROM r GROUP BY bucket_idx, n`;

    const [summary, byMode, seriesRows, coverage] = await Promise.all([
        localDb.query(summaryQuery, params),
        localDb.query(byModeQuery, params),
        localDb.query(seriesQuery, [...bucketParams(win), ...params]),
        coverageOf(filter, win, 'createdAt')
    ]);

    const series = densify(win, seriesRows.rows, (row) => ({
        n: row ? row.n : 0,
        p50: row ? row.p50 : null,
        p95: row ? row.p95 : null,
        p99: row ? row.p99 : null,
        max_ms: row ? row.max_ms : null
    }));

    return {
        window: { start: win.startIso, end: win.endIso, step_ms: win.stepMs },
        coverage,
        summary: summary.rows[0] ||
            { n: 0, p50: null, p95: null, p99: null, max_ms: null, avg_ms: null, negative: 0 },
        byMode: byMode.rows,
        series,
        backpressure: detectBackpressure(series)
    };
}

/**
 * Lag climbing while throughput does not.
 *
 * Lag rising alongside volume is a busy instance behaving correctly. Lag rising
 * while volume is flat or falling is the queue draining slower than it fills,
 * and that is the one worth a warning — it is the shape that precedes a backlog.
 *
 * Compares the last quarter of the window against the first three quarters, and
 * requires both a large relative jump and enough samples on each side for the
 * comparison to mean anything.
 */
function detectBackpressure(series) {
    const withData = series.filter((p) => p.n > 0 && p.p95 !== null);
    if (withData.length < 8) return { detected: false, reason: 'not enough buckets to compare' };

    const cut = Math.floor(withData.length * 0.75);
    const baseline = withData.slice(0, cut);
    const recent = withData.slice(cut);
    if (baseline.length === 0 || recent.length === 0) {
        return { detected: false, reason: 'not enough buckets to compare' };
    }

    const mean = (rows, key) => rows.reduce((a, r) => a + (r[key] || 0), 0) / rows.length;
    const baseLag = mean(baseline, 'p95');
    const recentLag = mean(recent, 'p95');
    const baseVol = mean(baseline, 'n');
    const recentVol = mean(recent, 'n');

    // A floor on the baseline: at single-digit milliseconds a doubling is noise,
    // not pressure.
    const lagRatio = baseLag > 5 ? recentLag / baseLag : 1;
    const volRatio = baseVol > 0 ? recentVol / baseVol : 1;

    return {
        detected: lagRatio >= 1.5 && volRatio <= 1.1,
        lag_ratio: Math.round(lagRatio * 100) / 100,
        volume_ratio: Math.round(volRatio * 100) / 100,
        baseline_p95_ms: baseLag,
        recent_p95_ms: recentLag
    };
}

module.exports = { getQueueLag, _internal: { detectBackpressure } };
