const express = require('express');
const router = express.Router();
const metricsController = require('../controllers/metricsController');
const insightsController = require('../controllers/insightsController');
const alertsController = require('../controllers/alertsController');
const { authenticateToken, requireElevatedRole, resolveScope } = require('../middlewares/auth');
const { syncLimiter, globalApiLimiter } = require('../middlewares/rateLimiter');

// Every route below reads or writes workflow-derived data, so resolveScope runs
// on all of them. Applied at the router rather than per route: a handler added
// later inherits the scope instead of silently shipping unscoped.
// It reads req.user, so authenticateToken has to come first.
// globalApiLimiter sits between the two: it keys on req.user, so it needs the
// token decoded first, and there is no point resolving a scope for a request
// that is about to be refused.
router.use(authenticateToken, globalApiLimiter, resolveScope);

router.get('/analytics/metrics', metricsController.getMetrics);
router.get('/analytics/executions', metricsController.getExecutions);
router.get('/analytics/slowest', metricsController.getSlowest);
router.get('/analytics/errors', metricsController.getErrors);
router.get('/execution-error/:id', metricsController.getExecutionError);
// F-12. Node-level timing for one execution, fetched from Postgres on demand.
// Same authorization as the line above; unlike it, this one cannot return
// payload contents — the summariser only produces counts and durations.
router.get('/executions/:id/trace', metricsController.getExecutionTrace);
// syncLimiter keys on req.user.id, which router.use above has already set.
router.post('/sync/force', syncLimiter, requireElevatedRole, metricsController.forceSync);

// Insights & ROI
router.get('/n8n-health', metricsController.getN8nHealth);
router.get('/settings/roi', metricsController.getSettings);
router.get('/settings', metricsController.getGlobalSettings);
// Instance-wide, not per user: whatever is written here changes the dashboard
// for everyone, so it takes the same gate as forcing a sync.
router.post('/settings', requireElevatedRole, metricsController.updateGlobalSettings);
router.post('/settings/roi', metricsController.updateSettings);
router.get('/analytics/roi', metricsController.getRoiMetrics);
router.get('/analytics/first-execution-date', metricsController.getFirstExecutionDate);
// Renamed from /analytics/concurrency in L-30: the series counts executions
// STARTED per bucket, which is volume, not concurrency. The old name is what
// made the drill-down behind it get written against a different measurement.
router.get('/analytics/execution-volume', metricsController.getExecutionVolume);
router.get('/analytics/execution-volume/details', metricsController.getExecutionVolumeDetails);
router.get('/analytics/error-intelligence', metricsController.getErrorIntelligence);
router.post('/analytics/error-group-executions', metricsController.getErrorGroupExecutions);
router.get('/analytics/workflow-drilldown/:id', metricsController.getWorkflowErrorDrilldown);

// Insights — the four questions F-01 made answerable, plus the workflow
// inventory the dropdowns are built from. Same router, so they inherit the same
// auth, rate limit and scope resolution as everything above; a separate router
// would be one more place to forget one of the three.
router.get('/analytics/triggers', insightsController.getTriggerBreakdown);
router.get('/analytics/queue-lag', insightsController.getQueueLag);
router.get('/analytics/storage', insightsController.getStorageForecast);
router.get('/analytics/concurrency', insightsController.getConcurrency);
router.get('/analytics/reliability', insightsController.getReliability);
router.get('/analytics/silent-workflows', insightsController.getSilentWorkflows);
router.get('/workflows', insightsController.getWorkflows);
router.get('/analytics/organisation', insightsController.getOrganisation);
router.get('/analytics/dependencies', insightsController.getDependencies);
router.get('/analytics/deploys', insightsController.getDeploys);
router.get('/analytics/metadata', insightsController.getMetadataKeys);
router.get('/analytics/node-profile', insightsController.getNodeProfile);

// F-19. The dashboard's own health. Not elevated: it reports counts, durations
// and file sizes about this process, and the person who needs it is whoever is
// looking at a chart that seems stale.
router.get('/analytics/system', insightsController.getSystemHealth);

// --- Alerting (F-13, F-14) and the error lifecycle (F-15) ---
//
// Reads are open to any authenticated user: knowing what the instance watches
// is not a privileged act, and a channel's secret never leaves the server.
// Writes take requireElevatedRole, because a rule created by one person alerts
// everyone the channel reaches — the same reasoning as the instance-wide
// settings above.
router.get('/alerts/schema', alertsController.getSchema);
router.get('/alerts/status', alertsController.getStatus);
router.get('/alerts/rules', alertsController.listRules);
router.post('/alerts/rules', requireElevatedRole, alertsController.createRule);
router.put('/alerts/rules/:id', requireElevatedRole, alertsController.updateRule);
router.delete('/alerts/rules/:id', requireElevatedRole, alertsController.deleteRule);

router.get('/alerts/channels', alertsController.listChannels);
router.post('/alerts/channels', requireElevatedRole, alertsController.createChannel);
router.put('/alerts/channels/:id', requireElevatedRole, alertsController.updateChannel);
router.delete('/alerts/channels/:id', requireElevatedRole, alertsController.deleteChannel);
// Sends a real message. Elevated, because it makes the server talk to the
// outside world on request.
router.post('/alerts/channels/:id/test', requireElevatedRole, alertsController.testChannel);

// F-24 §4 · cURL in and out.
//
// Parsing is elevated even though it has no side effect: it is a step in
// creating a channel, and the SSRF verdict it returns is information about what
// this server is allowed to reach.
router.post('/alerts/channels/parse-curl', requireElevatedRole, alertsController.parseChannelCurl);
router.get('/alerts/channels/:id/curl', requireElevatedRole, alertsController.exportChannelCurl);

router.get('/alerts/events', alertsController.listEvents);
router.post('/alerts/run', requireElevatedRole, alertsController.runNow);

// F-15. Triaging an error is ordinary work, not administration, so any
// authenticated user may do it — and every decision is recorded with who made it.
router.post('/fingerprints/:fingerprint/status', alertsController.setFingerprintStatus);
router.get('/fingerprints/:fingerprint/history', alertsController.getFingerprintHistory);

module.exports = router;
