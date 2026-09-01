/**
 * Settings reads and writes.
 *
 * The only DAO here that writes. It follows the same rule as the rest — domain
 * values in, data out, no `req`, no status codes — with one addition: writes go
 * through `localDb.exclusive`, the B-36 gate.
 */

const localDb = require('../config/localDb');
const { scopeClause, filterVisibleWorkflows } = require('../utils/scope');
const { daoError, isoDaysAgo } = require('./shared');

/**
 * Per-workflow ROI settings, with the execution counts the panel sizes them by.
 *
 * Moved verbatim. An earlier version of this function was rewritten from memory
 * rather than carried across, and quietly lost `execution_count` and
 * `executions_30d` and gained an `isArchived` filter that hid a workflow the
 * page had always listed. Extraction is a move, not a rewrite.
 */
async function listRoiSettings({ scope: caller }) {
    const scope = scopeClause(caller, 'w.id');
    // Aggregate first, join second.
    //
    // This used to LEFT JOIN every successful execution onto its workflow —
    // half a million rows carrying a name, a rate and four baseline columns
    // apiece — and then GROUP BY seven of those columns to get back to 164
    // rows. Measured at 2,020ms on the reference replica, and it is one of two
    // queries the Configure tab issues, on a connection they have to take turns
    // on. Grouping the executions on their own first and joining 164 to 164
    // gives byte-identical output in 725ms.
    const query = `
        SELECT
            w.id,
            w.name,
            COALESCE(s.saved_time_seconds, 0) as saved_time_seconds,
            COALESCE(s.hourly_rate, 0) as hourly_rate,
            -- Not COALESCEd, unlike the two above. NULL is the answer here: it
            -- means the per-run figure was typed in directly and no baseline was
            -- ever claimed, which the Business case view has to be able to tell
            -- apart from one that happens to read 0.
            s.baseline_frequency,
            s.baseline_per,
            s.baseline_duration,
            s.baseline_unit,
            COALESCE(x.execution_count, 0) as execution_count,
            COALESCE(x.executions_30d, 0) as executions_30d
        FROM workflow_entity w
        LEFT JOIN workflow_settings s ON w.id = s.workflow_id
        LEFT JOIN (
            SELECT
                "workflowId" as wf,
                COUNT(*) as execution_count,
                SUM(CASE WHEN "startedAt" >= ? THEN 1 ELSE 0 END) as executions_30d
            FROM execution_entity
            WHERE status = 'success'
            GROUP BY "workflowId"
        ) x ON x.wf = w.id
        ${scope.condition ? `WHERE ${scope.condition}` : ''}
        ORDER BY w.name ASC
    `;
    // The previous bound mixed 'localtime' into a comparison against UTC
    // timestamps, so the 30-day window was off by the server's UTC offset.
    const result = await localDb.query(query, [isoDaysAgo(30), ...scope.params]);
    return result.rows;
}

/**
 * Writes ROI settings for a set of workflows.
 *
 * @param {object[]} entries  already validated by validateRoiEntry
 * @param {?object}  scope    the caller's scope; null for unrestricted
 */
async function saveRoiSettings({ entries, scope: caller }) {
    // Two checks in one pass. workflow_settings has a foreign key to
    // workflow_entity, but it only bites if PRAGMA foreign_keys is on — which it
    // is, and this turns the resulting 500 into a message that names the offending
    // workflow. The scope check is the other half: ROI is written per workflow, so
    // without it a member could set the saved-time figure on somebody else's.
    //
    // Out of scope and non-existent return the SAME message on purpose. Telling
    // the caller which of the two it was would turn this endpoint into a way to
    // enumerate the workflow ids of every other project.
    const ids = entries.map((c) => c.workflow_id);
    if (ids.length > 0) {
        const known = await localDb.query(
            `SELECT id FROM workflow_entity WHERE id IN (${ids.map(() => '?').join(',')})`,
            ids
        );
        const knownSet = new Set(known.rows.map((r) => r.id));
        const visibleSet = await filterVisibleWorkflows(caller, ids);
        const rejected = ids.filter((id) => !knownSet.has(id) || !visibleSet.has(id));
        if (rejected.length > 0) {
            throw daoError(400, `Unknown workflow id(s): ${rejected.slice(0, 5).join(', ')}`);
        }
    }

    // Inside localDb.exclusive, which it was not before.
    //
    // B-36 put a gate around every write and a guard on `BEGIN` that names the
    // mistake. This handler raised its own transaction outside the gate, so the
    // guard fired on every ROI save — and because it logs rather than throws (a
    // warning that is wrong must not be able to stop an ETL pass) the endpoint
    // went on working and the message went unread. Wrapping it is what the
    // guard was asking for.
    await localDb.exclusive(async () => {
        await localDb.execute('BEGIN TRANSACTION');
        try {
            for (const s of entries) {
                await localDb.execute(
                    `INSERT INTO workflow_settings (
                         workflow_id, saved_time_seconds, hourly_rate,
                         baseline_frequency, baseline_per, baseline_duration, baseline_unit
                     )
                     VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(workflow_id) DO UPDATE SET
                         saved_time_seconds = excluded.saved_time_seconds,
                         hourly_rate = excluded.hourly_rate,
                         -- Written every time, nulls included. A save from the
                         -- Per-run figures view sends four nulls and MUST clear a
                         -- baseline that is no longer what the stored figure came
                         -- from; leaving it would make the other view redisplay a
                         -- sentence that no longer computes to the saved number.
                         baseline_frequency = excluded.baseline_frequency,
                         baseline_per       = excluded.baseline_per,
                         baseline_duration  = excluded.baseline_duration,
                         baseline_unit      = excluded.baseline_unit`,
                    [s.workflow_id, s.saved_time_seconds, s.hourly_rate,
                        s.baseline_frequency, s.baseline_per, s.baseline_duration, s.baseline_unit]
                );
            }
            await localDb.execute('COMMIT');
        } catch (err) {
            try {
                await localDb.execute('ROLLBACK');
            } catch (ignored) {
                // The error above is the one worth reporting.
            }
            throw err;
        }
    });

    return { message: 'Settings saved' };
}

/** Instance-wide dashboard settings, as a plain object. */
async function getGlobalSettings() {
    const result = await localDb.query('SELECT key, value FROM dashboard_settings');
    return result.rows.reduce((acc, row) => {
        acc[row.key] = row.value;
        return acc;
    }, {});
}

/** Writes one instance-wide setting. `key` and `value` are already validated. */
async function setGlobalSetting({ key, value }) {
    await localDb.exclusive(() => localDb.execute(
        'INSERT INTO dashboard_settings (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, value]
    ));
    return { message: 'Setting updated' };
}

module.exports = { listRoiSettings, saveRoiSettings, getGlobalSettings, setGlobalSetting };
