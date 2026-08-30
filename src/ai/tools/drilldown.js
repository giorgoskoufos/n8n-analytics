/**
 * The three "look at this one thing" tools.
 *
 * Separate from get_analytics because their inputs genuinely differ: a trace
 * wants an execution id, a group wants a fingerprint. Folding them into the
 * analytics envelope would mean carrying `startDate` and `folder` as unused
 * optional fields on every one of them — which is the repetition that tool was
 * created to remove, wearing a different hat.
 *
 * Each takes the caller's scope, so a drill-down cannot reach an execution the
 * user is not allowed to see. That check lives in the DAO, not here.
 *
 * ── The rule, and the entry that broke it ────────────────────────────────
 *
 * **A tool belongs here when its input is not a workflow id.** That is the whole
 * test, and `workflow_failure_history` used to fail it: its input IS a workflow
 * id, and once get_analytics grew a `workflow` filter the analytics envelope
 * carried exactly that.
 *
 * It showed. Asked whether a failure was isolated or recurring, the model
 * reached for `get_analytics(metric: 'workflow_failure_history')` — not
 * confusion, but the rule above applied correctly to a tool that no longer
 * followed it, costing one recovered step every single time.
 *
 * It has moved to `METRICS` in analytics.js, where the caller kept trying to put
 * it, taking `workflow` like every other filter there. `RENAMED` below is what
 * catches a caller that still has the old address.
 */

const metricsDao = require('../../dao/metricsDao');
const errorIntelligenceDao = require('../../dao/errorIntelligenceDao');

/**
 * Names that used to exist here, and where they went.
 *
 * Two moves are recorded, and they are different kinds of move.
 *
 * `workflow_errors` was a RENAME. It collided with the `errors_by_workflow`
 * metric — two names built from the same three words, one on each tool — and a
 * model asked for one workflow's failures reached for the wrong one and spent a
 * step finding out, measured on 1 turn in 33, every run.
 *
 * `workflow_failure_history` was a MOVE, to the other registry entirely. Both
 * end at the same place, so both live in one map, and execute.js works out which
 * tool the destination is on rather than this file asserting it — the entry
 * would otherwise have to be corrected a second time if it ever moved back.
 *
 * The map exists because without it an old name matches nothing and the helpful
 * redirect degrades into "unknown, here are twenty alternatives".
 */
const RENAMED = {
    workflow_errors: 'workflow_failure_history'
};

const DRILLDOWNS = {
    execution_trace: {
        describe: 'One execution\'s per-node timing — which node took the time, how many items ' +
            'it produced, where it stopped. `id` is an execution id.',
        run: ({ id, scope, userId }) =>
            metricsDao.getExecutionTrace({ scope, grouping: {}, route: { id }, userId })
    },
    execution_error: {
        describe: 'One failed execution\'s classification: which node, which category, which ' +
            'fingerprint. The error text and payload are not available. `id` is an execution id.',
        run: ({ id, scope, userId }) =>
            metricsDao.getExecutionError({ scope, grouping: {}, filters: {}, route: { id }, userId })
    },
    error_group: {
        describe: 'The executions behind one error fingerprint — when it happens, which ' +
            'workflows it hits. `id` is a fingerprint from search_catalog or error_intelligence. ' +
            'Covers the last 30 days.',
        // The DAO requires an explicit window rather than defaulting one, because
        // over HTTP an absent range means the client forgot rather than "all of
        // history". Here there is no client to have forgotten, so the tool
        // supplies the same 30 days the errors page opens on, and says so above.
        run: ({ id, scope }) => errorIntelligenceDao.getErrorGroupExecutions({
            scope,
            grouping: {},
            body: {
                fingerprint: id,
                startDate: new Date(Date.now() - 30 * 86400000).toISOString(),
                endDate: new Date().toISOString()
            }
        })
    }
};

module.exports = { DRILLDOWNS, RENAMED };
