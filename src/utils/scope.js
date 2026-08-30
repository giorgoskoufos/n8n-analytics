/**
 * Who is allowed to see which workflow.
 *
 * n8n's own model, mirrored: a workflow belongs to a project (`shared_workflow`),
 * and a user belongs to a project (`project_relation`). Everything the dashboard
 * shows — executions, errors, ROI, concurrency — hangs off a workflow id, so
 * deciding which workflow ids a user may see decides all of it at once.
 *
 * The two global roles are the exception. In n8n an owner or admin can open any
 * workflow on the instance, so scoping them here would not be a safety measure,
 * it would be a lie: the dashboard would report fewer executions than the
 * instance actually ran, and the first reading of that is data loss.
 */
const localDb = require('../config/localDb');
const log = require('./logger').logger('SCOPE');

// n8n 2.x role slugs. Anything else — 'global:member', 'global:chatUser', a
// project-scoped role, or null on an n8n old enough not to have the column —
// gets scoped.
const UNRESTRICTED_ROLES = new Set(['global:owner', 'global:admin']);

/**
 * The workflow ids one user may see, as a subquery rather than a list.
 *
 * Resolving the ids in JavaScript and inlining them as `IN (?, ?, ...)` would
 * need one bound parameter per workflow — 162 on this instance already — and
 * SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 999 on the build shipped with
 * older sqlite3 releases. A subquery costs exactly one parameter regardless of
 * how large the instance grows, and both joined columns are indexed.
 */
const VISIBLE_WORKFLOWS_SQL =
    'SELECT sw.workflow_id FROM shared_workflow sw ' +
    'JOIN project_relation pr ON pr.project_id = sw.project_id ' +
    'WHERE pr.user_id = ?';

// Whether the replica actually holds membership data. Cached because it is read
// on every request and answered by a table with a handful of rows; the TTL only
// bounds how long a stale "no" survives if the sync never calls the invalidator.
let availability = { known: false, value: false, at: 0 };
const AVAILABILITY_TTL_MS = 60_000;
let warnedUnavailable = false;

async function scopingDataExists() {
    const now = Date.now();
    if (availability.known && now - availability.at < AVAILABILITY_TTL_MS) {
        return availability.value;
    }
    try {
        const r = await localDb.query('SELECT 1 FROM project_relation LIMIT 1');
        availability = { known: true, value: r.rows.length > 0, at: now };
    } catch (err) {
        // The table is created at boot, so a failure here is the database being
        // unreachable rather than the feature being absent. Treat it as "no data"
        // and let the request fail on its own query with a real error, instead of
        // silently answering it with somebody else's rows.
        log.error('Could not read project_relation:', err.message);
        availability = { known: true, value: false, at: now };
    }
    return availability.value;
}

/** Called by the sync once membership has been replaced, so the next request sees it. */
function invalidateScopeCache() {
    availability = { known: false, value: false, at: 0 };
    warnedUnavailable = false;
}

/**
 * Builds the scope for one authenticated user.
 *
 * Fails OPEN in exactly one situation: the replica holds no membership rows at
 * all. That means either the instance predates n8n projects and exposes no
 * authorization data to mirror, or the first sync carrying this data has not run
 * yet. Failing closed there would hand every user an empty dashboard and no
 * indication why — and since there is genuinely nothing to enforce, an empty
 * dashboard would be no safer, only more confusing. Every other case is decided
 * from data: a user with no projects sees nothing, and that is correct.
 */
async function resolveScopeFor(user) {
    const userId = user && user.id;
    const role = user && user.role;

    if (UNRESTRICTED_ROLES.has(role)) {
        return { unrestricted: true, userId, reason: 'global-role' };
    }

    if (!(await scopingDataExists())) {
        if (!warnedUnavailable) {
            warnedUnavailable = true;
            log.warn(
                'No project membership in the replica — every user can see every ' +
                'workflow until the sync mirrors project_relation. This is expected on the ' +
                'first cycle after an upgrade, and on n8n versions without projects.'
            );
        }
        return { unrestricted: true, userId, reason: 'no-membership-data' };
    }

    return { unrestricted: false, userId, reason: 'project-membership' };
}

/**
 * A ` AND <column> IN (...)` fragment plus the parameters it introduces.
 *
 * Always appended at the end of a WHERE clause, so the caller only ever has to
 * append its params at the end of the params it already built — the one ordering
 * rule that has to hold at every call site.
 */
function scopeClause(scope, column) {
    if (!scope || scope.unrestricted) return { sql: '', condition: null, params: [] };
    const condition = `${column} IN (${VISIBLE_WORKFLOWS_SQL})`;
    return { sql: ` AND ${condition}`, condition, params: [scope.userId] };
}

/**
 * Whether one specific workflow is visible. For endpoints addressed by id, where
 * the answer decides between the resource and a 404 rather than filtering a list.
 */
async function canSeeWorkflow(scope, workflowId) {
    if (!scope || scope.unrestricted) return true;
    if (!workflowId) return false;
    const r = await localDb.query(
        `SELECT 1 FROM (${VISIBLE_WORKFLOWS_SQL}) WHERE workflow_id = ? LIMIT 1`,
        [scope.userId, workflowId]
    );
    return r.rows.length > 0;
}

/**
 * Narrows a caller-supplied list of workflow ids to the visible ones.
 * Used by writes, which must reject out-of-scope ids rather than filter them.
 */
async function filterVisibleWorkflows(scope, workflowIds) {
    if (!scope || scope.unrestricted) return new Set(workflowIds);

    const visible = new Set();
    // Chunked because the ROI endpoint accepts up to 1000 workflows in one
    // request, and SQLite's default variable ceiling is 999 on older builds.
    const CHUNK = 400;
    for (let i = 0; i < workflowIds.length; i += CHUNK) {
        const chunk = workflowIds.slice(i, i + CHUNK);
        const r = await localDb.query(
            `SELECT workflow_id FROM (${VISIBLE_WORKFLOWS_SQL}) ` +
            `WHERE workflow_id IN (${chunk.map(() => '?').join(',')})`,
            [scope.userId, ...chunk]
        );
        for (const row of r.rows) visible.add(row.workflow_id);
    }
    return visible;
}

/**
 * The visible workflow ids as a list, or null for an unrestricted caller.
 *
 * Everything else here expresses scope as a SQL fragment, which is the right
 * shape when the query is being built around it. The assistant's read-only
 * connection cannot use that: its restriction lives inside temp views, as a
 * membership test against a table it fills per request, so it needs the ids
 * themselves (config/readonlyDb).
 *
 * `null` means unrestricted and is not the same as an empty array — one is "no
 * limit", the other is "sees nothing". Returning `[]` for an owner would be a
 * silent outage; returning `null` for a member would be a leak.
 */
async function visibleWorkflowIds(scope) {
    if (!scope || scope.unrestricted) return null;
    const r = await localDb.query(VISIBLE_WORKFLOWS_SQL, [scope.userId]);
    return r.rows.map((row) => row.workflow_id);
}

module.exports = {
    UNRESTRICTED_ROLES,
    VISIBLE_WORKFLOWS_SQL,
    resolveScopeFor,
    invalidateScopeCache,
    scopeClause,
    canSeeWorkflow,
    filterVisibleWorkflows,
    visibleWorkflowIds
};
