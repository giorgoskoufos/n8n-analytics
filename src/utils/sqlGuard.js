/**
 * The check on SQL the model wrote — H-06.
 *
 * This is deliberately the *smallest* of the three mechanisms, not the largest.
 * The heavy lifting is done by things that cannot be argued with:
 *
 *   OPEN_READONLY   the statement cannot write, whatever it says
 *   ai_* views      the columns it can name do not include the payload
 *   ai_scope        the rows it can reach are the caller's, inside the relation
 *
 * All that is left here is: does this statement refer to anything other than
 * the views we published? That is a question about a handful of identifiers,
 * which a regex can answer honestly — unlike "which table does this bare column
 * belong to", which is the question a column-level allowlist would have had to
 * answer through aliases, joins and CTEs, and would have answered wrongly.
 *
 * The order matters. If this guard is ever wrong, the request still cannot
 * write, still cannot select a hidden column, and still cannot leave its scope.
 */

const { ALLOWED_VIEWS } = require('../config/aiViews');

const MAX_ROWS = 500;

// Anything that changes state or reaches outside the database. Present as
// defence in depth: a read-only connection already refuses all of it, but
// failing here gives the model a message it can correct rather than an engine
// error it cannot.
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|LOAD_EXTENSION)\b/i;

/** Strips comments and string literals so they cannot smuggle identifiers. */
function stripNoise(sql) {
    return sql
        .replace(/--[^\n]*/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/'(?:[^']|'')*'/g, "''")
        .replace(/"(?:[^"]|"")*"/g, '""');
}

/**
 * Every relation the statement names.
 *
 * FROM and JOIN are the only ways to introduce one in a SELECT, so this reads
 * the identifier that follows each. CTE names defined by the statement itself
 * are collected separately and subtracted — a `WITH recent AS (...)` may then
 * be selected from, which is ordinary SQL and not an escape, because whatever
 * the CTE itself reads was checked by this same pass.
 */
function referencedRelations(clean) {
    const found = new Set();
    const re = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
    let m;
    while ((m = re.exec(clean)) !== null) found.add(m[1].toLowerCase());

    const ctes = new Set();
    const cteRe = /(?:\bWITH\s+(?:RECURSIVE\s+)?|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/gi;
    while ((m = cteRe.exec(clean)) !== null) ctes.add(m[1].toLowerCase());

    for (const c of ctes) found.delete(c);
    return found;
}

/**
 * Validates and normalises one generated statement.
 *
 * @returns {{sql: string}} the statement to run, with a LIMIT guaranteed
 * @throws {Error} with `.reason` set to something the model can act on
 */
function guard(rawSql) {
    const sql = String(rawSql || '').trim()
        .replace(/^```(?:sql)?\s*/i, '')
        .replace(/```$/, '')
        .trim()
        .replace(/;+\s*$/, '');

    if (!sql) throw fail('Empty statement.');

    const clean = stripNoise(sql);

    // One statement. A second one is how a guard that only inspects the first
    // gets walked past.
    if (clean.includes(';')) throw fail('Only one statement is allowed.');

    if (!/^\s*(SELECT|WITH)\b/i.test(clean)) {
        throw fail('Only SELECT queries are allowed.');
    }
    const forbidden = clean.match(FORBIDDEN);
    if (forbidden) throw fail(`${forbidden[0].toUpperCase()} is not permitted.`);

    for (const rel of referencedRelations(clean)) {
        if (!ALLOWED_VIEWS.has(rel)) {
            // Names the offender. The model is going to retry, and "sqlite_master
            // is not readable" produces a better second attempt than "denied".
            throw fail(
                `\`${rel}\` is not readable. Available: ${[...ALLOWED_VIEWS].join(', ')}.`
            );
        }
    }

    // A LIMIT the model chose is kept if it is sane, and capped if it is not.
    // Appending unconditionally would break `... LIMIT 10` by making it
    // `... LIMIT 10 LIMIT 500`, so the existing one is rewritten in place.
    //
    // Both branches append on a NEW LINE, and the cap falls back to appending
    // when the in-place rewrite does not take. The reason is a trailing line
    // comment: the checks above run on comment-stripped SQL, but what executes
    // is the original, so `SELECT * FROM ai_errors -- x` + ` LIMIT 500` puts the
    // limit inside the comment and runs the query unbounded. A newline ends the
    // comment; `--` cannot reach past it.
    const existing = clean.match(/\bLIMIT\s+(\d+)\s*$/i);
    if (existing && Number(existing[1]) <= MAX_ROWS) {
        return { sql };
    }
    if (existing) {
        const capped = sql.replace(/\bLIMIT\s+\d+\s*$/i, `LIMIT ${MAX_ROWS}`);
        if (capped !== sql) return { sql: capped };
        // The LIMIT is there in the stripped text but not at the end of the raw
        // text — a comment sits between them. Appending still wins: SQLite takes
        // the last LIMIT, and ours is smaller.
    }
    return { sql: `${sql}\nLIMIT ${MAX_ROWS}` };
}

function fail(reason) {
    const err = new Error(reason);
    err.reason = reason;
    err.guarded = true;
    return err;
}

module.exports = { guard, MAX_ROWS, _internal: { stripNoise, referencedRelations } };
