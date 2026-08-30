const { validateSetting, validateRoiEntry } = require('../utils/validate');
const { groupingClause } = require('../utils/grouping');
const log = require('../utils/logger').logger('API');
const metricsDao = require('../dao/metricsDao');
const errorIntelligenceDao = require('../dao/errorIntelligenceDao');
const settingsDao = require('../dao/settingsDao');

/**
 * Relative time bounds are computed here rather than with SQLite's
 * datetime('now', '-N days'), so they can be passed as bound parameters and the
 * indexed column stays untouched on the left of the comparison.
 * Always UTC, matching how every timestamp is written by the sync.
 */

exports.getMetrics = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await metricsDao.getMetrics({ scope: req.scope, grouping: req.query, filters: req.query }));
    } catch (err) {
        // A DAO raises `expected` for a rejection it could only
        // detect next to the data — a bad id, an invisible workflow.
        // Anything else is a fault and keeps the generic message.
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Database errorfetching metrics' });
    }
};


exports.getExecutions = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await metricsDao.getExecutions({ scope: req.scope, grouping: req.query, filters: req.query }));
    } catch (err) {
        // A DAO raises `expected` for a rejection it could only
        // detect next to the data — a bad id, an invisible workflow.
        // Anything else is a fault and keeps the generic message.
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Database error' });
    }
};

exports.getSlowest = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await metricsDao.getSlowest({ scope: req.scope, grouping: req.query }));
    } catch (err) {
        // A DAO raises `expected` for a rejection it could only
        // detect next to the data — a bad id, an invisible workflow.
        // Anything else is a fault and keeps the generic message.
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Database error' });
    }
};

exports.getErrors = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await metricsDao.getErrors({ scope: req.scope, grouping: req.query }));
    } catch (err) {
        // A DAO raises `expected` for a rejection it could only
        // detect next to the data — a bad id, an invisible workflow.
        // Anything else is a fault and keeps the generic message.
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Database error' });
    }
};

exports.getExecutionError = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await metricsDao.getExecutionError({ scope: req.scope, grouping: req.query, filters: req.query, route: req.params, userId: req.user && req.user.id }));
    } catch (err) {
        // A DAO raises `expected` for a rejection it could only
        // detect next to the data — a bad id, an invisible workflow.
        // Anything else is a fault and keeps the generic message.
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to parse error data' });
    }
};

/**
 * F-12 · GET /api/executions/:id/trace
 *
 * Where one execution actually spent its time, node by node, and how many items
 * crossed each edge.
 *
 * Read from Postgres on demand rather than mirrored. The trace is the biggest
 * object n8n stores — 33 KB on average here and 284 KB at the top end — and it
 * is only interesting for the execution someone is currently looking at. This
 * is the third and last of the three places this codebase touches Postgres, and
 * it is the same one the Inspect button already used.
 *
 * What comes back is arithmetic, never payload: durations, item counts and node
 * names. The existing `?full=true` on the error endpoint returns the raw object;
 * this one cannot, by construction — summariseTrace does not copy values out.
 */
exports.getExecutionTrace = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await metricsDao.getExecutionTrace({ scope: req.scope, grouping: req.query, route: req.params, userId: req.user && req.user.id }));
    } catch (err) {
        // A DAO raises `expected` for a rejection it could only
        // detect next to the data — a bad id, an invisible workflow.
        // Anything else is a fault and keeps the generic message.
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to read the execution trace' });
    }
};

exports.forceSync = async (req, res) => {
    const { syncData } = require('../config/syncJob');
    log.info(`Manual sync requested by user ${req.user && req.user.id}`);
    try {
        const result = await syncData();

        // Answering 200 here would be a lie: the ETL declined to run because one
        // was already in flight. 409 lets the caller retry meaningfully instead of
        // believing it just got fresh data.
        if (result.status === 'already_running') {
            return res.status(409).json({
                status: 'already_running',
                error: 'A sync is already in progress. Try again in a moment.'
            });
        }

        // Another instance owns the ETL. Saying "done" here would be a lie, and
        // saying "failed" would send someone hunting for a bug that isn't there.
        if (result.status === 'not_lock_owner') {
            return res.status(409).json({
                status: 'not_lock_owner',
                error: `Another instance is the active writer (${result.owner}). ` +
                    'This one serves reads only, so it cannot sync on demand.'
            });
        }

        if (result.status === 'failed') {
            return res.status(500).json({ status: 'failed', error: 'Force Sync Failed' });
        }

        res.json({
            status: 'ok',
            message: 'Sync Complete',
            workflows: result.workflows,
            executions: result.executions,
            errors: result.errors
        });
    } catch (err) {
        log.error('Manual Sync failed:', err);
        res.status(500).json({ error: 'Force Sync Failed' });
    }
};

// --- INSIGHTS & ROI METHODS ---

exports.getN8nHealth = async (req, res) => {
    try {
        const baseUrl = process.env.N8N_EDITOR_BASE_URL;
        if (!baseUrl) return res.status(500).json({ status: 'error', message: 'N8N_EDITOR_BASE_URL not configured' });
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3500);
        
        const response = await fetch(`${baseUrl}/healthz`, {
            method: 'GET',
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (response.ok) {
            const data = await response.json();
            if (data.status === 'ok') {
                return res.json({ status: 'ok' });
            }
        }
        res.status(500).json({ status: 'error' });
    } catch (err) {
        res.status(500).json({ status: 'error' });
    }
};

exports.getSettings = async (req, res) => {
    try {
        res.json(await settingsDao.listRoiSettings({ scope: req.scope }));
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Database error' });
    }
};

exports.updateSettings = async (req, res) => {
    try {
        const { settings } = req.body;
        if (!settings || !Array.isArray(settings)) {
            return res.status(400).json({ error: 'Invalid settings payload' });
        }
        if (settings.length > 1000) {
            return res.status(400).json({ error: 'Too many settings in one request.' });
        }

        // Validate the whole payload before writing any of it, so a bad entry at
        // the end cannot leave the first half applied.
        const entries = [];
        for (const entry of settings) {
            const check = validateRoiEntry(entry);
            if (!check.ok) return res.status(400).json({ error: check.error });
            entries.push(check.value);
        }

        res.json(await settingsDao.saveRoiSettings({ entries, scope: req.scope }));
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to update settings' });
    }
};

exports.getRoiMetrics = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await metricsDao.getRoiMetrics({ scope: req.scope, grouping: req.query, filters: req.query }));
    } catch (err) {
        // A DAO raises `expected` for a rejection it could only
        // detect next to the data — a bad id, an invisible workflow.
        // Anything else is a fault and keeps the generic message.
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Database error fetching ROI metrics' });
    }
};

exports.getExecutionVolume = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await metricsDao.getExecutionVolume({ scope: req.scope, grouping: req.query, filters: req.query }));
    } catch (err) {
        // A DAO raises `expected` for a rejection it could only
        // detect next to the data — a bad id, an invisible workflow.
        // Anything else is a fault and keeps the generic message.
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch execution volume' });
    }
};

exports.getFirstExecutionDate = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await metricsDao.getFirstExecutionDate({ scope: req.scope, grouping: req.query }));
    } catch (err) {
        // A DAO raises `expected` for a rejection it could only
        // detect next to the data — a bad id, an invisible workflow.
        // Anything else is a fault and keeps the generic message.
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch first execution date' });
    }
};

exports.getGlobalSettings = async (req, res) => {
    try {
        res.json(await settingsDao.getGlobalSettings());
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Database error' });
    }
};

exports.updateGlobalSettings = async (req, res) => {
    try {
        const { key, value } = req.body;
        const check = validateSetting(key, value);
        if (!check.ok) return res.status(400).json({ error: check.error });

        res.json(await settingsDao.setGlobalSetting({ key, value }));
    } catch (err) {
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to update setting' });
    }
};

/**
 * The rows behind one bar of the execution-volume chart.
 *
 * Executions that STARTED inside the window — the same measurement the bar is.
 * It used to select executions that were RUNNING during the window: started at
 * or before the end, and either still going or stopped after the beginning. That
 * is overlap, not volume, so clicking a bar of height 12 could open a list of 30
 * rows or of 3, and neither number was wrong — they were answers to different
 * questions. The modal's own subtitle already said "Workflows started in this
 * window"; the query was the part that disagreed.
 *
 * As a side effect the predicate is now a plain range on "startedAt", so it is
 * one seek on idx_exec_started instead of a scan with an OR in it.
 */
exports.getExecutionVolumeDetails = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await metricsDao.getExecutionVolumeDetails({ scope: req.scope, grouping: req.query, filters: req.query }));
    } catch (err) {
        // A DAO raises `expected` for a rejection it could only
        // detect next to the data — a bad id, an invisible workflow.
        // Anything else is a fault and keeps the generic message.
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch execution volume details' });
    }
};

// Exported for the tests: the banding is a judgement call expressed as numbers,
// which is exactly the kind of thing that should be pinned down by assertion
// rather than by reading it back.
// The F-08 behaviour classification moved into dao/errorIntelligenceDao with
// the queries that use it. Re-exported, not reimplemented: the tests assert on
// this classification directly, and there must go on being one copy of it.
exports._internal = errorIntelligenceDao._internal;

exports.getErrorIntelligence = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await errorIntelligenceDao.getErrorIntelligence({ scope: req.scope, grouping: req.query, filters: req.query }));
    } catch (err) {
        // A DAO raises `expected` for a rejection it could only
        // detect next to the data — a bad id, an invisible workflow.
        // Anything else is a fault and keeps the generic message.
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to aggregate error intelligence' });
    }
};

exports.getWorkflowErrorDrilldown = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await errorIntelligenceDao.getWorkflowErrorDrilldown({ scope: req.scope, grouping: req.query, route: req.params, userId: req.user && req.user.id }));
    } catch (err) {
        // A DAO raises `expected` for a rejection it could only
        // detect next to the data — a bad id, an invisible workflow.
        // Anything else is a fault and keeps the generic message.
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch workflow drilldown data' });
    }
};

exports.getErrorGroupExecutions = async (req, res) => {
    try {
        const grouping = groupingClause(req.query, 'e."workflowId"');
        if (!grouping.ok) return res.status(400).json({ error: grouping.error });
        res.json(await errorIntelligenceDao.getErrorGroupExecutions({ scope: req.scope, grouping: req.query, body: req.body }));
    } catch (err) {
        // A DAO raises `expected` for a rejection it could only
        // detect next to the data — a bad id, an invisible workflow.
        // Anything else is a fault and keeps the generic message.
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error(err);
        res.status(500).json({ error: 'Failed to fetch group executions' });
    }
};

