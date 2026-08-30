/**
 * The four "look at this one thing" tools.
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
 * ── One of these is now on the wrong side of that line ───────────────────
 *
 * The rule above is "separate when the input is not a workflow id". Adding a
 * `workflow` filter to get_analytics moved the line, and
 * `workflow_failure_history` ended up behind it: its input IS a workflow id, and
 * the analytics envelope now carries exactly that.
 *
 * It shows. Asked whether a failure is isolated or recurring, the model reaches
 * for `get_analytics(metric: 'workflow_failure_history')` — not confusion, but
 * the rule above applied correctly to a tool that no longer follows it. It costs
 * one recovered step every time, and renaming the entry (from `workflow_errors`,
 * which collided with the `errors_by_workflow` metric) fixed the name collision
 * without touching this.
 *
 * The fix is to move it into METRICS, where the caller keeps trying to put it,
 * with `grouping.workflow` as its required input. Deliberately not done in the
 * same change as the rename: one is a rename, the other moves a tool between two
 * registries and changes what a missing argument means.
 */

const metricsDao = require('../../dao/metricsDao');
const errorIntelligenceDao = require('../../dao/errorIntelligenceDao');

/**
 * Names that used to exist here, and where they went.
 *
 * `workflow_errors` was this drill-down, and `errors_by_workflow` is a metric:
 * two names built from the same three words, one on each tool. A model asked for
 * one workflow's failures reached for the wrong one and spent a step finding
 * out — measured, on 1 turn in 33, every run.
 *
 * The rename fixes it for anyone reading the two lists side by side. This map
 * fixes it for a caller that already has the old name in its head, because
 * without it the old name matches nothing and the helpful redirect degrades into
 * "unknown, here are twenty alternatives".
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
    workflow_failure_history: {
        describe: 'The failure history of ONE workflow, grouped by node and category. ' +
            '`id` is a workflow id from search_catalog. Not to be confused with the ' +
            '`errors_by_workflow` metric, which counts failures ACROSS workflows and takes ' +
            'no id.',
        run: ({ id, scope, userId }) =>
            errorIntelligenceDao.getWorkflowErrorDrilldown({
                scope, grouping: {}, route: { id }, userId
            })
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
