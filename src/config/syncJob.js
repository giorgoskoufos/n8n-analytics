const { pool } = require('./db');
const localDb = require('./localDb');
const fs = require('fs');
const path = require('path');
const { parse } = require('flatted');
const { summariseTrace } = require('../utils/trace');
const { resolveError, extractHttpCode, CLASSIFIER_VERSION } = require('./errorParser');
const { fingerprintOf, FINGERPRINT_VERSION } = require('./fingerprint');
const {
    EXECUTION_MIRROR_COLUMNS, WORKFLOW_MIRROR_COLUMNS, TRANSIENT_INDEXES, mirrorPlan, toSqlite
} = require('./schema');
const instanceLock = require('./instanceLock');
const { invalidateScopeCache } = require('../utils/scope');
const log = require('../utils/logger').logger('SYNC');

let isSyncing = false;

// Statuses that can still change, so they must be re-checked every cycle.
// 'waiting' belongs here — a Wait node can hold an execution for days.
const NON_TERMINAL_STATUSES = ['new', 'running', 'waiting'];

// How long an execution may stay absent from Postgres before its status is
// written off as unknowable. Long enough to ride out replication lag and a
// restart, short enough that the row does not sit misleading forever.
const MISSING_GRACE_MS = Number(process.env.EXECUTION_MISSING_GRACE_MS) || 60 * 60 * 1000;

// How far back Phase B re-reads on every cycle, measured in execution ids.
//
// The hazard is real and visible in the data: Postgres hands out ids at INSERT
// but commits land out of order, so a row with a LOWER id can become visible
// after we have already passed it. A probe of the production table found 894
// rows whose createdAt runs backwards against id order — proof that ids are
// allocated concurrently, which is the precondition for that miss.
//
// The obvious fix, a watermark on createdAt, is worse: n8n has NO index on that
// column, so `WHERE "createdAt" > $1` plans as a Seq Scan of the whole table on
// every cycle, while `id > $1` is an Index Only Scan on the primary key. We
// never write to the n8n database, so adding an index is not an option either.
//
// Re-reading a fixed window of ids keeps the index and closes the same gap:
// the rows come back through ON CONFLICT DO UPDATE, which is already idempotent.
const ID_OVERLAP = Number(process.env.SYNC_ID_OVERLAP) || 500;

// --- Error analytics queue limits (M-14 / M-15) ---

// Ids per payload query. The old code joined execution_data — 1.2 GB — for every
// error id at once and held all of it in memory. Average payload is 42 KB and the
// largest seen is 2.2 MB, so a spike of a few thousand errors in one cycle meant
// hundreds of megabytes in a single result set.
const ERROR_CHUNK_SIZE = Number(process.env.ERROR_CHUNK_SIZE) || 50;

// Ceiling on how much of the queue one cycle drains. The rest stays pending and
// is picked up next time, so a backlog costs many small cycles instead of one
// enormous one.
const ERROR_BATCH_LIMIT = Number(process.env.ERROR_BATCH_LIMIT) || 500;

// Payloads above this are left unread. The check happens in Postgres, so an
// oversized trace is never sent over the wire at all.
const MAX_PAYLOAD_BYTES = Number(process.env.MAX_ERROR_PAYLOAD_BYTES) || 5 * 1024 * 1024;

// After this many failures an execution stops being retried. Without a ceiling a
// permanently unparseable trace is retried forever, every cycle.
const MAX_ANALYTICS_ATTEMPTS = Number(process.env.MAX_ANALYTICS_ATTEMPTS) || 5;

// Exponential backoff, capped. A failure that is really an outage should not be
// hammered at every cycle, and one that is really a bad row should drift out of
// the way of healthy work.
function backoffFor(attempts) {
    const minutes = Math.min(2 ** attempts, 6 * 60);
    return new Date(Date.now() + minutes * 60_000).toISOString();
}

// Always print a size a human can act on. Fixing the unit at MB turns every
// small payload into "0.0 MB, over the 0 MB limit", which tells the reader
// nothing at all.
function formatBytes(n) {
    if (!Number.isFinite(n)) return 'unknown size';
    if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} bytes`;
}

// n8n's schema has changed shape across major versions: soft deletes (deletedAt)
// arrived in 1.x, payload sizes and workflowVersionId in 2.x, projects somewhere
// between. Probe each table once and build every statement from the columns that
// actually exist, the same way authController handles the user table.
//
// This is not defensive decoration. A SELECT that names one column the source
// does not have fails the whole cycle, not just that field — so an instance one
// minor version behind would get no executions at all rather than fifteen
// columns instead of nineteen.
const columnCache = new Map();
function getTableColumns(table) {
    if (!columnCache.has(table)) {
        columnCache.set(
            table,
            pool
                .query(
                    `SELECT column_name FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = $1`,
                    [table]
                )
                .then((r) => new Set(r.rows.map((x) => x.column_name)))
                .catch((err) => {
                    log.error(`Could not read ${table} columns:`, err.message);
                    columnCache.delete(table);   // retry on the next cycle
                    return new Set();
                })
        );
    }
    return columnCache.get(table);
}

const getExecutionColumns = () => getTableColumns('execution_entity');

// ==========================================================================
// Progress numbering
// ==========================================================================

/**
 * The ETL pass, in order, as data.
 *
 * The log used to be a wall of unrelated sentences, so watching a sync meant
 * knowing which line came before which — and there was no way to tell "still
 * working" from "finished quietly". Numbering fixes that, but only if the
 * numbers cannot drift from the work, which is why the order lives here rather
 * than as literals at each call site.
 *
 * Gaps are expected and are information. A step that had nothing to do prints
 * nothing, so `[1/13] … [5/13] … [13/13]` says the three in between were
 * no-ops — which on a healthy instance is most of them, most of the time.
 */
const PASS_STEPS = [
    ['workflows', 'workflows'],
    ['authorization', 'permissions'],
    ['statistics', 'workflow counters'],
    ['organisation', 'folders, tags and versions'],
    ['executions', 'executions'],
    ['volume', 'volume buckets'],
    ['analytics', 'error details'],
    ['reclassify', 'reclassification'],
    ['retention', 'retention'],
    ['backfill', 'column backfill'],
    ['fingerprints', 'fingerprints'],
    ['profiling', 'node profiling'],
    ['done', 'replica up to date']
];

/**
 * One numbered progress line.
 *
 * The position comes from PASS_STEPS, not from a counter, so a step that is
 * skipped does not renumber the ones after it — `[9/13]` means the same stage
 * of the pass on every run, which is the only way the numbers are worth
 * printing at all.
 *
 * An unknown key is a bug in this file and says so rather than printing
 * `[0/13]`, which reads like a real step.
 */
function step(key, detail) {
    const index = PASS_STEPS.findIndex(([k]) => k === key);
    if (index === -1) {
        log.warn(`Unnumbered ETL step "${key}": ${detail}`);
        return;
    }
    const [, label] = PASS_STEPS[index];
    log.info(`[${index + 1}/${PASS_STEPS.length}] ${label} — ${detail}`);
}

// Returns a result object rather than nothing, because the caller cannot
// otherwise tell "synced" from "silently skipped" — /api/sync/force used to
// answer "Sync Complete" to a request that did no work at all.
async function syncData() {
    if (isSyncing) {
        log.info('Sync already running. Skipping concurrent request.');
        return { status: 'already_running' };
    }

    // isSyncing only guards against overlap inside THIS process. Two containers
    // sharing the replica each have their own flag and would happily write over
    // one another — which is what destroyed this file three times. The lock is
    // the cross-process half of the same guarantee.
    if (!(await instanceLock.claimForEtl())) {
        return { status: 'not_lock_owner', owner: await instanceLock.describeOwner() };
    }

    isSyncing = true;
    try {
        // isSyncing stops a second ETL pass. This stops the fingerprint backfill
        // and the alert pass — which run on their own timers and write through
        // the same connection — from opening a transaction inside this one.
        return await localDb.exclusive(runSyncPass);
    } finally {
        isSyncing = false;
    }
}

/** One ETL pass. Always called with the write gate held. */
async function runSyncPass() {
    const runStartedAt = new Date();
    const runStartedHr = process.hrtime.bigint();
    log.info('Starting ETL Sync...');
    try {
        // The schema is applied asynchronously now, and the boot sync fires two
        // seconds in. On a fresh database that is a race the ETL would lose.
        await localDb.ready;

        // 1. Sync Workflows (Full Sync for active/names is lightweight enough)
        const wfPlan = mirrorPlan(await getTableColumns('workflow_entity'), WORKFLOW_MIRROR_COLUMNS);
        const workflows = await pool.query(
            `SELECT id, name, active${wfPlan.select} FROM workflow_entity`
        );
        await localDb.execute('BEGIN TRANSACTION');
        await localDb.executeMany(
            `INSERT INTO workflow_entity (id, name, active${wfPlan.select})
             VALUES (?, ?, ?${wfPlan.placeholders})
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name, active = excluded.active${wfPlan.upsert}`,
            workflows.rows.map(w => [w.id, w.name, toSqlite(w.active), ...wfPlan.values(w)])
        );
        await localDb.execute('COMMIT');
        step('workflows', `${workflows.rows.length} synced`);

        // 1b. Sync who may see what. Runs right after the workflows so the ids it
        //     references already exist locally. Never throws: a dashboard that
        //     cannot refresh membership should keep serving the last known one,
        //     not stop syncing executions.
        await syncAuthorization();

        // 1c. n8n's own per-workflow counters (F-09). Cheap, and the only source
        //     that outlives execution pruning.
        const statistics = await syncWorkflowStatistics();
        if (statistics) step('statistics', `${statistics} workflows`);

        // 1d. Folders, tags, version history, dependencies, credentials by name,
        //     business metadata (F-16, F-11, F-10, F-18). A few thousand rows in
        //     total; each answers a question the executions alone cannot.
        const organisation = await syncOrganisation();

        // 2. Sync Executions
        //
        // Which of the mirrored columns this source has is settled once, here,
        // and then used by every phase below. Resolved before Phase A because
        // Phase A needs it too: the non-terminal refresh reads the same columns
        // the fetch does.
        const execColumns = await getExecutionColumns();
        const execPlan = mirrorPlan(execColumns, EXECUTION_MIRROR_COLUMNS);

        // PHASE A: Re-check every execution that has not reached a terminal state.
        //
        // This used to look at status='running' only, so rows stuck at 'new' or
        // 'waiting' were never revisited — the replica had five 'new' rows with a
        // NULL startedAt that could never be updated by anything.
        const openExecs = await localDb.query(
            `SELECT id, missing_since FROM execution_entity WHERE status IN (${NON_TERMINAL_STATUSES.map(() => '?').join(',')})`,
            NON_TERMINAL_STATUSES
        );
        const errorIds = new Set(); // Track new errors

        if (openExecs.rows.length > 0) {
            const openIds = openExecs.rows.map(r => r.id);
            log.info(`Re-checking status for ${openIds.length} non-terminal executions...`);

            // Query Postgres for the current state of these specific executions.
            // The mirrored columns come along too: finished, waitTill,
            // retrySuccessId and the payload sizes are precisely the fields that
            // move while an execution is still open, so refreshing status alone
            // would leave them frozen at whatever they were when the row first
            // appeared.
            const updatedExecs = await pool.query(
                `SELECT id, status, "startedAt", "stoppedAt"${execPlan.select}
                   FROM execution_entity WHERE id = ANY($1)`,
                [openIds]
            );

            const returned = new Map(updatedExecs.rows.map(e => [e.id, e]));
            const now = new Date();
            const nowIso = now.toISOString();

            await localDb.execute('BEGIN TRANSACTION');

            for (const local of openExecs.rows) {
                const e = returned.get(local.id);

                if (e) {
                    // Clearing missing_since matters: a row can disappear from a
                    // query and come back (replication lag, a transaction still
                    // open), and a stale marker would eventually condemn a healthy
                    // execution to 'unknown'.
                    await localDb.execute(
                        `UPDATE execution_entity
                            SET status = ?, "startedAt" = COALESCE("startedAt", ?), "stoppedAt" = ?,
                                missing_since = NULL${execPlan.assign}
                          WHERE id = ?`,
                        [
                            e.status,
                            e.startedAt ? e.startedAt.toISOString() : null,
                            e.stoppedAt ? e.stoppedAt.toISOString() : null,
                            ...execPlan.values(e),
                            e.id
                        ]
                    );
                    if (e.status === 'error' || e.status === 'crashed') errorIds.add(e.id);
                    continue;
                }

                // Postgres no longer has this row. Almost always it was pruned
                // before it ever finished, so its status is now unknowable — but
                // one absent cycle is not proof, so it is given a grace period
                // rather than being condemned immediately.
                if (!local.missing_since) {
                    await localDb.execute(
                        'UPDATE execution_entity SET missing_since = ? WHERE id = ?',
                        [nowIso, local.id]
                    );
                } else if (now - new Date(local.missing_since) >= MISSING_GRACE_MS) {
                    // 'unknown' is deliberately not 'crashed'. We do not know that
                    // it failed; we know only that we can never find out.
                    await localDb.execute(
                        "UPDATE execution_entity SET status = 'unknown' WHERE id = ?",
                        [local.id]
                    );
                    log.warn(
                        `Execution ${local.id} has been absent from Postgres since ` +
                        `${local.missing_since} — marking 'unknown'.`
                    );
                }
            }

            await localDb.execute('COMMIT');
        }

        // PHASE B: Incremental Sync for new executions
        const lastIdObj = await localDb.query('SELECT MAX(id) as max_id FROM execution_entity');
        let lastId = lastIdObj.rows[0].max_id;

        // Clamp the watermark to what Postgres actually has.
        //
        // MAX(id) over the replica is only trustworthy while every id in it came
        // from Postgres. One row with an impossibly high id — a manual insert, a
        // restore from the wrong source, a test that leaked — parks the watermark
        // above every real execution and the sync then fetches nothing, forever,
        // while cheerfully reporting "0 new executions". That is the failure mode
        // this project keeps being bitten by: silent, and indistinguishable from
        // idle. The clamp costs one index-only scan per cycle.
        if (lastId) {
            const pgMaxRes = await pool.query('SELECT MAX(id) AS max_id FROM execution_entity');
            const pgMax = pgMaxRes.rows[0].max_id;
            if (pgMax !== null && pgMax < lastId) {
                log.warn(
                    `Replica high-water id ${lastId} is beyond the source maximum ${pgMax}. ` +
                    'Clamping — a stray id would otherwise stall the sync indefinitely.'
                );
                lastId = pgMax;
            }
        }

        let execQuery = '';
        let params = [];

        // Skip executions the user deleted in n8n. Only applied on fetch: rows
        // already in the replica are kept, because retaining history that n8n no
        // longer has is the entire point of this database.
        const notDeleted = execColumns.has('deletedAt') ? 'AND "deletedAt" IS NULL' : '';

        if (!lastId) {
            // First time boot sync (last 14 days)
            log.info('Initial Boot: Fetching last 14 days of executions.');
            execQuery = `
                SELECT id, "workflowId", status, "startedAt", "stoppedAt"${execPlan.select}
                FROM execution_entity
                WHERE "startedAt" > NOW() - INTERVAL '14 days'
                  ${notDeleted}
                ORDER BY id ASC
            `;
        } else {
            // Incremental, with an overlap window so a late-committing row with a
            // lower id is not skipped for good. See ID_OVERLAP.
            const from = Math.max(0, lastId - ID_OVERLAP);
            log.info(`Incremental Sync from execution_entity id: ${from} (high water ${lastId}, overlap ${ID_OVERLAP})`);
            execQuery = `
                SELECT id, "workflowId", status, "startedAt", "stoppedAt"${execPlan.select}
                FROM execution_entity
                WHERE id > $1
                  ${notDeleted}
                ORDER BY id ASC
            `;
            params = [from];
        }

        const newExecs = await pool.query(execQuery, params);
        let syncedCount = 0;

        // One prepared statement for the whole batch, inside a single transaction,
        // so the write lock is held briefly instead of once per row.
        if (newExecs.rows.length > 0) {
            // The overlap re-reads rows we already have. Queueing their errors
            // again would make syncErrorAnalytics re-fetch payloads out of the
            // 1.2 GB execution_data table every single cycle, forever — so only
            // rows that are genuinely new, or whose status actually moved, are
            // handed on. One indexed lookup buys that.
            const fetchedIds = newExecs.rows.map(e => e.id);
            const knownRes = await localDb.query(
                `SELECT id, status FROM execution_entity WHERE id IN (${fetchedIds.map(() => '?').join(',')})`,
                fetchedIds
            );
            const knownStatus = new Map(knownRes.rows.map(r => [r.id, r.status]));

            let freshCount = 0;
            const batch = newExecs.rows.map(e => {
                const previous = knownStatus.get(e.id);
                const isNew = previous === undefined;
                if (isNew || previous !== e.status) freshCount++;

                if ((e.status === 'error' || e.status === 'crashed') && (isNew || previous !== e.status)) {
                    errorIds.add(e.id);
                }
                return [
                    e.id,
                    e.workflowId,
                    e.status,
                    e.startedAt ? e.startedAt.toISOString() : null,
                    e.stoppedAt ? e.stoppedAt.toISOString() : null,
                    ...execPlan.values(e)
                ];
            });

            await localDb.execute('BEGIN TRANSACTION');
            await localDb.executeMany(
                // The overlap window means existing rows come back through here
                // every cycle, so the conflict branch has to be a correct update
                // and not just a formality.
                //
                // startedAt is COALESCEd rather than overwritten: optimizeReplica
                // backfilled it for 76 rows that Postgres has as NULL, and a plain
                // assignment would wipe that repair on the very next sync.
                `INSERT INTO execution_entity
                    (id, "workflowId", status, "startedAt", "stoppedAt"${execPlan.select})
                 VALUES (?, ?, ?, ?, ?${execPlan.placeholders})
                 ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    "startedAt" = COALESCE(excluded."startedAt", execution_entity."startedAt"),
                    "stoppedAt" = excluded."stoppedAt",
                    missing_since = NULL${execPlan.upsert}`,
                batch
            );
            await localDb.execute('COMMIT');
            syncedCount = freshCount;
        }
        // Reports what actually changed, not how many rows the overlap happened to
        // re-read — otherwise every idle cycle would claim it synced 500 executions.
        step('executions', `${syncedCount} new or changed (${newExecs.rows.length} rows read)`);

        // 3. Update Concurrency Stats (UTC Standardized)
        await updateExecutionVolumeStats();

        // 4. Deep Error Analytics.
        //
        // Discovery and extraction are now separate. The cycle only records that
        // an execution needs analytics; a queue decides when the work happens.
        // Previously the two were the same step, so a failed extraction was lost
        // with the cycle that found it.
        if (errorIds.size > 0) {
            await enqueueForAnalytics(Array.from(errorIds));
        }
        const analytics = await processAnalyticsQueue();

        // Brings the history in line whenever the rules change. No-op otherwise.
        const reclassified = await reclassifyIfNeeded();

        // Last, so it can never remove a trace that this cycle still needed:
        // reclassification reads error_stack.
        const purged = await purgeExpiredErrorDetail();

        // One-time catch-up for the columns F-01 added. Deliberately after
        // everything else: it is the only work here that nobody is waiting for,
        // and it is time-boxed so a cycle spends its budget on today's data
        // before it spends any on history.
        const backfilled = await backfillMirroredColumns(execPlan);

        // F-07's equivalent, for the errors stored before fingerprinting existed.
        // Deliberately after the reclassification above: that pass rewrites
        // error_message, and the fingerprint is derived from it.
        //
        // Also scheduled independently of this cycle (server.js), because unlike
        // everything else here it reads and writes only the replica. Trapping it
        // inside a cycle that aborts the moment Postgres is unreachable would
        // mean an instance whose source is down can never group the error history
        // it already has — and that history is precisely what someone is looking
        // at while the source is down.
        const fingerprinted = await backfillFingerprints();
        const profiled = await profileWorkflowNodes();

        // Where n8n's own pruning currently stands (F-04).
        await recordSourceHorizon();

        const result = {
            status: 'ok',
            workflows: workflows.rows.length,
            executions: syncedCount,
            rowsRead: newExecs.rows.length,
            errors: errorIds.size,
            analytics,
            reclassified: reclassified.ran ? reclassified.changed : 0,
            purged,
            backfilled,
            fingerprinted,
            profiled,
            statistics,
            organisation
        };
        step('done', `${syncedCount} executions synced`);
        await recordSyncRun(runStartedAt, runStartedHr, result);
        return result;

    } catch (err) {
        log.error('Sync Error:', err);
        try { await localDb.execute('ROLLBACK'); } catch (e) { /* the caught error above is the one worth reporting */ }
        const failure = { status: 'failed', error: err.message };
        await recordSyncRun(runStartedAt, runStartedHr, failure);
        return failure;
    }
}

/**
 * Ages out the two heavy columns in execution_error_analytics.
 *
 * Together they are roughly 42 MB of a 95 MB replica and nothing ever expires
 * them. The row itself is always kept — every count, category and timeline on
 * the dashboard is computed from the other columns, so a purged row still
 * appears everywhere it used to; only the raw evidence behind it is gone.
 *
 * Two knobs, not one, because the two columns are not the same kind of data:
 *
 *   input_data is the actual payload that entered the failing node — real
 *   customer data, ~19 MB — and NOTHING in this codebase reads it. It is written
 *   and never used, which makes it pure liability: the thing H-06 exists to stop
 *   the AI reaching, and the thing a copy of this database would leak. Purged by
 *   default after 30 days.
 *
 *   error_stack is different: reclassifyIfNeeded and backfillErrorMessages both
 *   re-derive the message and category FROM it. Purging it makes those rows
 *   permanently unreclassifiable, so a future rules change would improve every
 *   recent error and silently skip the old ones. It is therefore kept by default
 *   and only aged out if the operator asks — see ERROR_STACK_RETENTION_DAYS in
 *   .env.example, which says so plainly.
 *
 * The freed pages are reused by SQLite for new rows, so the file stops growing;
 * it does not shrink until someone runs a VACUUM. That is deliberately NOT done
 * here — VACUUM rewrites the entire database under an exclusive lock and needs
 * twice the file size in free space, which is not something a five-minute cron
 * job should start on its own. src/scripts/optimizeReplica.js --apply does it.
 */
const ERROR_INPUT_RETENTION_DAYS = Number(process.env.ERROR_DETAIL_RETENTION_DAYS ?? 30);
const ERROR_STACK_RETENTION_DAYS = Number(process.env.ERROR_STACK_RETENTION_DAYS ?? 0);

async function purgeExpiredErrorDetail() {
    const purge = async (column, days) => {
        // 0 or anything unparseable means "keep forever". A typo in an env var
        // must not be read as "delete everything".
        if (!Number.isFinite(days) || days <= 0) return 0;
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        const r = await localDb.execute(
            `UPDATE execution_error_analytics
                SET ${column} = NULL
              WHERE timestamp < ? AND ${column} IS NOT NULL`,
            [cutoff]
        );
        return r.changes || 0;
    };

    try {
        const input = await purge('input_data', ERROR_INPUT_RETENTION_DAYS);
        const stack = await purge('error_stack', ERROR_STACK_RETENTION_DAYS);
        if (input || stack) {
            step('retention',
                `cleared input_data on ${input} rows` +
                `${stack ? `, error_stack on ${stack}` : ''} ` +
                '(run optimizeReplica.js --apply to reclaim the space)');
        }
        return { input, stack };
    } catch (err) {
        // Never fatal. Falling behind on retention costs disk; failing the sync
        // over it costs the data the sync exists to collect.
        log.error('Retention pass failed:', err.message);
        return { input: 0, stack: 0 };
    }
}

// Size of one backfill chunk, and how long a single cycle may spend on the
// whole pass. The budget is what makes this safe to run inside a five-minute
// cron: the work is resumable to the row, so being interrupted costs nothing but
// the current chunk, and a replica with 500,000 historical rows catches up over
// a few cycles instead of stalling one of them for minutes.
const BACKFILL_CHUNK = Number(process.env.BACKFILL_CHUNK) || 2000;
const BACKFILL_BUDGET_MS = Number(process.env.BACKFILL_BUDGET_MS) || 20000;

const BACKFILL_KEY = 'backfill_009_cursor';

async function putSetting(key, value) {
    await localDb.execute(
        `INSERT INTO dashboard_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value]
    );
}

// The oldest execution n8n itself still has (F-04).
const SOURCE_HORIZON_KEY = 'source_oldest_execution_id';

/**
 * Records where n8n's pruning currently stands.
 *
 * F-04 needs to answer "how large is the n8n database and why", and the obvious
 * proxy — every local row that carries a payload size — is only correct for as
 * long as the backfill has just finished. This replica deliberately keeps
 * history that Postgres has already pruned, and it keeps those rows' sizes with
 * it. A month from now, today's executions will be gone from n8n while their
 * `jsonSizeBytes` sit here unchanged, and a "retained bytes" figure built from
 * them would report a store roughly twice the size of the real one, growing
 * forever, and be believed.
 *
 * So the prune horizon is asked for rather than inferred. `MIN(id)` on the
 * source's primary key is an index seek — the cheapest question available — and
 * it self-corrects every cycle as the sweep advances.
 *
 * Never throws. This is a refinement to one panel; a source that will not answer
 * it must not fail the cycle that just moved thousands of executions.
 */
async function recordSourceHorizon() {
    try {
        const r = await pool.query(
            'SELECT MIN(id) AS oldest FROM execution_entity WHERE "deletedAt" IS NULL'
        );
        const oldest = r.rows[0] && r.rows[0].oldest;
        if (oldest === null || oldest === undefined) return null;
        // int8 arrives as a string from node-postgres; stored as text either way.
        await putSetting(SOURCE_HORIZON_KEY, String(oldest));
        return String(oldest);
    } catch (err) {
        log.warn('Could not read the source prune horizon:', err.message);
        return null;
    }
}

/**
 * Fills the columns F-01 added on rows that were synced before it existed.
 *
 * Roughly 70,000 of this replica's 500,000 executions still exist in Postgres;
 * the rest were pruned long ago and their new columns stay NULL forever. That is
 * the honest outcome and the reason this pass needs a cursor rather than a
 * simple "WHERE mode IS NULL" loop: without one, every cycle from now until the
 * end of time would re-examine the 430,000 rows that can never be filled.
 *
 * `mode` is the sentinel. It is NOT NULL in n8n's schema, so a local row with a
 * NULL mode is one this pass has not reached — there is no third possibility to
 * confuse it with. If a source is old enough not to have the column at all the
 * pass does not run, because then the sentinel would mean nothing.
 *
 * Progress is committed per chunk, so a crash, a deploy or a lock handover
 * resumes from the last completed chunk rather than from the beginning.
 *
 * Never throws. This is catch-up work on data the dashboard already displays; it
 * must not be able to fail a cycle that collected today's executions.
 */
async function backfillMirroredColumns(plan) {
    const idle = { filled: 0, done: true };
    if (!plan.any || !plan.cols.some((c) => c.pg === 'mode')) return idle;

    try {
        const stored = await localDb.query(
            'SELECT value FROM dashboard_settings WHERE key = ?', [BACKFILL_KEY]
        );
        const state = stored.rows[0] ? stored.rows[0].value : null;
        if (state === 'done') return idle;

        let cursor = Number(state) || 0;
        const deadline = Date.now() + BACKFILL_BUDGET_MS;
        let filled = 0;
        let examined = 0;

        for (;;) {
            // Ordered by id and bounded by the cursor, so this is a forward walk
            // of the primary key rather than a scan of the whole table.
            const pending = await localDb.query(
                `SELECT id FROM execution_entity
                  WHERE id > ? AND mode IS NULL
                  ORDER BY id LIMIT ?`,
                [cursor, BACKFILL_CHUNK]
            );

            if (pending.rows.length === 0) {
                await putSetting(BACKFILL_KEY, 'done');
                // The scaffold comes down with the building. This index exists to
                // make the walk above cheap, and the walk happens once; left
                // behind it would hold an entry for every row Postgres has
                // already pruned — 404,632 of them here, 4.7 MB — to serve a
                // query that will never run again.
                await localDb.execute(
                    `DROP INDEX IF EXISTS ${TRANSIENT_INDEXES.mirrorBackfill}`);
                step('backfill',
                    `complete — ${filled} of ${examined} remaining rows filled this pass; ` +
                    'the rest are no longer in Postgres');
                return { filled, done: true };
            }

            const ids = pending.rows.map((r) => r.id);
            examined += ids.length;

            const src = await pool.query(
                `SELECT id${plan.select} FROM execution_entity WHERE id = ANY($1)`, [ids]
            );

            if (src.rows.length > 0) {
                await localDb.execute('BEGIN TRANSACTION');
                try {
                    await localDb.executeMany(
                        `UPDATE execution_entity SET ${plan.setList} WHERE id = ?`,
                        src.rows.map((e) => [...plan.values(e), e.id])
                    );
                    // The cursor moves inside the same transaction as the rows it
                    // describes. Committed separately, a crash between the two
                    // would either redo work or — far worse — skip it.
                    await putSetting(BACKFILL_KEY, String(ids[ids.length - 1]));
                    await localDb.execute('COMMIT');
                } catch (e) {
                    await localDb.execute('ROLLBACK');
                    throw e;
                }
                filled += src.rows.length;
            } else {
                await putSetting(BACKFILL_KEY, String(ids[ids.length - 1]));
            }

            cursor = ids[ids.length - 1];

            if (Date.now() >= deadline) {
                const left = await localDb.query(
                    'SELECT COUNT(*) AS n FROM execution_entity WHERE id > ? AND mode IS NULL',
                    [cursor]
                );
                step('backfill',
                    `paused at execution ${cursor} — ${filled} rows filled, ` +
                    `${left.rows[0].n} still to examine`);
                return { filled, done: false };
            }
        }
    } catch (err) {
        log.error('Backfill pass failed:', err.message);
        return { filled: 0, done: false };
    }
}

/**
 * Writes one row per ETL pass to sync_runs.
 *
 * The only record of the sync used to be console output, so "when did this last
 * succeed" and "how long has it been getting slower" could not be answered — and
 * the second question is the one that tells you a replica is outgrowing its box
 * before it stops fitting. Failures are recorded too, with their message; a
 * table that only holds successes cannot show a gap.
 *
 * Never throws. Bookkeeping must not be able to fail a sync that worked.
 */
const SYNC_RUN_HISTORY = Number(process.env.SYNC_RUN_HISTORY) || 500;

async function recordSyncRun(startedAt, startedHr, result) {
    try {
        const durationMs = Math.round(Number(process.hrtime.bigint() - startedHr) / 1e6);
        const a = result.analytics || {};
        const p = result.purged || {};

        let bytes = null;
        try {
            const page = await localDb.query('PRAGMA page_count');
            const size = await localDb.query('PRAGMA page_size');
            bytes = page.rows[0].page_count * size.rows[0].page_size;
        } catch (e) { /* size is a nicety, not a reason to lose the row */ }

        await localDb.execute(
            `INSERT INTO sync_runs
               (started_at, finished_at, duration_ms, status, workflows, executions, rows_read,
                errors, analytics_done, analytics_failed, analytics_queued, reclassified,
                purged_input, purged_stack, replica_bytes, error_message)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                startedAt.toISOString(), new Date().toISOString(), durationMs, result.status,
                result.workflows ?? null, result.executions ?? null, result.rowsRead ?? null,
                result.errors ?? null, a.processed ?? null, a.failed ?? null, a.remaining ?? null,
                result.reclassified ?? null, p.input ?? null, p.stack ?? null, bytes,
                result.error ?? null
            ]
        );

        // Bounded history. This table is written every five minutes forever, and
        // the point of it is trend over days, not a permanent archive.
        await localDb.execute(
            `DELETE FROM sync_runs WHERE id <= (
                 SELECT MAX(id) FROM sync_runs
             ) - ?`,
            [SYNC_RUN_HISTORY]
        );

        log.info(`ETL pass ${result.status}`, {
            ms: durationMs,
            executions: result.executions ?? 0,
            errors: result.errors ?? 0,
            replicaMb: bytes ? +(bytes / 1048576).toFixed(1) : undefined
        });
    } catch (err) {
        log.error('Could not record sync run:', err.message);
    }
}

// n8n's sharing tables changed shape when projects arrived: before that,
// shared_workflow pointed straight at a user. Probed the same way as the other
// version-sensitive tables, so the dashboard scopes correctly on both.
const getSharedWorkflowColumns = () => getTableColumns('shared_workflow');

/**
 * Mirrors n8n's authorization graph into the replica: projects, who belongs to
 * them, and which workflows they hold.
 *
 * Replaced wholesale rather than upserted, and that is the whole point. Every
 * other table here is append-mostly, so ON CONFLICT DO UPDATE is enough. Access
 * is not: removing someone from a project is expressed in Postgres by the row
 * *disappearing*, and an upsert-only sync can never observe a disappearance. A
 * revoked user would keep their access here forever, which is precisely the
 * failure this feature exists to prevent.
 *
 * The read happens before the transaction opens. If Postgres is unreachable the
 * replica keeps the membership it already had — stale, but stale-and-correct
 * beats empty, which under the fail-open rule in utils/scope.js would silently
 * widen everyone's access rather than narrow it.
 */
async function syncAuthorization() {
    try {
        const columns = await getSharedWorkflowColumns();
        if (columns.size === 0) {
            log.warn('No shared_workflow table in the source — authorization not mirrored.');
            return;
        }

        let projects = [];
        let relations = [];
        let shares = [];

        if (columns.has('projectId')) {
            const [p, r, s] = await Promise.all([
                pool.query('SELECT id, name, type FROM project'),
                pool.query('SELECT "projectId", "userId", role FROM project_relation'),
                pool.query('SELECT "workflowId", "projectId", role FROM shared_workflow')
            ]);
            projects = p.rows.map((x) => [x.id, x.name, x.type]);
            relations = r.rows.map((x) => [x.projectId, x.userId, x.role]);
            shares = s.rows.map((x) => [x.workflowId, x.projectId, x.role]);
        } else if (columns.has('userId')) {
            // Pre-projects n8n. Each user is given a synthetic project of their
            // own so the replica keeps one shape and the scoping query does not
            // need a second branch of its own.
            const s = await pool.query('SELECT "workflowId", "userId", role FROM shared_workflow');
            const userIds = new Set(s.rows.map((x) => x.userId));
            projects = [...userIds].map((u) => [`user:${u}`, `Personal (${u})`, 'personal']);
            relations = [...userIds].map((u) => [`user:${u}`, u, 'project:personalOwner']);
            shares = s.rows.map((x) => [x.workflowId, `user:${x.userId}`, x.role]);
        } else {
            log.warn('shared_workflow has neither projectId nor userId — authorization not mirrored.');
            return;
        }

        await localDb.execute('BEGIN TRANSACTION');
        try {
            await localDb.execute('DELETE FROM shared_workflow');
            await localDb.execute('DELETE FROM project_relation');
            await localDb.execute('DELETE FROM project');
            await localDb.executeMany(
                'INSERT INTO project (id, name, type) VALUES (?, ?, ?)', projects
            );
            await localDb.executeMany(
                'INSERT OR IGNORE INTO project_relation (project_id, user_id, role) VALUES (?, ?, ?)', relations
            );
            await localDb.executeMany(
                'INSERT OR IGNORE INTO shared_workflow (workflow_id, project_id, role) VALUES (?, ?, ?)', shares
            );
            await localDb.execute('COMMIT');
        } catch (e) {
            await localDb.execute('ROLLBACK');
            throw e;
        }

        invalidateScopeCache();
        step('authorization',
            `${projects.length} projects, ${relations.length} memberships, ` +
            `${shares.length} workflow shares`);
    } catch (err) {
        // Deliberately swallowed. Executions are the reason this job exists; a
        // membership refresh that failed this cycle will be retried in five
        // minutes, and until then the previous mapping still applies.
        log.error('Authorization sync failed:', err.message);
    }
}

/**
 * Recomputes the rolling 24-hour execution-volume series: how many executions
 * STARTED in each five-minute bucket.
 *
 * Not concurrency. Nothing here has ever measured how many ran at the same time,
 * and the old name (concurrency_stats.active_count) is what led the drill-down
 * behind this chart to be written against overlap instead of starts. Real
 * concurrency is F-06.
 *
 * Three things changed with the rename:
 *
 * 1. The counting happens in SQL. It used to pull every execution of the last 30
 *    hours into memory and then run a filter over the whole array once per
 *    bucket — 288 passes over N rows to produce 288 numbers. One GROUP BY does
 *    the same work in a single indexed range scan.
 *
 * 2. The query no longer carries `OR "stoppedAt" IS NULL`. That clause existed to
 *    catch long-running executions that overlapped the window, which only matters
 *    if you are measuring overlap; it also made the whole predicate unindexable,
 *    so this scanned the table every five minutes.
 *
 * 3. Only buckets whose value actually changed are written. The old code rewrote
 *    all 288 rows every cycle — roughly 83,000 row writes a day into the WAL to
 *    express, almost always, two changed numbers.
 */
async function updateExecutionVolumeStats() {
    const STEP_MS = 5 * 60 * 1000;
    const BUCKETS = 288;   // 24 hours

    try {
        // Bucket boundaries derived by UTC arithmetic. The previous version floored
        // the LOCAL minute field before converting, which happens to agree because
        // every real UTC offset is a multiple of five minutes — a coincidence, not
        // a reason.
        const newest = Math.floor(Date.now() / STEP_MS) * STEP_MS;
        const oldest = newest - (BUCKETS - 1) * STEP_MS;
        const oldestIso = new Date(oldest).toISOString();

        // Bucket index straight from the timestamp, so the grouping is the same
        // arithmetic the JS below uses to turn an index back into a boundary.
        const counted = await localDb.query(
            `SELECT CAST((julianday("startedAt") - julianday(?)) * 86400.0 / 300 AS INTEGER) AS bucket_idx,
                    COUNT(*) AS started_count
               FROM execution_entity
              WHERE "startedAt" >= ?
              GROUP BY bucket_idx`,
            [oldestIso, oldestIso]
        );
        const byIndex = new Map(counted.rows.map(r => [r.bucket_idx, r.started_count]));

        const existing = new Map(
            (await localDb.query(
                'SELECT timestamp, started_count FROM execution_volume_stats WHERE timestamp >= ?',
                [oldestIso]
            )).rows.map(r => [r.timestamp, r.started_count])
        );

        const changed = [];
        for (let i = 0; i < BUCKETS; i++) {
            const ts = new Date(oldest + i * STEP_MS).toISOString();
            const count = byIndex.get(i) || 0;
            if (existing.get(ts) !== count) changed.push([ts, count]);
        }

        await localDb.execute('BEGIN TRANSACTION');
        try {
            const dropped = await localDb.execute(
                'DELETE FROM execution_volume_stats WHERE timestamp < ?', [oldestIso]
            );
            await localDb.executeMany(
                'INSERT OR REPLACE INTO execution_volume_stats (timestamp, started_count) VALUES (?, ?)',
                changed
            );
            await localDb.execute('COMMIT');
            step('volume', `${changed.length} of ${BUCKETS} buckets changed` +
                `${dropped.changes ? `, ${dropped.changes} expired` : ''}`);
        } catch (e) {
            await localDb.execute('ROLLBACK');
            throw e;
        }
    } catch (err) {
        log.error('Execution volume update failed:', err.message);
    }
}

const SAVE_DEBUG_ERRORS = process.env.SAVE_DEBUG_ERRORS === 'true'; // Controlled by .env flag

/**
 * Re-classifies the stored errors once, when the classifier rules have changed.
 *
 * Runs inside the sync so it is covered by the ETL lock — this is a mass write to
 * the analytics table and two instances doing it at once is exactly the scenario
 * H-34 exists to prevent.
 *
 * Only the derived fields are rewritten. The raw trace fields (stack, input_data,
 * metadata) are never touched, so this is always safe to re-run and never loses
 * anything that cannot be recomputed.
 */
async function reclassifyIfNeeded() {
    const stored = await localDb.query(
        `SELECT value FROM dashboard_settings WHERE key = 'classifier_version'`
    );
    const current = stored.rows[0] ? Number(stored.rows[0].value) : 0;
    if (current === CLASSIFIER_VERSION) return { ran: false };

    log.info(`Classifier rules changed (v${current} -> v${CLASSIFIER_VERSION}). Re-classifying stored errors…`);

    const rows = await localDb.query(
        `SELECT id, error_message, error_type, error_stack, node_type, error_category, http_code, timestamp
           FROM execution_error_analytics`
    );

    let changed = 0;
    await localDb.execute('BEGIN TRANSACTION');
    try {
        for (const r of rows.rows) {
            const next = resolveError(r.error_message, r.error_type, r.error_stack, r.node_type, r.http_code);
            const old = r.error_message === null ? null : String(r.error_message);
            if (next.errorMessage === old &&
                next.errorType === (r.error_type || '') &&
                next.errorCategory === r.error_category) continue;

            // The fingerprint is derived from the message, so rewriting the
            // message without recomputing it would leave the row filed under the
            // identity of text it no longer contains — and the group it belonged
            // to would quietly gain a member that does not match it.
            const refp = fingerprintOf(next.errorMessage, r.node_type, next.errorType);
            await localDb.execute(
                `UPDATE execution_error_analytics
                    SET error_message = ?, error_type = ?, error_category = ?, fingerprint = ?
                  WHERE id = ?`,
                [next.errorMessage, next.errorType, next.errorCategory, refp.fingerprint, r.id]
            );
            await registerFingerprint(refp, next.errorMessage, r.node_type, next.errorType, r.timestamp);
            changed++;
        }

        // Stamped in the same transaction as the rows. Separately, a crash between
        // the two would either redo the whole pass or, worse, record it as done
        // when it was not.
        await localDb.execute(
            `INSERT INTO dashboard_settings (key, value) VALUES ('classifier_version', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            [String(CLASSIFIER_VERSION)]
        );
        await localDb.execute('COMMIT');
    } catch (e) {
        try { await localDb.execute('ROLLBACK'); } catch (err) { /* the caught error above is the one worth reporting */ }
        log.error('Re-classification failed, rolled back:', e.message);
        return { ran: false, error: e.message };
    }

    step('reclassify', `${changed} of ${rows.rows.length} stored errors rewritten`);
    return { ran: true, changed, total: rows.rows.length };
}

/**
 * Mirrors n8n's own per-workflow counters (F-09).
 *
 * One row per (workflow, event type) holding a count and the timestamp of the
 * most recent occurrence. Small — 175 rows on this instance — and replaced
 * wholesale, like the authorization mirror, because a workflow deleted upstream
 * should stop appearing here rather than linger.
 *
 * Its value is that it outlives pruning. Execution rows age out; these counters
 * do not, so a workflow whose entire history has been deleted still reports when
 * it last ran. That is the second opinion the silent-death detector needs: on
 * its own, "no executions in the replica" cannot distinguish a workflow that
 * stopped from one whose rows were simply pruned.
 *
 * Never throws. It is a cross-check for one panel, not a reason to fail a cycle
 * that has already moved thousands of executions.
 */
async function syncWorkflowStatistics() {
    try {
        const columns = await getTableColumns('workflow_statistics');
        if (columns.size === 0) return 0;

        const src = await pool.query(
            'SELECT "workflowId", name, count, "latestEvent" FROM workflow_statistics'
        );
        const rows = src.rows.map((r) => [
            r.workflowId, r.name, r.count === null ? null : Number(r.count), toSqlite(r.latestEvent)
        ]);

        await localDb.execute('BEGIN TRANSACTION');
        try {
            await localDb.execute('DELETE FROM workflow_statistics');
            await localDb.executeMany(
                `INSERT OR REPLACE INTO workflow_statistics (workflow_id, name, count, latest_event)
                 VALUES (?, ?, ?, ?)`,
                rows
            );
            await localDb.execute('COMMIT');
        } catch (e) {
            try { await localDb.execute('ROLLBACK'); } catch (ignored) { /* the log below matters */ }
            throw e;
        }
        return rows.length;
    } catch (err) {
        log.warn('Could not mirror workflow_statistics:', err.message);
        return 0;
    }
}

// ==========================================================================
// F-16 / F-10 / F-11 / F-18 · The organisational and dependency graph
// ==========================================================================

// Values longer than this are stored cut short. n8n's own layer already caps
// these at 512 characters, so in practice this bound matches rather than
// tightens it — it is here so the replica's promise does not depend on that
// staying true upstream. See the migration comment for why the column needs
// care at all.
const METADATA_VALUE_MAX = Number(process.env.METADATA_VALUE_MAX) || 512;

// An operator who would rather no business values were mirrored at all can say
// so. Keys are always kept: they describe what a workflow records, not what it
// recorded, and the dynamic filter list is built from them.
const SYNC_METADATA_VALUES = process.env.SYNC_METADATA_VALUES !== 'false';

/**
 * Mirrors one small source table wholesale.
 *
 * Replace-all rather than upsert, for the same reason the authorization mirror
 * does it: every table here expresses a *current* state, and a row disappearing
 * upstream is meaningful. A tag removed from a workflow, a folder deleted, a
 * credential revoked — an upsert-only sync can never observe any of those, and
 * would show them forever.
 *
 * Never throws. These feed panels, not the core; a source that will not answer
 * must not fail a cycle that has already moved thousands of executions.
 */
async function mirrorTable(sourceTable, localTable, columns, mapRow) {
    try {
        const available = await getTableColumns(sourceTable);
        if (available.size === 0) return 0;

        const missing = columns.filter((c) => !available.has(c));
        if (missing.length > 0) {
            log.warn(`${sourceTable} is missing ${missing.join(', ')} — not mirrored.`);
            return 0;
        }

        const quoted = columns.map((c) => `"${c}"`).join(', ');
        const src = await pool.query(`SELECT ${quoted} FROM "${sourceTable}"`);
        const rows = src.rows.map(mapRow).filter(Boolean);
        const placeholders = rows.length ? rows[0].map(() => '?').join(', ') : '';

        await localDb.execute('BEGIN TRANSACTION');
        try {
            await localDb.execute(`DELETE FROM ${localTable}`);
            if (rows.length > 0) {
                await localDb.executeMany(
                    `INSERT OR REPLACE INTO ${localTable} VALUES (${placeholders})`, rows
                );
            }
            await localDb.execute('COMMIT');
        } catch (e) {
            try { await localDb.execute('ROLLBACK'); } catch (ignored) { /* the log below matters */ }
            throw e;
        }
        return rows.length;
    } catch (err) {
        log.warn(`Could not mirror ${sourceTable}:`, err.message);
        return 0;
    }
}

/**
 * Everything organisational, in one pass.
 *
 * Six tables totalling a few thousand rows against half a million executions, so
 * the cost is noise; they are grouped because they are read together and because
 * one failure among them should not look like six.
 */
async function syncOrganisation() {
    const folders = await mirrorTable(
        'folder', 'folder',
        ['id', 'name', 'parentFolderId', 'projectId', 'createdAt', 'updatedAt'],
        (r) => [r.id, r.name, r.parentFolderId, r.projectId,
            toSqlite(r.createdAt), toSqlite(r.updatedAt)]
    );

    const tags = await mirrorTable(
        'tag_entity', 'tag_entity', ['id', 'name'], (r) => [r.id, r.name]
    );

    const workflowTags = await mirrorTable(
        'workflows_tags', 'workflows_tags', ['workflowId', 'tagId'],
        (r) => [r.workflowId, r.tagId]
    );

    // F-11. `nodes` and `connections` are excluded by not being named here — they
    // are the workflow definition itself, and nothing in this dashboard renders
    // one.
    const history = await mirrorTable(
        'workflow_history', 'workflow_history',
        ['versionId', 'workflowId', 'authors', 'name', 'autosaved', 'createdAt'],
        (r) => [r.versionId, r.workflowId, r.authors, r.name,
            toSqlite(r.autosaved), toSqlite(r.createdAt)]
    );

    // F-10. dependencyInfo is a JSON object holding n8n's node id and version;
    // only the node id is kept, because that is what lets a dependency be traced
    // back to a specific node in the editor.
    const dependencies = await mirrorTable(
        'workflow_dependency', 'workflow_dependency',
        ['id', 'workflowId', 'workflowVersionId', 'publishedVersionId',
            'dependencyType', 'dependencyKey', 'dependencyInfo', 'createdAt'],
        (r) => [r.id, r.workflowId, r.workflowVersionId, r.publishedVersionId,
            r.dependencyType, r.dependencyKey,
            (r.dependencyInfo && r.dependencyInfo.nodeId) || null,
            toSqlite(r.createdAt)]
    );

    // F-10's other half. `data` is not in this list and must never be: it is the
    // encrypted credential blob.
    const credentials = await mirrorTable(
        'credentials_entity', 'credentials_entity',
        ['id', 'name', 'type', 'isManaged', 'createdAt', 'updatedAt'],
        (r) => [r.id, r.name, r.type, toSqlite(r.isManaged),
            toSqlite(r.createdAt), toSqlite(r.updatedAt)]
    );

    // F-18.
    const metadata = await mirrorTable(
        'execution_metadata', 'execution_metadata',
        ['id', 'executionId', 'key', 'value'],
        (r) => {
            const raw = r.value === null || r.value === undefined ? null : String(r.value);
            if (!SYNC_METADATA_VALUES) return [r.id, r.executionId, r.key, null, 0];
            const truncated = raw !== null && raw.length > METADATA_VALUE_MAX;
            return [r.id, r.executionId, r.key,
                truncated ? raw.slice(0, METADATA_VALUE_MAX) : raw, truncated ? 1 : 0];
        }
    );

    step('organisation',
        `${folders} folders, ${tags} tags, ${workflowTags} workflow tags, ${history} versions, ` +
        `${dependencies} dependencies, ${credentials} credentials, ${metadata} metadata rows`);
    return { folders, tags, workflowTags, history, dependencies, credentials, metadata };
}

// ==========================================================================
// F-07 · Fingerprints
// ==========================================================================

const FP_CURSOR_KEY = 'fingerprint_cursor';
const FP_VERSION_KEY = 'fingerprint_version';

// Same shape and reasoning as the F-01 backfill: chunked so a crash costs one
// chunk, time-boxed so today's data is never starved by history.
const FP_CHUNK = Number(process.env.FINGERPRINT_CHUNK) || 2000;
const FP_BUDGET_MS = Number(process.env.FINGERPRINT_BUDGET_MS) || 10000;

/**
 * Ensures a fingerprint has a row of its own.
 *
 * The row holds what cannot be derived: when the problem was first seen, and
 * whatever a human has since decided about it. Counts are deliberately absent —
 * they are one GROUP BY away in execution_error_analytics, and a stored copy is
 * a second source of truth for the same number.
 *
 * `first_seen` takes the MIN of what is stored and what is arriving, because the
 * backfill walks the table in id order while the ETL writes newest-first, so
 * this is routinely reached with an older timestamp after a newer one.
 */
async function registerFingerprint(fp, sampleMessage, nodeType, errorType, seenAt,
    { reopenIfResolved = false } = {}) {
    const when = seenAt || new Date().toISOString();
    const sample = sampleMessage === null || sampleMessage === undefined
        ? null : String(sampleMessage).slice(0, 2000);
    await localDb.execute(
        `INSERT INTO error_fingerprints
             (fingerprint, normalized_message, sample_message, node_type, error_type,
              first_seen, status, version)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
         ON CONFLICT(fingerprint) DO UPDATE SET
             first_seen = MIN(error_fingerprints.first_seen, excluded.first_seen),
             normalized_message = excluded.normalized_message,
             version = excluded.version`,
        [fp.fingerprint, fp.normalized, sample, nodeType || null, errorType || null,
            when, FINGERPRINT_VERSION]
    );

    // F-15 auto-reopen. A problem someone marked resolved and which then happened
    // again is not resolved, and leaving it closed is how a dashboard stops being
    // believed. Guarded on the occurrence being NEWER than the resolution, so the
    // backfill walking years of history cannot reopen everything ever closed —
    // and skipped outright during that walk, since none of those rows is news.
    if (!reopenIfResolved) return;
    const reopened = await localDb.execute(
        `UPDATE error_fingerprints
            SET status = 'open', status_at = ?, status_by = NULL
          WHERE fingerprint = ? AND status = 'resolved' AND ? > IFNULL(status_at, '')`,
        [when, fp.fingerprint, when]
    );
    if (reopened.changes > 0) {
        await localDb.execute(
            `INSERT INTO fingerprint_events (fingerprint, at, action, actor, note)
             VALUES (?, ?, 'reopened', NULL, ?)`,
            [fp.fingerprint, when, 'Reopened automatically: it happened again after being resolved.']
        );
        log.info(`Fingerprint ${fp.fingerprint} reopened — it recurred after being resolved.`);
    }
}

/**
 * Fingerprints the errors stored before fingerprinting existed, and
 * re-fingerprints everything when the rules change.
 *
 * One pass serves both, because they are the same walk. A version bump resets
 * the cursor to the beginning; ordinary operation resumes where it stopped. New
 * errors never need this — they are fingerprinted as they are inserted — so in
 * the steady state the cursor sits at 'done' and this costs one settings read
 * per cycle.
 *
 * Recomputing rather than skipping non-null rows on a version bump is the whole
 * point: a normalisation change that applied only to new errors would split
 * every historical group in two and leave the history disagreeing with the
 * present.
 */
async function backfillFingerprints() {
    // Called both from the ETL pass (already holding the gate — exclusive() is
    // reentrant, so this is a straight call) and from its own timer, where it
    // has to wait for a pass that may be mid-transaction.
    return localDb.exclusive(runFingerprintBackfill);
}

/**
 * Rows that still carry no fingerprint, and the lowest of them.
 *
 * Served by idx_err_fingerprint: NULLs sort first, so this scans only the rows
 * it finds and costs nothing once there are none — which is the steady state.
 */
async function unfingerprinted() {
    const r = await localDb.query(
        'SELECT MIN(id) AS lo, COUNT(*) AS n FROM execution_error_analytics ' +
        'WHERE fingerprint IS NULL'
    );
    return r.rows[0];
}

async function runFingerprintBackfill() {
    const versionRow = await localDb.query(
        'SELECT value FROM dashboard_settings WHERE key = ?', [FP_VERSION_KEY]
    );
    const storedVersion = versionRow.rows[0] ? Number(versionRow.rows[0].value) : 0;

    if (storedVersion !== FINGERPRINT_VERSION) {
        log.info(
            `Fingerprint rules changed (v${storedVersion} -> v${FINGERPRINT_VERSION}). ` +
            'Recomputing stored fingerprints...'
        );
        // Both in one transaction: a crash between them would either redo the
        // reset forever, or record the new version over a half-walked table.
        await localDb.execute('BEGIN TRANSACTION');
        try {
            await putSetting(FP_CURSOR_KEY, '0');
            await putSetting(FP_VERSION_KEY, String(FINGERPRINT_VERSION));
            await localDb.execute('COMMIT');
        } catch (e) {
            try { await localDb.execute('ROLLBACK'); } catch (ignored) { /* the throw below matters */ }
            throw e;
        }
    }

    const cursorRow = await localDb.query(
        'SELECT value FROM dashboard_settings WHERE key = ?', [FP_CURSOR_KEY]
    );
    const stored = cursorRow.rows[0] ? cursorRow.rows[0].value : '0';

    let cursor;
    if (stored === 'done') {
        // 'done' means the walk reached the end once. It does not mean the table
        // is complete, and the difference is not academic: a half-applied chunk
        // leaves rows below the cursor that nothing would ever revisit. Checked
        // every cycle because the check is free when there is nothing to find.
        const missed = await unfingerprinted();
        if (missed.n === 0) return { done: true, filled: 0 };
        log.warn(
            `${missed.n} error rows are unfingerprinted below a finished cursor. ` +
            `Rewinding to ${missed.lo} to repair them.`
        );
        cursor = missed.lo - 1;
    } else {
        cursor = Number(stored) || 0;
    }
    let filled = 0;
    const deadline = Date.now() + FP_BUDGET_MS;

    while (Date.now() < deadline) {
        const pending = await localDb.query(
            `SELECT id, error_message, node_type, error_type, timestamp
               FROM execution_error_analytics
              WHERE id > ?
              ORDER BY id
              LIMIT ?`,
            [cursor, FP_CHUNK]
        );

        if (pending.rows.length === 0) {
            // The cursor is an optimisation, not a proof.
            //
            // It records how far the walk got, and everything below it is
            // assumed finished — so a chunk that half-applied leaves rows that
            // nothing will ever look at again. That is not hypothetical: the
            // transaction collision between this pass and the ETL (see
            // localDb.exclusive) left 1,149 rows unfingerprinted in the middle
            // of the table, under a cursor that had moved on past them.
            //
            // So the end of the walk is verified rather than declared. If
            // anything is still null, the cursor rewinds to just before it and
            // the walk continues. This terminates: fingerprintOf always returns
            // a value, so every sweep strictly reduces the count.
            const missed = await unfingerprinted();
            if (missed.n > 0) {
                log.warn(
                    `Fingerprint walk reached the end with ${missed.n} rows still ` +
                    `unfingerprinted. Rewinding to ${missed.lo} to repair them.`
                );
                cursor = missed.lo - 1;
                await putSetting(FP_CURSOR_KEY, String(cursor));
                continue;
            }

            await putSetting(FP_CURSOR_KEY, 'done');
            // The scaffold comes down with the building — and only this one. The
            // other transient index belongs to a different backfill that may not
            // have finished, which is exactly the bug a shared list produced.
            await localDb.execute(
                `DROP INDEX IF EXISTS ${TRANSIENT_INDEXES.fingerprintBackfill}`);
            step('fingerprints', `complete — ${filled} rows written this pass`);
            return { done: true, filled };
        }

        await localDb.execute('BEGIN TRANSACTION');
        try {
            for (const r of pending.rows) {
                const fp = fingerprintOf(r.error_message, r.node_type, r.error_type);
                await localDb.execute(
                    'UPDATE execution_error_analytics SET fingerprint = ? WHERE id = ?',
                    [fp.fingerprint, r.id]
                );
                await registerFingerprint(fp, r.error_message, r.node_type, r.error_type, r.timestamp);
                filled++;
            }
            cursor = pending.rows[pending.rows.length - 1].id;
            // The cursor is committed with the rows it describes. Separately, a
            // crash between the two either redoes work or, far worse, skips it.
            await putSetting(FP_CURSOR_KEY, String(cursor));
            await localDb.execute('COMMIT');
        } catch (e) {
            try { await localDb.execute('ROLLBACK'); } catch (ignored) { /* the throw below matters */ }
            throw e;
        }
    }

    step('fingerprints', `paused at ${cursor} — ${filled} rows this pass`);
    return { done: false, filled, cursor };
}

// F-12 · node profiling.
//
// How many executions to read per workflow, how often to re-read a workflow,
// and how long one cycle may spend on the whole thing.
//
// The sample size is small on purpose. Node timings on this instance are
// dominated by one node per workflow by a factor of ten or more — 21.6 s of a
// 23.2 s execution in the worst case — so five samples separate the bottleneck
// from everything else comfortably, while fifty would multiply the bytes pulled
// out of Postgres for a sharper number nobody needs.
const PROFILE_SAMPLES = Number(process.env.PROFILE_SAMPLES) || 5;
const PROFILE_INTERVAL_MS = (Number(process.env.PROFILE_INTERVAL_HOURS) || 24) * 3600000;
const PROFILE_BUDGET_MS = Number(process.env.PROFILE_BUDGET_MS) || 15000;
const PROFILE_WORKFLOWS_PER_PASS = Number(process.env.PROFILE_WORKFLOWS_PER_PASS) || 6;

/**
 * Builds a per-node time and item profile for a few workflows each cycle.
 *
 * This is the only place in the codebase that reads execution payloads it was
 * not already going to read. Everything else fetches a trace because an
 * execution failed; this fetches successful ones, because "which node is slow"
 * cannot be answered from the failures — the failing node stops early and the
 * rest never run.
 *
 * Four things keep that affordable:
 *
 *   - **A sample, not a census.** PROFILE_SAMPLES executions per workflow.
 *   - **Staleness-ordered.** The workflow profiled longest ago goes first, so a
 *     pass that runs out of budget has still made progress on the oldest data
 *     rather than refreshing the same workflow forever.
 *   - **Only what changed.** A workflow with no execution newer than the one it
 *     was last profiled against is skipped entirely — no query, no bytes.
 *   - **Oversized traces are excluded by Postgres**, not by this process: the
 *     length test is in the SELECT, so a 200 MB payload is never transferred to
 *     be measured and thrown away. Same guard the error extractor uses.
 *
 * Never throws. Profiling is a refinement to one panel; a cycle that moved
 * thousands of executions must not fail because a trace would not parse.
 */
async function profileWorkflowNodes() {
    const deadline = Date.now() + PROFILE_BUDGET_MS;
    const staleBefore = new Date(Date.now() - PROFILE_INTERVAL_MS).toISOString();

    try {
        // Chosen from the replica, which already knows every workflow's newest
        // execution. Asking Postgres this would be a second round trip for
        // something mirrored five lines earlier in the same pass.
        const candidates = await localDb.query(
            `SELECT w.id, w.name, MAX(e.id) AS newest, COUNT(e.id) AS runs,
                    p.sampled_at, p.newest_execution_id
               FROM workflow_entity w
               JOIN execution_entity e ON e."workflowId" = w.id
               LEFT JOIN workflow_profile_state p ON p.workflow_id = w.id
              WHERE IFNULL(w."isArchived", 0) = 0
                AND e.status = 'success'
              GROUP BY w.id
             HAVING p.sampled_at IS NULL
                 OR (p.sampled_at < ? AND MAX(e.id) > IFNULL(p.newest_execution_id, 0))
              ORDER BY IFNULL(p.sampled_at, '') ASC, runs DESC
              LIMIT ?`,
            [staleBefore, PROFILE_WORKFLOWS_PER_PASS]
        );

        if (candidates.rows.length === 0) return { profiled: 0, nodes: 0 };

        let profiled = 0;
        let nodeRows = 0;

        for (const wf of candidates.rows) {
            if (Date.now() > deadline) {
                step('profiling', `paused — ${profiled} workflows this pass, budget spent`);
                break;
            }

            // Successful executions only, newest first. A failed one stops at
            // the broken node, so including them would make every node after it
            // look like it never runs.
            const ids = await localDb.query(
                `SELECT id FROM execution_entity
                  WHERE "workflowId" = ? AND status = 'success'
                  ORDER BY id DESC LIMIT ?`,
                [wf.id, PROFILE_SAMPLES]
            );
            if (ids.rows.length === 0) continue;

            const idList = ids.rows.map((r) => r.id);
            let traces;
            try {
                traces = await pool.query(
                    `SELECT d."executionId" AS exec_id,
                            CASE WHEN octet_length(d.data) > $2 THEN NULL ELSE d.data END AS data,
                            EXTRACT(EPOCH FROM (e."stoppedAt" - e."startedAt")) * 1000 AS wall_ms
                       FROM execution_data d
                       JOIN execution_entity e ON e.id = d."executionId"
                      WHERE d."executionId" = ANY($1::int[])`,
                    [idList, MAX_PAYLOAD_BYTES]
                );
            } catch (err) {
                log.warn(`Could not fetch traces for ${wf.name}:`, err.message);
                continue;
            }

            // node name -> aggregate across the sample
            const agg = new Map();
            // "from|to" -> item counts across the sample
            const edges = new Map();
            let sampled = 0;
            let unreadable = 0;
            let nodeMs = 0;
            let wallMs = 0;

            for (const row of traces.rows) {
                if (!row.data) { unreadable++; continue; }
                let summary;
                try {
                    summary = summariseTrace(parse(row.data), Math.round(row.wall_ms || 0));
                } catch (err) { unreadable++; continue; }
                if (!summary.has_run_data) { unreadable++; continue; }

                sampled++;
                nodeMs += summary.total_node_ms;
                wallMs += summary.wall_ms || 0;

                for (const n of summary.nodes) {
                    const cur = agg.get(n.name) || {
                        samples: 0, runs: 0, total_ms: 0, max_ms: 0,
                        items_out: null, failed_runs: 0, is_sub_node: n.is_sub_node,
                        node_type: n.type
                    };
                    cur.samples++;
                    cur.runs += n.runs;
                    cur.total_ms += n.ms;
                    cur.max_ms = Math.max(cur.max_ms, n.ms);
                    cur.failed_runs += n.failed_runs;
                    if (n.items_out !== null) cur.items_out = (cur.items_out || 0) + n.items_out;
                    // Once a node has been seen writing to main it is not a sub
                    // node, whatever a later run without output suggests.
                    if (!n.is_sub_node) cur.is_sub_node = false;
                    if (!cur.node_type && n.type) cur.node_type = n.type;
                    agg.set(n.name, cur);
                }

                for (const e of summary.flow) {
                    const key = `${e.from}\u0000${e.to}`;
                    const cur = edges.get(key) ||
                        { from: e.from, to: e.to, samples: 0, runs: 0, items_in: 0, items_out: 0 };
                    cur.samples++;
                    cur.runs += e.runs;
                    cur.items_in += e.items_in;
                    cur.items_out += e.items_out;
                    edges.set(key, cur);
                }
            }

            // Replaced, not merged: the profile is "the last N executions", and
            // merging would blend the workflow as it is with the workflow as it
            // was before someone fixed it — with nothing on screen to say so.
            await localDb.exclusive(async () => {
                await localDb.execute('BEGIN TRANSACTION');
                try {
                    await localDb.execute(
                        'DELETE FROM workflow_node_profile WHERE workflow_id = ?', [wf.id]);
                    await localDb.execute(
                        'DELETE FROM workflow_edge_profile WHERE workflow_id = ?', [wf.id]);
                    for (const e of edges.values()) {
                        await localDb.execute(
                            `INSERT INTO workflow_edge_profile
                                (workflow_id, from_node, to_node, samples, runs, items_in, items_out)
                             VALUES (?,?,?,?,?,?,?)`,
                            [wf.id, e.from, e.to, e.samples, e.runs, e.items_in, e.items_out]
                        );
                    }
                    for (const [name, a] of agg) {
                        await localDb.execute(
                            `INSERT INTO workflow_node_profile
                                (workflow_id, node_name, samples, runs, total_ms, max_ms,
                                 items_out, failed_runs, is_sub_node, node_type)
                             VALUES (?,?,?,?,?,?,?,?,?,?)`,
                            [wf.id, name, a.samples, a.runs, Math.round(a.total_ms),
                                Math.round(a.max_ms), a.items_out, a.failed_runs,
                                a.is_sub_node ? 1 : 0, a.node_type]
                        );
                        nodeRows++;
                    }
                    // Written even when the sample produced nothing readable.
                    // Otherwise a workflow whose traces never parse is retried
                    // on every cycle for the life of the deployment.
                    await localDb.execute(
                        `INSERT INTO workflow_profile_state
                            (workflow_id, sampled_at, executions_sampled, executions_unreadable,
                             newest_execution_id, total_node_ms, total_wall_ms)
                         VALUES (?,?,?,?,?,?,?)
                         ON CONFLICT(workflow_id) DO UPDATE SET
                            sampled_at = excluded.sampled_at,
                            executions_sampled = excluded.executions_sampled,
                            executions_unreadable = excluded.executions_unreadable,
                            newest_execution_id = excluded.newest_execution_id,
                            total_node_ms = excluded.total_node_ms,
                            total_wall_ms = excluded.total_wall_ms`,
                        [wf.id, new Date().toISOString(), sampled, unreadable,
                            idList[0], Math.round(nodeMs), Math.round(wallMs)]
                    );
                    await localDb.execute('COMMIT');
                } catch (err) {
                    try { await localDb.execute('ROLLBACK'); } catch (ignored) { /* the log below matters */ }
                    throw err;
                }
            });

            profiled++;
        }

        if (profiled > 0) {
            step('profiling', `${profiled} workflow(s), ${nodeRows} node rows`);
        }
        return { profiled, nodes: nodeRows };
    } catch (err) {
        log.error('Node profiling failed:', err.message);
        return { profiled: 0, nodes: 0, error: err.message };
    }
}

/**
 * Records that these executions need their error detail extracted.
 *
 * Marking is cheap and separate from doing the work on purpose: whatever happens
 * to this process afterwards, the intent survives in the database.
 */
async function enqueueForAnalytics(ids) {
    if (!ids || ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    await localDb.execute(
        `UPDATE execution_entity
            SET analytics_status = 'pending', analytics_attempts = 0, analytics_next_attempt = NULL
          WHERE id IN (${placeholders})`,
        ids
    );
}

/**
 * Drains up to ERROR_BATCH_LIMIT of the queue, in chunks.
 *
 * Everything that used to make this fragile is handled here: work is bounded per
 * cycle, payloads are fetched in small batches rather than one enormous join,
 * failures are retried with backoff instead of vanishing, and an execution that
 * keeps failing is eventually parked rather than retried forever.
 */
async function processAnalyticsQueue() {
    const due = await localDb.query(
        `SELECT id FROM execution_entity
          WHERE analytics_status = 'pending'
            AND (analytics_next_attempt IS NULL OR analytics_next_attempt <= ?)
          ORDER BY id DESC
          LIMIT ?`,
        [new Date().toISOString(), ERROR_BATCH_LIMIT]
    );

    const ids = due.rows.map(r => r.id);
    if (ids.length === 0) return { processed: 0, failed: 0, remaining: 0 };

    let processed = 0;
    let failed = 0;

    for (let i = 0; i < ids.length; i += ERROR_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + ERROR_CHUNK_SIZE);
        const result = await syncErrorAnalytics(chunk);
        processed += result.done;
        failed += result.failed;
    }

    const left = await localDb.query(
        `SELECT COUNT(*) AS n FROM execution_entity WHERE analytics_status = 'pending'`
    );
    const remaining = left.rows[0].n;

    step('analytics',
        `${processed} extracted, ${failed} failed, ${remaining} still queued`);
    return { processed, failed, remaining };
}

/**
 * Extracts error detail for one chunk of execution ids.
 *
 * Returns counts rather than throwing, because the caller is draining a queue —
 * one bad chunk must not abandon the rest.
 */
async function syncErrorAnalytics(errorIdsArray) {
    if (!errorIdsArray || errorIdsArray.length === 0) return { done: 0, failed: 0 };

    const markFailed = async (ids, reason) => {
        for (const id of ids) {
            const cur = await localDb.query(
                'SELECT analytics_attempts AS a FROM execution_entity WHERE id = ?', [id]
            );
            const attempts = (cur.rows[0] ? cur.rows[0].a : 0) + 1;
            if (attempts >= MAX_ANALYTICS_ATTEMPTS) {
                await localDb.execute(
                    `UPDATE execution_entity SET analytics_status = 'failed', analytics_attempts = ? WHERE id = ?`,
                    [attempts, id]
                );
                log.warn(`Giving up on analytics for execution ${id} after ${attempts} attempts (${reason}).`);
            } else {
                await localDb.execute(
                    `UPDATE execution_entity
                        SET analytics_attempts = ?, analytics_next_attempt = ?
                      WHERE id = ?`,
                    [attempts, backoffFor(attempts), id]
                );
            }
        }
    };

    let result;
    try {
        // octet_length is evaluated by Postgres, so an oversized trace is measured
        // without ever being sent. Selecting it and checking here would mean
        // pulling the very payload we are trying to avoid.
        const query = `
            SELECT
                CASE WHEN octet_length(d.data) > $2 THEN NULL ELSE d.data END AS data,
                octet_length(d.data) AS data_bytes,
                e."workflowId" AS workflow_id, e."startedAt", e.id as exec_id
            FROM execution_data d
            JOIN execution_entity e ON d."executionId" = e.id
            WHERE d."executionId" = ANY($1)
        `;
        result = await pool.query(query, [errorIdsArray, MAX_PAYLOAD_BYTES]);
    } catch (e) {
        // The whole chunk failed — a timeout, a dropped connection. Retry later.
        log.error(`Payload fetch failed for ${errorIdsArray.length} errors:`, e.message);
        await markFailed(errorIdsArray, e.message);
        return { done: 0, failed: errorIdsArray.length };
    }

    // Anything Postgres did not return no longer exists there — pruned before we
    // got to it. Retrying cannot help, so park it rather than churn every cycle.
    const returned = new Set(result.rows.map(r => r.exec_id));
    const vanished = errorIdsArray.filter(id => !returned.has(id));
    if (vanished.length > 0) {
        const placeholders = vanished.map(() => '?').join(',');
        await localDb.execute(
            `UPDATE execution_entity SET analytics_status = 'failed' WHERE id IN (${placeholders})`,
            vanished
        );
        log.warn(`${vanished.length} error payloads no longer exist in Postgres — pruned before extraction.`);
    }

    const succeeded = [];
    const oversized = [];

    try {
        const analyticsData = [];

        await localDb.execute('BEGIN TRANSACTION');

        for (const row of result.rows) {
            const dataStr = row.data;
            if (!dataStr) {
                if (row.data_bytes > MAX_PAYLOAD_BYTES) {
                    oversized.push({ id: row.exec_id, bytes: row.data_bytes });
                } else {
                    succeeded.push(row.exec_id);   // genuinely empty, nothing to extract
                }
                continue;
            }

            let fullData;
            try {
                // n8n compresses or stores execution data weirdly depending on version, parsing safely
                fullData = typeof dataStr === 'string' ? parse(dataStr) : dataStr;
                if (fullData && typeof fullData === 'object' && fullData.data) {
                    if (typeof fullData.data === 'string') {
                        // Some versions base64 encode or double json stringify
                        try { fullData = parse(fullData.data); } catch (e) { /* not doubly-encoded; keep what we have */ }
                    }
                }
            } catch (e) {
                // Left in the queue deliberately, not silently dropped: it gets a
                // backoff and a bounded number of retries, and if the trace is
                // simply unparseable it ends up 'failed' where it can be counted.
                log.error(`Failed to parse data for execution ${row.exec_id}`);
                continue;
            }

            // Raw candidates, straight from the trace. They are reconciled against
            // the stack below rather than being trusted as-is.
            let rawMessage = "";
            let rawType = "";
            let httpCode = null;
            let nodeName = "Unknown Node";
            let nodeType = "Unknown Type";
            let nodeId = "";
            let errorStack = "";
            let sourceNode = "";
            let sourceOutputIndex = null;
            let executionSource = "";
            let inputData = "";
            let metadataJson = "";

            if (fullData && fullData.resultData) {
                const rootErr = fullData.resultData.error;
                rawMessage = rootErr?.description || rootErr?.message || "";
                nodeName = fullData.resultData.lastNodeExecuted || rootErr?.node?.name || nodeName;
                nodeType = rootErr?.node?.type || nodeType;
                nodeId = rootErr?.node?.id || "";
                rawType = rootErr?.name || "";
                errorStack = rootErr?.stack || "";
                httpCode = extractHttpCode(rootErr);

                // Try to find executionSource
                executionSource = fullData.executionData?.runtimeData?.source || "";

                // Extract metadata
                if (fullData.executionData?.metadata) {
                    try { metadataJson = JSON.stringify(fullData.executionData.metadata); } catch (e) { /* circular or unserialisable metadata is optional detail */ }
                }

                // Attempt to find the source node and branch
                if (fullData.executionData?.nodeExecutionStack) {
                    const stack = fullData.executionData.nodeExecutionStack;
                    if (stack && stack.length > 0) {
                        const lastFrame = stack[stack.length - 1];

                        // Grab input data that led to the crash
                        if (lastFrame?.data) {
                            try { inputData = JSON.stringify(lastFrame.data); } catch (e) { /* circular or unserialisable payload is optional detail */ }
                        }

                        if (lastFrame?.source?.main && lastFrame.source.main.length > 0) {
                            const sourceObj = lastFrame.source.main[0];
                            if (sourceObj) {
                                sourceNode = sourceObj.previousNode || "";
                                sourceOutputIndex = sourceObj.previousNodeOutput !== undefined ? sourceObj.previousNodeOutput : null;
                            }
                        }
                    }
                }
            } else if (fullData && fullData[0]) {
                const root = fullData[0];
                // `root.message` used to sit at the end of this chain. It is not an
                // error message — on this shape it is whatever unrelated property
                // happens to be named `message`, which is how unrelated strings ended
                // up stored as error text. Removed: better an empty message we can
                // detect than a wrong one we cannot.
                rawMessage = root.resultData?.error?.description || root.resultData?.error?.message
                    || root.error?.description || root.error?.message || "";
                nodeName = root.resultData?.lastNodeExecuted || root.resultData?.error?.node?.name || root.error?.node?.name || nodeName;
                nodeType = root.resultData?.error?.node?.type || root.error?.node?.type || nodeType;
                nodeId = root.resultData?.error?.node?.id || root.error?.node?.id || "";
                rawType = root.resultData?.error?.name || root.error?.name || "";
                errorStack = root.resultData?.error?.stack || root.error?.stack || "";
                httpCode = extractHttpCode(root.resultData?.error) ?? extractHttpCode(root.error);

                executionSource = root.executionData?.runtimeData?.source || "";
                if (root.executionData?.metadata) {
                    try { metadataJson = JSON.stringify(root.executionData.metadata); } catch (e) { /* circular or unserialisable metadata is optional detail */ }
                }

                if (root.executionData?.nodeExecutionStack) {
                    const lastFrame = root.executionData.nodeExecutionStack[root.executionData.nodeExecutionStack.length - 1];
                    if (lastFrame?.data) {
                        try { inputData = JSON.stringify(lastFrame.data); } catch (e) { /* circular or unserialisable payload is optional detail */ }
                    }
                }
            }

            // Fallback for timestamp
            const startedStr = row.startedAt ? row.startedAt.toISOString() : new Date().toISOString();

            // Reconcile against the stack before classifying — classifying the raw
            // candidate is exactly what produced the 3.643 'unknown' rows.
            const { errorType, errorMessage, errorCategory } =
                resolveError(rawMessage, rawType, errorStack, nodeType, httpCode);

            // F-07. Computed here rather than derived at read time: the read
            // path groups on it, and a GROUP BY over a normalisation function
            // cannot use an index.
            const fp = fingerprintOf(errorMessage, nodeType, errorType);

            const payload = {
                id: row.exec_id,
                workflow_id: row.workflow_id,
                node_id: nodeId,
                node_name: nodeName,
                node_type: nodeType,
                error_type: errorType,
                error_message: errorMessage,
                error_stack: errorStack,
                source_node: sourceNode,
                source_output: sourceOutputIndex,
                input_data: inputData,
                metadata: metadataJson,
                execution_source: executionSource,
                error_category: errorCategory,
                http_code: httpCode,
                fingerprint: fp.fingerprint,
                started_at: startedStr
            };

            // For debug purposes, add the raw data to the export list if flag is on
            if (SAVE_DEBUG_ERRORS) {
                analyticsData.push({ ...payload, rawTrace: fullData });
            } else {
                analyticsData.push(payload);
            }

            // Insert into SQLite
            await localDb.execute(
                `INSERT INTO execution_error_analytics
                 (id, workflow_id, node_id, node_name, node_type, error_type, error_message, error_stack, source_node, source_output_index, input_data, metadata, execution_source, error_category, http_code, fingerprint, timestamp)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                 node_id=excluded.node_id,
                 node_name=excluded.node_name,
                 node_type=excluded.node_type,
                 error_type=excluded.error_type,
                 error_message=excluded.error_message,
                 error_stack=excluded.error_stack,
                 source_node=excluded.source_node,
                 source_output_index=excluded.source_output_index,
                 input_data=excluded.input_data,
                 metadata=excluded.metadata,
                 execution_source=excluded.execution_source,
                 error_category=excluded.error_category,
                 fingerprint=excluded.fingerprint,
                 http_code=COALESCE(excluded.http_code, execution_error_analytics.http_code)`,
                [
                    row.exec_id,
                    row.workflow_id,
                    nodeId,
                    nodeName,
                    nodeType,
                    errorType,
                    errorMessage,
                    errorStack,
                    sourceNode,
                    sourceOutputIndex,
                    inputData,
                    metadataJson,
                    executionSource,
                    errorCategory,
                    httpCode,
                    fp.fingerprint,
                    startedStr
                ]
            );
            await registerFingerprint(fp, errorMessage, nodeType, errorType, startedStr,
                { reopenIfResolved: true });
            succeeded.push(row.exec_id);
        }

        // Marked inside the same transaction as the rows they describe. Committing
        // the analytics and then marking done separately would leave a window
        // where a crash loses the mark and the work is repeated — or worse, where
        // the mark survives and the analytics do not.
        if (succeeded.length > 0) {
            const ph = succeeded.map(() => '?').join(',');
            await localDb.execute(
                `UPDATE execution_entity
                    SET analytics_status = 'done', analytics_next_attempt = NULL
                  WHERE id IN (${ph})`,
                succeeded
            );
        }

        // Too large to read. Not a failure to retry — it will be exactly as large
        // next time — so it is parked with its size recorded in the log.
        if (oversized.length > 0) {
            const ph = oversized.map(() => '?').join(',');
            await localDb.execute(
                `UPDATE execution_entity SET analytics_status = 'failed' WHERE id IN (${ph})`,
                oversized.map(o => o.id)
            );
            // One line, not one per row: a spike would otherwise bury everything
            // else in the log with the same message repeated hundreds of times.
            const biggest = Math.max(...oversized.map(o => o.bytes));
            log.warn(
                `${oversized.length} error payload(s) skipped for exceeding ` +
                `${formatBytes(MAX_PAYLOAD_BYTES)} (largest ${formatBytes(biggest)}): ` +
                `${oversized.slice(0, 5).map(o => o.id).join(', ')}` +
                `${oversized.length > 5 ? `, +${oversized.length - 5} more` : ''}. ` +
                'Raise MAX_ERROR_PAYLOAD_BYTES to include them.'
            );
        }

        await localDb.execute('COMMIT');
        // Not logged at info: processAnalyticsQueue reports the same pass as
        // step 7 with the fuller count (extracted / failed / still queued), and
        // two lines saying "45" invite the reader to add them up.
        log.debug(`Error analytics chunk written: ${analyticsData.length} records.`);

        // Debug Export.
        //
        // scratch/ is gitignored, so it does not exist in the container: with
        // SAVE_DEBUG_ERRORS on, writeFileSync threw and took the whole analytics
        // pass down with it. The directory is created on demand now, the path is
        // configurable, and a failure here is logged rather than propagated —
        // a troubleshooting aid must never break the thing being troubleshot.
        if (SAVE_DEBUG_ERRORS && analyticsData.length > 0) {
            try {
                const outPath = process.env.DEBUG_ERRORS_PATH
                    ? path.resolve(process.env.DEBUG_ERRORS_PATH)
                    : path.resolve(__dirname, '../../scratch/debug_errors.json');
                fs.mkdirSync(path.dirname(outPath), { recursive: true });
                fs.writeFileSync(outPath, JSON.stringify(analyticsData, null, 2));
                log.info(`Raw debug export saved to ${outPath}`);
            } catch (e) {
                log.error('Could not write the debug export:', e.message);
            }
        }

        return { done: succeeded.length, failed: vanished.length + oversized.length };

    } catch (e) {
        log.error('Failed to map error analytics:', e);
        try { await localDb.execute('ROLLBACK'); } catch (err) { /* the caught error above is the one worth reporting */ }
        // The rollback undid the 'done' marks too, so everything in this chunk is
        // still pending. Give it a backoff so the next cycle does not walk
        // straight back into the same failure.
        await markFailed(errorIdsArray, e.message);
        return { done: 0, failed: errorIdsArray.length };
    }
}

function isSyncActive() {
    return isSyncing;
}

/**
 * Resolves once no ETL pass is in flight, or after timeoutMs, whichever comes
 * first. Returns true if the sync actually finished.
 *
 * This is what makes shutdown safe. The ETL writes to the replica inside explicit
 * transactions; killing the process mid-pass leaves a hot journal at best, and the
 * replica holds execution history that n8n has already pruned, so there is nothing
 * to restore it from.
 *
 * Polling rather than an event emitter on purpose — syncData has several exit
 * paths (success, caught error, rollback) and a flag checked in one place cannot
 * fall out of sync with them the way a set of emit() calls can.
 */
function waitForIdle(timeoutMs = 8000) {
    if (!isSyncing) return Promise.resolve(true);

    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const timer = setInterval(() => {
            if (!isSyncing) {
                clearInterval(timer);
                resolve(true);
            } else if (Date.now() >= deadline) {
                clearInterval(timer);
                resolve(false);
            }
        }, 100);
        // Never hold the event loop open just to watch for idleness.
        if (timer.unref) timer.unref();
    });
}

module.exports = {
    // Exported so a test can assert that every step() call site has a number,
    // which is the one way this numbering can rot: add a stage, forget the list,
    // and the log quietly says "[9/13]" for two different things.
    PASS_STEPS,
    step,
    syncData,
    syncAuthorization,
    updateExecutionVolumeStats,
    syncErrorAnalytics,
    enqueueForAnalytics,
    processAnalyticsQueue,
    reclassifyIfNeeded,
    syncWorkflowStatistics,
    syncOrganisation,
    backfillFingerprints,
    profileWorkflowNodes,
    purgeExpiredErrorDetail,
    isSyncActive,
    waitForIdle
};
