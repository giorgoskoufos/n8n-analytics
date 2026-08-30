/**
 * Running one tool call.
 *
 * The single place a tool name turns into work. Every path through here takes
 * the caller's scope as an argument rather than reading it from somewhere
 * ambient, for the same reason the DAOs do: a scope that can be forgotten is a
 * scope that will be.
 *
 * ── Two shapes of the same permission ────────────────────────────────────
 *
 * The context carries the caller's scope twice, deliberately:
 *
 *   ctx.scope       the descriptor the DAOs take, which they turn into a SQL
 *                   fragment around the query they are building
 *   ctx.visibleIds  the id list the read-only connection takes, because its
 *                   restriction lives inside temp views as a membership test
 *                   rather than as an appended clause
 *
 * They are not interchangeable and passing one where the other is expected does
 * not fail loudly — `scopeClause` given an array produces no filter at all,
 * which is a leak that looks like working code. Hence the two names.
 */

const { METRICS } = require('./tools/analytics');
const { DRILLDOWNS, RENAMED } = require('./tools/drilldown');
const docs = require('./tools/docs');
const catalog = require('./catalog');
const conversations = require('../dao/conversationsDao');
const readonlyDb = require('../config/readonlyDb');
const { guard } = require('../utils/sqlGuard');
const { VIEWS, ALLOWED_VIEWS } = require('../config/aiViews');
const { resolveWindow } = require('../dao/shared');
const insightsDao = require('../dao/insightsDao');
const log = require('../utils/logger').logger('AI-TOOL');

/** A short, human phrase for how long ago something was. */
function ago(ms) {
    if (ms === null || ms === undefined) return null;
    const s = Math.round(ms / 1000);
    if (s < 90) return `${s} seconds ago`;
    if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
    if (s < 172800) return `${(s / 3600).toFixed(1)} hours ago`;
    return `${(s / 86400).toFixed(1)} days ago`;
}

/**
 * What this assistant can answer right now.
 *
 * Deliberately includes the negatives. A model that knows the replica stops at a
 * date will say "there is no data before then" instead of reporting a confident
 * zero, and that difference is the whole reason this tool exists.
 */
async function describeInstance({ scope, visibleIds }) {
    const health = await insightsDao.getSystemHealth({ brief: true });
    const kinds = await catalog.summary(visibleIds);
    const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k.n]));

    const [range] = await readonlyDb.query(
        `SELECT MIN(started_at) AS oldest, MAX(started_at) AS newest, COUNT(*) AS n
           FROM ai_executions`, [], { scope: visibleIds }
    );

    const lagMs = health.pipeline && health.pipeline.since_last_run_ms;
    return {
        coverage: range && range.oldest
            ? `executions from ${String(range.oldest).slice(0, 10)} to ${String(range.newest).slice(0, 10)}`
            : 'no executions',
        executions: (range && range.n) || 0,
        workflows: byKind.workflow || 0,
        error_groups: byKind.error_group || 0,
        folders: byKind.folder || 0,
        tags: byKind.tag || 0,
        syncedAgo: ago(lagMs),
        syncStatus: (health.pipeline && health.pipeline.status) || 'unknown',
        dataAgeAgo: ago(health.data && health.data.data_age_ms),
        stale: (health.pipeline && health.pipeline.status) !== 'ok',
        not_available: [
            'execution input payloads',
            'raw error messages and stack traces',
            'credentials',
            'business metadata values',
            'other users and their conversations'
        ]
    };
}


/**
 * The shape of what run_sql can read.
 *
 * Generated, not written. The columns come from SQLite itself via
 * `PRAGMA table_info`, and the prose comes from the `note` beside each view
 * definition — so a view that gains a column, or loses one, describes itself
 * correctly on the next call with nobody having remembered to update a document.
 *
 * This is the whole "schema explanation" the assistant needs. A hand-written one
 * would be a second description of the same thing, and the second description is
 * the one that goes stale.
 */
async function describeViews({ view, visibleIds }) {
    const wanted = view && ALLOWED_VIEWS.has(view)
        ? VIEWS.filter((v) => v.name === view)
        : VIEWS;

    const out = [];
    for (const v of wanted) {
        // PRAGMA works on views in SQLite and reports the columns the view
        // projects — which is exactly the question, and cheaper than parsing the
        // definition here.
        const cols = await readonlyDb.query(`PRAGMA table_info(${v.name})`, [], { scope: visibleIds });
        out.push({
            view: v.name,
            note: v.note || null,
            columns: cols.map((c) => c.name)
        });
    }
    return {
        views: out,
        note: 'These views already restrict rows to what this user may see. Do not add a filter ' +
            'for that. A column you expect and cannot find was left out deliberately — payloads, ' +
            'error text and credentials are not available through any view.'
    };
}

/**
 * Builds the argument object one metric's DAO expects.
 *
 * Three shapes, declared per metric in analytics.js rather than inferred: a
 * bucket grid, a raw range in a filters bag, or neither. Inferring it from the
 * DAO signature would work until the day two metrics disagreed about what
 * `startDate` means, which is exactly the sort of thing that is invisible until
 * a chart is wrong.
 */
function argsFor(metric, spec, args, scope) {
    const grouping = {
        workflow: args.workflow || undefined,
        folder: args.folder || undefined,
        tag: args.tag || undefined,
        project: args.project || undefined
    };

    if (spec.window === 'resolved') {
        const win = resolveWindow(
            { startDate: args.startDate, endDate: args.endDate },
            spec.defaults || {}
        );
        if (!win.ok) throw new Error(win.error);
        const base = { window: win, scope, grouping };
        // getQueueLag is the one that takes `mode` as its own argument rather
        // than inside a filters bag.
        return metric === 'queue_lag' ? { ...base, mode: args.mode || null } : base;
    }

    if (spec.window === 'range') {
        return {
            scope,
            grouping,
            filters: {
                startDate: args.startDate,
                endDate: args.endDate,
                mode: args.mode,
                // Not `workflow`: `filters.workflow` is matched by NAME, and
                // handing it an id matches nothing. The id travels in
                // `grouping`, which is where every id-shaped filter lives.
                folder: grouping.folder,
                tag: grouping.tag,
                project: grouping.project
            }
        };
    }

    return { scope, grouping };
}

/**
 * @param {string} name  the tool the model chose
 * @param {object} args  its arguments, already JSON-parsed
 * @param {object} ctx   { scope, userId }
 */
async function execute(name, args, ctx) {
    const { scope, visibleIds, userId } = ctx;

    switch (name) {
    case 'search_catalog':
        return catalog.search({
            query: args.query, kind: args.kind, limit: args.limit, scope: visibleIds
        });

    case 'describe_instance':
        return describeInstance({ scope, visibleIds });

    case 'describe_views':
        return describeViews({ view: args.view, visibleIds });

    case 'get_analytics': {
        const spec = METRICS[args.metric];
        if (!spec) {
            // The near miss first. Saying WHERE a name lives turns a retry
            // into a redirect, and the full list below stays for the case where
            // the name is simply wrong rather than in the wrong place.
            const moved = RENAMED[args.metric];
            if (moved) {
                throw new Error(
                    `"${args.metric}" no longer exists. For ONE workflow's failure history, ` +
                    `call drill_down with kind="${moved}" and that workflow's id. For failures ` +
                    'counted ACROSS workflows, the metric is "errors_by_workflow".'
                );
            }
            if (DRILLDOWNS[args.metric]) {
                throw new Error(
                    `"${args.metric}" is a drill_down kind, not a get_analytics metric. ` +
                    `Call drill_down with kind="${args.metric}" and the id it needs.`
                );
            }
            throw new Error(
                `Unknown metric "${args.metric}". Available: ${Object.keys(METRICS).join(', ')}.`
            );
        }
        return spec.run(argsFor(args.metric, spec, args, scope));
    }

    case 'drill_down': {
        const spec = DRILLDOWNS[args.kind];
        if (!spec) {
            // The same near-miss checks in the other direction.
            const moved = RENAMED[args.kind];
            if (moved) {
                throw new Error(`"${args.kind}" was renamed to "${moved}". Use that kind.`);
            }
            if (METRICS[args.kind]) {
                throw new Error(
                    `"${args.kind}" is a get_analytics metric, not a drill_down kind. ` +
                    `Call get_analytics with metric="${args.kind}".`
                );
            }
            throw new Error(
                `Unknown drill-down "${args.kind}". Available: ${Object.keys(DRILLDOWNS).join(', ')}.`
            );
        }
        return spec.run({ id: args.id, scope, userId });
    }

    case 'run_sql': {
        const { sql } = guard(args.sql);
        log.info(`SQL tool: ${args.purpose}`);
        const rows = await readonlyDb.query(sql, [], { scope: visibleIds });
        return { rows, row_count: rows.length };
    }

    case 'remember': {
        // The one tool that writes. It writes to this dashboard's own database,
        // about the person asking, and nowhere else — but the caps and the
        // refusals live in the DAO rather than here, because "what may be
        // remembered" is a property of the store and not of one call site.
        const result = await conversations.remember(userId, args.fact, ctx.conversationId);
        if (!result.ok) throw new Error(result.reason);
        return result.duplicate
            ? { saved: true, note: 'Already remembered; nothing changed.' }
            : { saved: true, fact: result.content };
    }

    case 'ask_n8n_docs':
        return { answer: await docs.ask(args.question, userId) };

    default:
        throw new Error(`Unknown tool "${name}".`);
    }
}

module.exports = { execute, describeInstance, describeViews, _internal: { argsFor, ago } };
