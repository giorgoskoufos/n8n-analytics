/**
 * Workflow, folder, tag and project filters (F-16).
 *
 * 163 workflows in one flat list does not scale, and n8n already knows how they
 * are organised — 16 folders with real hierarchy, 5 tags, a project. The
 * dashboard ignored all of it.
 *
 * Shaped exactly like utils/scope.js and for the same reason: every page filters
 * by workflow id in the end, so restricting the set of visible ids restricts
 * everything at once. Written as a subquery rather than an id list because the
 * alternative costs one bound parameter per workflow and SQLite's default
 * variable ceiling is 999 on older builds.
 *
 * These compose with the scope filter rather than replacing it. A user may
 * narrow their view to a folder; they may not widen it past what they are
 * allowed to see, so both clauses are appended and both must hold.
 */

// Folder membership is hierarchical: asking for "Nova" means Nova and
// everything beneath it. n8n stores only the parent pointer, so the descendants
// are walked with a recursive CTE — the tree is fifteen nodes deep at most and
// SQLite has supported WITH RECURSIVE since 3.8.
const FOLDER_TREE_SQL = `
    WITH RECURSIVE subtree(id) AS (
        SELECT ?
        UNION
        SELECT f.id FROM folder f JOIN subtree s ON f.parent_folder_id = s.id
    )
    SELECT w.id FROM workflow_entity w
     WHERE w."parentFolderId" IN (SELECT id FROM subtree)`;

const TAG_SQL = 'SELECT wt.workflow_id FROM workflows_tags wt WHERE wt.tag_id = ?';

// One workflow.
//
// Written as a subquery over `workflow_entity` rather than as `column = ?`,
// which would be shorter and would also be the one filter here that is not a
// set of ids — and the reason every one of these is a set of ids is that they
// then compose with each other and with the scope clause by the same rule.
// Going through the table also means an id that belongs to no workflow selects
// nothing, rather than being taken on faith.
const WORKFLOW_SQL = 'SELECT w.id FROM workflow_entity w WHERE w.id = ?';

const PROJECT_SQL = 'SELECT sw.workflow_id FROM shared_workflow sw WHERE sw.project_id = ?';

// Ids in n8n are nanoid-style: short, alphanumeric, no punctuation. Validating
// the shape means a malformed one is a 400 rather than a silently empty page —
// the same reasoning as the execution-mode allowlist.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Builds the ` AND <column> IN (...)` fragments for whichever of folder, tag and
 * project were asked for.
 *
 * Returns { ok: false, error } for a malformed id. Returns an empty fragment
 * when none were given, so callers can append unconditionally.
 */
function groupingClause(query, column) {
    const parts = [];
    const params = [];

    // Each filter is independent and they intersect: folder AND tag means
    // workflows in that folder that also carry that tag.
    const filters = [
        ['workflow', query.workflow, WORKFLOW_SQL],
        ['folder', query.folder, FOLDER_TREE_SQL],
        ['tag', query.tag, TAG_SQL],
        ['project', query.project, PROJECT_SQL]
    ];

    for (const [name, value, sql] of filters) {
        if (value === undefined || value === null || value === '') continue;
        if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
            return { ok: false, error: `${name} is not a valid id` };
        }
        parts.push(`${column} IN (${sql})`);
        params.push(value);
    }

    return {
        ok: true,
        active: parts.length > 0,
        sql: parts.length ? ` AND ${parts.join(' AND ')}` : '',
        conditions: parts,
        params
    };
}

module.exports = { groupingClause, WORKFLOW_SQL, FOLDER_TREE_SQL, TAG_SQL, PROJECT_SQL };
