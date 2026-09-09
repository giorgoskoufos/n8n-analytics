/**
 * Boots the real server against a temporary replica and calls every endpoint.
 *
 * This is the test that catches what unit tests structurally cannot: a route
 * left out of a middleware chain, a SQL fragment whose parameters no longer line
 * up, a migration that does not run on an empty database. Every one of those has
 * happened in this codebase, and each was found by starting the app rather than
 * by reading it.
 *
 * No Postgres. CI does not have an n8n instance, and requiring one would mean
 * this suite never runs. The handful of endpoints that genuinely need the source
 * database are asserted to fail the way they are documented to fail, which is
 * itself worth checking — a missing Postgres should be a 503, not a crash.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');
const PORT = 3117;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(48).toString('base64');
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'n8ndb-test-')), 'test.sqlite');

// 40 executions plus the one retry of the first of them.
const SEEDED = 41;
/** A folder that exists and holds no workflows. See the note in `seed()`. */
const EMPTY_FOLDER = 'fld-empty';
const SEEDED_SUCCESS = 33;   // 40 - 8 failures + the successful retry

const OWNER = jwt.sign({ id: 'u-owner', email: 'o@x', role: 'global:owner', jti: '1' }, SECRET, { expiresIn: '1h' });
const MEMBER = jwt.sign({ id: 'u-member', email: 'm@x', role: 'global:member', jti: '2' }, SECRET, { expiresIn: '1h' });

let child;

/**
 * A throwaway HTTP server standing in for a webhook target.
 *
 * Delivery is mocked in most test suites and that is exactly what hides the
 * interesting failures: a wrong header, a body that is not JSON, a timeout that
 * is never applied. This receives the real request the real code sends.
 */
let sink;
const sinkReceived = [];
let sinkStatus = 200;

function startSink() {
    return new Promise((resolve) => {
        sink = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                sinkReceived.push({
                    method: req.method,
                    headers: req.headers,
                    body: (() => { try { return JSON.parse(body); } catch { return body; } })()
                });
                res.writeHead(sinkStatus, { 'Content-Type': 'application/json' });
                res.end('{}');
            });
        });
        sink.listen(0, '127.0.0.1', () => resolve());
    });
}
const sinkUrl = () => `http://127.0.0.1:${sink.address().port}/hook`;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Waits for something the app does in the background rather than on request.
 *
 * Fingerprinting is eventually consistent on purpose: it is local maintenance
 * scheduled apart from the request path, so "shortly after boot" is the real
 * contract and polling for it is the honest way to assert it. A fixed sleep
 * would be slower on a fast machine and flaky on a slow one.
 */
async function waitFor(predicate, what, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await predicate();
        if (last) return last;
        await sleep(200);
    }
    throw new Error(`timed out waiting for ${what}`);
}

async function api(pathname, { token, method = 'GET', body } = {}) {
    const res = await fetch(BASE + pathname, {
        method,
        headers: {
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch (ignored) { /* 204 and friends have no body */ }
    return { status: res.status, body: json, headers: res.headers };
}

/**
 * A handful of rows, so "200 with an empty array" cannot pass for "200 with data".
 *
 * The mirrored F-01 columns are declared here rather than left to migration 009
 * to add. Both work — addColumnIfMissing skips what already exists — but a
 * fixture that cannot hold a `mode` can only test the endpoints that read it
 * against NULL, and NULL is the one value every one of them is written to skip.
 *
 * The shape is deliberate:
 *   · two trigger modes in a 1:1 split, one of which carries every failure, so a
 *     per-mode error rate that silently aggregates is visible as a wrong number
 *     rather than as a missing one;
 *   · a queue lag that varies per row, so a percentile cannot pass by returning
 *     the same constant it was given;
 *   · one real retry chain, which is the only way the self-healed EXISTS branch
 *     is ever executed — this instance has no retries at all.
 */
function seed() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB);
        db.serialize(() => {
            db.run(`CREATE TABLE workflow_entity (
                id TEXT PRIMARY KEY, name TEXT, active BOOLEAN, "isArchived" BOOLEAN)`);
            db.run(`CREATE TABLE execution_entity (
                id INTEGER PRIMARY KEY, "workflowId" TEXT, status TEXT,
                "startedAt" DATETIME, "stoppedAt" DATETIME,
                mode TEXT, "createdAt" DATETIME, finished BOOLEAN,
                "retryOf" TEXT, "retrySuccessId" TEXT, "waitTill" DATETIME,
                "jsonSizeBytes" INTEGER, "binaryDataSizeBytes" INTEGER)`);
            db.run("INSERT INTO workflow_entity VALUES ('wf-a','Alpha',1,0),('wf-b','Beta',1,0)," +
                "('wf-z','Zeta Retired',0,1)");

            // A real folder with nothing in it.
            //
            // Seeded here rather than written after boot, because the running
            // server owns the write gate (B-36) and a second writer on one SQLite
            // file is the thing that gate exists to prevent. `IF NOT EXISTS`
            // matches the migration that would otherwise create it, so the
            // migration finds it already there and moves on.
            //
            // It exists to hold one distinction apart: an id that names NOTHING
            // is refused, and an id that names something EMPTY still answers
            // zero. Without the second half, the fix for the first is free to
            // overshoot and nobody notices.
            db.run(`CREATE TABLE IF NOT EXISTS folder (
                id TEXT PRIMARY KEY, name TEXT, parent_folder_id TEXT,
                project_id TEXT, created_at DATETIME, updated_at DATETIME)`);
            db.run("INSERT INTO folder (id, name) VALUES ('fld-empty','Nothing In Here')");

            // Error detail for the seeded failures (F-07). The messages differ
            // only in a row number, which is exactly the case the old
            // SUBSTR-based grouping filed as eight separate problems.
            db.run(`CREATE TABLE execution_error_analytics (
                id INTEGER PRIMARY KEY, workflow_id TEXT, node_id TEXT, node_name TEXT,
                node_type TEXT, error_type TEXT, error_message TEXT, error_stack TEXT,
                source_node TEXT, source_output_index INTEGER, input_data TEXT,
                metadata TEXT, execution_source TEXT, error_category TEXT,
                http_code INTEGER, timestamp DATETIME)`);

            const now = Date.now();
            const rows = [];
            for (let i = 0; i < 40; i++) {
                const started = new Date(now - i * 60000);
                const stopped = new Date(started.getTime() + 2500);
                const isError = i % 5 === 0;
                // Every failure is a webhook, so a breakdown that mixes the modes
                // reports two wrong rates instead of one missing split.
                const mode = isError || i % 2 === 0 ? 'webhook' : 'trigger';
                rows.push([1000 + i, i % 2 ? 'wf-a' : 'wf-b', isError ? 'error' : 'success',
                    started.toISOString(), stopped.toISOString(),
                    mode, new Date(started.getTime() - (10 + i)).toISOString(),
                    isError ? 0 : 1, null, null, null, 1000 * (i + 1), 0]);
            }
            // The retry of execution 1000, which failed. Same workflow, later,
            // successful — so it self-heals exactly one failure. Placed inside
            // the seeded span rather than after `now`: a row in the future is
            // inside or outside a "last 7 days" window depending on how long the
            // server took to boot, and a test that flips on timing is worse than
            // no test.
            rows.push([2000, 'wf-b', 'success',
                new Date(now - 20 * 60000 + 30000).toISOString(),
                new Date(now - 20 * 60000 + 32000).toISOString(),
                'retry', new Date(now - 20 * 60000 + 29950).toISOString(),
                1, '1000', null, null, 500, 0]);

            const errStmt = db.prepare(
                'INSERT INTO execution_error_analytics (id, workflow_id, node_name, node_type,' +
                ' error_type, error_message, error_category, timestamp) VALUES (?,?,?,?,?,?,?,?)');
            for (let i = 0; i < 40; i += 5) {
                errStmt.run([1000 + i, i % 2 ? 'wf-a' : 'wf-b', 'Fetch', 'n8n-nodes-base.postgres',
                    'QueryError', `Row ${5000 + i} not found`, 'data',
                    new Date(now - i * 60000).toISOString()]);
            }
            errStmt.finalize();

            // A cursor that says the fingerprint walk finished, over rows that
            // have no fingerprint. This is the state the transaction collision
            // left the real replica in — 1,149 rows stranded under a cursor that
            // had moved past them — and nothing would ever have revisited them.
            // The boot pass has to notice and repair it.
            db.run('CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT)');
            db.run("INSERT INTO dashboard_settings (key, value) VALUES " +
                "('fingerprint_cursor','done'),('fingerprint_version','1')");

            // F-19. Created here rather than left to the migration (which is
            // CREATE TABLE IF NOT EXISTS, so it sees this and skips) because the
            // health panel has to be tested against a run history, and the
            // server's own ETL never runs in these tests.
            //
            // Three passes that worked and one that did not, most recent last.
            // The mix is the point: the first version of the panel compared the
            // stored status against the string 'success', which the ETL never
            // writes, and so reported four failures out of four.
            db.run(`CREATE TABLE sync_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
                duration_ms INTEGER NOT NULL, status TEXT NOT NULL,
                workflows INTEGER, executions INTEGER, rows_read INTEGER, errors INTEGER,
                analytics_done INTEGER, analytics_failed INTEGER, analytics_queued INTEGER,
                reclassified INTEGER, purged_input INTEGER, purged_stack INTEGER,
                replica_bytes INTEGER, error_message TEXT)`);
            const runStmt = db.prepare(
                'INSERT INTO sync_runs (started_at, finished_at, duration_ms, status,' +
                ' executions, replica_bytes, error_message) VALUES (?,?,?,?,?,?,?)');
            const RUNS = [
                [180, 'ok', 400, 100000000, null],
                [120, 'ok', 500, 110000000, null],
                [60, 'ok', 600, 120000000, null],
                [2, 'failed', 700, 121000000, 'boom']
            ];
            for (const [minsAgo, status, ms, size, err] of RUNS) {
                const at = new Date(now - minsAgo * 60000).toISOString();
                runStmt.run([at, new Date(now - minsAgo * 60000 + ms).toISOString(),
                    ms, status, 10, size, err]);
            }
            runStmt.finalize();

            const stmt = db.prepare(
                'INSERT INTO execution_entity (id,"workflowId",status,"startedAt","stoppedAt",' +
                'mode,"createdAt",finished,"retryOf","retrySuccessId","waitTill",' +
                '"jsonSizeBytes","binaryDataSizeBytes") ' +
                'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
            for (const r of rows) stmt.run(r);
            stmt.finalize();
        });
        db.close((e) => (e ? reject(e) : resolve()));
    });
}

test.before(async () => {
    await seed();
    await startSink();

    child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            DASHBOARD_DB_PATH: DB,
            DASHBOARD_PORT: String(PORT),
            DASHBOARD_JWT_SECRET: SECRET,
            // No n8n instance in CI. The boot sync would spend its connection
            // timeout failing before the first assertion could run.
            SKIP_BOOT_SYNC: '1',
            SYNC_INTERVAL_MINUTES: '59',
            LOG_LEVEL: 'error',
            // The sink is on loopback, which is refused by default. Allowing it
            // here is the same switch a single-host deployment would set.
            ALERT_ALLOW_PRIVATE_TARGETS: 'true',
            N8N_EDITOR_BASE_URL: 'http://127.0.0.1:9',   // closed port: /n8n-health must fail cleanly
            DASHBOARD_DB_HOST: '127.0.0.1',
            DASHBOARD_DB_PORT: '1',
            DASHBOARD_DB_CONNECT_TIMEOUT_MS: '400'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });

    for (let i = 0; i < 60; i++) {
        try { if ((await fetch(BASE + '/healthz')).ok) return; } catch (ignored) { /* not up yet */ }
        await sleep(250);
    }
    throw new Error('server did not start within 15s:\n' + log);
});

test.after(async () => {
    if (sink) sink.close();
    if (child) child.kill('SIGTERM');
    await sleep(1500);
    if (child && !child.killed) child.kill('SIGKILL');
    try { fs.rmSync(path.dirname(DB), { recursive: true, force: true }); } catch (ignored) { /* temp dir */ }
});

// ------------------------------------------------------------ schema and boot
test('the migrations build a complete schema on an empty database', async () => {
    // The server only starts listening once they have finished, so reaching this
    // test at all is half the assertion; the other half is that they ran against
    // a database that already had two of the tables.
    const db = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
    const rows = await new Promise((resolve, reject) => {
        db.all("SELECT name FROM sqlite_master WHERE type='table'", (e, r) => (e ? reject(e) : resolve(r)));
    });
    db.close();
    const tables = rows.map((r) => r.name);
    for (const t of ['schema_migrations', 'project', 'project_relation', 'shared_workflow',
        'execution_volume_stats', 'rate_limits', 'sync_runs', 'dashboard_settings',
        'execution_error_analytics', 'error_fingerprints', 'workflow_statistics',
        'folder', 'tag_entity', 'workflows_tags', 'workflow_history',
        'workflow_dependency', 'credentials_entity', 'execution_metadata',
        'instance_lock']) {
        assert.ok(tables.includes(t), `missing table ${t} — have ${tables.join(', ')}`);
    }
});

// ------------------------------------------------------------------ probes
test('liveness is open, readiness reports the missing Postgres', async () => {
    assert.equal((await api('/healthz')).status, 200);
    // 503 rather than a crash: no n8n database is reachable in this environment.
    assert.equal((await api('/readyz')).status, 503);
});

// B-7. The unauthenticated part is the whole point and it is easy to lose:
// every router under /api calls router.use(authenticateToken) with no path, so
// this route only stays open while it is declared ABOVE them in server.js.
// Moving it down looks harmless and turns it into a 401 — which defeats the
// reason it exists, since the person who most needs the version is the one who
// cannot log in.
test('the version endpoint answers without a token, from package.json', async () => {
    const res = await api('/api/version');
    assert.equal(res.status, 200);
    assert.equal(res.body.version, require('../package.json').version);
    assert.equal(res.body.node, process.version);
    // Reported even when nothing stamped it, so the field is never absent.
    assert.ok(typeof res.body.commit === 'string' && res.body.commit.length > 0);
});

// ------------------------------------------------------------------- auth
test('every API route refuses an anonymous caller', async () => {
    const routes = [
        '/api/analytics/metrics', '/api/analytics/executions', '/api/analytics/slowest',
        '/api/analytics/errors', '/api/analytics/roi', '/api/analytics/first-execution-date',
        '/api/analytics/execution-volume', '/api/analytics/error-intelligence',
        '/api/settings', '/api/settings/roi', '/api/chat-history', '/api/health/deep',
        '/api/analytics/triggers', '/api/analytics/queue-lag', '/api/analytics/storage',
        '/api/analytics/reliability', '/api/analytics/concurrency',
        '/api/analytics/silent-workflows', '/api/workflows',
        '/api/analytics/organisation', '/api/analytics/dependencies',
        '/api/analytics/deploys', '/api/analytics/metadata', '/api/analytics/system',
        '/api/analytics/node-profile', '/api/executions/1/trace'
    ];
    for (const r of routes) {
        assert.equal((await api(r)).status, 401, `${r} answered an anonymous caller`);
    }
});

test('an unusable token is 401, not 403', async () => {
    // The distinction the frontend depends on: 401 clears the session, 403 shows
    // a message. While a bad token answered 403, every authorization refusal in
    // the app logged the user out instead of explaining itself.
    assert.equal((await api('/api/analytics/slowest', { token: 'not-a-jwt' })).status, 401);
});

// ------------------------------------------------------------- read endpoints
test('every read endpoint answers with data', async () => {
    const checks = [
        ['/api/analytics/metrics', (b) => b.summary.total === SEEDED && b.topWorkflows.length === 2],
        ['/api/analytics/executions?limit=50', (b) => b.length === SEEDED],
        ['/api/analytics/slowest', (b) => b.length === 2],
        ['/api/analytics/errors', (b) => b.length > 0],
        ['/api/analytics/roi', (b) => Number(b.summary.total_executions) === SEEDED_SUCCESS],
        ['/api/analytics/first-execution-date', (b) => typeof b.firstDate === 'string'],
        ['/api/analytics/execution-volume', (b) => Array.isArray(b)],
        ['/api/analytics/error-intelligence', (b) => 'summary' in b && 'categories' in b],
        ['/api/settings', (b) => typeof b === 'object'],
        ['/api/settings/roi', (b) => b.length === 3],
        // No longer a bare array. The chat is threaded now, so this answers
        // "which conversation, and what is in it" — and `conversation: null` for
        // a user who has never asked anything is a real answer rather than an
        // empty list pretending to be one.
        ['/api/chat-history',
            (b) => Array.isArray(b.messages) && 'conversation' in b],
        ['/api/analytics/execution-volume/details?time=' +
            encodeURIComponent(new Date(Date.now() - 600000).toISOString()) + '&window=60',
            (b) => Array.isArray(b) && b.length > 0]
    ];
    for (const [route, ok] of checks) {
        const r = await api(route, { token: OWNER });
        assert.equal(r.status, 200, `${route} -> ${r.status} ${JSON.stringify(r.body)}`);
        assert.ok(ok(r.body), `${route} returned unexpected shape: ${JSON.stringify(r.body).slice(0, 200)}`);
    }
});

test('the chart and its drill-down count the same thing', async () => {
    // L-30: they used to answer different questions — the chart counted starts,
    // the drill-down counted overlaps, so a bar of height 12 could open a list of
    // 30 rows and neither number was wrong.
    //
    // Asked for an explicit range rather than the default. The default reads the
    // series the ETL caches, and the ETL is deliberately not running here.
    const start = new Date(Date.now() - 3 * 3600000).toISOString();
    const end = new Date(Date.now() + 3600000).toISOString();
    const series = await api(
        `/api/analytics/execution-volume?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
        { token: OWNER });
    assert.equal(series.status, 200);

    const filled = series.body.filter((b) => b.started_count > 0);
    assert.ok(filled.length > 0, 'the seeded executions should land in some bucket');
    assert.equal(
        series.body.reduce((a, b) => a + b.started_count, 0), SEEDED,
        'every seeded execution should be counted exactly once');

    for (const bucket of filled.slice(0, 5)) {
        const drill = await api(
            `/api/analytics/execution-volume/details?time=${encodeURIComponent(bucket.timestamp)}&window=5`,
            { token: OWNER });
        assert.equal(drill.body.length, bucket.started_count,
            `bar and drill-down disagree at ${bucket.timestamp}`);
        for (const row of drill.body) {
            assert.ok(row.startedAt >= bucket.timestamp, 'a row started before its bucket');
        }
    }
});

// ------------------------------------------------------------------- insights
test('the trigger breakdown splits what the blended rate hides', async () => {
    // The whole claim of F-02: one aggregate error rate describes neither mode.
    // The fixture puts every failure on webhooks, so a breakdown that quietly
    // aggregated would report the same rate twice instead of 0% and something.
    const r = await api('/api/analytics/triggers', { token: OWNER });
    assert.equal(r.status, 200);

    const byMode = Object.fromEntries(r.body.modes.map((m) => [m.mode, m]));
    assert.ok(byMode.webhook && byMode.trigger, `expected both modes, got ${Object.keys(byMode)}`);
    assert.equal(byMode.webhook.errors, 8, 'every seeded failure is a webhook');
    assert.equal(byMode.trigger.errors, 0, 'no schedule failed');
    assert.ok(byMode.webhook.error_rate > byMode.trigger.error_rate,
        'the split is the point — these must not be the same number');

    // Every mode's series is dense and sums back to its own total, so a chart
    // cannot silently drop a bucket.
    for (const m of r.body.modes) {
        const series = r.body.series[m.mode];
        assert.ok(Array.isArray(series) && series.length > 0, `no series for ${m.mode}`);
        assert.equal(series.reduce((a, p) => a + p.total, 0), m.total,
            `series for ${m.mode} does not sum to its total`);
    }

    // Nothing was pruned out of this fixture, so coverage has to say so.
    assert.equal(r.body.coverage.complete, true);
    assert.equal(r.body.coverage.pct, 100);
});

test('queue lag percentiles are ordered and measured, not invented', async () => {
    const r = await api('/api/analytics/queue-lag', { token: OWNER });
    assert.equal(r.status, 200);

    const s = r.body.summary;
    assert.equal(s.n, SEEDED, 'every seeded row has a createdAt');
    // Lags run from 10 ms to 49 ms by construction.
    assert.ok(s.p50 >= 10 && s.p50 <= 49, `p50 out of range: ${s.p50}`);
    assert.ok(s.p50 <= s.p95 && s.p95 <= s.p99 && s.p99 <= s.max_ms,
        `percentiles out of order: ${JSON.stringify(s)}`);
    assert.equal(s.negative, 0, 'no row should start before it was created');

    // Per mode, and the parts add up to the whole.
    assert.equal(r.body.byMode.reduce((a, m) => a + m.n, 0), SEEDED);

    const filtered = await api('/api/analytics/queue-lag?mode=trigger', { token: OWNER });
    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.summary.n < s.n, 'a mode filter must narrow the sample');
    assert.equal(filtered.body.byMode.length, 1);
});

test('reliability separates a failure that stayed failed from one that did not', async () => {
    const r = await api('/api/analytics/reliability', { token: OWNER });
    assert.equal(r.status, 200);

    assert.equal(r.body.total, SEEDED);
    assert.equal(r.body.retry_attempts, 1, 'one row is a retry of another');
    assert.equal(r.body.first_attempts, SEEDED - 1, 'a retry is not a first attempt');
    assert.equal(r.body.raw.failures, 8);
    assert.equal(r.body.self_healed, 1, 'execution 1000 failed and its retry succeeded');
    assert.equal(r.body.effective.failures, 7);
    assert.ok(r.body.effective.rate < r.body.raw.rate,
        'the effective rate must be the lower of the two once a retry has succeeded');

    // finished vs status: the fixture keeps them consistent, so nothing should
    // be flagged as disagreeing.
    assert.equal(r.body.finished.unfinished, 8);
    assert.equal(r.body.finished.unfinished_success, 0);
    assert.equal(r.body.finished.finished_failure, 0);
});

test('the storage forecast refuses to project from a day and a half of data', async () => {
    const r = await api('/api/analytics/storage', { token: OWNER });
    assert.equal(r.status, 200);

    // Sum of 1000..40000 plus the retry's 500.
    assert.equal(r.body.totals.json_bytes, 820500);
    assert.equal(r.body.totals.executions, SEEDED);
    assert.ok(r.body.byWorkflow.length >= 2);
    assert.ok(r.body.byWorkflow[0].json_bytes >= r.body.byWorkflow[1].json_bytes,
        'the heaviest workflow comes first');

    // One day of fixture cannot support a trend, and saying so is the correct
    // answer — inventing a projection from it would be worse than none.
    assert.equal(r.body.forecast.known, false);
    assert.match(r.body.forecast.reason, /days/);
});

test('fingerprinting collapses the same problem into one group', async () => {
    // Eight failures whose messages differ only in a row number. Under the old
    // (category, node_name, SUBSTR) rule that is eight groups; it must be one.
    const r = await waitFor(async () => {
        const res = await api('/api/analytics/error-intelligence', { token: OWNER });
        return res.body && res.body.errorGroups && res.body.errorGroups.length > 0 ? res : null;
    }, 'the background fingerprint pass');
    assert.equal(r.status, 200);
    assert.equal(r.body.grouping.by, 'fingerprint');

    assert.equal(r.body.errorGroups.length, 1,
        `expected one group, got ${r.body.errorGroups.map((g) => g.normalized_message)}`);

    const g = r.body.errorGroups[0];
    assert.equal(g.count, 8);
    assert.match(g.fingerprint, /^[0-9a-f]{16}$/);
    assert.equal(g.normalized_message, 'Row <N> not found');
    assert.equal(g.error_category, 'data');
    assert.equal(g.category_count, 1);
    assert.equal(g.status, 'open', 'a fingerprint nobody has triaged is open');
    assert.equal(g.affected_workflows, 2);
    assert.ok(g.is_new, 'nothing was seen before this window');

    // F-08: each failure is followed by a success of the same workflow, so
    // behaviourally this recovers — whatever its category says.
    //
    // Seven of eight, not eight: the most recent failure is the newest execution
    // of its workflow, so there is no next run to have succeeded yet. That is the
    // honest answer at the edge of the data and not an off-by-one — a query that
    // returned 8 here would be counting a recovery that has not happened.
    assert.equal(g.observed, 8);
    assert.equal(g.recovered, 7);
    assert.equal(g.behaviour, 'transient');
    assert.equal(g.recovery_rate, 87.5);
    // 'data' is not in the static transient set, so the measurement contradicts
    // the label — which is the whole finding of F-08.
    assert.equal(g.label_disagrees, true);
    assert.equal(r.body.summary.mislabelled_groups, 1);
    assert.equal(r.body.summary.transient_observed, 8);
    assert.equal(r.body.summary.structural_observed, 0);
});

test('the group drill-down is keyed on the fingerprint and validates it', async () => {
    const groups = await waitFor(async () => {
        const res = await api('/api/analytics/error-intelligence', { token: OWNER });
        return res.body && res.body.errorGroups && res.body.errorGroups.length > 0 ? res : null;
    }, 'the background fingerprint pass');
    const fp = groups.body.errorGroups[0].fingerprint;

    const ok = await api('/api/analytics/error-group-executions', {
        token: OWNER,
        method: 'POST',
        body: {
            fingerprint: fp,
            startDate: new Date(Date.now() - 86400000).toISOString(),
            endDate: new Date(Date.now() + 3600000).toISOString()
        }
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.executions.length, 8, 'the drill-down must agree with the group count');

    // A malformed fingerprint answered with an empty list would read as "no
    // occurrences", which is a different statement from "that is not an id".
    for (const bad of ['nope', '', null, 'ABCDEF0123456789', '0123456789abcdefx']) {
        const r = await api('/api/analytics/error-group-executions', {
            token: OWNER,
            method: 'POST',
            body: {
                fingerprint: bad,
                startDate: new Date(Date.now() - 86400000).toISOString(),
                endDate: new Date().toISOString()
            }
        });
        assert.equal(r.status, 400, `${JSON.stringify(bad)} should be refused`);
    }
});

test('every fingerprint gets a row of its own to carry state', async () => {
    const rows = await waitFor(async () => {
        const db = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
        const r = await new Promise((resolve, reject) => {
            db.all('SELECT * FROM error_fingerprints', (e, x) => (e ? reject(e) : resolve(x)));
        });
        db.close();
        return r.length ? r : null;
    }, 'the fingerprint registry to be populated');

    assert.equal(rows.length, 1);
    assert.equal(rows[0].normalized_message, 'Row <N> not found');
    assert.equal(rows[0].status, 'open');
    assert.equal(rows[0].version, 1);
    assert.ok(rows[0].first_seen, 'first_seen is a watermark and must be set');
    assert.ok(rows[0].sample_message.startsWith('Row '),
        'the sample is a real message, not the normalised shape');
});

test('concurrency reports simultaneity, and it is far below the start count', async () => {
    // The fixture starts 40 executions one minute apart, each lasting 2.5
    // seconds — so nothing ever overlaps and the answer must be 1, however many
    // started. That gap is the entire point of F-06.
    const r = await api('/api/analytics/concurrency', { token: OWNER });
    assert.equal(r.status, 200);

    assert.equal(r.body.summary.peak, 1, 'no two seeded executions overlap');
    assert.equal(r.body.summary.unresolved, 0);
    assert.equal(r.body.summary.open_ended, 0);
    assert.ok(r.body.summary.busy_pct > 0 && r.body.summary.busy_pct < 20,
        `2.5s per minute is a few percent busy, got ${r.body.summary.busy_pct}`);

    // The series still reports the starts, so the two numbers sit side by side.
    const started = r.body.series.reduce((a, p) => a + p.started, 0);
    assert.equal(started, r.body.summary.executions);
    assert.ok(started > r.body.summary.peak,
        'starts must exceed simultaneity here — otherwise the panel says nothing');

    assert.equal(r.body.limit, null, 'no ceiling configured by default');
});

test('the concurrency limit is a validated setting, not a free-form value', async () => {
    for (const bad of ['0', '-3', 'lots', '2.5', '100000']) {
        const r = await api('/api/settings', {
            token: OWNER, method: 'POST', body: { key: 'concurrency_limit', value: bad }
        });
        assert.equal(r.status, 400, `${bad} should be refused`);
    }

    assert.equal((await api('/api/settings', {
        token: OWNER, method: 'POST', body: { key: 'concurrency_limit', value: '5' }
    })).status, 200);

    const withLimit = await api('/api/analytics/concurrency', { token: OWNER });
    assert.equal(withLimit.body.limit, 5);

    // Clearable — a limit set once must not be permanent.
    assert.equal((await api('/api/settings', {
        token: OWNER, method: 'POST', body: { key: 'concurrency_limit', value: '' }
    })).status, 200);
    assert.equal((await api('/api/analytics/concurrency', { token: OWNER })).body.limit, null);
});

test('silence is measured against the data, not against the clock', async () => {
    // The trap this endpoint exists to avoid. The seeded executions all happened
    // in the last 40 minutes, so nothing is late — but if silence were measured
    // as `now - lastRun` on a replica whose sync had stalled, every scheduled
    // workflow would report as dead at once. That is not hypothetical: the first
    // version of this flagged five workflows during a three-hour sync outage,
    // and all five were running perfectly.
    const r = await api('/api/analytics/silent-workflows', { token: OWNER });
    assert.equal(r.status, 200);

    assert.ok(r.body.data_as_of, 'the clock it measured against must be reported');
    assert.equal(typeof r.body.replica_lag_ms, 'number');
    assert.equal(r.body.silent.length, 0, 'nothing in this fixture is overdue');

    // wf-a and wf-b are active and running; wf-z is archived and must be
    // excluded outright, because not running is what archived means.
    const named = [...r.body.silent, ...r.body.dormant, ...r.body.running,
        ...r.body.never_observed].map((w) => w.id);
    assert.ok(!named.includes('wf-z'), 'an archived workflow is not a silent one');
    assert.ok(named.includes('wf-a') && named.includes('wf-b'));
});

test('a workflow that misses its own cadence is caught', async () => {
    // k is the number of missed intervals that counts as silent. The seeded
    // workflows run once a minute; at a low enough threshold the most recent gap
    // still must not trip, and at an absurd one nothing may.
    const strict = await api('/api/analytics/silent-workflows?k=1.5', { token: OWNER });
    assert.equal(strict.status, 200);
    const loose = await api('/api/analytics/silent-workflows?k=100', { token: OWNER });
    assert.equal(loose.body.silent.length, 0);
    assert.ok(strict.body.silent.length >= loose.body.silent.length,
        'a stricter threshold cannot find fewer');

    // Every workflow lands in exactly one bucket.
    const total = strict.body.silent.length + strict.body.dormant.length +
        strict.body.running.length + strict.body.never_observed.length;
    assert.equal(total, 2, 'two active, non-archived workflows, each counted once');
});

test('the workflow inventory carries the archived flag and sorts it last', async () => {
    const r = await api('/api/workflows', { token: OWNER });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 3);

    const zeta = r.body.find((w) => w.id === 'wf-z');
    assert.ok(zeta, 'the archived workflow must still be returned — the caller decides');
    assert.equal(zeta.is_archived, 1);
    assert.equal(r.body[r.body.length - 1].id, 'wf-z', 'archived rows sort last');
    assert.equal(zeta.last_run, null, 'it has never run');
});

test('a mode filter narrows every view that accepts one, drill-down included', async () => {
    const all = await api('/api/analytics/metrics', { token: OWNER });
    const hooks = await api('/api/analytics/metrics?mode=webhook', { token: OWNER });
    const sched = await api('/api/analytics/metrics?mode=trigger', { token: OWNER });
    assert.equal(hooks.status, 200);
    assert.equal(hooks.body.summary.total + sched.body.summary.total + 1, all.body.summary.total,
        'webhook + trigger + the one retry should account for every execution');
    assert.equal(sched.body.summary.error, 0);

    const rows = await api('/api/analytics/executions?limit=50&mode=trigger', { token: OWNER });
    assert.ok(rows.body.length > 0);
    assert.ok(rows.body.every((e) => e.mode === 'trigger'), 'a filtered list must contain only that mode');

    // The L-30 invariant, under the new filter: a bar and the list behind it
    // have to be counting the same rows.
    const start = new Date(Date.now() - 3 * 3600000).toISOString();
    const end = new Date(Date.now() + 3600000).toISOString();
    const series = await api('/api/analytics/execution-volume' +
        `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&mode=webhook`,
        { token: OWNER });
    assert.equal(series.status, 200);
    const filled = series.body.filter((b) => b.started_count > 0);
    assert.ok(filled.length > 0);
    for (const bucket of filled.slice(0, 5)) {
        const drill = await api('/api/analytics/execution-volume/details' +
            `?time=${encodeURIComponent(bucket.timestamp)}&window=5&mode=webhook`, { token: OWNER });
        assert.equal(drill.body.length, bucket.started_count,
            `filtered bar and drill-down disagree at ${bucket.timestamp}`);
        assert.ok(drill.body.every((row) => row.mode === 'webhook'));
    }
});

test('the credential mirror has no column that could hold a secret', async () => {
    // The single most important assertion in this file. credentials_entity.data
    // is the encrypted credential blob; the dashboard has no use for it and a
    // future edit that adds it back would be a serious mistake made silently.
    const db = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
    const cols = await new Promise((resolve, reject) => {
        db.all('PRAGMA table_info(credentials_entity)', (e, r) => (e ? reject(e) : resolve(r)));
    });
    const history = await new Promise((resolve, reject) => {
        db.all('PRAGMA table_info(workflow_history)', (e, r) => (e ? reject(e) : resolve(r)));
    });
    db.close();

    const names = cols.map((c) => c.name);
    assert.ok(names.length > 0, 'the table should exist');
    assert.ok(!names.includes('data'), `credentials_entity must not carry a data column: ${names}`);

    // Same idea one table over: `nodes` and `connections` are the workflow
    // definition itself, and mirroring them would turn a metadata replica into a
    // copy of the customer's automations.
    const hNames = history.map((c) => c.name);
    assert.ok(!hNames.includes('nodes') && !hNames.includes('connections'),
        `workflow_history must not carry the definition: ${hNames}`);
});

test('a folder or tag filter narrows every endpoint that takes one', async () => {
    // The filter has to compose with authorization rather than replace it, and it
    // has to reach the same endpoints the dashboard reads — otherwise two panels
    // on one screen describe different sets of workflows.
    for (const route of ['/api/analytics/metrics', '/api/analytics/executions',
        '/api/analytics/triggers', '/api/analytics/error-intelligence']) {
        const bad = await api(`${route}?folder=${encodeURIComponent('not a folder!')}`, { token: OWNER });
        assert.equal(bad.status, 400, `${route} should refuse a malformed folder id`);
    }

    // An id that is well-formed but names nothing is refused, and this assertion
    // used to say the opposite — "returns an empty answer rather than an error,
    // that is a real if uninteresting result". It is not. A zero that means
    // "nothing happened in this folder" and a zero that means "you asked about a
    // folder that does not exist" are different answers, and the page rendered
    // them identically: every figure at zero, 200 OK, nothing to distinguish
    // them. Same failure class as the bug that motivated `filterFor`, and the
    // same rule F-24 §1 already states for charts — empty ≠ zero.
    const missing = await api('/api/analytics/metrics?folder=nosuchfolder', { token: OWNER });
    assert.equal(missing.status, 400, 'an id naming nothing is refused, not answered with zeroes');
    assert.match(missing.body.error, /no folder with id/i);
    assert.match(missing.body.error, /nosuchfolder/, 'and it names the offending filter');

    // A folder that EXISTS and is simply empty still answers zero, which is the
    // half of this that must not change. Making a real empty set into a 400
    // would be the same mistake pointed the other way.
    const realButEmpty = await api(`/api/analytics/metrics?folder=${EMPTY_FOLDER}`, { token: OWNER });
    assert.equal(realButEmpty.status, 200, 'a real folder with nothing in it is a real zero');
    assert.equal(realButEmpty.body.summary.total, 0);

    // And with no filter, everything is still there.
    const all = await api('/api/analytics/metrics', { token: OWNER });
    assert.equal(all.body.summary.total, SEEDED);
});

test('deploy comparison pairs versions within one workflow', async () => {
    const r = await api('/api/analytics/deploys', { token: OWNER });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.deploys));
    // No history is seeded, so there is nothing to compare — and the endpoint
    // must say that rather than invent a baseline.
    assert.equal(r.body.deploys.length, 0);
    assert.equal(typeof r.body.orphan_versions, 'number');
});

// ------------------------------------------------------------------ alerting
test('the alert form is built from the server vocabulary, not a copy of it', async () => {
    // /api/alerts/schema exists so a rule type cannot be in the engine and
    // missing from the form, or shown with the wrong units next to it.
    const r = await api('/api/alerts/schema', { token: OWNER });
    assert.equal(r.status, 200);

    const types = r.body.ruleTypes.map((t) => t.type);
    for (const expected of ['new_fingerprint', 'error_rate', 'silent_death', 'queue_lag',
        'volume_drop', 'payload_spike', 'db_growth']) {
        assert.ok(types.includes(expected), `${expected} is missing from the schema`);
    }
    // Every type that takes a threshold must say what the number means.
    for (const t of r.body.ruleTypes) {
        assert.ok(t.label && t.description, `${t.type} has no description`);
        if (t.threshold) {
            assert.ok(t.threshold.unit, `${t.type} has a threshold with no unit`);
            assert.ok(t.threshold.hint, `${t.type} has a threshold with no explanation`);
            assert.ok(t.threshold.min < t.threshold.max);
        }
    }
    assert.ok(r.body.channelTypes.some((c) => c.type === 'n8n_workflow'));
});

test('configuring alerting is owner-only, seeing it is not', async () => {
    const rule = { name: 'members cannot', type: 'error_rate', threshold: 50 };
    assert.equal((await api('/api/alerts/rules', {
        token: MEMBER, method: 'POST', body: rule
    })).status, 403);

    // Reading is open: knowing what the instance watches is not privileged, and
    // a channel's secret never leaves the server anyway.
    assert.equal((await api('/api/alerts/rules', { token: MEMBER })).status, 200);
    assert.equal((await api('/api/alerts/channels', { token: MEMBER })).status, 200);
});

test('a rule is refused unless its threshold makes sense for its type', async () => {
    const bad = [
        [{ name: 'no type', type: 'nonsense', threshold: 1 }, /Unknown rule type/],
        [{ name: '', type: 'error_rate', threshold: 5 }, /name/],
        // 500% of executions cannot fail.
        [{ name: 'impossible', type: 'error_rate', threshold: 500 }, /between/],
        // A multiplier below one means "fires when it gets better".
        [{ name: 'backwards', type: 'silent_death', threshold: 0.5 }, /between/],
        [{ name: 'bad window', type: 'error_rate', threshold: 5, window_minutes: 0 }, /window_minutes/],
        [{ name: 'bad scope', type: 'error_rate', threshold: 5, workflow_id: 'no spaces!' }, /workflow_id/]
    ];
    for (const [body, pattern] of bad) {
        const r = await api('/api/alerts/rules', { token: OWNER, method: 'POST', body });
        assert.equal(r.status, 400, `${JSON.stringify(body)} should be refused`);
        assert.match(r.body.error, pattern);
    }
});

test('a channel refuses a destination an alert should never reach', async () => {
    // Link-local is the cloud metadata endpoint. No configuration allows it.
    const meta = await api('/api/alerts/channels', {
        token: OWNER, method: 'POST',
        body: { name: 'metadata', type: 'webhook', config: { url: 'http://169.254.169.254/latest/' } }
    });
    assert.equal(meta.status, 400);
    assert.match(meta.body.error, /link-local/);

    for (const url of ['ftp://example.com/x', 'not-a-url']) {
        const r = await api('/api/alerts/channels', {
            token: OWNER, method: 'POST', body: { name: 'bad', type: 'webhook', config: { url } }
        });
        assert.equal(r.status, 400, `${url} should be refused`);
    }
});

test('an alert fires once, is delivered, and the cooldown holds the rest', async () => {
    sinkReceived.length = 0;

    const channel = await api('/api/alerts/channels', {
        token: OWNER, method: 'POST',
        body: {
            name: 'test sink', type: 'webhook',
            config: { url: sinkUrl(), header_name: 'X-Token', header_value: 's3cret' }
        }
    });
    assert.equal(channel.status, 201);

    // The fixture is 8 failures in 41 executions — about 20%. A 5% threshold
    // fires; the min_executions guard is satisfied by the 20-odd runs each
    // workflow has.
    const rule = await api('/api/alerts/rules', {
        token: OWNER, method: 'POST',
        body: {
            name: 'anything failing', type: 'error_rate', threshold: 5,
            window_minutes: 1440, min_executions: 5,
            channel_id: channel.body.id, cooldown_minutes: 60
        }
    });
    assert.equal(rule.status, 201);

    const first = await api('/api/alerts/run?force=true', { token: OWNER, method: 'POST' });
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'ok');
    assert.ok(first.body.fired > 0, 'a workflow failing 20% of the time should fire a 5% rule');
    assert.equal(first.body.delivered, first.body.fired, 'everything that fired should have been sent');

    // The real request, received by a real server.
    assert.equal(sinkReceived.length, first.body.fired);
    const got = sinkReceived[0];
    assert.equal(got.method, 'POST');
    assert.equal(got.headers['x-token'], 's3cret', 'the configured header must be sent');
    assert.equal(got.body.source, 'n8n-analytics');
    assert.equal(got.body.rule, 'anything failing');
    assert.ok(got.body.title.includes('%'), 'the alert should say how bad it is');
    assert.ok(got.body.data && typeof got.body.data.rate === 'number',
        'the numbers behind the sentence travel with it');

    // Second pass, nothing changed: the cooldown must hold it.
    const before = sinkReceived.length;
    const second = await api('/api/alerts/run?force=true', { token: OWNER, method: 'POST' });
    assert.equal(second.body.fired, 0, 'the same subject must not alert twice inside the cooldown');
    assert.ok(second.body.suppressed > 0, 'and the suppression must be visible, not silent');
    assert.equal(sinkReceived.length, before, 'nothing more was sent');

    // The event log records what happened, including who it was about.
    const events = await api('/api/alerts/events', { token: OWNER });
    assert.equal(events.status, 200);
    assert.ok(events.body.length >= first.body.fired);
    assert.equal(events.body[0].delivery_status, 'sent');
    assert.ok(events.body[0].subject_label, 'an alert has to name its subject');
});

test('a channel test reports a failure as a failure, not as an error', async () => {
    const channel = await api('/api/alerts/channels', {
        token: OWNER, method: 'POST',
        body: { name: 'sometimes broken', type: 'webhook', config: { url: sinkUrl() } }
    });

    sinkStatus = 500;
    const bad = await api(`/api/alerts/channels/${channel.body.id}/test`, {
        token: OWNER, method: 'POST'
    });
    // The caller asked whether it works and got an answer. That is a successful
    // request reporting a failure, not a failed request.
    assert.equal(bad.status, 200);
    assert.equal(bad.body.ok, false);
    assert.match(bad.body.error, /500/);

    sinkStatus = 200;
    const good = await api(`/api/alerts/channels/${channel.body.id}/test`, {
        token: OWNER, method: 'POST'
    });
    assert.equal(good.body.ok, true);

    // The result sticks to the channel, so one that has been quietly failing is
    // visible without reading the whole event log.
    const list = await api('/api/alerts/channels', { token: OWNER });
    const mine = list.body.find((c) => c.id === channel.body.id);
    assert.ok(mine.last_ok_at);
});

test('a channel secret never leaves the server, and editing does not wipe it', async () => {
    const created = await api('/api/alerts/channels', {
        token: OWNER, method: 'POST',
        body: {
            name: 'telegram', type: 'telegram',
            config: { bot_token: 'super-secret-token', chat_id: '12345' }
        }
    });
    assert.equal(created.status, 201);

    const list = await api('/api/alerts/channels', { token: OWNER });
    const mine = list.body.find((c) => c.id === created.body.id);
    assert.notEqual(mine.config.bot_token, 'super-secret-token');
    assert.equal(mine.config.chat_id, '12345', 'a non-secret field is readable');
    assert.equal(JSON.stringify(list.body).includes('super-secret-token'), false,
        'the token must not appear anywhere in the response');

    // Renaming sends the secret back blank, because the form never had it. That
    // must mean "unchanged" rather than "clear it".
    const renamed = await api(`/api/alerts/channels/${created.body.id}`, {
        token: OWNER, method: 'PUT',
        body: { name: 'telegram renamed', type: 'telegram', config: { chat_id: '12345' } }
    });
    assert.equal(renamed.status, 200);

    const db = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
    const rows = await new Promise((resolve, reject) => {
        db.all('SELECT config FROM alert_channels WHERE id = ?', [created.body.id],
            (e, r) => (e ? reject(e) : resolve(r)));
    });
    db.close();
    assert.match(rows[0].config, /super-secret-token/,
        'renaming a channel must not erase its token');
});

test('a rule with no channel still fires and is recorded', async () => {
    const rule = await api('/api/alerts/rules', {
        token: OWNER, method: 'POST',
        body: {
            name: 'recorded only', type: 'error_rate', threshold: 1,
            window_minutes: 1440, min_executions: 5, cooldown_minutes: 0
        }
    });
    assert.equal(rule.status, 201);

    const run = await api('/api/alerts/run?force=true', { token: OWNER, method: 'POST' });
    assert.ok(run.body.fired > 0);

    const events = await api('/api/alerts/events', { token: OWNER });
    const mine = events.body.filter((e) => e.rule_name === 'recorded only');
    assert.ok(mine.length > 0);
    assert.equal(mine[0].delivery_status, 'no_channel',
        'silence about delivery is not the same as delivery');
});

// -------------------------------------------------------- error lifecycle
test('a fingerprint can be triaged, and the decision is recorded with who made it', async () => {
    const groups = await waitFor(async () => {
        const res = await api('/api/analytics/error-intelligence', { token: OWNER });
        return res.body && res.body.errorGroups && res.body.errorGroups.length > 0 ? res : null;
    }, 'the background fingerprint pass');
    const fp = groups.body.errorGroups[0].fingerprint;

    const ack = await api(`/api/fingerprints/${fp}/status`, {
        token: MEMBER, method: 'POST',
        body: { action: 'acknowledge', note: 'looking at it' }
    });
    // Triage is ordinary work, not administration.
    assert.equal(ack.status, 200);
    assert.equal(ack.body.status, 'acknowledged');
    assert.equal(ack.body.status_by, 'm@x');

    const resolved = await api(`/api/fingerprints/${fp}/status`, {
        token: OWNER, method: 'POST', body: { action: 'resolve', note: 'fixed the column name' }
    });
    assert.equal(resolved.body.status, 'resolved');

    const history = await api(`/api/fingerprints/${fp}/history`, { token: OWNER });
    assert.equal(history.status, 200);
    assert.equal(history.body.events.length, 2);
    assert.deepEqual(history.body.events.map((e) => e.action), ['acknowledged', 'resolved']);
    assert.equal(history.body.events[0].actor, 'm@x');
    assert.equal(history.body.fingerprint.notes, 'fixed the column name');

    // Unknown actions and unknown fingerprints are refused rather than ignored.
    assert.equal((await api(`/api/fingerprints/${fp}/status`, {
        token: OWNER, method: 'POST', body: { action: 'obliterate' }
    })).status, 400);
    assert.equal((await api('/api/fingerprints/0000000000000000/status', {
        token: OWNER, method: 'POST', body: { action: 'resolve' }
    })).status, 404);
});

test('a resolved fingerprint stops producing new-failure alerts', async () => {
    // The point of "ignore" and "resolve" is that they are decisions, not
    // cosmetics. A rule that keeps alerting about something you closed is the
    // fastest way to have every alert ignored.
    const groups = await api('/api/analytics/error-intelligence', { token: OWNER });
    const fp = groups.body.errorGroups[0].fingerprint;
    await api(`/api/fingerprints/${fp}/status`, {
        token: OWNER, method: 'POST', body: { action: 'ignore' }
    });

    const rule = await api('/api/alerts/rules', {
        token: OWNER, method: 'POST',
        body: {
            name: 'anything new', type: 'new_fingerprint',
            window_minutes: 1440, min_executions: 1, cooldown_minutes: 0
        }
    });
    assert.equal(rule.status, 201);

    const run = await api('/api/alerts/run?force=true', { token: OWNER, method: 'POST' });
    const events = await api('/api/alerts/events', { token: OWNER });
    assert.equal(events.body.filter((e) => e.rule_name === 'anything new').length, 0,
        'an ignored fingerprint must not alert');
    assert.equal(run.body.status, 'ok');
});

// ------------------------------------------------------------- input validation
test('bad input is 400, never 500', async () => {
    const bad = [
        '/api/analytics/metrics?startDate=foo&endDate=bar',
        '/api/analytics/metrics?startDate=2026-08-20T00:00:00Z',            // only one bound
        '/api/analytics/metrics?startDate=2026-08-20T00:00:00Z&endDate=2026-08-01T00:00:00Z', // backwards
        '/api/analytics/executions?status=not-a-status',
        '/api/analytics/execution-volume/details?time=nonsense',
        // An unknown mode matches nothing, and an empty chart is indistinguishable
        // from a quiet day. The 400 is what tells the two apart.
        '/api/analytics/metrics?mode=not-a-mode',
        '/api/analytics/executions?mode=not-a-mode',
        '/api/analytics/queue-lag?mode=not-a-mode',
        '/api/analytics/execution-volume?mode=not-a-mode'
    ];
    for (const route of bad) {
        const r = await api(route, { token: OWNER });
        assert.equal(r.status, 400, `${route} -> ${r.status}`);
        assert.ok(r.body && r.body.error, 'a 400 should say what was wrong');
    }
});

test('a malformed JSON body is 400 and leaks no stack trace', async () => {
    const res = await fetch(BASE + '/api/settings', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + OWNER, 'Content-Type': 'application/json' },
        body: '{not json'
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(!/at .*\(.*:\d+:\d+\)/.test(text), 'response contained a stack trace');
});

// ----------------------------------------------------------------- authorization
test('instance-wide settings are owner-only', async () => {
    assert.equal((await api('/api/settings', {
        token: MEMBER, method: 'POST', body: { key: 'timezone', value: 'UTC' }
    })).status, 403);

    assert.equal((await api('/api/settings', {
        token: OWNER, method: 'POST', body: { key: 'timezone', value: 'Europe/Athens' }
    })).status, 200);

    const after = await api('/api/settings', { token: OWNER });
    assert.equal(after.body.timezone, 'Europe/Athens');
});

test('an unknown setting key is refused and names what is allowed', async () => {
    const r = await api('/api/settings', {
        token: OWNER, method: 'POST', body: { key: 'anything', value: 'x' }
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /timezone/);
});

test('ROI writes validate the workflow and the numbers', async () => {
    assert.equal((await api('/api/settings/roi', {
        token: OWNER, method: 'POST', body: { settings: [{ workflow_id: 'wf-a', saved_time_seconds: 120, hourly_rate: 40 }] }
    })).status, 200);

    const unknown = await api('/api/settings/roi', {
        token: OWNER, method: 'POST', body: { settings: [{ workflow_id: 'does-not-exist', saved_time_seconds: 1, hourly_rate: 1 }] }
    });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /Unknown workflow id/);

    const absurd = await api('/api/settings/roi', {
        token: OWNER, method: 'POST', body: { settings: [{ workflow_id: 'wf-a', saved_time_seconds: 999999, hourly_rate: 1 }] }
    });
    assert.equal(absurd.status, 400);
});

test('the AI assistant no longer refuses a scoped user outright', async () => {
    // The inverse of what this used to assert. The assistant answered 403 to
    // every project member, because a filter cannot be safely appended to a
    // query a model composed — one subquery steps around it. It no longer
    // composes those queries: the restriction now lives inside the views it
    // reads (see the view-scoping test in unit.test.js), so a member can be
    // answered within their own scope.
    //
    // 500 and 503 are both acceptable, because whether OpenAI is configured and
    // reachable is a property of the environment rather than of this behaviour:
    // 503 is what the controller answers when no API key is set, which is the
    // normal state in CI and in any checkout without a key. 403 is not
    // acceptable — that would be the refusal this test exists to catch.
    const r = await api('/api/ai-chat', { token: MEMBER, method: 'POST', body: { message: 'hello' } });
    assert.notEqual(r.status, 403, 'a project member must not be refused outright any more');
    assert.ok([200, 500, 503].includes(r.status), `unexpected ${r.status}`);
});

// -------------------------------------------------------------------- logging
test('every response carries a request id', async () => {
    const r = await api('/api/analytics/slowest', { token: OWNER });
    assert.match(r.headers.get('x-request-id') || '', /^[A-Za-z0-9._-]+$/);
});

test('a caller-supplied request id is honoured, a hostile one is not', async () => {
    const good = await fetch(BASE + '/api/analytics/slowest', {
        headers: { Authorization: 'Bearer ' + OWNER, 'X-Request-Id': 'trace-abc-123' }
    });
    assert.equal(good.headers.get('x-request-id'), 'trace-abc-123');

    const bad = await fetch(BASE + '/api/analytics/slowest', {
        headers: { Authorization: 'Bearer ' + OWNER, 'X-Request-Id': 'a'.repeat(500) }
    });
    assert.notEqual(bad.headers.get('x-request-id'), 'a'.repeat(500));
});

// ----------------------------------------------------------- endpoints needing pg
test('endpoints that need Postgres fail cleanly instead of crashing', async () => {
    const health = await api('/api/health/deep', { token: OWNER });
    assert.equal(health.status, 503);
    assert.match(health.body.postgres, /error/);
    assert.equal(health.body.replica, 'ok', 'the replica should still be reported healthy');

    const login = await api('/api/login', {
        method: 'POST', body: { email: 'nobody@example.com', password: 'x' }
    });
    assert.equal(login.status, 500);

    assert.equal((await api('/api/n8n-health', { token: OWNER })).status, 500);

    // And the process is still up and serving after all of that.
    assert.equal((await api('/api/analytics/slowest', { token: OWNER })).status, 200);
});

// ------------------------------------------------------------------------ F-19
test('the dashboard health panel counts the passes it has, correctly', async () => {
    const r = await api('/api/analytics/system', { token: OWNER });
    assert.equal(r.status, 200);
    const b = r.body;

    // Three of the seeded passes worked. THIS is the regression guard: the first
    // version compared against 'success', a status the ETL never writes, and so
    // reported every healthy pass as a failure. `ok` being 3 rather than 0 is
    // the whole point of the mixed fixture.
    assert.equal(b.runs.ok, 3);
    assert.ok(b.runs.failed >= 1);
    assert.equal(b.runs.total, b.runs.ok + b.runs.failed);
    assert.ok(b.runs.history.length >= 4);
    assert.ok(b.pipeline.consecutive_failures >= 1, 'the newest seeded pass failed');
    assert.ok(b.pipeline.last_success_at, 'the last pass that worked is still findable');
    assert.equal(b.pipeline.status, 'ok', 'a pass two minutes ago is not late');

    // Bounded rather than exact, because the ETL cron in this server can fire
    // during the suite: SYNC_INTERVAL_MINUTES is 59, which cron reads as
    // "minutes 0 and 59 of every hour", and a run that lands then adds a real
    // failed row (there is no Postgres here). That extra row is a fact about
    // the fixture, not a bug — and pinning exact totals against it produced a
    // test that failed roughly once an hour for reasons unrelated to the code.
    assert.ok(b.storage.growth.samples >= 4);
    assert.ok(b.storage.growth.bytes_per_day > 0);
    assert.ok(b.storage.growth.span_hours > 2.5 && b.storage.growth.span_hours < 3.5);

    // Nothing here has run a VACUUM, and the panel does not pretend otherwise.
    assert.equal(b.storage.last_vacuum_at, null);

    // The data half is measured separately from the pipeline half — a sync that
    // succeeds while n8n has gone quiet must not read as fresh data.
    assert.ok(typeof b.data.newest_execution === 'string');
    assert.ok(b.data.data_age_ms >= 0);
    assert.equal(b.data.executions, SEEDED);

    // The file's own header agrees with itself.
    assert.ok(b.storage.bytes > 0);
    assert.equal(b.storage.reclaimable_bytes, b.storage.free_pages * b.storage.page_size);
    assert.ok(b.fingerprints.groups > 0, 'the fixture has fingerprinted errors');
});

test('a finished fingerprint cursor over unfingerprinted rows repairs itself', async () => {
    // The fixture starts with cursor = 'done' and every analytics row null — the
    // shape a half-applied chunk leaves behind. Nothing below a finished cursor
    // is ever re-read, so without the verification at the end of the walk these
    // errors would stay ungrouped for the life of the database, and the only
    // symptom would be a group count quietly too low.
    let left = null;
    for (let i = 0; i < 20; i++) {
        const r = await api('/api/analytics/system', { token: OWNER });
        left = r.body.fingerprints.unfingerprinted;
        if (left === 0) break;
        await sleep(250);
    }
    assert.equal(left, 0, 'the walk should have rewound and filled them in');
});

test('the brief health answer is a strict subset, for the header to poll', async () => {
    const full = await api('/api/analytics/system', { token: OWNER });
    const brief = await api('/api/analytics/system?brief=1', { token: OWNER });
    assert.equal(brief.status, 200);
    assert.equal(brief.body.brief, true);

    // It exists to be cheap: the expensive blocks must genuinely be absent, not
    // merely smaller. If they creep back in, the header starts counting half a
    // million rows on every page load of every page and nothing will say so.
    for (const heavy of ['runs', 'queue', 'fingerprints', 'storage', 'backfills']) {
        assert.ok(!(heavy in brief.body), `brief mode should not compute ${heavy}`);
    }

    // And what it does answer has to agree with the full version, or the header
    // and the settings panel would tell two different stories about one sync.
    assert.equal(brief.body.pipeline.status, full.body.pipeline.status);
    assert.equal(brief.body.pipeline.expected_interval_ms,
        full.body.pipeline.expected_interval_ms);
    assert.equal(brief.body.data.newest_execution, full.body.data.newest_execution);
});

// ------------------------------------------------------------------------ F-12
test('the node profile answers honestly before anything has been profiled', async () => {
    const r = await api('/api/analytics/node-profile', { token: OWNER });
    assert.equal(r.status, 200);
    // No ETL runs here, so nothing has been sampled. The panel has to be able to
    // say that rather than render an empty table that looks like "no slow nodes".
    assert.deepEqual(r.body.nodes, []);
    assert.deepEqual(r.body.workflows, []);
    assert.deepEqual(r.body.flow, []);
    assert.equal(r.body.coverage.profiled_workflows, 0);
    assert.ok(r.body.coverage.active_workflows > 0);
    assert.match(r.body.coverage.note, /have been profiled/);
});

test('the execution trace validates its id before reaching Postgres', async () => {
    // 400, not 500 and not a query. The id goes into a parameterised int cast,
    // so this is about answering the caller rather than about injection.
    for (const bad of ['abc', '-1', '0', '1.5']) {
        const r = await api(`/api/executions/${bad}/trace`, { token: OWNER });
        assert.equal(r.status, 400, `${bad} should be rejected`);
    }
    // A well-formed id with no Postgres behind it fails cleanly, and the process
    // is still serving afterwards.
    const r = await api('/api/executions/1/trace', { token: OWNER });
    assert.equal(r.status, 500);
    assert.equal((await api('/api/analytics/slowest', { token: OWNER })).status, 200);
});

// ============================================ F-24 §4 · multi-header channels
//
// End to end, through the real API and a real receiving server: two headers are
// stored, delivered, redacted on read-back, and — the part most likely to break
// — a masked value submitted unchanged keeps ITS OWN stored secret rather than
// a neighbour's.

test('a channel delivers every custom header it was given', async () => {
    sinkReceived.length = 0;

    const created = await api('/api/alerts/channels', {
        token: OWNER, method: 'POST',
        body: {
            name: 'two-header sink', type: 'webhook',
            config: {
                url: sinkUrl(),
                headers: [
                    { name: 'Authorization', value: 'Bearer alpha' },
                    { name: 'X-Signature', value: 'sha256=beta' }
                ]
            }
        }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const channelId = created.body.id;

    const test1 = await api(`/api/alerts/channels/${channelId}/test`, { token: OWNER, method: 'POST' });
    assert.equal(test1.status, 200, JSON.stringify(test1.body));
    assert.equal(sinkReceived.length, 1);

    const got = sinkReceived[0];
    assert.equal(got.headers.authorization, 'Bearer alpha');
    assert.equal(got.headers['x-signature'], 'sha256=beta');
    // The one header the dashboard owns must survive a config that never
    // mentions it — the body is JSON and unparseable without it.
    assert.equal(got.headers['content-type'], 'application/json');
});

test('header values are masked on read-back, and the names are not', async () => {
    const list = await api('/api/alerts/channels', { token: OWNER });
    const ch = list.body.find((c) => c.name === 'two-header sink');
    assert.ok(ch, 'the channel should be listed');
    assert.equal(ch.config.headers.length, 2);
    for (const h of ch.config.headers) {
        assert.ok(h.name, 'names travel so the form can show which headers exist');
        assert.notEqual(h.value, 'Bearer alpha');
        assert.notEqual(h.value, 'sha256=beta');
    }
    // And the URL, which is not a secret, comes back intact.
    assert.equal(ch.config.url, sinkUrl());
});

test('editing one header keeps the others secret, matched by name not position', async () => {
    sinkReceived.length = 0;
    const list = await api('/api/alerts/channels', { token: OWNER });
    const ch = list.body.find((c) => c.name === 'two-header sink');
    const masked = ch.config.headers.find((h) => h.name === 'X-Signature').value;

    // Submitted in the OPPOSITE order to how they are stored, with one edited
    // and one left masked. If blank-means-keep resolved by index instead of by
    // name, X-Signature would come back holding Authorization's secret.
    const updated = await api(`/api/alerts/channels/${ch.id}`, {
        token: OWNER, method: 'PUT',
        body: {
            name: 'two-header sink', type: 'webhook',
            config: {
                url: sinkUrl(),
                headers: [
                    { name: 'X-Signature', value: masked },
                    { name: 'Authorization', value: 'Bearer GAMMA' }
                ]
            }
        }
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));

    const test2 = await api(`/api/alerts/channels/${ch.id}/test`, { token: OWNER, method: 'POST' });
    assert.equal(test2.status, 200, JSON.stringify(test2.body));
    const got = sinkReceived[sinkReceived.length - 1];
    assert.equal(got.headers.authorization, 'Bearer GAMMA', 'the edited header took its new value');
    assert.equal(got.headers['x-signature'], 'sha256=beta', 'the untouched header kept its own secret');
});

test('removing every header actually removes them', async () => {
    sinkReceived.length = 0;
    const list = await api('/api/alerts/channels', { token: OWNER });
    const ch = list.body.find((c) => c.name === 'two-header sink');

    const updated = await api(`/api/alerts/channels/${ch.id}`, {
        token: OWNER, method: 'PUT',
        body: { name: 'two-header sink', type: 'webhook', config: { url: sinkUrl(), headers: [] } }
    });
    assert.equal(updated.status, 200);

    await api(`/api/alerts/channels/${ch.id}/test`, { token: OWNER, method: 'POST' });
    const got = sinkReceived[sinkReceived.length - 1];
    assert.equal(got.headers.authorization, undefined);
    assert.equal(got.headers['x-signature'], undefined);
    assert.equal(got.headers['content-type'], 'application/json', 'ours still goes');
});

test('a reserved header is refused rather than quietly dropped', async () => {
    const r = await api('/api/alerts/channels', {
        token: OWNER, method: 'POST',
        body: {
            name: 'bad headers', type: 'webhook',
            config: { url: sinkUrl(), headers: [{ name: 'Content-Type', value: 'text/plain' }] }
        }
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Content-Type/i);
});

// ============================================ F-24 §4 · cURL in and out

test('a pasted curl fills in the URL and the headers', async () => {
    const r = await api('/api/alerts/channels/parse-curl', {
        token: OWNER, method: 'POST',
        body: {
            command: `curl -X POST '${sinkUrl()}' ` +
                `-H 'Content-Type: application/json' -H 'Authorization: Bearer abc' -d '{"a":1}'`
        }
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.url, sinkUrl());
    // Content-Type is ours to set, so a pasted one is dropped with a note
    // rather than refused — it is the commonest header in any curl example.
    assert.deepEqual(r.body.headers, [{ name: 'Authorization', value: 'Bearer abc' }]);
    assert.ok(r.body.notes.length, 'the dropped body and header should be reported, not silent');
});

test('a pasted curl aimed somewhere the server may not reach is refused at paste time', async () => {
    // The same validateUrl every typed URL goes through. Refused here, where
    // the person can still see what they pasted, rather than at save time.
    const r = await api('/api/alerts/channels/parse-curl', {
        token: OWNER, method: 'POST',
        body: { command: 'curl -X POST http://169.254.169.254/latest/meta-data/' }
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /link-local/i);
});

test('a paste carrying a second shell command is refused, not half-read', async () => {
    const r = await api('/api/alerts/channels/parse-curl', {
        token: OWNER, method: 'POST',
        body: { command: `curl ${sinkUrl()}; rm -rf /` }
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /unquoted/);
});

test('exporting a channel as curl never hands back a stored secret', async () => {
    const created = await api('/api/alerts/channels', {
        token: OWNER, method: 'POST',
        body: {
            name: 'export me', type: 'webhook',
            config: { url: sinkUrl(), headers: [{ name: 'Authorization', value: 'Bearer TOPSECRET' }] }
        }
    });
    assert.equal(created.status, 201);

    const r = await api(`/api/alerts/channels/${created.body.id}/curl`, { token: OWNER });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.command.includes('curl'));
    assert.ok(r.body.command.includes(sinkUrl()));
    assert.ok(r.body.command.includes('Authorization'), 'the header name is useful and not secret');
    assert.ok(!r.body.command.includes('TOPSECRET'),
        'this API has never read a stored secret back, and a shell-shaped response is no exception');
    assert.equal(r.body.redacted, true);
    assert.match(r.body.note, /masked/i);
});

// ============================================ F-24 §3 · ?mode= on error intel

test('the error page can be filtered by trigger type', async () => {
    const all = await api('/api/analytics/error-intelligence', { token: OWNER });
    assert.equal(all.status, 200);

    const webhook = await api('/api/analytics/error-intelligence?mode=webhook', { token: OWNER });
    assert.equal(webhook.status, 200, JSON.stringify(webhook.body));
    assert.equal(webhook.body.mode, 'webhook', 'the applied filter is echoed so the page can say so');

    // A filter can only ever narrow. This is the assertion that would catch the
    // filter being attached to the wrong table or dropped from a query.
    assert.ok(webhook.body.summary.total_errors <= all.body.summary.total_errors);
    assert.ok(webhook.body.summary.total_executions <= all.body.summary.total_executions);
    assert.ok(webhook.body.errorGroups.length <= all.body.errorGroups.length);
});

test('the error rate filters BOTH halves of its own ratio', async () => {
    // The bug this guards is specific: filtering the numerator (errors) and not
    // the denominator (executions) yields a rate that is wrong in the direction
    // that looks reassuring — webhook errors over ALL runs.
    const manual = await api('/api/analytics/error-intelligence?mode=manual', { token: OWNER });
    assert.equal(manual.status, 200);
    const all = await api('/api/analytics/error-intelligence', { token: OWNER });

    if (manual.body.summary.total_errors > 0) {
        assert.ok(manual.body.summary.total_executions < all.body.summary.total_executions,
            'the denominator must narrow with the filter, not stay at the unfiltered total');
    }
});

test('an unknown trigger type is a 400, not an empty page', async () => {
    // An empty chart is indistinguishable from a quiet day; a 400 is what tells
    // the two apart. Same reasoning as the four endpoints F-02 already covered.
    const r = await api('/api/analytics/error-intelligence?mode=cron', { token: OWNER });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Unknown execution mode/);
});

test('the drill-down under a group carries the same trigger filter as the group', async () => {
    const list = await api('/api/analytics/error-intelligence?mode=webhook', { token: OWNER });
    const group = list.body.errorGroups[0];
    if (!group) return;   // no errors in the fixture window — nothing to assert

    const drill = await api('/api/analytics/error-group-executions', {
        token: OWNER, method: 'POST',
        body: {
            fingerprint: group.fingerprint,
            startDate: new Date(Date.now() - 30 * 86400000).toISOString(),
            endDate: new Date().toISOString(),
            mode: 'webhook'
        }
    });
    assert.equal(drill.status, 200, JSON.stringify(drill.body));

    const bad = await api('/api/analytics/error-group-executions', {
        token: OWNER, method: 'POST',
        body: {
            fingerprint: group.fingerprint,
            startDate: new Date(Date.now() - 30 * 86400000).toISOString(),
            endDate: new Date().toISOString(),
            mode: 'not-a-mode'
        }
    });
    assert.equal(bad.status, 400, 'the drill-down validates the mode like every other endpoint');
});

// ============================================ F-24 §5 · trace on the Slowest tab

test('the slowest list carries an execution to open a trace on', async () => {
    const r = await api('/api/analytics/slowest', { token: OWNER });
    assert.equal(r.status, 200);
    if (!r.body.length) return;   // nothing finished in the fixture window

    for (const row of r.body) {
        assert.ok('slowest_exec_id' in row, 'every row needs something the trace panel can open');
        assert.ok('max_duration' in row,
            'and its worst run, so an average dragged up by one outlier can be told from a uniformly slow workflow');
        if (row.max_duration !== null && row.avg_duration !== null) {
            assert.ok(row.max_duration >= row.avg_duration - 1e-9,
                'the maximum cannot be below the mean');
        }
    }
});

// ============================================ H-06 · the documentation service
//
// The connection is per person, and that is a decision about accountability
// rather than about privacy. The documentation is public — everyone gets the
// same page — but the credential is issued against the approver's own account
// at the service, so a single shared one would attribute every question to one
// person and land any misuse of the service on them.
//
// These tests hold the two properties that follow: nobody borrows anybody
// else's connection, and the callback cannot be driven by someone who did not
// start the flow.

test('the docs connection is reported per user, and nobody borrows another', async () => {
    const owner = await api('/api/integrations/docs', { token: OWNER });
    assert.equal(owner.status, 200);
    assert.equal(owner.body.provider, 'n8n-docs');
    assert.equal(typeof owner.body.connected, 'boolean');
    // The token itself must never appear in something a page can read.
    assert.ok(!('refresh_token' in owner.body), 'the credential leaked into the status');
    assert.ok(!('access_token' in owner.body));

    const member = await api('/api/integrations/docs', { token: MEMBER });
    assert.equal(member.status, 200);
    assert.equal(member.body.connected, owner.body.connected === true ? member.body.connected : false);
});

test('the OAuth callback is reachable without a token, and useless without state', async () => {
    // It has to be reachable: a browser returning from an authorisation screen
    // carries no Authorization header, because the token is in localStorage and
    // a top-level navigation cannot send it. Everything therefore rests on the
    // state parameter.
    const res = await fetch(BASE + '/api/integrations/docs/callback?code=fake&state=invented');
    assert.notEqual(res.status, 401, 'the callback must not require a token');
    assert.equal(res.status, 400);

    const html = await res.text();
    assert.match(html, /expired or did not come from here/);
    // The same answer for an unknown state and an expired one: telling them
    // apart would say which guess was close.
    assert.ok(!/invented/.test(html), 'the callback echoed the state back');
});

test('an authenticated caller cannot read the credential through any route', async () => {
    // Belt and braces on the rule that the secret has exactly one reader. If a
    // route ever starts returning it, this fails rather than the leak being
    // found later.
    for (const route of ['/api/integrations/docs', '/api/settings', '/api/analytics/system']) {
        const r = await api(route, { token: OWNER });
        const body = JSON.stringify(r.body || {});
        assert.ok(!/refresh_token|"access_token"/.test(body),
            `${route} exposed a credential field`);
    }
});
