/**
 * What exists on this instance, searchable by name.
 *
 * ── Why this is not a vector store ───────────────────────────────────────
 *
 * "RAG over the database" sounds like embeddings over the rows. It should not
 * be. There are 535,000 executions and they are structured — counts, statuses,
 * timestamps — and the right tool for a structured question is a query, which
 * the DAO layer already provides. Embedding them would answer "which rows read
 * similarly to this sentence", a question nobody has.
 *
 * What genuinely needs retrieval is much smaller and is prose: the NAMES. 164
 * workflows, 16 folders, 5 tags, a project, the node types in use, and the 98
 * error groups. Roughly 350 short strings. That is the gap that actually hurts
 * today — asked about "the Call Center errors", the model has no way to learn
 * that Call Center is a folder rather than a workflow, and quietly answers about
 * nothing.
 *
 * At that size FTS5 — built into the SQLite already open — beats embeddings on
 * every axis that matters here: no new dependency, no API cost, no index to go
 * stale, and exact substring matches on identifiers, which is what workflow
 * names mostly are.
 *
 * ── Dynamic, because the instance is ─────────────────────────────────────
 *
 * Workflows are created and archived constantly. The index is rebuilt from the
 * replica on a short TTL rather than maintained incrementally, because it is
 * cheap enough that correctness is free: whatever the last sync wrote is what
 * the next question sees. There is no separate store to drift.
 *
 * It is built on the read-only connection, so it is scoped by the same
 * `ai_scope` the views are — a project member searching finds their own
 * workflows and not the instance's.
 */

const readonlyDb = require('../../config/readonlyDb');
const log = require('../../utils/logger').logger('AI-CATALOG');

const TTL_MS = Number(process.env.AI_CATALOG_TTL_MS) || 120_000;

/**
 * Where each kind of name comes from.
 *
 * `sql` selects (id, name, detail). Everything reads through the `ai_*` views,
 * so a caller can only ever find what they are allowed to see.
 */
const SOURCES = [
    {
        kind: 'workflow',
        sql: `SELECT id,
                     name,
                     CASE WHEN is_archived = 1 THEN 'archived'
                          WHEN active = 1 THEN 'active'
                          ELSE 'inactive' END AS detail
                FROM ai_workflows`
    },
    {
        kind: 'folder',
        sql: "SELECT id, name, 'folder' AS detail FROM ai_folders"
    },
    {
        kind: 'tag',
        sql: "SELECT id, name, 'tag' AS detail FROM ai_tags"
    },
    {
        kind: 'project',
        sql: 'SELECT id, name, type AS detail FROM ai_projects'
    },
    {
        kind: 'node_type',
        // Node types are not a table; they are whatever the profiler has seen.
        sql: `SELECT DISTINCT node_type AS id, node_type AS name, 'node type' AS detail
                FROM ai_node_profile WHERE node_type IS NOT NULL`
    },
    {
        kind: 'error_group',
        // "all time" is not decoration. Without it the model read this total as
        // the current window's and reported an all-time 3,976 beside a 30-day
        // breakdown of 50, as though they described the same set.
        sql: `SELECT fingerprint AS id,
                     error_label AS name,
                     error_type || ' · ' || occurrences || ' occurrences, all time' AS detail
                FROM ai_error_groups WHERE occurrences > 0`
    }
];

let builtAt = 0;
let builtFor = null;

/**
 * (Re)builds the index for one caller.
 *
 * Keyed on the caller as well as the clock: the read-only connection is shared
 * and serialised, so an index built for an owner must not be handed to a project
 * member on the next question. Comparing the scope is cheaper than rebuilding,
 * and rebuilding is cheap.
 */
async function ensureIndex(scope) {
    const key = scope === null ? '*' : [...scope].sort().join(',');
    if (builtFor === key && Date.now() - builtAt < TTL_MS) return;

    // One scope load for the whole rebuild. Going through `query` per statement
    // would have reloaded ai_scope in front of each of ~350 inserts — for an
    // unrestricted caller that is 164 inserts of scope per row written.
    const total = await readonlyDb.withScope(scope, async ({ run, all }) => {
        await run('CREATE VIRTUAL TABLE IF NOT EXISTS temp.ai_catalog USING fts5(' +
            'kind UNINDEXED, id UNINDEXED, name, detail UNINDEXED)');
        await run('DELETE FROM ai_catalog');

        let n = 0;
        for (const src of SOURCES) {
            const rows = await all(src.sql);
            for (const r of rows) {
                if (!r.name) continue;
                await run(
                    'INSERT INTO ai_catalog (kind, id, name, detail) VALUES (?, ?, ?, ?)',
                    [src.kind, String(r.id), String(r.name),
                        r.detail == null ? '' : String(r.detail)]
                );
                n++;
            }
        }
        return n;
    });

    builtAt = Date.now();
    builtFor = key;
    log.info(`Catalog rebuilt: ${total} entries.`);
}

/**
 * FTS5 needs a query it will accept.
 *
 * A user's words arrive with punctuation FTS5 reads as operators — a quote, a
 * `-`, a `*` — and a malformed MATCH is a hard error, not an empty result. Each
 * word is therefore quoted as a literal and given a prefix `*`, so "call cent"
 * finds "CallCenterPerMinute" and nothing the user typed can be read as syntax.
 */
function toMatchQuery(query) {
    const words = String(query || '')
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((w) => w.length > 0)
        .slice(0, 8);
    if (words.length === 0) return null;
    return words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(' OR ');
}

/**
 * Finds entries by name.
 *
 * Falls back to a LIKE scan when FTS5 returns nothing. The two disagree on
 * exactly the case that matters most here: `CallCenterPerMinute` is one FTS5
 * token, so searching "center" matches nothing, while a human plainly means it.
 */
async function search({ query, kind = null, limit = 10, scope }) {
    await ensureIndex(scope);
    const cap = Math.min(Math.max(Number(limit) || 10, 1), 50);
    const kindSql = kind ? ' AND kind = ?' : '';
    const kindParams = kind ? [kind] : [];

    const match = toMatchQuery(query);
    let rows = [];
    if (match) {
        rows = await readonlyDb.query(
            `SELECT kind, id, name, detail FROM ai_catalog
              WHERE ai_catalog MATCH ?${kindSql}
              ORDER BY rank LIMIT ?`,
            [match, ...kindParams, cap], { scope }
        );
    }

    if (rows.length === 0) {
        const like = `%${String(query || '').trim()}%`;
        rows = await readonlyDb.query(
            `SELECT kind, id, name, detail FROM ai_catalog
              WHERE name LIKE ?${kindSql} LIMIT ?`,
            [like, ...kindParams, cap], { scope }
        );
    }

    return rows;
}

/**
 * One entry, by exactly what the caller said.
 *
 * `search` is the wrong instrument for a tag. A tag is a claim that a specific
 * thing was chosen — from the dropdown, or typed in full — and answering it with
 * a ranked list would mean the server picking one, which is precisely the
 * decision a tag exists to remove. So: exact id, or exact name, or nothing.
 *
 * Matching on `id` as well as `name` is not a loosening. Both columns come from
 * the scoped index, so either way the answer can only ever be something this
 * caller was already allowed to see — and error groups are identified by a
 * fingerprint no one would type as a name.
 */
async function resolveExact({ kind, value, scope }) {
    await ensureIndex(scope);
    const needle = String(value == null ? '' : value).trim();
    if (!needle) return [];
    // More than one is a real answer here, not an overflow to cut off: names
    // repeat on a live instance — an archived copy beside the active one is the
    // usual way — and the caller has to be able to say which ones.
    return readonlyDb.query(
        `SELECT kind, id, name, detail FROM ai_catalog
          WHERE kind = ? AND (id = ? OR lower(name) = lower(?))
          LIMIT 5`,
        [kind, needle, needle], { scope }
    );
}

/** Counts per kind — used by describe_instance to say what it knows about. */
async function summary(scope) {
    await ensureIndex(scope);
    return readonlyDb.query(
        'SELECT kind, COUNT(*) AS n FROM ai_catalog GROUP BY kind ORDER BY n DESC',
        [], { scope }
    );
}

module.exports = { search, summary, resolveExact, _internal: { toMatchQuery, ensureIndex } };
