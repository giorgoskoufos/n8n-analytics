/**
 * Error intelligence — fingerprints, categories and behaviour (F-07/F-08).
 *
 * Lifted out of metricsController. See dao/shared.js for why, and for the rule
 * this layer follows: domain values in, data out, never a `req` and never a
 * status code. Validation that could only run next to the data throws
 * `daoError`, which the controller translates.
 */

const localDb = require('../config/localDb');
// No `scopeClause` here any more: every query in this file narrows through
// `filterFor`, which applies the caller's scope AND whatever they asked to
// filter by. Importing the half that only does the first is how a call site
// ends up silently dropping the second — which is exactly what four functions
// in this file were doing: taking a `grouping` argument and never reading it.
const { canSeeWorkflow } = require('../utils/scope');
const { parseDateRange, parseExecutionMode } = require('../utils/validate');
const { filterFor, daoError, isoDaysAgo } = require('./shared');
const log = require('../utils/logger').logger('DAO');

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



/** F-07/F-08 · Error groups, categories and behaviour. */
async function getErrorIntelligence({ scope: caller, grouping, filters = {} }) {
    const range = parseDateRange(filters.startDate, filters.endDate);
    if (!range.ok) throw daoError(400, range.error);

    // F-24 §3 · the gap F-02 left behind.
    //
    // F-02 put ?mode= on getMetrics, getExecutions, getExecutionVolume and
    // getExecutionVolumeDetails — and not on this endpoint. So the
    // dashboard could say webhooks fail at 4.03% and schedules at 0.82%,
    // and could not say WHICH ERRORS were whose. The one question the
    // breakdown makes worth asking was the one it could not answer.
    //
    // execution_error_analytics has no mode column of its own: its primary
    // key IS the execution id (that is what `ex.id = a.id` in the behaviour
    // query below relies on), so the filter is a join back to
    // execution_entity on the primary key. Cheap, and it keeps `mode` in
    // exactly one table.
    const modeCheck = parseExecutionMode(filters.mode);
    if (!modeCheck.ok) throw daoError(400, modeCheck.error);
    const mode = modeCheck.mode;

    // Applied to the analytics table (via the id join) and to
    // execution_entity directly, because the error rate is a ratio and both
    // halves of it must describe the same population. Filtering only the
    // numerator would report webhook errors over ALL executions and produce
    // a rate that is wrong in the direction that looks reassuring.
    const modeAnalytics = (alias) => mode
        ? ` AND ${alias ? alias + '.' : ''}id IN (SELECT id FROM execution_entity WHERE mode = ?)`
        : '';
    const mp = mode ? [mode] : [];              // the one bound value, or none
    const modeExec = (alias) => mode ? ` AND ${alias ? alias + '.' : ''}mode = ?` : '';

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
    const aScope = filterFor({ scope: caller, grouping }, 'workflow_id');
    const aaScope = filterFor({ scope: caller, grouping }, 'a.workflow_id');
    const eScope = filterFor({ scope: caller, grouping }, '"workflowId"');
    const weScope = filterFor({ scope: caller, grouping }, 'w.id');
    // No `if (!f.ok)` guard here any more. `restrict` used to report a bad
    // grouping id by returning `{ ok: false, error }`; `filterFor` throws
    // instead, so the guard would have been checking a field that no longer
    // exists — always falsy, and therefore always rejecting with an empty
    // message. Validation of those ids happens in the controller, which can
    // still answer 400 properly.

    // 1. Summary Stats
    const summaryQuery = `
        SELECT 
            COUNT(*) as total_errors,
            COUNT(DISTINCT workflow_id) as affected_workflows,
            COUNT(DISTINCT node_name) as unique_failing_nodes,
            SUM(CASE WHEN error_category IN ('rate_limit','network','upstream') THEN 1 ELSE 0 END) as transient_count,
            SUM(CASE WHEN error_category IN ('auth','config','data','logic') THEN 1 ELSE 0 END) as structural_count
        FROM execution_error_analytics
        WHERE timestamp >= ? AND timestamp <= ?${aScope.sql}${modeAnalytics('')}
    `;

    const prevSummaryQuery = `
        SELECT COUNT(*) as total_errors
        FROM execution_error_analytics
        WHERE timestamp >= ? AND timestamp < ?${aScope.sql}${modeAnalytics('')}
    `;

    // Total executions for error rate calculation
    const execCountQuery = `
        SELECT COUNT(*) as total
        FROM execution_entity
        WHERE "startedAt" >= ? AND "startedAt" <= ?${eScope.sql}${modeExec('')}
    `;

    // 2. Category Breakdown
    const categoryQuery = `
        SELECT error_category, COUNT(*) as count
        FROM execution_error_analytics
        WHERE timestamp >= ? AND timestamp <= ?${aScope.sql}${modeAnalytics('')}
        GROUP BY error_category
        ORDER BY count DESC
    `;

    // 3. Trend Timeline (daily buckets)
    const trendQuery = `
        SELECT date(timestamp) as day, error_category, COUNT(*) as count
        FROM execution_error_analytics
        WHERE timestamp >= ? AND timestamp <= ?${aScope.sql}${modeAnalytics('')}
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
        WHERE e."startedAt" >= ? AND e."startedAt" <= ?${weScope.sql}${modeExec('e')}
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
          AND a.fingerprint IS NOT NULL${aaScope.sql}${modeAnalytics('a')}
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
    // Note on ?mode= and this query: the filter lands on `a` (the error
    // rows being judged) and deliberately NOT on the `ex` CTE. The question
    // is "did the next run of this workflow succeed", and the next run is
    // the next run whatever triggered it. Filtering the CTE to one mode
    // would make a webhook failure followed by a successful schedule run
    // read as never having recovered, which is a claim about the filter
    // rather than about the error.
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
           AND a.fingerprint IS NOT NULL${aScope.sql}${modeAnalytics('a')}
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
          AND a.fingerprint IS NOT NULL${aScope.sql}${modeAnalytics('a')}
        GROUP BY a.fingerprint, a.error_category
    `;

    const [summary, prevSummary, execCount, categories, trend, health, groups, groupCategories,
        behaviour] = await Promise.all([
            localDb.query(summaryQuery, [startIso, endIso, ...aScope.params, ...mp]),
            localDb.query(prevSummaryQuery, [prevStartIso, prevEndIso, ...aScope.params, ...mp]),
            localDb.query(execCountQuery, [startIso, endIso, ...eScope.params, ...mp]),
            localDb.query(categoryQuery, [startIso, endIso, ...aScope.params, ...mp]),
            localDb.query(trendQuery, [startIso, endIso, ...aScope.params, ...mp]),
            localDb.query(healthQuery, [startIso, endIso, ...weScope.params, ...mp]),
            localDb.query(groupsQuery, [startIso, endIso, ...aaScope.params, ...mp]),
            localDb.query(groupCategoryQuery, [startIso, endIso, ...aScope.params, ...mp]),
            localDb.query(behaviourQuery, [startIso, startIso, endIso, ...aScope.params, ...mp])
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

    return ({
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
        // Echoed so the page can state which slice it is showing. A filtered
        // view that looks like an unfiltered one is the same failure as an
        // empty chart that looks like a quiet day.
        mode,
        n8nBaseUrl
    });
}

/** Errors for one workflow. */
async function getWorkflowErrorDrilldown({ scope: caller, grouping, route = {}, userId }) {
    const { id } = route;
    if (!id) throw daoError(400, 'Workflow ID is required');

    // Addressed by workflow id. Same reasoning as getExecutionError: the 404
    // below already exists for a workflow that is not there, so an invisible
    // one takes the identical answer and reveals nothing.
    if (!(await canSeeWorkflow(caller, id))) {
        log.warn(`User ${userId} was refused workflow ${id}.`);
        throw daoError(404, 'Workflow not found');
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
        throw daoError(404, 'Workflow not found');
    }

    return ({
        workflowName: info.rows[0].name,
        nodeDistribution: dist.rows,
        sourceDistribution: sources.rows,
        rawErrors: raw.rows
    });
}

/** The executions behind one fingerprint. */
async function getErrorGroupExecutions({ scope: caller, grouping, body = {} }) {
    const { fingerprint, startDate, endDate, mode: rawMode } = body;

    // A fingerprint is 16 hex characters produced by this server. Anything
    // else is not a value a client could have got from us, and validating the
    // shape keeps a malformed one from being answered with an empty list that
    // reads as "no occurrences".
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(fingerprint)) {
        throw daoError(400, 'A valid fingerprint is required');
    }
    if (!startDate || !endDate) {
        throw daoError(400, 'Missing required parameters');
    }

    // These go straight into a timestamp comparison. Unvalidated, a malformed
    // value simply matched nothing and the empty result read as "no errors".
    const range = parseDateRange(startDate, endDate);
    if (!range.ok) throw daoError(400, range.error);

    // The same filter as the list above it, for the same reason L-30 gave:
    // if the filter applies to the group row but not to the rows behind it,
    // a group counted as 12 opens onto 30 occurrences and the page
    // contradicts itself in the space of one click.
    const modeCheck = parseExecutionMode(rawMode);
    if (!modeCheck.ok) throw daoError(400, modeCheck.error);
    const modeSql = modeCheck.mode
        ? ' AND a.id IN (SELECT id FROM execution_entity WHERE mode = ?)' : '';
    const modeParams = modeCheck.mode ? [modeCheck.mode] : [];

    const scope = filterFor({ scope: caller, grouping }, 'a.workflow_id');

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
          AND a.timestamp >= ? AND a.timestamp <= ?${scope.sql}${modeSql}
        ORDER BY a.timestamp DESC
        LIMIT 30
    `;

    const result = await localDb.query(query, [
        fingerprint, range.start.toISOString(), range.end.toISOString(),
        ...scope.params, ...modeParams
    ]);
    return ({ executions: result.rows });
}

module.exports = {
    getErrorIntelligence,
    getWorkflowErrorDrilldown,
    getErrorGroupExecutions,

    // Asserted on directly by the unit tests, and re-exported through
    // metricsController._internal so the suite keeps its existing entry point.
    _internal: { natureOf, STATIC_TRANSIENT, MIN_BEHAVIOUR_OBSERVATIONS }
};
