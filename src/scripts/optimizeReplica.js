/**
 * One-off optimisation and cleanup pass over the local replica.
 *
 * Everything here is also applied automatically at boot by localDb.js, but on a
 * database this size building the indexes during a container start is slow and
 * VACUUM cannot run at all while the app holds the file. Running it offline means
 * the replica can be shipped to the server already optimised.
 *
 *   node src/scripts/optimizeReplica.js            # report only, no writes
 *   node src/scripts/optimizeReplica.js --apply    # perform the migration
 *
 * The app must not be running against the target file.
 */
const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');

const APPLY = process.argv.includes('--apply');
const dbPath = process.env.DASHBOARD_DB_PATH
    ? path.resolve(process.env.DASHBOARD_DB_PATH)
    : path.resolve(__dirname, '../../dashboard.sqlite');

if (!fs.existsSync(dbPath)) {
    console.error(`No database at ${dbPath}`);
    process.exit(1);
}

const db = new sqlite3.Database(dbPath, APPLY ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY);
const all = (sql, p = []) => new Promise((res, rej) => { db.all(sql, p, (e, r) => (e ? rej(e) : res(r))); });
const run = (sql, p = []) => new Promise((res, rej) => { db.run(sql, p, function (e) { if (e) rej(e); else res(this); }); });

// Derived from the migrations rather than restated. This list used to be a
// second, hand-maintained copy and had fallen five indexes behind the app —
// so the script whose whole purpose is "ship a replica that is already
// optimised" was shipping one that was not.
const { INDEX_STATEMENTS: INDEXES } = require('../config/schema');

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);

(async () => {
    console.log(`Database : ${dbPath}`);
    console.log(`Mode     : ${APPLY ? 'APPLY (writes)' : 'REPORT ONLY'}`);
    console.log(`Size     : ${(fs.statSync(dbPath).size / 1048576).toFixed(1)} MB`);

    // ── survey ───────────────────────────────────────────────────────
    const [{ journal_mode }] = await all('PRAGMA journal_mode');
    const existing = (await all(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`)).map(r => r.name);
    const missing = INDEXES.filter(sql => !existing.includes(sql.match(/idx_\w+/)[0]));
    // Three distinct cases, and only one of them is safe to delete.
    //  - empty   : neither timestamp, no workflow outcome ever recorded
    //  - salvage : real executions n8n finished but never stamped a start time.
    //              Every dashboard query filters on startedAt, so these are
    //              currently invisible and undercount the error totals.
    //  - stuck   : started, never finished, and since pruned from Postgres, so
    //              the sync can never resolve them
    const empty = (await all(
        `SELECT COUNT(*) n FROM execution_entity WHERE "startedAt" IS NULL AND "stoppedAt" IS NULL`))[0].n;
    const salvage = await all(
        `SELECT status, COUNT(*) n FROM execution_entity
         WHERE "startedAt" IS NULL AND "stoppedAt" IS NOT NULL GROUP BY status`);
    const zombiesStuck = await all(
        `SELECT id, status, "startedAt" FROM execution_entity
         WHERE "stoppedAt" IS NULL AND "startedAt" IS NOT NULL`);
    const hasCustomLogs = (await all(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='custom_logs'`))[0].n > 0;
    const chatSql = (await all(`SELECT sql FROM sqlite_master WHERE name='dashboard_chat_history'`))[0]?.sql || '';
    const chatNeedsUtc = chatSql.includes('localtime');

    step(1, `journal_mode = ${journal_mode}` + (journal_mode !== 'wal' ? '  -> will switch to WAL' : '  (already WAL)'));
    step(2, `indexes: ${existing.length} present, ${missing.length} to create`);
    missing.forEach(s => console.log('      + ' + s.match(/idx_\w+/)[0]));
    step(3, `orphan rows`);
    console.log(`      ${empty} empty (no timestamps at all) -> delete`);
    salvage.forEach(s => console.log(`      ${s.n} ${s.status} with stoppedAt but no startedAt -> backfill startedAt = stoppedAt`));
    zombiesStuck.forEach(z => console.log(`      id=${z.id} ${z.status} since ${z.startedAt}, never finished -> mark crashed`));
    step(4, `custom_logs table: ${hasCustomLogs ? 'present -> will be dropped' : 'absent'}`);
    step(5, `chat created_at default: ${chatNeedsUtc ? "localtime -> will be rebuilt as UTC" : 'already UTC'}`);

    if (!APPLY) {
        console.log('\nReport only. Re-run with --apply to perform these changes.');
        db.close();
        return;
    }

    // ── apply ────────────────────────────────────────────────────────
    console.log('\n--- applying ---');

    if (journal_mode !== 'wal') {
        const [r] = await all('PRAGMA journal_mode = WAL');
        console.log(`journal_mode -> ${r.journal_mode}`);
    }

    for (const sql of INDEXES) {
        const t = Date.now();
        await run(sql);
        console.log(`index ${sql.match(/idx_\w+/)[0]} (${Date.now() - t} ms)`);
    }

    // Rows that never received a start time carry no analytical value and break
    // date handling downstream. Rows that started but were pruned from Postgres
    // before the sync saw them finish keep their timestamp but stop pretending
    // to still be running.
    if (empty) {
        const r = await run(
            `DELETE FROM execution_entity WHERE "startedAt" IS NULL AND "stoppedAt" IS NULL`);
        console.log(`deleted ${r.changes} rows with no timestamps at all`);
    }

    // Approximate the start from the recorded end. These executions failed at or
    // near their stop time, so duration reads as zero — unknown, but not
    // misleading — and they finally become visible to the error dashboard.
    const sal = await run(
        `UPDATE execution_entity SET "startedAt" = "stoppedAt"
         WHERE "startedAt" IS NULL AND "stoppedAt" IS NOT NULL`);
    if (sal.changes) console.log(`backfilled startedAt on ${sal.changes} previously invisible executions`);
    if (zombiesStuck.length) {
        const r = await run(
            `UPDATE execution_entity SET status = 'crashed'
             WHERE "stoppedAt" IS NULL AND "startedAt" IS NOT NULL AND status IN ('new','running','waiting')`);
        console.log(`marked ${r.changes} abandoned executions as crashed`);
    }

    if (hasCustomLogs) {
        const rows = await all('SELECT * FROM custom_logs');
        fs.writeFileSync(
            path.resolve(__dirname, '../../custom_logs.dropped.json'),
            JSON.stringify(rows, null, 2)
        );
        await run('DROP TABLE custom_logs');
        console.log(`dropped custom_logs (${rows.length} rows saved to custom_logs.dropped.json)`);
    }

    if (chatNeedsUtc) {
        await run('BEGIN');
        await run(`CREATE TABLE dashboard_chat_history_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            sql_used TEXT,
            created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )`);
        await run(`INSERT INTO dashboard_chat_history_new (id, user_id, role, content, sql_used, created_at)
                   SELECT id, user_id, role, content, sql_used, created_at FROM dashboard_chat_history`);
        await run('DROP TABLE dashboard_chat_history');
        await run('ALTER TABLE dashboard_chat_history_new RENAME TO dashboard_chat_history');
        await run('COMMIT');
        console.log('rebuilt dashboard_chat_history with a UTC default');
    }

    await run('ANALYZE');
    console.log('ANALYZE done');

    // VACUUM must run outside a transaction and cannot run while the app holds
    // the file — the main reason this script exists as an offline step.
    const before = fs.statSync(dbPath).size;
    await run('VACUUM');
    const after = fs.statSync(dbPath).size;
    console.log(`VACUUM: ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB`);

    // F-19. Nothing else in the codebase runs a VACUUM, so this is the only
    // place that can honestly answer "when was the last one". Written after the
    // VACUUM rather than before, so a run that dies halfway does not leave a
    // date behind for work that did not finish.
    await run(
        `INSERT INTO dashboard_settings (key, value) VALUES ('last_vacuum_at', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [new Date().toISOString()]
    );

    const [{ integrity_check }] = await all('PRAGMA integrity_check');
    const [{ n }] = await all('SELECT COUNT(*) n FROM execution_entity');
    console.log(`\nintegrity_check: ${integrity_check}`);
    console.log(`execution_entity: ${n} rows`);
    db.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
