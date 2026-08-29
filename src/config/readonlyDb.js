/**
 * The assistant's own connection to the replica — H-06.
 *
 * SQLite has no users, roles or GRANT, so "a second read-only account" is a
 * second *connection* opened `OPEN_READONLY`. That is not a weaker substitute:
 * the flag is enforced by SQLite itself, below any SQL we or the model can
 * write, and a write attempted on it fails with SQLITE_READONLY. Verified
 * against the real replica before this file was written.
 *
 * It buys three separate things:
 *
 *   1. No statement reachable from the assistant can modify the replica —
 *      including one that gets past the guard.
 *   2. The B-36 write gate is untouched. AI queries do not queue behind the
 *      ETL and, more importantly, cannot sit inside its transaction.
 *   3. The temp views of aiViews.js live here and nowhere else, so the columns
 *      the assistant can reach are scoped to this connection rather than being
 *      a property of the process.
 *
 * What it deliberately does NOT do is hide `input_data`. A read-only connection
 * reads everything. Confidentiality is the views' job; this file's job is
 * integrity and time limits. Conflating the two is how a system ends up with
 * one mechanism and two claims.
 */

const sqlite3 = require('sqlite3');
const path = require('path');
const { VIEWS, LABEL_TABLE, errorLabel } = require('./aiViews');
const log = require('../utils/logger').logger('AI-DB');

const dbPath = process.env.DASHBOARD_DB_PATH
    ? path.resolve(process.env.DASHBOARD_DB_PATH)
    : path.resolve(__dirname, '../../dashboard.sqlite');

const DEFAULT_TIMEOUT_MS = Number(process.env.AI_QUERY_TIMEOUT_MS) || 8000;
const LABELS_TTL_MS = 60_000;

let db = null;
let ready = null;
let labelsBuiltAt = 0;

/**
 * Queries run one at a time on this connection.
 *
 * `db.interrupt()` is the only timeout mechanism node-sqlite3 offers, and it
 * interrupts every statement in flight on the connection rather than a chosen
 * one. With concurrent queries a timeout on a slow question would abort a fast
 * one that happened to overlap, and the second caller would get an error with
 * no cause it could act on. Serialising costs nothing at this volume — this is
 * a chat box, not a query engine — and makes the interrupt precise.
 */
let chain = Promise.resolve();

function open() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
        db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
            if (err) {
                // Not fatal to the process, unlike localDb. Every other endpoint
                // works without this connection; only the assistant stops.
                log.error(`Could not open the replica read-only: ${err.message}`);
                ready = null;
                return reject(err);
            }
            // Readers do not block writers in WAL, but the ETL checkpoints, and
            // a checkpoint can briefly lock. Wait rather than fail the question.
            db.run('PRAGMA busy_timeout = 4000', () => {
                buildViews().then(resolve, reject);
            });
        });
    });
    return ready;
}

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, (err) => (err ? reject(err) : resolve()));
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

/**
 * Rebuilds the derived error-label table.
 *
 * The label has to be computed in JavaScript — SQLite has no regex, and this
 * connection could not write the result to the main database if it did. A temp
 * table is the one place a read-only connection may put derived data, and 98
 * rows make the cost of rebuilding it irrelevant.
 *
 * The TTL exists because fingerprints appear as the ETL runs. A stale label
 * table would silently omit new error groups from every answer, which is the
 * failure mode that looks like "the errors stopped".
 */
async function buildLabels(force = false) {
    if (!force && Date.now() - labelsBuiltAt < LABELS_TTL_MS) return;

    // Label only. Counting here would be counting across every project — an
    // unscoped total sitting in a column that reads like a safe one, waiting
    // for something to join to it. `ai_error_groups` aggregates through the
    // scoped `ai_errors` instead, so occurrences always mean "for this caller".
    const rows = await all('SELECT fingerprint, normalized_message FROM error_fingerprints');

    await run(`CREATE TEMP TABLE IF NOT EXISTS ${LABEL_TABLE} (
        fingerprint TEXT PRIMARY KEY, error_label TEXT)`);
    await run(`DELETE FROM ${LABEL_TABLE}`);

    for (const r of rows) {
        await run(
            `INSERT INTO ${LABEL_TABLE} (fingerprint, error_label) VALUES (?, ?)`,
            [r.fingerprint, errorLabel(r.normalized_message)]
        );
    }
    labelsBuiltAt = Date.now();
}

async function buildViews() {
    // Must exist before the views, which select through it.
    await run('CREATE TEMP TABLE IF NOT EXISTS ai_scope (workflow_id TEXT PRIMARY KEY)');
    await buildLabels(true);
    for (const v of VIEWS) {
        // TEMP, so they exist only for this connection and are not written to
        // the replica — which this connection could not do in any case.
        await run(`CREATE TEMP VIEW IF NOT EXISTS ${v.name} AS ${v.sql}`);
    }
    log.info(`Read-only AI connection ready — ${VIEWS.length} views.`);
}

/**
 * Loads the workflow ids this request may see into `ai_scope`.
 *
 * Runs inside the same serialised slot as the query it belongs to, so the table
 * cannot describe one caller while another's statement executes. That
 * serialisation is what makes a single shared connection safe here; without it
 * this would have to be a connection per user.
 *
 * `null` means unrestricted — an n8n owner or admin — and loads every workflow
 * rather than skipping the filter. Same relation, same code path: a bug that
 * emptied the table would show up as "no data" for everyone, which is loud,
 * instead of as a silent scope bypass, which is not.
 */
async function loadScope(visibleWorkflowIds) {
    await run('DELETE FROM ai_scope');
    if (visibleWorkflowIds === null) {
        await run('INSERT INTO ai_scope (workflow_id) SELECT id FROM workflow_entity');
        return;
    }
    for (const id of visibleWorkflowIds) {
        await run('INSERT OR IGNORE INTO ai_scope (workflow_id) VALUES (?)', [id]);
    }
}

/**
 * Runs one guarded statement.
 *
 * The caller is responsible for having passed the SQL through the guard; this
 * function assumes nothing about it except that it must not be allowed to run
 * forever. `interrupt()` aborts whatever is executing, which is why the chain
 * above guarantees that is only ever this statement.
 */
async function query(sql, params = [], { timeoutMs = DEFAULT_TIMEOUT_MS, scope } = {}) {
    await open();

    if (scope === undefined) {
        // Not a default worth having. Every caller knows who is asking, and a
        // forgotten argument must not quietly mean "show them everything".
        throw new Error('readonlyDb.query requires an explicit scope (null for unrestricted).');
    }

    const task = chain.then(async () => {
        await buildLabels();
        await loadScope(scope);

        let timer = null;
        let timedOut = false;
        try {
            return await new Promise((resolve, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    db.interrupt();
                }, timeoutMs);

                db.all(sql, params, (err, rows) => {
                    if (err) {
                        return reject(timedOut
                            ? new Error(`Query exceeded ${timeoutMs} ms and was cancelled.`)
                            : err);
                    }
                    resolve(rows || []);
                });
            });
        } finally {
            clearTimeout(timer);
        }
    });

    // The chain must survive a rejected task, or one failed query stops every
    // later one on the connection.
    chain = task.then(() => undefined, () => undefined);
    return task;
}

function close() {
    if (!db) return Promise.resolve();
    return new Promise((resolve) => {
        db.close(() => { db = null; ready = null; resolve(); });
    });
}

module.exports = { query, close, _internal: { buildLabels, loadScope, open } };
