/**
 * One tool, twenty-nine analyses.
 *
 * ── Why this is a single tool and not twenty-nine ────────────────────────
 *
 * The obvious shape is one tool per DAO function. It reads well and it costs
 * badly: every analytics DAO takes the same envelope — a date window, an
 * execution mode, a folder/tag/project filter — so declaring them separately
 * repeats one parameter block twenty-nine times in every request. That is the
 * expensive part, not the number of destinations, and it is repetition rather
 * than information: the model re-reads the definition of `startDate` on every
 * turn.
 *
 * Collapsing them is only possible *because* the DAO refactor gave them a
 * uniform signature. One `metric` enum, one parameter block, one place that
 * maps a metric onto the function that answers it. Tools whose inputs genuinely
 * differ — a trace wants an execution id, not a window — stay separate, in
 * drilldown.js, because forcing them in here would put the repetition back as
 * unused optional fields.
 *
 * The enum descriptions are the metric catalogue. They are what the model reads
 * to choose, so they say what the number MEANS and what it does not, rather
 * than restating the function name in prose.
 */

const insightsDao = require('../../dao/insightsDao');
const queueLagDao = require('../../dao/queueLagDao');
const metricsDao = require('../../dao/metricsDao');
const errorIntelligenceDao = require('../../dao/errorIntelligenceDao');
const settingsDao = require('../../dao/settingsDao');

/**
 * How each metric is answered.
 *
 * `window` says what the DAO wants: 'resolved' takes the bucket grid produced by
 * resolveWindow, 'range' takes the raw start/end in a `filters` bag, and 'none'
 * takes neither. `defaults` are the DAO's own window preferences, kept here
 * beside the metric rather than guessed by the caller.
 */
const METRICS = {
    // ── Volume, timing, load ──────────────────────────────────────────
    kpis: {
        run: (o) => metricsDao.getMetrics(o),
        window: 'range',
        describe: 'Headline counts for the window: total executions, failures, average duration, ' +
            'and the same figures for the preceding window so a trend can be stated. Start here ' +
            'for "how are things", and quote the counts, never the rate alone.'
    },
    execution_volume: {
        run: (o) => metricsDao.getExecutionVolume(o),
        window: 'range',
        describe: 'Executions started per five-minute bucket. Use for "when did traffic change"; ' +
            'a bucket with no executions is a real zero, not missing data.'
    },
    trigger_breakdown: {
        run: (o) => insightsDao.getTriggerBreakdown(o),
        window: 'resolved',
        describe: 'Executions, failures and error rate split by how they were triggered ' +
            '(webhook, trigger, manual...). The failure modes do not overlap — a webhook error is ' +
            'usually a caller sending something unexpected, a schedule error is usually the ' +
            'workflow breaking — so a blended rate describes neither.'
    },
    queue_lag: {
        run: (o) => queueLagDao.getQueueLag(o),
        window: 'resolved',
        describe: 'How long executions waited before starting: p50/p95/p99 over time and per mode, ' +
            'plus a backpressure verdict (lag climbing while throughput is not). Answers "is the ' +
            'queue keeping up", which is different from "is anything failing".'
    },
    concurrency: {
        run: (o) => insightsDao.getConcurrency(o),
        window: 'resolved',
        defaults: { defaultDays: 1, maxDays: 7 },
        describe: 'How many executions ran at the same instant, measured by sweep line — not the ' +
            'number started, which is a different and much larger number.'
    },
    slowest: {
        run: (o) => metricsDao.getSlowest(o),
        window: 'none',
        describe: 'The ten slowest workflows by average duration over the last 7 days, each with ' +
            'its worst single run and that run\'s id. A 9s average made of 9s runs and one made of ' +
            'a 200s outlier are different problems, so compare max against avg.'
    },
    node_profile: {
        run: (o) => insightsDao.getNodeProfile(o),
        window: 'none',
        describe: 'Where the time goes inside workflows, per node: total and max milliseconds, ' +
            'runs, failures. Use for "why is X slow" once slowest has said that it is.'
    },

    // ── Failures ──────────────────────────────────────────────────────
    error_intelligence: {
        run: (o) => errorIntelligenceDao.getErrorIntelligence(o),
        window: 'range',
        describe: 'The main failure picture: totals, categories, the largest fingerprint groups, ' +
            'and which groups behave unlike their label. Accepts mode= — error profiles differ ' +
            'completely between webhook and trigger, so filter when the question names one.'
    },
    errors_by_workflow: {
        run: (o) => metricsDao.getErrors(o),
        window: 'none',
        describe: 'Failure count and total runs per workflow — counts ACROSS workflows, so a ' +
            'rate can be given with its denominator. For the failure history of ONE workflow, ' +
            'broken down by node and category, use drill_down with ' +
            'kind="workflow_failure_history".'
    },
    reliability: {
        run: (o) => insightsDao.getReliability(o),
        window: 'resolved',
        describe: 'Retry-aware error rate: raw failures against failures that stayed failed after ' +
            'retries. A workflow that retries twice as often is not more reliable, and the raw ' +
            'rate says it is.'
    },
    silent_workflows: {
        run: (o) => insightsDao.getSilentWorkflows(o),
        window: 'none',
        describe: 'Active workflows that stopped running without failing — silence, not errors. ' +
            'Each carries its learned cadence and how many multiples of it have passed.'
    },

    // ── Structure and change ──────────────────────────────────────────
    organisation: {
        run: (o) => insightsDao.getOrganisation(o),
        window: 'resolved',
        describe: 'Executions and failures rolled up by folder, tag and project. Use when the ' +
            'question names a grouping rather than a workflow.'
    },
    blast_radius: {
        run: (o) => insightsDao.getDependencies(o),
        window: 'resolved',
        defaults: { defaultDays: 30 },
        describe: 'What each credential and sub-workflow reaches, with the error rate of everything ' +
            'that depends on it. Answers "what breaks if this credential expires".'
    },
    deploys: {
        run: (o) => insightsDao.getDeploys(o),
        window: 'resolved',
        defaults: { defaultDays: 30 },
        describe: 'Workflow versions saved by a person, with the error rate either side of each. ' +
            'Use to test "did something change just before this started".'
    },
    workflows: {
        run: (o) => insightsDao.getWorkflows(o),
        window: 'none',
        describe: 'The workflow inventory: name, active, archived, folder, last run. Prefer ' +
            'search_catalog to find one by name; use this to list or count them.'
    },
    metadata_keys: {
        run: (o) => insightsDao.getMetadataKeys(o),
        window: 'none',
        describe: 'Which business-metadata keys the instance records, and how often. The VALUES ' +
            'are customer identifiers and are never available.'
    },

    // ── Cost ──────────────────────────────────────────────────────────
    storage_forecast: {
        run: (o) => insightsDao.getStorageForecast(o),
        window: 'none',
        describe: 'Bytes of execution data retained and the projected growth, bounded to what n8n ' +
            'itself still holds rather than the replica\'s longer history.'
    },
    roi: {
        run: (o) => metricsDao.getRoiMetrics(o),
        window: 'range',
        describe: 'Time and money saved, from the per-workflow figures an operator configured. ' +
            'Only as good as those settings — say so if they are mostly unset.'
    },
    roi_settings: {
        run: (o) => settingsDao.listRoiSettings(o),
        window: 'none',
        describe: 'The configured saved-time and hourly-rate per workflow, with execution counts. ' +
            'Use to answer why an ROI figure is what it is, or which workflows are unconfigured.'
    },

    // ── The instance itself ───────────────────────────────────────────
    dashboard_health: {
        run: (o) => insightsDao.getSystemHealth(o),
        window: 'none',
        describe: 'The ETL\'s own history and the replica\'s freshness. describe_instance already ' +
            'summarises this; reach for it only when asked about the pipeline in detail.'
    }
};

module.exports = { METRICS };
