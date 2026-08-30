/**
 * What is actually true, read from the same DAOs the assistant reads.
 *
 * Nothing here is hard-coded. A fixture that says "ΑΑΑ_Processor had 10,076
 * executions" is correct for about five minutes on a live replica, and an
 * evaluation that fails because the data moved teaches everyone to ignore it.
 * The numbers are computed at run time, immediately before the question is
 * asked, and the checks compare against those.
 *
 * Going through the DAO rather than through hand-written SQL is deliberate too:
 * the assistant's numbers come from the DAO, so a DAO bug would agree with
 * itself and the check would pass. The point of the traps in `scenarios.js` is
 * to catch that anyway — every "correct" figure ships with the WRONG figure the
 * observed failures produced, and an answer containing the wrong one fails even
 * if it also contains the right one.
 *
 * The entity ids below are here so scenarios can be written about things that
 * exist on THIS instance. A dataset built on invented folder names measures
 * nothing except the assistant's willingness to say it cannot find them.
 */

const metricsDao = require('../../src/dao/metricsDao');
const errorIntelligenceDao = require('../../src/dao/errorIntelligenceDao');
const localDb = require('../../src/config/localDb');

const DAYS = 7;

function windowIso(days = DAYS) {
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
    return { startDate: start.toISOString(), endDate: end.toISOString() };
}

/** The scope an unrestricted caller gets. Mirrors resolveScopeFor for an owner. */
const OWNER = null;

async function one(sql, params = []) {
    const r = await localDb.query(sql, params);
    return r.rows[0] || null;
}

async function many(sql, params = []) {
    const r = await localDb.query(sql, params);
    return r.rows;
}

async function findWorkflow(nameLike) {
    const row = await one(
        'SELECT id, name FROM workflow_entity WHERE name LIKE ? ORDER BY LENGTH(name) LIMIT 1',
        [nameLike]
    );
    if (!row) throw new Error(`No workflow matching ${nameLike}`);
    return row;
}

/**
 * The facts one run needs.
 *
 * `instance` is here so the traps can exist: the failure that started this was
 * the assistant reporting the instance's totals under one workflow's name, and
 * the only way to catch that automatically is to know both numbers and insist
 * the answer contains one and not the other.
 */
async function collect() {
    const win = windowIso();

    const proc = await findWorkflow('%_Processor');
    const call = await findWorkflow('CallCenterPerMinute');

    const forWorkflow = async (id) => {
        const m = await metricsDao.getMetrics({
            scope: OWNER, grouping: { workflow: id }, filters: win
        });
        const e = await errorIntelligenceDao.getErrorIntelligence({
            scope: OWNER, grouping: { workflow: id }, filters: win
        });
        return {
            total: m.summary.total,
            errors: m.summary.error,
            groups: (e.groups || []).map((g) => g.node_name || g.nodeName).filter(Boolean)
        };
    };

    const instanceMetrics = await metricsDao.getMetrics({
        scope: OWNER, grouping: {}, filters: win
    });

    // The workflow with the most failures in the window, and the group behind
    // them. Several scenarios ask about "the thing that is actually broken",
    // and that has to be whatever is actually broken today.
    const worst = await one(
        `SELECT w.id, w.name, COUNT(*) AS errors
           FROM execution_entity e JOIN workflow_entity w ON w.id = e."workflowId"
          WHERE e.status = 'error' AND e."startedAt" >= ?
          GROUP BY w.id, w.name ORDER BY errors DESC LIMIT 1`,
        [win.startDate]
    );

    const failedExecution = await one(
        `SELECT e.id, e."workflowId" AS workflow_id, w.name AS workflow_name
           FROM execution_entity e JOIN workflow_entity w ON w.id = e."workflowId"
          WHERE e.status = 'error' ORDER BY e.id DESC LIMIT 1`
    );
    const okExecution = await one(
        `SELECT e.id, e."workflowId" AS workflow_id, w.name AS workflow_name
           FROM execution_entity e JOIN workflow_entity w ON w.id = e."workflowId"
          WHERE e.status = 'success' ORDER BY e.id DESC LIMIT 1`
    );

    const allNames = (await many('SELECT name FROM workflow_entity')).map((r) => r.name);

    return {
        window: win,
        days: DAYS,
        instance: {
            total: instanceMetrics.summary.total,
            errors: instanceMetrics.summary.error,
            workflowCount: (await one('SELECT COUNT(*) AS n FROM workflow_entity')).n
        },
        workflows: {
            processor: { ...proc, ...(await forWorkflow(proc.id)) },
            callCenter: { ...call, ...(await forWorkflow(call.id)) },
            worst: worst || null
        },
        folders: await many('SELECT id, name FROM folder ORDER BY name LIMIT 8'),
        tags: await many('SELECT id, name FROM tag_entity ORDER BY name LIMIT 8'),
        project: await one('SELECT id, name FROM project LIMIT 1'),
        credential: await one('SELECT id, name FROM credentials_entity LIMIT 1'),
        executions: { failed: failedExecution, ok: okExecution },
        allNames,
        /** Every other workflow's name, for "did it wander off the subject". */
        othersThan: (...keep) => allNames.filter((n) => !keep.includes(n))
    };
}

module.exports = { collect, windowIso };
