// ==========================================
// n8n Analytics Dashboard - Backend Server
// ==========================================

require('dotenv').config();
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const path = require('path');
const log = require('./src/utils/logger').logger('SERVER');
const { requestLog } = require('./src/middlewares/requestLog');

// Route Imports
const authRoutes = require('./src/routes/authRoutes');
const metricsRoutes = require('./src/routes/metricsRoutes');
const aiRoutes = require('./src/routes/aiRoutes');

const app = express();
app.set('trust proxy', 1);
const port = process.env.DASHBOARD_PORT || 3000;

// Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),

            // No 'unsafe-inline'. Every inline onclick has been replaced by the
            // data-action dispatcher in global_functions.js, which is what lets this
            // directive actually hold — with it present, one missed escape anywhere
            // turns straight into script execution and a stolen auth token.
            // 'self' only. Chart.js and marked used to be loaded from jsDelivr
            // with no version in the URL, which meant a third party could change
            // the code running in a page that holds an auth token — and a major
            // release could break the dashboard with no warning. Both are now
            // served from public/vendor, so no external origin may supply script.
            "script-src": ["'self'"],

            // Blocks inline event handler attributes outright, so a reintroduced
            // onclick= fails loudly in the console instead of silently reopening the hole.
            "script-src-attr": ["'none'"],

            // Still needed: Tailwind emits inline style attributes (skeleton loaders
            // size their bars this way). Inline style is a far smaller risk than
            // inline script — it cannot execute.
            "style-src": ["'self'", "'unsafe-inline'"],

            // Open Sans and Font Awesome are vendored, so Google Fonts and cdnjs
            // are no longer reachable — and no longer needed for the page to render.
            "font-src": ["'self'"],
            "connect-src": ["'self'"],
            "img-src": ["'self'", "data:"],

            // Nothing here embeds or is embedded, and no plugin content is expected.
            "object-src": ["'none'"],
            "base-uri": ["'self'"],
            "frame-ancestors": ["'none'"],
        },
    },
}));
// Resolved against this file, not the working directory. `express.static('public')`
// is CWD-relative, so starting the process from anywhere but the project root
// served nothing at all — and the failure looks like a broken frontend rather
// than a misconfigured start command.
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '100kb' }));

// Mounted below express.static and above the routers: static assets are noise in
// a request log, while everything under /api is worth a line. It has to come
// before the routers so the response hooks are attached before a handler can
// answer.
app.use('/api', requestLog);

// Main Routes
app.use('/api', authRoutes);
app.use('/api', metricsRoutes);
app.use('/api', aiRoutes);

// --- Health probes ---
//
// Three levels, deliberately separated. The old single /healthz ran SELECT 1
// against the production n8n Postgres on every call, unauthenticated and
// unthrottled: an orchestrator probing every second turned into 86k queries a
// day, and any anonymous caller could burn the connection pool for free.
//
//   /healthz          liveness  — is this process alive? no I/O at all.
//   /readyz           readiness — can it serve? cached, so N probes cost 1 query.
//   /api/health/deep  diagnostic — authenticated, uncached, returns detail.

const { pool } = require('./src/config/db');
const localDb = require('./src/config/localDb');
const instanceLock = require('./src/config/instanceLock');
const { authenticateToken } = require('./src/middlewares/auth');
const { healthLimiter } = require('./src/middlewares/rateLimiter');

// Liveness: if the event loop can answer, the process is alive. Touching a
// database here is actively harmful — a Postgres blip would make the
// orchestrator kill a perfectly healthy container that still serves the
// replica just fine.
app.get('/healthz', healthLimiter, (req, res) => res.status(200).end());

const READINESS_TTL_MS = 20_000;
let readiness = { checkedAt: 0, ok: false };
let readinessInFlight = null;

// The cache is what makes this cheap; the in-flight guard is what keeps it
// cheap. Without the guard, every probe arriving in the instant after the TTL
// expires starts its own query — exactly the stampede the cache exists to stop.
async function isReady() {
    if (Date.now() - readiness.checkedAt < READINESS_TTL_MS) return readiness.ok;
    if (readinessInFlight) return readinessInFlight;

    readinessInFlight = (async () => {
        let ok = false;
        try {
            await pool.query('SELECT 1');
            ok = true;
        } catch (err) {
            log.error('Readiness probe failed:', err.message);
        }
        readiness = { checkedAt: Date.now(), ok };
        readinessInFlight = null;
        return ok;
    })();

    return readinessInFlight;
}

app.get('/readyz', healthLimiter, async (req, res) => {
    res.status((await isReady()) ? 200 : 503).end();
});

// Detail is only safe behind auth — error text and row counts describe the
// infrastructure to anyone who asks.
app.get('/api/health/deep', authenticateToken, async (req, res) => {
    const report = { postgres: 'unknown', replica: 'unknown', executions: null, etl: null };

    try {
        await pool.query('SELECT 1');
        report.postgres = 'ok';
    } catch (err) {
        report.postgres = `error: ${err.message}`;
    }

    try {
        const r = await localDb.query('SELECT COUNT(*) AS n FROM execution_entity');
        report.replica = 'ok';
        report.executions = r.rows[0].n;
    } catch (err) {
        report.replica = `error: ${err.message}`;
    }

    // Which instance is the active writer. With more than one container up this
    // is the first thing anyone needs to know, and guessing from the logs is
    // exactly how the duplicate-writer incident went unnoticed for so long.
    report.etl = instanceLock.isHolding()
        ? { role: 'writer', lockOwner: 'this instance' }
        : { role: 'reader', lockOwner: await instanceLock.describeOwner() };

    // A read-only instance is healthy. It is doing precisely what it should.
    const healthy = report.postgres === 'ok' && report.replica === 'ok';
    res.status(healthy ? 200 : 503).json(report);
});

// --- Error handling, last in the chain ---
//
// Express 5 forwards a rejected async handler here instead of leaving the request
// hanging, and without this it would answer with its own HTML page containing the
// stack trace. Nothing about the internals should reach the client; the detail
// belongs in the log, where it is actually useful.
app.use((err, req, res, next) => {
    // A malformed JSON body is the caller's mistake, not a server fault — express
    // .json() raises it before any route runs.
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Request body is not valid JSON.' });
    }
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request body is too large.' });
    }

    log.error(`Unhandled failure on ${req.method} ${req.originalUrl}:`, err);

    // Already streaming a response: the only correct move is to let the default
    // handler tear the connection down, since headers cannot be rewritten.
    if (res.headersSent) return next(err);

    res.status(500).json({ error: 'Internal server error' });
});

// ETL Sync Engine
const cron = require('node-cron');
const { syncData, waitForIdle, backfillFingerprints } = require('./src/config/syncJob');
const { runAlertPass } = require('./src/config/alertEngine');

// Start competing for the ETL lock immediately. The heartbeat runs whether or
// not we win: if the current writer goes away, this instance takes over on its
// own within one TTL, which is what makes a start-first rolling update recover
// without anyone touching it.
instanceLock.startHeartbeat();

const syncInterval = process.env.SYNC_INTERVAL_MINUTES || 5;
const syncTask = cron.schedule(`*/${syncInterval} * * * *`, () => {
    syncData();
});

// Run an initial sync on boot. The handle is kept so a shutdown arriving inside
// this window cancels it instead of starting an ETL pass on the way out.
//
// SKIP_BOOT_SYNC exists for the integration tests, which boot the app against a
// temporary replica and no Postgres at all. Without it every test run waits out
// the connection timeout before the first assertion.
const bootSyncTimer = process.env.SKIP_BOOT_SYNC === '1'
    ? null
    : setTimeout(() => { syncData(); }, 2000);

/**
 * Error fingerprinting (F-07), scheduled apart from the ETL.
 *
 * It reads and writes only the replica — no Postgres, no network — and that is
 * why it does not live solely inside the sync cycle. A cycle aborts the moment
 * the source database is unreachable, and an instance in that state is exactly
 * when someone is staring at the error history it already has. Grouping that
 * history should not depend on the thing that is broken.
 *
 * Runs once shortly after the schema is ready and then alongside each sync tick.
 * Both are no-ops once the backfill has finished — one settings read.
 */
function maintainFingerprints() {
    backfillFingerprints().catch((err) => {
        log.error('Fingerprint maintenance failed:', err.message);
    });
}

const fingerprintTimer = setTimeout(() => {
    localDb.ready.then(maintainFingerprints);
}, 1000);
const fingerprintTask = cron.schedule(`*/${syncInterval} * * * *`, maintainFingerprints);

/**
 * The alert pass (F-13), scheduled beside the ETL rather than inside it.
 *
 * Every rule reads the replica and nothing else, so a deployment whose Postgres
 * is unreachable — or whose ETL writer has died — should still be able to tell
 * someone that the workflows stopped. Putting it inside syncData would make
 * alerting fail in precisely the situation it exists for.
 *
 * It runs shortly after each sync tick rather than at the same moment, so it
 * judges data the cycle has already written instead of racing it. The pass skips
 * itself when the replica is too stale to judge, which is what stops a stalled
 * pipeline from reporting every scheduled workflow as dead.
 */
function evaluateAlerts() {
    runAlertPass().catch((err) => log.error('Alert pass failed:', err.message));
}

const ALERT_DELAY_MS = Number(process.env.ALERT_DELAY_MS) || 30000;
let alertDelayTimer = null;
const alertTask = cron.schedule(`*/${syncInterval} * * * *`, () => {
    clearTimeout(alertDelayTimer);
    alertDelayTimer = setTimeout(evaluateAlerts, ALERT_DELAY_MS);
});

// Server Initialization.
//
// The socket is created now so the shutdown handler and the error handler below
// always have something to attach to, but it does not start listening until the
// schema migrations have finished. The migrations await between statements, so
// unlike the old synchronous block they no longer implicitly queue ahead of
// everything else on the connection — a request served in that window would
// query a table that does not exist yet. On a fresh database that is the
// difference between a working first boot and a page of 500s.
//
// Not listening is also the honest signal: a container that has not bound its
// port is not ready, which is exactly what an orchestrator should see.
const server = http.createServer(app);

localDb.ready.then(() => {
    server.listen(port, () => {
        log.info(`🚀 n8n Analytics Dashboard modularized and listening at http://localhost:${port}`);
        log.info(`📡 Press Ctrl+C to stop the server`);
    });
});

// Error Handling for the Server
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        log.error(`❌ Error: Port ${port} is already in use. Please kill the existing process or change DASHBOARD_PORT in your .env file.`);
    } else {
        log.error('❌ Server error:', err);
    }
    process.exit(1);
});

// --- Graceful shutdown ---
//
// Only SIGINT was handled before, so `docker stop` — which sends SIGTERM, waits,
// then SIGKILLs — killed this process outright. A container was observed exiting
// 137 (SIGKILL) in production. That is a hard kill in the middle of whatever the
// ETL was writing, against a replica holding history n8n has already pruned.
//
// The deadline must stay under the orchestrator's grace period (Docker: 10s by
// default), otherwise the SIGKILL lands anyway and none of this ran.
const SHUTDOWN_DEADLINE_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 8000;
let shuttingDown = false;

// Resolves either way. Used for teardown steps that are allowed to fail: one
// stuck step must not consume the whole budget and take the rest down with it.
function withTimeout(promise, ms, label) {
    return Promise.race([
        Promise.resolve(promise).catch((err) => {
            log.error(`${label} failed:`, err.message);
        }),
        new Promise((resolve) => {
            const t = setTimeout(() => {
                log.warn(`${label} did not finish in ${ms}ms — abandoning it.`);
                resolve();
            }, ms);
            if (t.unref) t.unref();
        })
    ]);
}

async function shutdown(signal, exitCode = 0) {
    // A second Ctrl+C, or SIGTERM followed by SIGINT, must not start a parallel
    // teardown that closes the database under the first one.
    if (shuttingDown) {
        log.info(`${signal} ignored — already shutting down.`);
        return;
    }
    shuttingDown = true;
    log.info(`${signal} received. Draining…`);

    // Hard backstop: if any step below hangs, exit anyway rather than wait for
    // the SIGKILL, which would defeat the entire purpose.
    const guard = setTimeout(() => {
        log.error('Deadline exceeded — forcing exit.');
        process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    guard.unref();

    try {
        // 1. Stop scheduling new work first, so nothing starts while we drain.
        if (bootSyncTimer) clearTimeout(bootSyncTimer);
        if (fingerprintTimer) clearTimeout(fingerprintTimer);
        if (syncTask) (syncTask.destroy || syncTask.stop).call(syncTask);
        if (fingerprintTask) (fingerprintTask.destroy || fingerprintTask.stop).call(fingerprintTask);
        if (alertDelayTimer) clearTimeout(alertDelayTimer);
        if (alertTask) (alertTask.destroy || alertTask.stop).call(alertTask);
        log.info('Cron stopped.');

        // 2. Stop accepting connections. In-flight requests keep their sockets.
        await new Promise((resolve) => { server.close(resolve); });
        if (server.closeIdleConnections) server.closeIdleConnections();
        log.info('HTTP server closed.');

        // 3. Let the ETL finish its transaction. This is the step that protects
        //    the replica; everything else is tidiness.
        const idle = await waitForIdle(SHUTDOWN_DEADLINE_MS - 2000);
        log.info(idle
            ? '[SHUTDOWN] ETL idle.'
            : '[SHUTDOWN] ETL still running at deadline — closing anyway, SQLite will roll back.');

        // 4. Hand the ETL lock back before the database closes, so a replacement
        //    instance starts syncing at once instead of waiting out the TTL.
        await withTimeout(instanceLock.release(), 1000, 'ETL lock release');

        // 5. Checkpoint the WAL and close the replica. This is the one step whose
        //    success actually matters, so it gets the larger share of the budget.
        await withTimeout(localDb.closeAsync(), 3000, 'Replica close');

        // 6. Release Postgres. Bounded on purpose: pool.end() waits for in-flight
        //    connections, and if Postgres is the reason we are shutting down it
        //    never returns. We only ever read from it, so abandoning the pool
        //    costs nothing — whereas blocking here would turn a successful
        //    shutdown into a forced exit and report failure for work that
        //    actually succeeded.
        await withTimeout(pool.end(), 1500, 'Postgres pool drain');
        log.info('Postgres pool released.');

        clearTimeout(guard);
        log.info('✅ Stopped cleanly.');
        process.exit(exitCode);
    } catch (err) {
        log.error('Error while shutting down:', err);
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Node's default for an unhandled rejection is to crash with no cleanup — which
// on this app means an abrupt kill during an ETL write. Keep the crash semantics
// (masking these would hide real bugs) but route it through the drain above.
process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection:', reason);
    shutdown('unhandledRejection', 1);
});

// After an uncaught exception the process state is untrustworthy, so this only
// tries to close the database — it does not attempt to keep serving.
process.on('uncaughtException', (err) => {
    log.error('Uncaught exception:', err);
    shutdown('uncaughtException', 1);
});