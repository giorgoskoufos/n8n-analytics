/**
 * What the AI is allowed to see — H-06.
 *
 * This file is the whole answer to "which columns can the assistant read", and
 * it is the only place that answer is written down. Everything downstream reads
 * it: the read-only connection builds these views, the SQL guard allows exactly
 * these names, and the schema prompt is generated from them. Three copies of a
 * security boundary is how the boundary rots.
 *
 * ── Why views instead of a column allowlist ──────────────────────────────
 *
 * The obvious implementation is a `{table: [columns]}` map plus a parser that
 * checks the generated SQL against it. That parser is the weak point: it has to
 * attribute every bare column to the right table through aliases, joins,
 * subqueries and CTEs, and it fails open — a column it cannot attribute is a
 * column it cannot reject.
 *
 * Views move the check from my parser into SQLite. `ai_errors` simply has no
 * `input_data` column, so `SELECT input_data FROM ai_errors` is a hard
 * `no such column` error from the engine no matter how it is spelled, nested or
 * aliased. What is left for the guard is a much smaller and far more reliable
 * question: does this statement name anything other than an `ai_*` view?
 *
 * Verified on the real replica: `CREATE TEMP VIEW` succeeds on a connection
 * opened `OPEN_READONLY` (temp objects live in the temp database, not the main
 * file), and selecting a hidden column through the view is refused by SQLite.
 *
 * ── The two threats are not the same threat ──────────────────────────────
 *
 *   writing to the replica   → OPEN_READONLY, enforced by SQLite
 *   reading customer payload → these views, enforced by SQLite
 *
 * A read-only connection happily serves `SELECT input_data`. Only the second
 * mechanism stops that, which is why both exist.
 */

// ── What never appears in any view, and why ──────────────────────────────
//
//   execution_error_analytics.input_data    3.0 MB of the payloads that caused
//                                           the crash — real customer records
//   execution_error_analytics.error_stack   23.8 MB, same content in trace form
//   execution_error_analytics.error_message raw text; H-32 established it
//                                           carries custom Greek copy, ids and
//                                           payload fragments
//   error_fingerprints.sample_message       a raw message by definition
//   error_fingerprints.normalized_message   see errorLabel() below — masked
//                                           numerically, NOT textually
//   users                                   password hashes, emails, MFA
//   credentials_entity                      credential material
//   dashboard_chat_history                  other people's conversations
//   rate_limits, sqlite_master              internals; no analytical value
//   execution_metadata.value                business metadata values are
//                                           customer identifiers (F-18)

/**
 * The technical head of an error message, with the payload cut off.
 *
 * `normalized_message` looked like the safe field and is not. The fingerprint
 * normaliser replaces numbers, dates and quoted strings — `<N>`, `<DATE>`,
 * `<STR>` — which is the right normalisation for *grouping* errors and the
 * wrong one for *showing* them: free text and bare identifiers are left
 * untouched. Measured on the live replica, 7 of 98 fingerprints still contain a
 * customer ticket number, Greek complaint text, or a whole failing row
 * (`WIND, OTE, ΚΕΡΚΥΡΑ - ΚΕΡΚΥΡΑΣ`).
 *
 * The observation that fixes it: in every one of those, the customer data
 * begins at a structural delimiter. What precedes the first `(`, `[`, `->`,
 * `|`, `:` or `, ` is the error class, and what follows is the payload it
 * failed on. Cutting there gives "Failing row contains", "failed to parse logic
 * tree", "call_center" — which is what a reader needs to know what broke, and
 * carries nothing about who it broke for.
 *
 * Verified: 0 of the 7 leak after cutting, and the 98 fingerprints collapse to
 * 52 distinct labels.
 *
 * Truncation is a blunt instrument, so it is deliberately aggressive. If this
 * ever drops something diagnostically necessary, the fix is a better parse of
 * the head — never a longer cut.
 */
function errorLabel(message) {
    const raw = String(message == null ? '' : message).trim();
    if (!raw) return '';
    // Split on the first delimiter that introduces a value rather than more
    // error class. `, ` is included because a bare comma-separated tail is the
    // "Failing row contains" shape; `:` only with a following space, so that
    // `TypeError:` and timestamps do not get chopped mid-token.
    const head = raw.split(/[([{]|->|\||\s:\s|:\s|,\s|\s—\s/)[0];
    return head.trim().slice(0, 80);
}

/**
 * The views, in dependency order.
 *
 * Names are prefixed `ai_` without exception. That prefix is not decoration —
 * the guard's allowlist test is "every identifier this statement names is an
 * `ai_*` view", so a view that forgets the prefix is a view the model cannot
 * use, and a base table can never be mistaken for one.
 *
 * ── Scoping (M-20's leftover, closed here) ───────────────────────────────
 *
 * H-06's own note explains why per-user scoping was abandoned for this
 * endpoint: "το ελεύθερο SQL δεν στενεύεται με φίλτρο — ένα subquery ή UNION
 * το προσπερνά". That is true of appending `AND workflow_id IN (...)` to a
 * statement the model composed, and it is why the assistant answers 403 to
 * every scoped user today.
 *
 * Views make the filter unbypassable instead of merely present. Every view that
 * hangs off a workflow selects through `ai_scope`, a temp table holding the
 * workflow ids this request may see, so the restriction is part of the relation
 * itself. A subquery against `ai_executions` is still a subquery against the
 * filtered `ai_executions`; a UNION unions two filtered relations. There is no
 * spelling that reaches around it, because SQLite resolves the view before the
 * model's SQL ever applies.
 *
 * `ai_scope` is repopulated per request on a connection that runs one statement
 * at a time, so it always describes the caller in flight. For an owner or admin
 * it holds every workflow id — same code path, no second branch to keep honest.
 */
const VIEWS = [
    {
        name: 'ai_workflows',
        note: 'One row per workflow. `is_archived` matters: archived workflows are hidden from pickers but still counted in history.',
        sql: `
            SELECT id,
                   name,
                   active,
                   "isArchived"      AS is_archived,
                   "parentFolderId"  AS folder_id,
                   "triggerCount"    AS trigger_count,
                   "createdAt"       AS created_at,
                   "updatedAt"       AS updated_at
              FROM workflow_entity
             WHERE id IN (SELECT workflow_id FROM ai_scope)`
    },
    {
        name: 'ai_executions',
        note: 'One row per run. `duration_seconds` is precomputed — do not recompute it from the timestamps.',
        sql: `
            SELECT id,
                   "workflowId"          AS workflow_id,
                   status,
                   mode,
                   "startedAt"           AS started_at,
                   "stoppedAt"           AS stopped_at,
                   "retryOf"             AS retry_of,
                   "jsonSizeBytes"       AS json_bytes,
                   "binaryDataSizeBytes" AS binary_bytes,
                   CASE WHEN "stoppedAt" IS NOT NULL AND "startedAt" IS NOT NULL
                        THEN (julianday("stoppedAt") - julianday("startedAt")) * 86400
                   END                   AS duration_seconds
              FROM execution_entity
             WHERE "workflowId" IN (SELECT workflow_id FROM ai_scope)`
    },
    {
        name: 'ai_errors',
        note: 'One row per failed node. Carries the classification, never the message or the payload — join ai_error_groups on fingerprint for a readable label.',
        sql: `
            SELECT id,
                   workflow_id,
                   node_name,
                   node_type,
                   error_type,
                   error_category,
                   http_code,
                   timestamp,
                   fingerprint
              FROM execution_error_analytics
             WHERE workflow_id IN (SELECT workflow_id FROM ai_scope)`
    },
    {
        name: 'ai_error_groups',
        note: 'The 98 fingerprint groups. `error_label` is the technical head of the message with the payload stripped; there is no fuller text available to this connection by design.',
        // Reads the temp table that readonlyDb builds — the label has to be
        // computed in JS (SQLite has no regex) and cannot be stored in the main
        // database from a read-only connection.
        // Counts aggregate through ai_errors, which is itself scoped, so a
        // project member sees the volume of their OWN failures rather than the
        // instance's. Counting in the label table instead would have leaked a
        // total across every project through a column that looks innocuous.
        sql: `
            SELECT g.fingerprint,
                   g.error_label,
                   f.node_type,
                   f.error_type,
                   f.first_seen,
                   f.status,
                   COUNT(e.id)      AS occurrences,
                   MAX(e.timestamp) AS last_seen
              FROM ai_error_labels g
              JOIN error_fingerprints f ON f.fingerprint = g.fingerprint
              LEFT JOIN ai_errors e ON e.fingerprint = g.fingerprint
             GROUP BY g.fingerprint`
    },
    {
        name: 'ai_folders',
        note: 'Folder tree. `parent_folder_id` is null at the root.',
        sql: `
            SELECT id, name, parent_folder_id, project_id, created_at
              FROM folder`
    },
    {
        name: 'ai_projects',
        sql: 'SELECT id, name, type FROM project'
    },
    {
        name: 'ai_tags',
        sql: 'SELECT id, name FROM tag_entity'
    },
    {
        name: 'ai_workflow_tags',
        sql: 'SELECT workflow_id, tag_id FROM workflows_tags WHERE workflow_id IN (SELECT workflow_id FROM ai_scope)'
    },
    {
        name: 'ai_deploys',
        note: 'Workflow versions. `autosaved = 0` is a deliberate save by a person; autosaved rows are noise for deploy correlation.',
        sql: `
            SELECT version_id, workflow_id, name, authors, autosaved, created_at
              FROM workflow_history
             WHERE workflow_id IN (SELECT workflow_id FROM ai_scope)`
    },
    {
        name: 'ai_node_profile',
        note: 'Per-node execution cost (F-12). total_ms across `runs` samples, so avg = total_ms / runs.',
        sql: `
            SELECT workflow_id, node_name, node_type, samples, runs,
                   total_ms, max_ms, items_out, failed_runs, is_sub_node
              FROM workflow_node_profile
             WHERE workflow_id IN (SELECT workflow_id FROM ai_scope)`
    },
    {
        name: 'ai_dependencies',
        note: 'What each workflow depends on (F-10) — credential ids, sub-workflow ids, webhook paths. `dependency_key` is an identifier, never a secret.',
        sql: `
            SELECT workflow_id, dependency_type, dependency_key, published_version_id
              FROM workflow_dependency
             WHERE workflow_id IN (SELECT workflow_id FROM ai_scope)`
    },
    {
        name: 'ai_workflow_settings',
        note: 'ROI inputs configured by the operator (F-21).',
        sql: 'SELECT workflow_id, saved_time_seconds, hourly_rate FROM workflow_settings'
            + ' WHERE workflow_id IN (SELECT workflow_id FROM ai_scope)'
    },
    {
        name: 'ai_metadata_keys',
        note: 'Business metadata KEYS only (F-18). The values are customer identifiers and are not exposed.',
        sql: 'SELECT DISTINCT key FROM execution_metadata'
    },
    {
        name: 'ai_sync_runs',
        note: 'The ETL\'s own history — how fresh the replica is, and whether the last pass succeeded. This is how the assistant knows whether to trust its own numbers.',
        sql: `
            SELECT id, started_at, finished_at, duration_ms, status,
                   workflows, executions, rows_read, errors, replica_bytes
              FROM sync_runs`
    }
];

const ALLOWED_VIEWS = new Set(VIEWS.map((v) => v.name));

// The temp table ai_error_groups reads from. Not in ALLOWED_VIEWS: the model
// gets the joined view, not the raw label table, so there is one name to learn.
const LABEL_TABLE = 'ai_error_labels';

module.exports = { VIEWS, ALLOWED_VIEWS, LABEL_TABLE, errorLabel };
