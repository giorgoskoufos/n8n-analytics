/**
 * Unit tests for the pure logic: input validation, the logger, and the error
 * classifier.
 *
 * node:test, no framework. The runner is in the Node the app already requires,
 * so there is nothing to install, nothing to keep up to date, and no second
 * config file describing how to run tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const { parseIsoDate, parseDateRange, parseExecutionMode, validateSetting, validateRoiEntry } =
    require(path.join(ROOT, 'src/utils/validate'));

// ---------------------------------------------------------------- parseIsoDate
test('parseIsoDate accepts a real ISO timestamp', () => {
    const d = parseIsoDate('2026-08-18T10:30:00.000Z');
    assert.equal(d.toISOString(), '2026-08-18T10:30:00.000Z');
});

test('parseIsoDate returns null instead of throwing', () => {
    // The reason this helper exists: new Date('foo').toISOString() throws a
    // RangeError, so ?startDate=foo used to be a 500 and a stack trace.
    for (const bad of ['foo', '', null, undefined, {}, [], '2026-13-45']) {
        assert.equal(parseIsoDate(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
});

test('parseIsoDate rejects years outside 2000-2100', () => {
    // '202-01-01' parses as the year 202 and silently matches nothing.
    assert.equal(parseIsoDate('0202-01-01T00:00:00Z'), null);
    assert.equal(parseIsoDate('3000-01-01T00:00:00Z'), null);
    assert.notEqual(parseIsoDate('2026-01-01T00:00:00Z'), null);
});

// --------------------------------------------------------------- parseDateRange
test('parseDateRange requires both bounds or neither', () => {
    assert.equal(parseDateRange(undefined, undefined).ok, true, 'neither is the default range');
    assert.equal(parseDateRange('2026-01-01', undefined).ok, false, 'one bound is a mistake, not a default');
    assert.equal(parseDateRange(undefined, '2026-01-01').ok, false);
});

test('parseDateRange rejects a backwards range', () => {
    // Not a database error — it simply matches nothing, which reads as
    // "no data" rather than "you asked backwards".
    const r = parseDateRange('2026-08-20T00:00:00Z', '2026-08-10T00:00:00Z');
    assert.equal(r.ok, false);
    assert.match(r.error, /before/i);
});

test('parseDateRange accepts a valid range', () => {
    const r = parseDateRange('2026-08-10T00:00:00Z', '2026-08-20T00:00:00Z');
    assert.equal(r.ok, true);
    assert.ok(r.start < r.end);
});

// -------------------------------------------------------------- validateSetting
test('validateSetting allows only known keys and says which', () => {
    const r = validateSetting('arbitrary_key', 'x');
    assert.equal(r.ok, false);
    assert.match(r.error, /timezone/, 'the error should name what IS allowed');
});

test('validateSetting checks the timezone against Intl, not a list', () => {
    assert.equal(validateSetting('timezone', 'Europe/Athens').ok, true);
    assert.equal(validateSetting('timezone', 'UTC').ok, true);
    assert.equal(validateSetting('timezone', 'Mars/Olympus_Mons').ok, false);
    assert.equal(validateSetting('timezone', '').ok, false);
});

// ------------------------------------------------------------- validateRoiEntry
test('validateRoiEntry bounds the numbers', () => {
    assert.equal(validateRoiEntry({ workflow_id: 'w1', saved_time_seconds: 60, hourly_rate: 50 }).ok, true);
    assert.equal(validateRoiEntry({ workflow_id: 'w1', saved_time_seconds: -1, hourly_rate: 50 }).ok, false);
    assert.equal(validateRoiEntry({ workflow_id: 'w1', saved_time_seconds: 86401, hourly_rate: 50 }).ok, false);
    assert.equal(validateRoiEntry({ workflow_id: 'w1', saved_time_seconds: 60, hourly_rate: 100001 }).ok, false);
    assert.equal(validateRoiEntry({ saved_time_seconds: 60, hourly_rate: 50 }).ok, false, 'workflow_id is required');
});

// ---------------------------------------------------------------------- logger
test('the logger never prints a secret', () => {
    // Both of these had already leaked through another channel and had to be
    // rotated; the log must not be a third way out.
    const { logger } = require(path.join(ROOT, 'src/utils/logger'));
    const captured = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
        logger('TEST').info('boot', {
            password: 'hunter2',
            token: 'eyJhbGciOi',
            nested: { apiKey: 'sk-live-secret', keep: 'visible' }
        });
    } finally {
        process.stdout.write = realWrite;
    }
    const out = captured.join('');
    assert.ok(!out.includes('hunter2'), 'password leaked');
    assert.ok(!out.includes('eyJhbGciOi'), 'token leaked');
    assert.ok(!out.includes('sk-live-secret'), 'nested key leaked');
    assert.ok(out.includes('visible'), 'redaction should not eat ordinary fields');
});

test('the logger keeps an Error usable', () => {
    // An Error has no enumerable properties, so a logger that treated trailing
    // arguments as a fields object would drop the message entirely.
    const { logger } = require(path.join(ROOT, 'src/utils/logger'));
    const captured = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
        logger('TEST').error('Sync failed:', new Error('connection refused'));
    } finally {
        process.stderr.write = realWrite;
    }
    assert.match(captured.join(''), /connection refused/);
});

// ----------------------------------------------------------------- error parser
test('the error classifier suite passes', () => {
    // Kept as its own script rather than rewritten here: it is 47 cases built
    // from real production rows, and it doubles as a tool that can be run
    // directly while tuning the rules. Re-expressing it would fork the fixtures.
    const out = execFileSync(process.execPath, ['src/scripts/testErrorParser.js'],
        { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /0 failed/);
});

// ------------------------------------------------------------ parseExecutionMode
test('parseExecutionMode treats absent as "every mode"', () => {
    // Optional on every endpoint that takes it, so nothing must be a valid answer.
    for (const empty of [undefined, null, '']) {
        const r = parseExecutionMode(empty);
        assert.equal(r.ok, true);
        assert.equal(r.mode, null);
    }
});

test('parseExecutionMode refuses anything n8n would not produce', () => {
    assert.equal(parseExecutionMode('webhook').mode, 'webhook');
    assert.equal(parseExecutionMode('trigger').mode, 'trigger');

    // The reason this is a 400 and not a pass-through: the value is a bound
    // parameter either way, so it is not an injection risk — but an unknown mode
    // matches no rows, and an empty chart looks exactly like a quiet day.
    for (const bad of ['Webhook', 'cron', 'webhook ', 42, {}]) {
        const r = parseExecutionMode(bad);
        assert.equal(r.ok, false, `should reject ${JSON.stringify(bad)}`);
        assert.match(r.error, /webhook/, 'the message should name what is allowed');
    }
});

// --------------------------------------------------------------------- forecast
//
// The storage forecast is the one piece of arithmetic on the insights page that
// cannot be checked by eye, and it is the one most able to be confidently wrong:
// a projection is believed. Tested here rather than through the endpoint so each
// branch can be given the exact shape it is meant to recognise.

const { forecast, detectBackpressure, densify, sweepConcurrency, growthFrom } =
    require(path.join(ROOT, 'src/controllers/insightsController'))._internal;

const MB = 1048576;
/** n days ending today, each with the same volume. */
function days(count, executions, bytes, from = 1) {
    return Array.from({ length: count }, (_, i) => ({
        day: `2026-08-${String(from + i).padStart(2, '0')}`,
        executions,
        json_bytes: bytes,
        binary_bytes: 0
    }));
}

test('forecast will not project from too little history', () => {
    const r = forecast(days(3, 100, MB), { oldest: '2026-08-01', newest: '2026-08-03' }, 3 * MB);
    // Three rows, one of which is today and dropped, leaves two.
    assert.equal(r.known, false);
    assert.match(r.reason, /three/);
});

test('forecast projects linearly when nothing is being pruned', () => {
    const daily = days(11, 100, 10 * MB);
    const retained = 100 * MB;
    const r = forecast(daily, { oldest: '2026-08-01', newest: '2026-08-11T00:00:00Z' }, retained);

    assert.equal(r.known, true);
    assert.equal(r.pruning, false);
    assert.equal(r.days_measured, 10, 'today is partial and must be excluded');
    assert.equal(r.daily_bytes, 10 * MB);
    assert.ok(Math.abs(r.trend_bytes_per_day) < 1, 'a flat series has no trend');
    assert.equal(r.projection.in_30_days, retained + 300 * MB);
    assert.equal(r.projection.in_90_days, retained + 900 * MB);
});

test('forecast refuses to project once n8n is pruning, and predicts the plateau', () => {
    // The shape a retention sweep leaves: a thin tail of survivors at the far
    // end, full days after it. Averaging across the tail is what understated the
    // real rate by 30% on the live instance.
    const daily = [...days(4, 5, MB, 1), ...days(21, 100, 10 * MB, 5)];
    const r = forecast(daily, { oldest: '2026-08-01', newest: '2026-08-25T00:00:00Z' }, 2000 * MB);

    assert.equal(r.known, true);
    assert.equal(r.pruning, true, 'four days at 5% of the median is a sweep, not a quiet weekend');
    assert.equal(r.projection, null, 'a linear projection through a prune is fiction');
    assert.equal(r.days_measured, 20, 'the tail is excluded from the rate, today too');
    assert.equal(r.daily_bytes, 10 * MB, 'the rate is the full days only, not the average of everything');
    assert.equal(r.tail_bytes, 4 * MB, 'what survived past the horizon is counted, not averaged away');

    // 20 days from the oldest full day to `newest`, at 10 MB, plus the tail.
    assert.equal(r.retention_days, 20);
    assert.equal(r.equilibrium_bytes, 204 * MB);
    assert.equal(r.headroom_bytes, 204 * MB - 2000 * MB);
});

// -------------------------------------------------------------- detectBackpressure
test('backpressure is lag rising while volume does not', () => {
    const flat = (n, p95) => Array.from({ length: n }, () => ({ n: 100, p95 }));

    // Steady: same lag, same volume.
    assert.equal(detectBackpressure(flat(20, 50)).detected, false);

    // Lag tripled on the last quarter with volume unchanged — the queue is
    // draining slower than it fills.
    assert.equal(detectBackpressure([...flat(15, 50), ...flat(5, 150)]).detected, true);

    // Lag tripled because the volume tripled is a busy instance, not pressure.
    const busy = [...flat(15, 50),
        ...Array.from({ length: 5 }, () => ({ n: 400, p95: 150 }))];
    assert.equal(detectBackpressure(busy).detected, false);

    // Too little to compare is reported as such rather than as "healthy".
    const thin = detectBackpressure(flat(4, 50));
    assert.equal(thin.detected, false);
    assert.match(thin.reason, /enough/);
});

// ---------------------------------------------------------------------- densify
test('densify fills empty buckets with zero rather than dropping them', () => {
    // A sparse series lets a chart draw a straight line through a quiet night
    // between two busy hours — the one shape the data never had.
    const win = { originMs: Date.parse('2026-08-01T00:00:00Z'), stepMs: 3600000, count: 4 };
    const out = densify(win, [{ bucket_idx: 0, total: 7 }, { bucket_idx: 3, total: 2 }],
        (row) => ({ total: row ? row.total : 0 }));

    assert.deepEqual(out.map((p) => p.total), [7, 0, 0, 2]);
    assert.equal(out[0].time_val, '2026-08-01T00:00:00.000Z');
    assert.equal(out[3].time_val, '2026-08-01T03:00:00.000Z');
});

// ------------------------------------------------------------ sweepConcurrency
//
// The one measurement on the insights page that cannot be produced by
// aggregation: it needs every interval, and its answers are integers that are
// either exactly right or quietly off by one.

const T0 = Date.parse('2026-08-01T00:00:00Z');
const at = (ms) => new Date(T0 + ms).toISOString();
/** A finished execution occupying [from, to) milliseconds after T0. */
const run = (from, to) => ({ started: at(from), stopped: at(to), status: 'success' });

test('concurrency counts overlap, not starts', () => {
    // Four executions start inside one minute; only two are ever simultaneous.
    const r = sweepConcurrency([
        run(0, 1000), run(2000, 3000), run(10000, 40000), run(20000, 30000)
    ], T0, T0 + 60000, 60000, 1);

    assert.equal(r.summary.executions, 4, 'all four started in the window');
    assert.equal(r.summary.peak, 2, 'the pair overlapping at 20-30s is the peak');
    assert.equal(r.series[0].started, 4, 'the bucket still reports four starts');
    // Busy time: 1s + 1s + 30s + 10s of execution across a 60s window.
    assert.equal(r.summary.busy_ms, 42000);
    assert.equal(r.summary.avg, 0.7);
});

test('an execution ending as another begins is not concurrency', () => {
    // The tie-break that matters: sorted the other way, a busy instance reports
    // a phantom extra slot on every handover.
    const back_to_back = sweepConcurrency([run(0, 5000), run(5000, 10000)], T0, T0 + 10000, 10000, 1);
    assert.equal(back_to_back.summary.peak, 1);

    const overlapping = sweepConcurrency([run(0, 5001), run(5000, 10000)], T0, T0 + 10000, 10000, 1);
    assert.equal(overlapping.summary.peak, 2, 'one millisecond of overlap is overlap');
});

test('concurrency includes executions already running when the window opened', () => {
    // Started before the window, still going inside it. Its start is not counted
    // — it did not start here — but it is occupying a slot.
    const r = sweepConcurrency([
        { started: at(-30000), stopped: at(30000), status: 'success' },
        run(10000, 20000)
    ], T0, T0 + 60000, 60000, 1);

    assert.equal(r.summary.peak, 2);
    assert.equal(r.series[0].started, 1, 'only the one that began inside the window counts as a start');
    // 30s of the first (clipped at the window edge) plus 10s of the second.
    assert.equal(r.summary.busy_ms, 40000);
});

test('an execution that ended at an unknown time is excluded, not left open', () => {
    // A row written off as 'unknown' or 'crashed' with no stoppedAt is finished;
    // treating it as still running would add a permanent extra slot to every
    // bucket after it. One such row exists on the live replica, from May.
    const r = sweepConcurrency([
        { started: at(0), stopped: null, status: 'crashed' },
        run(10000, 20000)
    ], T0, T0 + 60000, 60000, 1);

    assert.equal(r.summary.unresolved, 1, 'and it is counted, so the omission is visible');
    assert.equal(r.summary.peak, 1, 'the crashed row must not hold a slot');
    assert.equal(r.summary.busy_ms, 10000);

    // A genuinely in-flight one does hold a slot.
    const live = sweepConcurrency([
        { started: at(0), stopped: null, status: 'running' }
    ], T0, T0 + 60000, 60000, 1);
    assert.equal(live.summary.open_ended, 1);
    assert.equal(live.summary.peak, 1);
});

test('concurrency spans buckets rather than being credited to the first', () => {
    // One execution running across three whole buckets must appear in all three.
    const r = sweepConcurrency([run(0, 180000)], T0, T0 + 180000, 60000, 3);
    assert.deepEqual(r.series.map((p) => p.peak), [1, 1, 1]);
    assert.deepEqual(r.series.map((p) => p.avg), [1, 1, 1]);
    assert.deepEqual(r.series.map((p) => p.started), [1, 0, 0], 'it only started once');
});

// -------------------------------------------------------------- fingerprinting
//
// The rules here were chosen against real messages from a production instance,
// so the cases below are the shapes that actually occur, not invented ones. Each
// asserts the collapse it was added for.

const { normalizeMessage, fingerprintOf } = require(path.join(ROOT, 'src/config/fingerprint'));
const norm = normalizeMessage;
const fpOf = (m, t, e) => fingerprintOf(m, t, e).fingerprint;

test('normalisation collapses the values that differ between occurrences', () => {
    assert.equal(norm('Row 4821 not found'), 'Row <N> not found');
    assert.equal(norm("Column 'remedy_id' does not exist in selected table"),
        'Column <STR> does not exist in selected table');
    assert.equal(norm('Request to https://api.example.com/v2/items?id=9 failed'),
        'Request to <URL> failed');
    assert.equal(norm('No mailbox for alice.smith+tag@example.co.uk'), 'No mailbox for <EMAIL>');
    assert.equal(norm('Job 3f2504e0-4f89-11d3-9a0c-0305e82c3301 missing'), 'Job <UUID> missing');
    assert.equal(norm('Expired on 2026-08-14T09:31:00Z'), 'Expired on <DATE>');
    assert.equal(norm('Digest 9f86d081884c7d659a2feaa0c55ad015 mismatch'), 'Digest <HEX> mismatch');
});

test('two occurrences of the same problem share a fingerprint', () => {
    // The case the old SUBSTR grouping got wrong, and the reason 14,267 errors
    // became 1,524 groups instead of 98.
    assert.equal(fpOf('Row 4821 not found', 'pg', 'Error'), fpOf('Row 4822 not found', 'pg', 'Error'));
    assert.equal(
        fpOf("Column 'remedy_id' does not exist", 'pg', 'Error'),
        fpOf("Column 'receivedDateTime' does not exist", 'pg', 'Error'));
});

test('genuinely different problems do not', () => {
    assert.notEqual(fpOf('Row <N> not found', 'pg', 'E'), fpOf('Table not found', 'pg', 'E'));
    // Same message from a different kind of node is a different problem.
    assert.notEqual(fpOf('timeout', 'n8n-nodes-base.postgres', 'E'),
        fpOf('timeout', 'n8n-nodes-base.httpRequest', 'E'));
    assert.notEqual(fpOf('timeout', 'pg', 'TimeoutError'), fpOf('timeout', 'pg', 'NetworkError'));
});

test('an HTML error page collapses to its title, not its markup', () => {
    // 300 of this instance's errors are whole HTML documents returned by an
    // upstream service. No two are byte-identical — session ids and ray ids in
    // the markup — so they produced nearly 300 separate groups.
    const page = (title, ray) =>
        `<!DOCTYPE html>\n<html lang="en"><head><title>${title}</title></head>` +
        `<body><p>Ray id ${ray}</p></body></html>`;

    assert.equal(norm(page('Not Found', 'abc123')), '<HTML: not found>');
    assert.equal(fpOf(page('Not Found', 'abc123'), 'http', 'E'),
        fpOf(page('Not Found', 'zzz999'), 'http', 'E'), 'the same page twice is one problem');
    assert.notEqual(fpOf(page('Not Found', 'a'), 'http', 'E'),
        fpOf(page('Service Suspended', 'a'), 'http', 'E'),
        'two different upstream failures must stay apart');

    const untitled = '<html><body>something went wrong</body></html>';
    assert.equal(norm(untitled), '<HTML>');
});

test('normalisation is bounded and never throws', () => {
    for (const odd of [null, undefined, '', 0, {}, []]) {
        assert.equal(typeof norm(odd), 'string', `should survive ${JSON.stringify(odd)}`);
    }
    // A dumped payload must not make every occurrence unique through sheer length.
    const huge = 'Failed: ' + 'x'.repeat(50000);
    assert.ok(norm(huge).length <= 300);
    // An unbalanced quote must not swallow the rest of the message.
    assert.match(norm("Bad value ' and then some real text here"), /real text/);
});

test('the fingerprint is 16 hex characters and depends on every part of the key', () => {
    assert.match(fpOf('m', 'n', 't'), /^[0-9a-f]{16}$/);
    // The parts are joined with a separator that cannot occur inside them, so a
    // value ending where the next begins cannot forge another triple's identity.
    const sep = String.fromCharCode(0);
    assert.notEqual(fpOf('a', 'b', 'c'), fpOf('a' + sep + 'b', '', 'c'));
});

// ------------------------------------------------------- behavioural classification
//
// F-08. "Transient" used to be a static map from the error category, which is a
// guess about the wording of a message. On the instance this was built against
// that guess was wrong for four of the six error groups with enough occurrences
// to judge — including an upstream returning "service suspended", filed as
// transient, which recovered zero times out of forty-seven.

const { natureOf, MIN_BEHAVIOUR_OBSERVATIONS } =
    require(path.join(ROOT, 'src/controllers/metricsController'))._internal;

test('behaviour is unproven below the evidence floor', () => {
    // One failure followed by one success is a 100% recovery rate and means
    // nothing. A badge reading "transient" on that is worse than no badge.
    const thin = natureOf({ observed: MIN_BEHAVIOUR_OBSERVATIONS - 1, recovered: 4 });
    assert.equal(thin.behaviour, 'unknown');
    assert.equal(thin.recovery_rate, null);

    // And a fingerprint with no behavioural data at all does not throw.
    assert.equal(natureOf(undefined).behaviour, 'unknown');
    assert.equal(natureOf(null).observed, 0);
});

test('behaviour bands separate self-healing, intermittent and broken', () => {
    // Never recovers: the thing the item calls structural regardless of what the
    // message says.
    assert.equal(natureOf({ observed: 47, recovered: 0 }).behaviour, 'structural');
    // Almost always recovers: leave it to the retry.
    assert.equal(natureOf({ observed: 469, recovered: 355 }).behaviour, 'transient');
    // The middle band exists because the data has one. Collapsing it into either
    // neighbour would report a flaky upstream as either fine or broken.
    const mid = natureOf({ observed: 17, recovered: 6 });
    assert.equal(mid.behaviour, 'intermittent');
    assert.equal(mid.recovery_rate, 35.3);
});

test('the band boundaries are where they claim to be', () => {
    assert.equal(natureOf({ observed: 100, recovered: 10 }).behaviour, 'structural');
    assert.equal(natureOf({ observed: 100, recovered: 11 }).behaviour, 'intermittent');
    assert.equal(natureOf({ observed: 100, recovered: 69 }).behaviour, 'intermittent');
    assert.equal(natureOf({ observed: 100, recovered: 70 }).behaviour, 'transient');
});


// ------------------------------------------------------------------ F-19 growth
// The replica-growth figure on the health panel is a first-to-last slope over a
// bounded history, and every way it can mislead is a null it has to return
// rather than a number someone would believe.
const runsAt = (samples) => samples.map(([hours, bytes]) => ({
    started_at: new Date(Date.UTC(2026, 7, 20) + hours * 3600000).toISOString(),
    replica_bytes: bytes
}));

test('growth needs two sized samples before it will answer', () => {
    assert.equal(growthFrom([]).bytes_per_day, null);
    assert.equal(growthFrom(runsAt([[0, 1000]])).bytes_per_day, null);
    // Rows written before the size column was recorded are not samples.
    assert.equal(growthFrom([
        { started_at: '2026-08-20T00:00:00.000Z', replica_bytes: null },
        { started_at: '2026-08-20T06:00:00.000Z', replica_bytes: null }
    ]).samples, 0);
});

test('growth extrapolates the observed slope to a day, and says over what span', () => {
    // 12 MB gained across 6 hours is 48 MB/day.
    const g = growthFrom(runsAt([[0, 100 * 1048576], [6, 112 * 1048576]]));
    assert.equal(g.bytes_per_day, 48 * 1048576);
    assert.equal(g.span_hours, 6);
    assert.equal(g.samples, 2);
});

test('a VACUUM between two samples reports shrinkage, not a hidden zero', () => {
    // The series is not monotonic and must not pretend to be: retention and
    // VACUUM both move the file down. A floor at zero here would quietly report
    // "no growth" for a database that had just been halved.
    const g = growthFrom(runsAt([[0, 4000000000], [24, 3000000000]]));
    assert.ok(g.bytes_per_day < 0, 'a shrinking file must read as shrinking');
    assert.equal(g.bytes_per_day, -1000000000);
});

test('two samples at the same instant cannot produce a rate', () => {
    // Division by a zero span. Two passes recorded in the same millisecond is
    // improbable but not impossible, and Infinity MB/day would render.
    assert.equal(growthFrom(runsAt([[0, 1000], [0, 2000]])).bytes_per_day, null);
});

// ------------------------------------------------------------- the write gate
// One SQLite connection, three things on timers writing through it. SQLite has
// no nested transactions, so overlapping BEGINs fail — which is what stalled the
// replica for nine hours before F-19 made it visible. These pin the three
// properties that stop it happening again.
const localDb = require(path.join(ROOT, 'src/config/localDb'));

test('the gate serialises two passes and is reentrant within one', async () => {
    const order = [];
    const slow = localDb.exclusive(async () => {
        order.push('a:start');
        assert.equal(localDb.holdsWriteGate(), true);
        await new Promise((r) => { setTimeout(r, 20); });
        // The ETL calls the fingerprint backfill as its last step. A plain mutex
        // would deadlock here; this must simply run.
        await localDb.exclusive(async () => { order.push('a:nested'); });
        order.push('a:end');
    });
    const fast = localDb.exclusive(async () => { order.push('b'); });

    await Promise.all([slow, fast]);
    assert.deepEqual(order, ['a:start', 'a:nested', 'a:end', 'b'],
        'the second writer must wait for the first to finish, not interleave');
});

test('a pass that throws does not strand every writer behind it', async () => {
    // The gate is a promise chain. Chaining onto a rejected link without
    // normalising it leaves every later acquisition unresolved for the life of
    // the process — an outage that looks exactly like a hung ETL.
    await assert.rejects(localDb.exclusive(async () => { throw new Error('boom'); }),
        /boom/);
    let ran = false;
    await localDb.exclusive(async () => { ran = true; });
    assert.equal(ran, true);
});

test('outside a pass, nothing claims to hold the gate', () => {
    assert.equal(localDb.holdsWriteGate(), false);
});

// ------------------------------------------------------- F-12 · node traces
// The shapes below are the ones measured in n8n's own execution_data on the
// instance this was built against, not invented ones.
const { summariseTrace, causeChain, itemFlow } =
    require(path.join(ROOT, 'src/utils/trace'));

/** One run, in the shape n8n writes. */
const nodeRun = (ms, opts = {}) => ({
    startTime: opts.start ?? 1000,
    executionTime: ms,
    executionIndex: opts.index ?? 0,
    executionStatus: opts.status || 'success',
    source: opts.source || [],
    ...(opts.items === undefined ? {} : { data: { main: [Array(opts.items).fill({ json: {} })] } }),
    ...(opts.channel ? { data: { [opts.channel]: [[{ json: {} }]] } } : {}),
    ...(opts.error ? { error: opts.error } : {})
});

const payload = (runData, error) => ({
    resultData: { runData, ...(error ? { error } : {}), lastNodeExecuted: Object.keys(runData).pop() }
});

test('node time above wall time is reported, not clamped', () => {
    // Measured at 1.74x on a real execution: n8n runs branches concurrently, so
    // the node times genuinely add up to more than the execution took. A
    // "percent of wall" column capped at 100 would hide precisely the fan-out
    // it exists to reveal.
    const t = summariseTrace(payload({ A: [nodeRun(20000)], B: [nodeRun(16000)] }), 21000);
    assert.equal(t.total_node_ms, 36000);
    assert.equal(t.overlap_ratio, 1.71);
    assert.ok(t.overlap_ratio > 1);
});

test('a node that ran five times is one row carrying five runs', () => {
    const t = summariseTrace(payload({ Model: [nodeRun(4000), nodeRun(4000), nodeRun(4000), nodeRun(4000), nodeRun(5617)] }));
    assert.equal(t.nodes.length, 1);
    assert.equal(t.nodes[0].runs, 5);
    assert.equal(t.nodes[0].ms, 21617);
    assert.equal(t.run_count, 5);
});

test('a sub-node has no item count, and that is not zero', () => {
    // An AI chat model never writes to the main output. Zero would read as "it
    // produced nothing", which is a different and wrong statement — and this is
    // the single most expensive node in the slowest execution on this instance.
    const t = summariseTrace(payload({
        'OpenAI Chat Model': [nodeRun(21617, { channel: 'ai_languageModel' })],
        'Edit Fields': [nodeRun(5, { items: 3 })]
    }));
    const model = t.nodes.find((n) => n.name === 'OpenAI Chat Model');
    const edit = t.nodes.find((n) => n.name === 'Edit Fields');
    assert.equal(model.items_out, null);
    assert.equal(model.is_sub_node, true);
    assert.equal(edit.items_out, 3);
    assert.equal(edit.is_sub_node, false);
});

test('an empty runData object counts as no trace, not as a workflow that did nothing', () => {
    // Real: a cancelled execution ran 25 seconds with `runData: {}`. Present
    // and empty is indistinguishable from absent for every question this
    // answers, and "has_run_data: true, 0 nodes, overlap 0.00" invites the
    // reader to believe the trace was read.
    const t = summariseTrace({ resultData: { runData: {} } }, 25469);
    assert.equal(t.has_run_data, false);
    assert.equal(t.overlap_ratio, null, 'not 0.00');
});

test('an execution with no runData says so instead of reporting zero', () => {
    // Real: one of the twelve slowest executions in three days ran 25 seconds
    // and carries no runData. "0 ms across 0 nodes" would be a claim about
    // where 25 seconds went.
    const t = summariseTrace({ resultData: {} }, 25469);
    assert.equal(t.has_run_data, false);
    assert.equal(t.nodes.length, 0);
    assert.equal(t.wall_ms, 25469, 'the wall time is still known and still reported');
});

test('a node that failed inside a successful execution is counted', () => {
    // Observed on a real run: MCP Client errored while the execution's own
    // status is `success`. Every error rate in this codebase is computed from
    // that status, so nothing else in the product can see this.
    const t = summariseTrace(payload({
        Trigger: [nodeRun(2, { items: 1 })],
        'MCP Client': [nodeRun(177, { status: 'error', error: { message: 'tool failed' } })]
    }));
    assert.equal(t.failed_nodes, 1);
    assert.equal(t.nodes.find((n) => n.name === 'MCP Client').status, 'error');
});

test('the cause walk terminates on a payload that references itself', () => {
    // execution_data is `flatted`-encoded, which can represent a cycle. A naive
    // while(cause) walk over one never returns.
    const a = { name: 'A', message: 'outer' };
    const b = { name: 'B', message: 'inner', cause: a };
    a.cause = b;
    const chain = causeChain(a);
    assert.ok(chain.length >= 2 && chain.length <= 8);
    assert.equal(chain[0].message, 'outer');
});

test('the cause walk follows context.cause as well as cause', () => {
    const chain = causeChain({ message: 'wrapper', context: { cause: { message: 'real reason' } } });
    assert.equal(chain.length, 2);
    assert.equal(chain[1].message, 'real reason');
});

test('item flow uses the exact source run, and skips trigger nodes', () => {
    // `previousNodeRun` is present on every sourced run in the sample, so the
    // input to a run is a specific branch of a specific earlier run rather than
    // an average. A trigger has no source: its input is unknown, not zero, and
    // an edge is a claim about two nodes.
    const runData = {
        Webhook: [nodeRun(4, { items: 5 })],
        Split: [nodeRun(10, { items: 80, source: [{ previousNode: 'Webhook', previousNodeOutput: 0, previousNodeRun: 0 }] })],
        Rollup: [nodeRun(20, { items: 5, source: [{ previousNode: 'Split', previousNodeOutput: 0, previousNodeRun: 0 }] })]
    };
    const flow = itemFlow(runData);
    assert.equal(flow.length, 2, 'the trigger contributes no edge');

    const rollup = flow.find((e) => e.to === 'Rollup');
    assert.equal(rollup.items_in, 80);
    assert.equal(rollup.items_out, 5);
    assert.equal(rollup.lost, 75);

    const split = flow.find((e) => e.to === 'Split');
    assert.equal(split.lost, -75, 'expansion is negative loss, not zero');
});

test('the array-wrapped payload shape is read the same as the object one', () => {
    const inner = payload({ A: [nodeRun(7, { items: 2 })] });
    const t = summariseTrace([inner]);
    assert.equal(t.has_run_data, true);
    assert.equal(t.nodes[0].ms, 7);
});

test('the failing item index and sub-messages are extracted when present', () => {
    // itemIndex appears on 238 of 300 real failures; messages on 15. Both are
    // the nearest thing this instance has to a cause chain, which never appears
    // at all.
    const t = summariseTrace(payload(
        { HTTP: [nodeRun(193, { status: 'error', error: { message: 'boom' } })] },
        {
            message: 'Service unavailable',
            node: { name: 'HTTP', type: 'n8n-nodes-base.httpRequest' },
            context: { itemIndex: 74 },
            messages: ['upstream said 503']
        }
    ));
    assert.equal(t.error.item_index, 74);
    assert.deepEqual(t.error.messages, ['upstream said 503']);
    assert.equal(t.error.node_type, 'n8n-nodes-base.httpRequest');
    assert.equal(t.error.chain.length, 1, 'no nested cause exists on this instance');
});

// ------------------------------------------------- ETL progress numbering
// The numbers are only worth printing if [9/13] means the same stage on every
// run. Two ways that rots: a call site with a key nobody listed, or a duplicate
// key so two stages share a number.
const { PASS_STEPS } = require(path.join(ROOT, 'src/config/syncJob'));

test('every numbered ETL step in the source is listed in PASS_STEPS', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/config/syncJob.js'), 'utf8');
    const used = new Set([...source.matchAll(/\bstep\('([a-z]+)'/g)].map((m) => m[1]));
    const listed = new Set(PASS_STEPS.map(([key]) => key));

    for (const key of used) {
        assert.ok(listed.has(key), `step('${key}') is called but not listed in PASS_STEPS`);
    }
    assert.ok(used.size > 0, 'the regex should find the call sites at all');
});

test('the step list has no duplicates and no gaps', () => {
    const keys = PASS_STEPS.map(([key]) => key);
    assert.equal(new Set(keys).size, keys.length, 'two stages would share a number');
    assert.equal(PASS_STEPS[PASS_STEPS.length - 1][0], 'done',
        'the last line of a pass should be the one that says it finished');
    for (const entry of PASS_STEPS) {
        assert.equal(entry.length, 2);
        assert.equal(typeof entry[1], 'string');
        assert.ok(entry[1].length > 0, 'every step needs a human label');
    }
});
