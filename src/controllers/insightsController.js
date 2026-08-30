const { parseExecutionMode } = require('../utils/validate');
const { groupingClause } = require('../utils/grouping');
const log = require('../utils/logger').logger('API');
const queueLagDao = require('../dao/queueLagDao');
const { resolveWindow } = require('../dao/shared');
const insightsDao = require('../dao/insightsDao');

/**
 * The questions F-01 made answerable.
 *
 * Every endpoint here reads a column that did not exist in the replica three
 * migrations ago, which is also why they share one concern the older endpoints
 * do not have: the mirrored columns are NULL on every execution Postgres had
 * already pruned before the backfill ran. On this instance that is 404,632 of
 * 503,000 rows — four fifths of the table, all of it older than the retention
 * horizon.
 *
 * So each answer carries a `coverage` block saying how much of the window it
 * could actually see. Without it a 60-day chart shows traffic collapsing in
 * July, and the collapse is this replica's history rather than the instance's.
 * Reporting the number is the difference between a gap and a lie.
 */



/**
 * Expands a sparse `bucket_idx` result into a dense series.
 *
 * Empty buckets have to be present as zeroes. A sparse series lets the chart
 * join two busy hours with a straight line through the quiet night between them,
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

// ==========================================================================
// F-02 · Analysis by trigger type
// ==========================================================================

/**
 * Executions split by how they were triggered.
 *
 * The split matters because the failure modes do not overlap: a webhook error is
 * usually a caller sending something unexpected, a schedule error is usually the
 * workflow itself breaking. Counted together they average into one number that
 * describes neither. On this instance webhooks fail at 4.0% and schedules at
 * 1.1%, and the dashboard reported 3.9% — the webhook figure, wearing
 * everything's name.
 */
exports.getTriggerBreakdown = async (req, res) => {
    try {
        const win = resolveWindow(req.query);
        if (!win.ok) return res.status(400).json({ error: win.error });
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await insightsDao.getTriggerBreakdown({ window: win, scope: req.scope, grouping: req.query }));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch trigger breakdown' });
    }
};

// ==========================================================================
// F-03 · Queue lag
// ==========================================================================

/**
 * How long an execution waited between being created and starting to run.
 *
 * The first thing to move when a queue-mode instance runs short of workers, and
 * measured by nothing — not by n8n, and not by this dashboard until `createdAt`
 * was mirrored. It is healthy here (p95 of 53 ms on webhooks) which is precisely
 * why it is worth recording now: the value of the metric is the baseline, and a
 * baseline cannot be collected retroactively.
 *
 * Percentiles rather than an average. Queue lag is a long tail by nature — one
 * execution waiting a second while ten thousand wait fifteen milliseconds barely
 * moves the mean, and it is the only interesting event in the window.
 */
exports.getQueueLag = async (req, res) => {
    try {
        // Everything here is HTTP: read the request, validate it, decide the
        // 400s. The analysis itself is in dao/queueLagDao — one place, called
        // by this handler and by the AI assistant with the same domain values.
        const win = resolveWindow(req.query);
        if (!win.ok) return res.status(400).json({ error: win.error });

        const mode = parseExecutionMode(req.query.mode);
        if (!mode.ok) return res.status(400).json({ error: mode.error });

        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });

        res.json(await queueLagDao.getQueueLag({
            window: win,
            mode: mode.mode,
            scope: req.scope,
            grouping: req.query
        }));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch queue lag' });
    }
};

// ==========================================================================
// F-04 · Database growth
// ==========================================================================

/**
 * Where the n8n database's size is coming from, and where it is heading.
 *
 * Deliberately not bounded by the caller's date range. The question is not "how
 * many bytes did this week produce" but "how large is the store and why", so the
 * set is everything n8n is still holding. `days` only controls the daily series.
 */
exports.getStorageForecast = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await insightsDao.getStorageForecast({ scope: req.scope, grouping: req.query, days: Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 120) }));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch storage forecast' });
    }
};

// ==========================================================================
// F-05 · Retry-aware error rate
// ==========================================================================

/**
 * Two error rates, because there are two questions.
 *
 * Raw is "how often did something go wrong". Effective is "how often did
 * something go wrong and stay wrong". They are the same number on this instance
 * — retries are not switched on, so `retryOf` and `retrySuccessId` are empty
 * everywhere — and they stop being the same number the moment anyone enables
 * them, at which point an error rate that cannot see a retry starts counting
 * failures that were resolved seconds later.
 *
 * Building it now rather than then is the point of the item: the alternative is
 * discovering the flaw from a dashboard that has already been wrong for a month.
 */
exports.getReliability = async (req, res) => {
    try {
        const win = resolveWindow(req.query);
        if (!win.ok) return res.status(400).json({ error: win.error });
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await insightsDao.getReliability({ window: win, scope: req.scope, grouping: req.query }));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch reliability metrics' });
    }
};

// ==========================================================================
// F-06 · Real concurrency
// ==========================================================================

// Concurrency is the one metric here that cannot be answered by aggregation —
// it needs every interval — so its window is capped harder than the others.
const MAX_CONCURRENCY_DAYS = 7;
/**
 * How many executions were actually running at once.
 *
 * The distinction this exists to draw: `execution_volume_stats` counts
 * executions *started* per bucket, and after L-30 the chart says so — but the
 * number still reads like load. It is not. This instance starts about sixteen
 * executions in a five-minute bucket and never has more than three in flight,
 * because the median execution lasts 114 milliseconds. Sixteen sequential blips
 * and sixteen parallel runs are the same bar on the volume chart and completely
 * different facts about capacity.
 *
 * Computed by sweep line rather than in SQL. Every alternative — a correlated
 * subquery per bucket, a self-join on overlap — is quadratic or worse, and an
 * execution spanning several buckets breaks the GROUP BY formulation outright.
 * Sorting 2n events and walking them once is O(n log n) and, unlike the SQL
 * versions, is exactly right for an execution of any length.
 */
exports.getConcurrency = async (req, res) => {
    try {
        const win = resolveWindow(req.query, { defaultDays: 1, maxDays: MAX_CONCURRENCY_DAYS });
        if (!win.ok) return res.status(400).json({ error: win.error });
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await insightsDao.getConcurrency({ window: win, scope: req.scope, grouping: req.query }));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch concurrency' });
    }
};

// ==========================================================================
// F-09 · Silent death detection
// ==========================================================================

/**
 * Active workflows that have stopped running.
 *
 * The item calls this the most insidious problem in automations, and it is: a
 * workflow that fails is visible everywhere, a workflow that simply stops is
 * visible nowhere. Everything needed to see it is already here — the executions
 * and their timestamps — and nothing looked.
 *
 * The trap, and the reason this endpoint is shaped the way it is:
 *
 *   Silence is measured against how fresh the DATA is, not against the clock.
 *
 * The first version of this measured `now - lastRun` and flagged five workflows
 * at once, each apparently dead for 3.2 hours. They were not. The ETL had
 * stopped 3.2 hours earlier, so every scheduled workflow in the instance looked
 * identically dead. Measuring against the newest execution the replica actually
 * holds makes that impossible by construction: if nothing has synced, nothing
 * looks silent, and the staleness is reported once, on its own, as the fact it
 * is. An alerting feature that cries wolf the moment its own pipeline hiccups
 * would be switched off within a week.
 */
exports.getSilentWorkflows = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await insightsDao.getSilentWorkflows({ scope: req.scope, grouping: req.query, k: Math.min(Math.max(Number(req.query.k) || insightsDao.DEFAULT_SILENCE_K, 1.5), 100) }));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to detect silent workflows' });
    }
};

// ==========================================================================
// F-17 · Workflow inventory
// ==========================================================================

/**
 * Every workflow, with the metadata that decides whether it belongs in a list.
 *
 * The dropdowns used to be built from whichever workflows happened to appear in
 * the current window's top-executions query, which made them both incomplete and
 * full of archived entries. 87 of this instance's 163 workflows are archived and
 * none has run since the beginning of the month — more than half of every picker
 * was dead.
 *
 * Archived rows are returned rather than filtered here. The caller decides: the
 * dropdowns hide them by default, and the aggregate views must keep counting
 * their executions, because that history is real and happened.
 */
exports.getWorkflows = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await insightsDao.getWorkflows({ scope: req.scope, grouping: req.query }));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch workflows' });
    }
};

// ==========================================================================
// F-16 · Folders, tags, projects
// ==========================================================================

/**
 * How the instance is organised, with the numbers attached.
 *
 * n8n already keeps a folder tree, tags and projects; the dashboard listed 163
 * workflows flat and ignored all three. The counts are what make the structure
 * worth having — "the Nova folder holds nine workflows and 62% of the failures"
 * is a sentence the flat list cannot produce.
 *
 * Folder totals are rolled up through the hierarchy: asking about a parent
 * includes everything beneath it, which is what anyone means by "how much does
 * this folder cost".
 */
exports.getOrganisation = async (req, res) => {
    try {
        const win = resolveWindow(req.query);
        if (!win.ok) return res.status(400).json({ error: win.error });
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await insightsDao.getOrganisation({ window: win, scope: req.scope, grouping: req.query }));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch organisation' });
    }
};

// ==========================================================================
// F-10 · Blast radius
// ==========================================================================

/**
 * What else breaks when one thing does.
 *
 * n8n records, per workflow version, every node type and credential id it uses —
 * 2,568 rows this dashboard never opened. The question it answers is the one
 * asked in the minute after an auth error: is this one broken workflow, or is it
 * an expired token that is about to take eleven others with it? On this instance
 * a single Google Sheets credential is used by 42 workflows.
 *
 * Credential *contents* are nowhere near this. The mirror stores a credential's
 * name and type and nothing else; the encrypted blob is excluded at the sync.
 */
exports.getDependencies = async (req, res) => {
    try {
        const win = resolveWindow(req.query, { defaultDays: 30 });
        if (!win.ok) return res.status(400).json({ error: win.error });
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await insightsDao.getDependencies({ window: win, scope: req.scope, grouping: req.query }));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch dependencies' });
    }
};

// ==========================================================================
// F-11 · Deploy correlation
// ==========================================================================

/**
 * git blame for automations.
 *
 * n8n keeps every saved version with its author, and every execution records the
 * version it ran. Put together they answer "the errors start at the version
 * deployed on the 13th, by X" — which no n8n tool will tell you.
 *
 * Autosaves are separated rather than dropped. n8n writes one on nearly every
 * keystroke pause, so 5 of the 204 versions here are real saves and the rest are
 * noise; a chart marking all 204 as deploys would be a solid line. But an
 * autosave is still the moment a change existed, so it stays available.
 */
exports.getDeploys = async (req, res) => {
    try {
        const win = resolveWindow(req.query, { defaultDays: 30 });
        if (!win.ok) return res.status(400).json({ error: win.error });
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await insightsDao.getDeploys({ window: win, scope: req.scope, grouping: req.query, includeAutosaves: req.query.autosaves === 'true' }));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch deploys' });
    }
};

// ==========================================================================
// F-18 · Business metadata
// ==========================================================================

/**
 * The keys workflows record about their own runs, and what they hold.
 *
 * This table was empty when the item was written and is not any more. It is the
 * hook for business-level questions the dashboard structurally cannot ask
 * otherwise — "show me every failed execution for customer X" — because nothing
 * else here knows what a customer is.
 *
 * Keys are always listed. Values are listed only where there are few enough
 * distinct ones to be a filter rather than a data dump.
 */
exports.getMetadataKeys = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await insightsDao.getMetadataKeys({ scope: req.scope, grouping: req.query }));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch metadata keys' });
    }
};

// ==========================================================================
// F-12 · Where a workflow spends its time
// ==========================================================================

/**
 * GET /api/analytics/node-profile
 *
 * The workflow-level answer to "which node is the bottleneck", built from a
 * sample of successful executions per workflow (see profileWorkflowNodes).
 *
 * Two things this endpoint is careful about, because both would otherwise turn
 * a sample into a claim:
 *
 *   - **Every figure is per execution, not a total.** A node profiled from five
 *     samples and one profiled from two are not comparable as sums, and the sum
 *     is what the table stores. Dividing here rather than in the browser means
 *     the ranking and the number agree.
 *   - **Coverage is reported.** How many workflows have a profile at all, and
 *     how old the oldest one is. A "slowest nodes" list drawn from a third of
 *     the instance reads exactly like one drawn from all of it.
 */
exports.getNodeProfile = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await insightsDao.getNodeProfile({ scope: req.scope, grouping: req.query, workflowId: req.query.workflowId || null }));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to read the node profile' });
    }
};

// ==========================================================================
// F-19 · The dashboard observing itself
// ==========================================================================

/**
 * How often the ETL is supposed to run, in milliseconds.
 *
 * Read from the same variable server.js builds the cron expression from, so the
 * "is it late?" verdict below cannot disagree with the schedule that produces
 * the runs. A deployment that syncs hourly must not be told it is stalled every
 * six minutes.
 */
/**
 * GET /api/analytics/system
 *
 * An observability tool that cannot be asked whether it is working is asking to
 * be believed. Every panel on every other page is downstream of one process
 * finishing every few minutes, and until now the only evidence that it had was
 * a line in a log file nobody reads.
 *
 * Three things it deliberately does NOT do:
 *
 *   - It does not report freshness as "minutes since the last successful sync"
 *     alone. A sync can succeed and move nothing, so the age of the newest
 *     execution is reported next to it. The two disagreeing is the interesting
 *     case: the pipeline is running and the source has gone quiet.
 *   - It does not claim a VACUUM date it does not have. Nothing here runs one —
 *     that is the offline script's job — so the reclaimable space is measured
 *     instead, which is the question a date was standing in for anyway.
 *   - It does not require an elevated role. It exposes counts, durations and
 *     file sizes about this dashboard, no customer data and no scoped rows, and
 *     the person most likely to notice something is wrong is whoever is looking
 *     at a chart that seems stale.
 */
exports.getSystemHealth = async (req, res) => {
    try {
        res.json(await insightsDao.getSystemHealth({ brief: req.query.brief === '1' }));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to read dashboard health' });
    }
};

// Exported for the tests, which assert on the arithmetic rather than on a
// rendered number.
exports._internal = {
    resolveWindow, densify,
    // Moved into dao/insightsDao with the queries that use them. Re-exported
    // rather than reimplemented: the tests assert on this arithmetic, and there
    // must go on being exactly one copy of it to assert against.
    forecast: insightsDao._internal.forecast,
    sweepConcurrency: insightsDao._internal.sweepConcurrency,
    growthFrom: insightsDao._internal.growthFrom,
    // Moved to dao/queueLagDao with the query it belongs to. Re-exported, not
    // reimplemented — the tests assert on the arithmetic, and there must go on
    // being exactly one copy of it to assert against.
    detectBackpressure: queueLagDao._internal.detectBackpressure
};
