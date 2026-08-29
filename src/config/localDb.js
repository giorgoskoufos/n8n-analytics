const sqlite3 = require('sqlite3').verbose();
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('path');
const fs = require('fs');
const { MIGRATIONS } = require('./schema');
const log = require('../utils/logger').logger('DB');

// Configurable so the replica can live on a mounted volume instead of inside the
// container. It holds history that has already been pruned from the n8n Postgres
// and cannot be rebuilt, so it must survive container replacement.
const dbPath = process.env.DASHBOARD_DB_PATH
    ? path.resolve(process.env.DASHBOARD_DB_PATH)
    : path.resolve(__dirname, '../../dashboard.sqlite');

/**
 * The replica's directory must exist and be writable before anything else runs.
 *
 * Checked here, loudly, because the failure this catches is the one that has the
 * least helpful default message. The container runs as the unprivileged `node`
 * user, and Docker applies image ownership only to a volume it creates empty — a
 * volume that already exists from a previous root-owned container is left exactly
 * as it was. The result is EACCES, surfacing as SQLITE_CANTOPEN with no hint of
 * why, on a deployment that worked yesterday.
 *
 * Exits rather than continuing. Without the replica every endpoint returns 500,
 * and a process that stays up while being unable to do anything is harder to
 * diagnose than one that stops and says why.
 */
function ensureWritableDataDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
    } catch (err) {
        log.error(
            `\n[DB] Cannot write to ${dir} (${err.code || err.message}).\n` +
            `     The dashboard runs as an unprivileged user and needs to own this directory.\n` +
            `     If this is a Docker volume created by an older, root-owned version, run once:\n\n` +
            `       docker run --rm -v <your-volume>:/data alpine chown -R 1000:1000 /data\n\n` +
            `     Then start the container again.\n`
        );
        process.exit(1);
    }
}

ensureWritableDataDir(path.dirname(dbPath));

/**
 * Resolves once the schema is up to date.
 *
 * server.js awaits this before it listens or schedules the ETL. The migrations
 * await between statements, so unlike the old synchronous serialize() block they
 * do not implicitly queue ahead of everything else on the connection — a request
 * arriving mid-migration would query a table that is not there yet.
 *
 * Declared before the connection is opened, so the open callback closes over a
 * binding that already exists rather than one further down the file.
 */
let signalReady;
const ready = new Promise((resolve) => { signalReady = resolve; });

const localDb = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        // Fatal. Every endpoint depends on this file; staying up only turns one
        // clear message at boot into a 500 on every request afterwards.
        log.error(`Could not open ${dbPath}: ${err.message}`);
        process.exit(1);
    }
    log.info(`Connected to the local SQLite database at ${dbPath}`);
    // Chained, not fired side by side. node-sqlite3 runs statements in parallel
    // mode by default — serialize() only orders the ones issued inside its
    // callback — so the pragmas and the migrations were racing. The first boot
    // after the migrations arrived died on
    // "Safety level may not be changed inside a transaction": PRAGMA synchronous
    // had landed in the middle of a migration's BEGIN.
    signalReady(applyPragmas().then(() => localDb.exclusive(() => runMigrations(localDb))));
});

localDb.ready = ready;

/**
 * Connection tuning. Must run before any other statement.
 *
 * The default rollback journal takes an exclusive lock for the whole write
 * transaction, so every ETL cycle froze all readers — the API appeared to hang
 * on a five minute rhythm. WAL lets readers continue against the last committed
 * snapshot while the sync writes.
 */
async function applyPragmas() {
    const pragmas = [
        // Persisted in the database header — survives restarts and file copies.
        'PRAGMA journal_mode = WAL',
        // Per-connection, so these are reapplied on every boot.
        'PRAGMA synchronous = NORMAL',   // safe under WAL, far fewer fsyncs
        'PRAGMA busy_timeout = 5000',    // wait instead of throwing SQLITE_BUSY
        'PRAGMA foreign_keys = ON',      // the schema declares them; enforce them
        'PRAGMA cache_size = -32000'     // ~32 MB page cache
    ];

    for (const pragma of pragmas) {
        try {
            await localDb.execute(pragma);
        } catch (err) {
            // Awaited one at a time and each error caught. Fired without a
            // callback, as these were, a failing pragma surfaces as an 'error'
            // event on the Database — which is an uncaught exception that takes
            // the process down at boot, several frames away from the cause.
            log.error(`${pragma} failed:`, err.message);
        }
    }
}

// The schema itself lives in schema.js — it is data, and things that only want
// to read it should not have to open a database to do so. What stays here is the
// part that touches the disk.

/** Adds a column only if the table does not already have it. */
async function addColumnIfMissing(db, table, column, definition) {
    const info = await db.query(`PRAGMA table_info(${table})`);
    if (info.rows.some((c) => c.name === column)) return false;
    await db.execute(`ALTER TABLE ${table} ADD COLUMN "${column}" ${definition}`);
    log.info(`Added column ${table}.${column}`);
    return true;
}

/**
 * Applies every migration that has not run yet.
 *
 * Each one is wrapped in its own transaction together with the row that records
 * it, so the two can never disagree: a crash halfway leaves the migration
 * unapplied AND unrecorded, and the next boot simply retries it.
 *
 * A failure exits the process. The alternative is serving a dashboard whose
 * schema is in a state nobody has described, against a database holding history
 * that cannot be rebuilt.
 */
async function runMigrations(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        )
    `);

    const applied = new Set(
        (await db.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id)
    );

    let ran = 0;
    for (const migration of MIGRATIONS) {
        if (applied.has(migration.id)) continue;

        await db.execute('BEGIN TRANSACTION');
        try {
            for (const sql of migration.sql || []) {
                await db.execute(sql);
            }
            for (const [table, column, definition] of migration.columns || []) {
                await addColumnIfMissing(db, table, column, definition);
            }
            if (migration.run) await migration.run(db);

            await db.execute(
                'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
                [migration.id, new Date().toISOString()]
            );
            await db.execute('COMMIT');
            ran++;
        } catch (err) {
            try { await db.execute('ROLLBACK'); } catch (e) { /* the failure below is the one that matters */ }
            log.error(
                `\n[DB] Migration ${migration.id} failed: ${err.message}\n` +
                `     The database is unchanged — this migration ran inside a transaction.\n` +
                `     Refusing to start against a schema in an unknown state.\n`
            );
            process.exit(1);
        }
    }

    if (ran > 0) log.info(`Applied ${ran} schema migration(s).`);

    // Outside the loop and outside any transaction: ANALYZE only refreshes the
    // planner's statistics, and it is worth re-running whenever the data has
    // grown, not only when the schema changed.
    await db.execute('ANALYZE');
    log.info('Schema ready.');
}

// ==========================================================================
// One writer at a time
// ==========================================================================

/**
 * A transaction belongs to the CONNECTION, not to the function that opened it.
 *
 * This process has exactly one SQLite connection and three things on timers that
 * write through it: the ETL pass, the fingerprint backfill and the alert pass.
 * Each brackets its work in BEGIN/COMMIT. SQLite has no nested transactions, so
 * the moment two of them overlap the second BEGIN fails with "cannot start a
 * transaction within a transaction" — and it kills whichever pass was unlucky,
 * not the one already running.
 *
 * That is not hypothetical. The ETL and the fingerprint backfill were scheduled
 * on the same cron expression, so they fired in the same millisecond: eighteen
 * consecutive failed passes, the replica nine hours behind, and nothing saying
 * so. F-19's health panel is what finally showed it.
 *
 * So the gate lives here rather than in each caller. Work handed to exclusive()
 * runs when no other exclusive() work is in flight, and the guard in execute()
 * makes a caller who forgets say so loudly instead of failing at 3am.
 *
 * Reentrant, via AsyncLocalStorage: the ETL calls the fingerprint backfill as
 * its last step, and a plain mutex would deadlock the moment it did.
 */
const writeGate = new AsyncLocalStorage();
let gateTail = Promise.resolve();

localDb.exclusive = function (fn) {
    // Already inside the gate — this is one pass calling its own step, not a
    // second writer.
    if (writeGate.getStore()) return Promise.resolve().then(fn);

    const run = () => writeGate.run({ held: true }, fn);
    // Queued behind whatever holds it. The tail is normalised so one rejection
    // cannot break the chain and strand every writer after it.
    const queued = gateTail.then(run, run);
    gateTail = queued.then(() => {}, () => {});
    return queued;
};

/** Whether the caller currently owns the connection. Used by the tests. */
localDb.holdsWriteGate = () => Boolean(writeGate.getStore());

// Convert callback based queries to promises for easier async/await usage
localDb.query = function (sql, params = []) {
    return new Promise((resolve, reject) => {
        this.all(sql, params, (err, rows) => {
            if (err) {
                reject(err);
            } else {
                // To keep compatibility with pg structure expecting `rows`
                resolve({ rows });
            }
        });
    });
};

localDb.execute = function (sql, params = []) {
    // Only ever true for a bug, and cheap: the store lookup short-circuits
    // before the regex. It logs rather than throws — a warning that is wrong
    // must not be able to stop an ETL pass — but it names the exact mistake
    // that produced a nine-hour outage here, at the moment it is made.
    if (!writeGate.getStore() && /^\s*BEGIN\b/i.test(sql)) {
        log.error(
            'BEGIN TRANSACTION issued outside localDb.exclusive(). Two writers on ' +
            'one connection collide with "cannot start a transaction within a ' +
            'transaction". Wrap this pass in localDb.exclusive().'
        );
    }
    return new Promise((resolve, reject) => {
        this.run(sql, params, function (err) {
            if (err) {
                reject(err);
            } else {
                resolve(this);
            }
        });
    });
};

/**
 * Runs one statement over many parameter sets against a single prepared statement.
 *
 * The sync previously awaited a separate execute() per row, so a batch of a few
 * thousand executions meant a few thousand parse/plan cycles and promise
 * round-trips while holding the write lock. Preparing once and reusing keeps that
 * lock held for a fraction of the time.
 *
 * The caller owns the surrounding transaction.
 */
localDb.executeMany = function (sql, rows) {
    return new Promise((resolve, reject) => {
        if (!rows || rows.length === 0) { resolve(0); return; }

        const stmt = this.prepare(sql, (prepErr) => {
            if (prepErr) return reject(prepErr);

            let pending = rows.length;
            let failed = null;

            for (const params of rows) {
                stmt.run(params, (err) => {
                    if (err && !failed) failed = err;
                    if (--pending === 0) {
                        stmt.finalize((finErr) => {
                            const e = failed || finErr;
                            if (e) reject(e);
                            else resolve(rows.length);
                        });
                    }
                });
            }
        });
    });
};

/**
 * Closes the replica cleanly, checkpointing the WAL first.
 *
 * The checkpoint is the part that matters. Under WAL, recent commits live in the
 * -wal sidecar until something folds them back into the main file. A container
 * that dies without checkpointing leaves the newest data in a file that is easy
 * to leave behind when someone copies "the database" — which is exactly how this
 * replica lost 86% of its rows during the volume migration. TRUNCATE folds the
 * WAL back and empties it, so after a clean stop dashboard.sqlite is complete on
 * its own.
 *
 * Never rejects: shutdown must continue even if the checkpoint fails.
 */
localDb.closeAsync = function () {
    return new Promise((resolve) => {
        this.run('PRAGMA wal_checkpoint(TRUNCATE)', (err) => {
            if (err) log.error('WAL checkpoint failed:', err.message);
            this.close((closeErr) => {
                if (closeErr) log.error('Error closing replica:', closeErr.message);
                else log.info('Replica closed cleanly.');
                resolve();
            });
        });
    });
};

module.exports = localDb;
