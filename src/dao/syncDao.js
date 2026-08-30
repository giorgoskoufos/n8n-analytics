/**
 * What the replica still owes, read from the replica alone.
 *
 * ── Why this is a DAO and not part of syncJob ────────────────────────────
 *
 * It was written inside `syncJob.js`, next to the stages it measures, which is
 * where the knowledge lives. It could not stay there: the reader is the health
 * endpoint behind the header's status line, which runs on every page load of
 * every page, and requiring `syncJob` from a DAO drags the whole ETL module —
 * a Postgres pool, three backfill engines, the alert queue — into the request
 * path to answer a five-word question.
 *
 * So the direction is inverted. This file owns the settings keys and the
 * counting; `syncJob` writes to the keys and imports them from here, and
 * `insightsDao` reads the count. Nothing imports `syncJob` to find out how far
 * behind it is.
 *
 * ── Everything here is local, and that is the constraint ─────────────────
 *
 * The one fact only Postgres knows — how many executions are still upstream —
 * is written into `dashboard_settings` by the cycle that measured it, precisely
 * so this file never has to open a connection to the production database.
 */

const localDb = require('../config/localDb');

/**
 * How many executions the source still has beyond the last batch synced.
 *
 * Written by the ETL, read here. See the note above on why it is stored rather
 * than counted on demand.
 */
const EXEC_BEHIND_KEY = 'sync_exec_behind';

/** The mirrored-column walk (F-01) and the fingerprint walk (F-07). */
const BACKFILL_CURSOR_KEY = 'backfill_009_cursor';
const FP_CURSOR_KEY = 'fingerprint_cursor';

/**
 * The backlog when the current catch-up began — the denominator for a
 * percentage. Written by whoever first observes a backlog, cleared when it
 * reaches zero.
 */
const CATCHUP_BASELINE_KEY = 'sync_catchup_baseline';

/**
 * What this replica still owes.
 *
 * ── The problem it exists for ────────────────────────────────────────────
 *
 * A first sync does not finish in one pass, and it never did. Five stages are
 * deliberately bounded — executions by a row limit, the analytics queue by its
 * chunk size, three backfills by a time budget each — because the alternative
 * is one cycle holding the write gate for minutes. That is the right design and
 * it has one cost: after the first cycle the dashboard is *partly* populated,
 * and nothing said so.
 *
 * What the first user of a new instance actually saw was pages of plausible,
 * quietly incomplete numbers. The only signal was noticing that the alerting
 * was reasoning about data hours older than it should be. The remedy people
 * arrive at unaided is pressing "Sync now" repeatedly — a person doing by hand
 * what a scheduler exists to do.
 *
 * @returns {Promise<{total:number, executions:number, analytics:number,
 *                    fingerprints:number, mirrored:number, stage:?string}>}
 */
async function syncBacklog() {
    const [behind, queued, unfingerprinted, cursors] = await Promise.all([
        localDb.query('SELECT value FROM dashboard_settings WHERE key = ?', [EXEC_BEHIND_KEY]),
        localDb.query(
            "SELECT COUNT(*) AS n FROM execution_entity WHERE analytics_status = 'pending'"
        ),
        localDb.query(
            'SELECT COUNT(*) AS n FROM execution_error_analytics WHERE fingerprint IS NULL'
        ),
        localDb.query(
            'SELECT key, value FROM dashboard_settings WHERE key IN (?, ?)',
            [BACKFILL_CURSOR_KEY, FP_CURSOR_KEY]
        )
    ]);

    const cursorFor = (key) => cursors.rows.find((r) => r.key === key)?.value ?? null;

    // A cursor that has never been written reads as null, which is NOT the same
    // as finished — on a fresh replica every cursor is null and every one of
    // them has a table to walk. `done` is the only value that means done.
    const mirrorCursor = cursorFor(BACKFILL_CURSOR_KEY);
    const fingerprintPending = cursorFor(FP_CURSOR_KEY) !== 'done';

    const executions = Number(behind.rows[0]?.value) || 0;
    const analytics = Number(queued.rows[0]?.n) || 0;
    const fingerprints = fingerprintPending ? (Number(unfingerprinted.rows[0]?.n) || 0) : 0;

    // ── Above the cursor, not "all of them" ─────────────────────────────
    //
    // The obvious query is `COUNT(*) WHERE mode IS NULL`, and it is wrong twice.
    //
    // It never reaches zero. Rows that predate n8n's own pruning have no source
    // to be filled FROM — 404,632 of them on the instance this was built against
    // — so the walk passes over them, leaves them null, and correctly declares
    // itself finished. A backlog built on the total would sit at four hundred
    // thousand forever, which means a catch-up that never ends and a scheduler
    // that keeps calling passes until it hits its own safety cap.
    //
    // And it ignores progress. A walk halfway down the table has done half the
    // work; the total says otherwise, so the percentage would not move.
    //
    // So it counts what the walk will actually LOOK AT: the same `id > cursor
    // AND mode IS NULL` the walk itself chunks over. Rows below the cursor are
    // finished with, whether or not they ended up filled.
    const mirrored = mirrorCursor === 'done' ? 0 : (Number((await localDb.query(
        'SELECT COUNT(*) AS n FROM execution_entity WHERE id > ? AND mode IS NULL',
        [Number(mirrorCursor) || 0]
    )).rows[0].n) || 0);

    return {
        total: executions + analytics + fingerprints + mirrored,
        executions,
        analytics,
        fingerprints,
        mirrored,
        // What a reader would name if asked what is happening now. Ordered by
        // what has to happen first, so the label does not jump backwards.
        stage: executions > 0 ? 'executions'
            : mirrored > 0 ? 'details'
                : analytics > 0 ? 'errors'
                    : fingerprints > 0 ? 'grouping'
                        : null
    };
}

module.exports = {
    syncBacklog,
    EXEC_BEHIND_KEY,
    BACKFILL_CURSOR_KEY,
    FP_CURSOR_KEY,
    CATCHUP_BASELINE_KEY
};
