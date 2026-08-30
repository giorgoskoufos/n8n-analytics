/**
 * The pieces every analytics DAO is built from.
 *
 * ── Why this layer exists ────────────────────────────────────────────────
 *
 * Until now the SQL lived inside the Express handlers: 106 SELECTs across 3,500
 * lines of `metricsController` and `insightsController`, each welded to a `req`
 * it read parameters from and a `res` it answered on. That is fine while HTTP is
 * the only caller. It stops being fine the moment a second one appears — the AI
 * assistant — because there is no unit to call. The choice would have been to
 * write the analysis a second time for the assistant, which is the same fault
 * F-24 spent itself removing from the frontend: two places defining one thing,
 * drifting apart on the first change nobody applies twice.
 *
 * So: one place runs the SQL. Controllers parse HTTP and hand down domain
 * values. The assistant hands down the same domain values. Neither owns the
 * query.
 *
 * ── The line that keeps this MVC rather than a relocation ────────────────
 *
 * A DAO never sees `req`. It takes validated domain values — an ISO window, a
 * mode string, a scope object — and returns data. Validation and the 400s it
 * produces stay in the controller, because "the client sent a bad date" is an
 * HTTP fact. The instant a DAO reads `req.query`, it has become a second
 * controller and the layer has bought nothing.
 *
 * ── Scope is a required argument, deliberately ───────────────────────────
 *
 * In the handlers, scope arrived implicitly: `restrict(req, column)` reached
 * into the request and produced a clause. Implicit is exactly wrong here. A
 * forgotten scope is not a bug that shows up as a broken page, it is one user
 * reading another project's data, and it looks like a working feature. So it is
 * a named argument, and `filterFor` throws when it is missing rather than
 * defaulting to unrestricted — the same rule readonlyDb.query follows.
 */

const localDb = require('../config/localDb');
const { scopeClause } = require('../utils/scope');
const { groupingClause } = require('../utils/grouping');
const { parseDateRange } = require('../utils/validate');

const DEFAULT_RANGE_DAYS = 7;
const MAX_RANGE_DAYS = 60;
/**
 * The window an endpoint works in, plus the bucket grid for its time series.
 *
 * The grid is anchored on a whole bucket boundary rather than on the requested
 * start, so bucket zero covers the same span as every other one. An unanchored
 * grid makes the first point of every chart a partial bucket, which reads as a
 * dip that is really just a shorter measurement.
 */
function resolveWindow(query, { defaultDays = DEFAULT_RANGE_DAYS, maxDays = MAX_RANGE_DAYS } = {}) {
    const range = parseDateRange(query.startDate, query.endDate);
    if (!range.ok) return { ok: false, error: range.error };

    const end = range.end || new Date();
    let start = range.start || new Date(end.getTime() - defaultDays * 86400000);

    // Capped for the same reason getMetrics caps: the bucket arithmetic below is
    // linear in the number of buckets, and nothing on the front end can render
    // more than a few hundred points usefully.
    const maxMs = maxDays * 86400000;
    if (end.getTime() - start.getTime() > maxMs) start = new Date(end.getTime() - maxMs);

    // Hourly up to four days, daily beyond — the same threshold the main
    // dashboard uses, so a chart here lines up with the one there.
    const stepMs = (end.getTime() - start.getTime()) > 4 * 86400000 ? 86400000 : 3600000;
    const originMs = Math.floor(start.getTime() / stepMs) * stepMs;
    const count = Math.max(1, Math.ceil((end.getTime() - originMs) / stepMs));

    return {
        ok: true,
        startIso: start.toISOString(),
        endIso: end.toISOString(),
        originIso: new Date(originMs).toISOString(),
        originMs,
        stepMs,
        count
    };
}

/** Relative ISO timestamps. Used by every DAO that defaults its own window. */
const isoDaysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
const isoHoursAgo = (hours) => new Date(Date.now() - hours * 3600000).toISOString();

/** Milliseconds between two SQLite datetime expressions. */
const msBetween = (a, b) => `(julianday(${a}) - julianday(${b})) * 86400000.0`;

/** `bucket_idx` for a window's grid, as a SELECT expression. */
const bucketExpr = 'CAST((julianday(e."startedAt") - julianday(?)) * 86400.0 / ? AS INTEGER)';

/** The two parameters bucketExpr binds, in order. */
const bucketParams = (win) => [win.originIso, win.stepMs / 1000];

/**
 * Percentiles by nearest rank, in SQL.
 *
 * SQLite ships no percentile function, so the rank is computed with a window
 * function and the row at that rank picked out with a conditional MAX. The index
 * `1 + CAST((n - 1) * p AS INTEGER)` is always within [1, n], including when n
 * is 1 — a percentile over a nearly empty bucket is exactly where an off-by-one
 * turns into a NULL the chart draws as zero.
 */
function percentileColumns(valueAlias) {
    const at = (p) => `MAX(CASE WHEN rn = 1 + CAST((n - 1) * ${p} AS INTEGER) THEN ${valueAlias} END)`;
    return `${at(0.5)} AS p50, ${at(0.95)} AS p95, ${at(0.99)} AS p99`;
}

/**
 * Everything that narrows which workflows an answer covers, as one fragment.
 *
 * Two independent restrictions apply and must never be confused. Authorization
 * (utils/scope) decides what a caller is ALLOWED to see; grouping
 * (utils/grouping) is what they ASKED to see. Building both here is what stops a
 * call site from applying the second and forgetting the first — a permission bug
 * wearing a filter's clothes.
 *
 * The scope clause always comes first, so a grouping filter can only narrow the
 * set further, never widen it.
 *
 * @param {object}  opts
 * @param {object}  opts.scope     the caller's scope descriptor; `null` only for
 *                                 an explicitly unrestricted caller
 * @param {object} [opts.grouping] `{ workflow, folder, tag, project }`, already validated
 * @param {string}  column         the workflow-id column to restrict, qualified
 */
function filterFor({ scope, grouping = {} }, column) {
    if (scope === undefined) {
        throw new Error(
            'A DAO filter needs an explicit scope (null for an unrestricted caller). ' +
            'Defaulting it would turn a missed argument into a data leak.'
        );
    }
    const s = scopeClause(scope, column);
    const g = groupingClause(grouping, column);
    // Grouping ids are validated in the controller, which can answer 400. Reaching
    // here invalid is a programming error, not a client one.
    if (!g.ok) throw new Error(`Invalid grouping passed to a DAO: ${g.error}`);

    return {
        sql: s.sql + g.sql,
        params: [...s.params, ...g.params],
        condition: s.condition,
        grouped: g.active
    };
}

/**
 * Expands a sparse `bucket_idx` result into a dense series.
 *
 * Empty buckets have to be present as zeroes. A sparse series lets a chart join
 * two busy hours with a straight line through the quiet night between them,
 * which is the one shape the data never had.
 */
function densify(win, rows, fill) {
    const byIndex = new Map(rows.map((r) => [r.bucket_idx, r]));
    const series = [];
    for (let i = 0; i < win.count; i++) {
        series.push({
            time_val: new Date(win.originMs + i * win.stepMs).toISOString(),
            ...fill(byIndex.get(i))
        });
    }
    return series;
}

/**
 * How much of the window carries the column an answer depends on.
 *
 * `column` is the mirrored column being relied on; rows where it is NULL are
 * rows the backfill could not reach because Postgres had already pruned them.
 */
async function coverageOf(filter, win, column) {
    const r = await localDb.query(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN e."${column}" IS NOT NULL THEN 1 ELSE 0 END) AS covered,
                MIN(CASE WHEN e."${column}" IS NOT NULL THEN e."startedAt" END) AS covered_from
           FROM execution_entity e
          WHERE e."startedAt" >= ? AND e."startedAt" <= ?${filter.sql}`,
        [win.startIso, win.endIso, ...filter.params]
    );
    const row = r.rows[0] || {};
    const total = row.total || 0;
    const covered = row.covered || 0;
    return {
        total,
        covered,
        pct: total ? Math.round((covered / total) * 1000) / 10 : 100,
        covered_from: row.covered_from || null,
        // The one thing a reader needs to decide whether to trust the chart.
        complete: covered === total
    };
}

/** `mode` filter fragment from an already-validated mode (or null). */
function modeClause(mode) {
    return mode
        ? { sql: ' AND e.mode = ?', params: [mode] }
        : { sql: '', params: [] };
}

/**
 * Refuses a grouping filter whose id names nothing.
 *
 * ── The bug this closes ──────────────────────────────────────────────────
 *
 * `groupingClause` validates the SHAPE of an id and not its EXISTENCE, so
 * `{ workflow: 'NotARealWorkflow' }` was accepted, produced
 * `... IN (SELECT id FROM workflow_entity WHERE id = 'NotARealWorkflow')`, and
 * selected nothing. The endpoint answered 200 with every figure at zero.
 *
 * A zero that means "this did not happen" and a zero that means "you asked
 * about something that does not exist" are different answers, and nothing on
 * the page distinguished them. It is the same failure class as the bug that
 * motivated `filterFor` itself: a filter silently dropping, and the result
 * looking exactly as authoritative either way. The codebase already states the
 * rule elsewhere — F-24 §1, "empty ≠ zero" — and this is the last place that
 * was breaking it.
 *
 * ── Existence, not visibility ────────────────────────────────────────────
 *
 * This checks that the entity is IN THE REPLICA. It deliberately does not check
 * that the caller can see anything in it, and it deliberately does not check
 * that it CONTAINS anything, for two separate reasons:
 *
 *   · A real folder with no workflows in it is a legitimate empty result. Making
 *     that a 400 would be the same mistake in the opposite direction.
 *   · Answering differently for "does not exist" and "exists but is not yours"
 *     turns this into a way to enumerate another project's folder and workflow
 *     ids. Scope already handles the second case correctly, by returning the
 *     empty set it is supposed to return.
 *
 * So: a typo or a hallucinated id is refused; an honest zero still reads as
 * zero.
 *
 * @param {object} grouping  `{ workflow, folder, tag, project }`, any subset
 * @throws a 400 `daoError` naming the first id that resolves to nothing
 */
const GROUPING_TABLES = [
    ['workflow', 'workflow_entity', 'id'],
    ['folder', 'folder', 'id'],
    ['tag', 'tag_entity', 'id'],
    ['project', 'project', 'id']
];

async function assertGroupingExists(grouping = {}) {
    for (const [name, table, column] of GROUPING_TABLES) {
        const value = grouping[name];
        if (value === undefined || value === null || value === '') continue;

        const r = await localDb.query(
            `SELECT 1 AS present FROM ${table} WHERE ${column} = ? LIMIT 1`, [value]
        );
        if (!r.rows.length) {
            // Named, and quoted, because the id is almost always a copy-paste or
            // a model's guess and the reader needs to see which of four filters
            // was the wrong one.
            throw daoError(400,
                `No ${name} with id "${value}" exists in this dashboard's data. ` +
                'It may have been deleted, or the id may be wrong — nothing was measured, ' +
                'rather than measured as zero.');
        }
    }
}

/**
 * A rejection a DAO can raise without knowing what HTTP is.
 *
 * Most validation belongs in the controller, where the request is. Some of it
 * genuinely cannot go there: a drill-down that resolves an id and finds nothing,
 * or a filter whose validity depends on a value the query itself returns. Those
 * checks have to run next to the data.
 *
 * So the DAO throws this and the controller translates the `status` it carries.
 * The alternative — returning `{ ok: false, error }` and asking every caller to
 * remember to check — is the shape that produces a 200 with a body describing a
 * failure the first time someone forgets.
 */
function daoError(status, message) {
    const err = new Error(message);
    err.status = status;
    err.expected = true;
    return err;
}

const badRequest = (message) => daoError(400, message);
const notFound = (message) => daoError(404, message);

module.exports = {
    msBetween, bucketExpr, bucketParams, percentileColumns,
    filterFor, assertGroupingExists, densify, coverageOf, modeClause,
    isoDaysAgo, isoHoursAgo, resolveWindow,
    daoError, badRequest, notFound
};
