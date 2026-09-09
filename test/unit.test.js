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

/**
 * A throwaway replica, pointed at BEFORE any app module is required.
 *
 * Without this, `DASHBOARD_DB_PATH` is unset, localDb and readonlyDb fall back
 * to ./dashboard.sqlite, and these tests run against whatever replica happens
 * to be sitting in the working copy. On a maintainer's machine that is the real
 * one — 200 MB of production history — so four tests passed here by reading
 * live customer data and failed in CI, where the file does not exist. One of
 * them asserted on a folder name that only exists on that one instance.
 *
 * Set before the first require on purpose: both modules resolve the path once,
 * at load time, and localDb is required at module scope further down this file.
 */
const os = require('node:os');
const TMP_DB = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-unit-')), 'unit.sqlite'
);
process.env.DASHBOARD_DB_PATH = TMP_DB;

const { parseIsoDate, parseDateRange, parseExecutionMode, validateSetting, validateApiKey,
    validateRoiEntry } =
    require(path.join(ROOT, 'src/utils/validate'));

/**
 * The few rows the AI tests need to be about anything.
 *
 * Deliberately small and deliberately fictional. The point is not to simulate
 * an instance — it is that a test asserting "the catalogue finds this" should
 * carry the thing it expects to find, rather than hoping the machine it runs on
 * happens to have one.
 */
test.before(async () => {
    const localDb = require(path.join(ROOT, 'src/config/localDb'));
    await localDb.ready;

    await localDb.executeMany(
        'INSERT OR IGNORE INTO workflow_entity (id, name, active, "isArchived", "parentFolderId") VALUES (?,?,?,?,?)',
        [
            ['wf-fixture-a', 'Call Center - Ticket Router', 1, 0, 'fld-fixture'],
            ['wf-fixture-b', 'Invoice Sync', 1, 0, 'fld-fixture'],
            ['wf-fixture-c', 'Nightly Cleanup', 0, 1, null],
            // A deliberate duplicate. The "refuse an ambiguous name" test used
            // to skip itself whenever the replica had no two workflows sharing
            // a name, which meant it only ever ran on an instance that happened
            // to have one. Now it runs everywhere.
            ['wf-fixture-d', 'Invoice Sync', 1, 0, null]
        ]
    );
    await localDb.execute(
        'INSERT OR IGNORE INTO folder (id, name) VALUES (?,?)', ['fld-fixture', 'Call Center']
    );

    const now = Date.now();
    await localDb.executeMany(
        `INSERT OR IGNORE INTO execution_entity
            (id, "workflowId", status, "startedAt", "stoppedAt", mode, "createdAt", finished)
         VALUES (?,?,?,?,?,?,?,?)`,
        Array.from({ length: 12 }, (_, i) => {
            const started = new Date(now - i * 3600000);
            const failed = i % 4 === 0;
            return [9000 + i, i % 2 ? 'wf-fixture-a' : 'wf-fixture-b',
                failed ? 'error' : 'success',
                started.toISOString(), new Date(started.getTime() + 1500).toISOString(),
                i % 3 ? 'webhook' : 'trigger',
                new Date(started.getTime() - 200).toISOString(), failed ? 0 : 1];
        })
    );
    await localDb.executeMany(
        `INSERT OR IGNORE INTO execution_error_analytics
            (id, workflow_id, node_name, node_type, error_type, error_message, error_category, timestamp)
         VALUES (?,?,?,?,?,?,?,?)`,
        [0, 4, 8].map((i) => [9000 + i, 'wf-fixture-a', 'HTTP Request',
            'n8n-nodes-base.httpRequest', 'NetworkError', 'connect ETIMEDOUT 10.0.0.1:443',
            'timeout', new Date(now - i * 3600000).toISOString()])
    );
});

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

test('the model is checked for shape, deliberately not for membership', () => {
    // No allowlist of known models, and that is the decision rather than an
    // omission: providers ship faster than this dashboard does, and a list would
    // make the newest model unreachable until somebody edited a file and
    // redeployed — the exact barrier moving the setting out of the environment
    // removes. So the check only stops the field being used as free storage.
    assert.equal(validateSetting('ai_model', 'gpt-5.4-mini').ok, true);
    assert.equal(validateSetting('ai_model', 'some-model-released-next-year').ok, true);
    assert.equal(validateSetting('ai_model', '').ok, true, 'empty clears it');
    assert.equal(validateSetting('ai_model', 'a model with spaces').ok, false);
    assert.equal(validateSetting('ai_model', 'x'.repeat(65)).ok, false);
});

// --------------------------------------------------------------- validateApiKey
test('an API key is checked for shape only, because only the provider knows', () => {
    // A regex insisting on `sk-` today is a regex rejecting a valid key the day
    // the prefix changes, and the verification anyone actually trusts is the
    // next answer working. So: something was typed, and it is not absurd.
    assert.equal(validateApiKey(`sk-proj-${'a'.repeat(40)}`).ok, true);
    assert.equal(validateApiKey('short').ok, false);
    assert.equal(validateApiKey(undefined).ok, false);

    const pasted = validateApiKey(`sk-proj-${'a'.repeat(40)} `);
    assert.equal(pasted.ok, true, 'a trailing newline from a copy-paste is trimmed, not refused');
    assert.ok(!/\s/.test(pasted.value));

    const broken = validateApiKey(`sk-proj-${'a'.repeat(20)} ${'b'.repeat(20)}`);
    assert.equal(broken.ok, false);
    assert.match(broken.error, /copy-paste/, 'and says what probably went wrong');
});

// ------------------------------------------------------------- validateRoiEntry
test('validateRoiEntry bounds the numbers', () => {
    assert.equal(validateRoiEntry({ workflow_id: 'w1', saved_time_seconds: 60, hourly_rate: 50 }).ok, true);
    assert.equal(validateRoiEntry({ workflow_id: 'w1', saved_time_seconds: -1, hourly_rate: 50 }).ok, false);
    assert.equal(validateRoiEntry({ workflow_id: 'w1', saved_time_seconds: 86401, hourly_rate: 50 }).ok, false);
    assert.equal(validateRoiEntry({ workflow_id: 'w1', saved_time_seconds: 60, hourly_rate: 100001 }).ok, false);
    assert.equal(validateRoiEntry({ saved_time_seconds: 60, hourly_rate: 50 }).ok, false, 'workflow_id is required');
});

test('the ROI baseline is all four fields or none of them', () => {
    const base = { workflow_id: 'w1', saved_time_seconds: 60, hourly_rate: 50 };
    const full = {
        ...base,
        baseline_frequency: 5, baseline_per: 'week',
        baseline_duration: 30, baseline_unit: 'minutes'
    };

    const complete = validateRoiEntry(full);
    assert.equal(complete.ok, true);
    assert.deepEqual(
        {
            f: complete.value.baseline_frequency, p: complete.value.baseline_per,
            d: complete.value.baseline_duration, u: complete.value.baseline_unit
        },
        { f: 5, p: 'week', d: 30, u: 'minutes' }
    );

    // The common case, and NOT an error: the figure was typed directly in
    // Per-run figures. The nulls are load-bearing — they are what clears a
    // stale baseline off a row that used to have one.
    const none = validateRoiEntry(base);
    assert.equal(none.ok, true);
    assert.equal(none.value.baseline_frequency, null);
    assert.equal(none.value.baseline_per, null);
    assert.equal(none.value.baseline_duration, null);
    assert.equal(none.value.baseline_unit, null);

    // Three of four is a sentence with a hole in it: it can be neither
    // recomputed nor redisplayed, so it is refused rather than half-stored.
    for (const missing of
        ['baseline_frequency', 'baseline_per', 'baseline_duration', 'baseline_unit']) {
        const partial = { ...full };
        delete partial[missing];
        assert.equal(validateRoiEntry(partial).ok, false, `${missing} missing must be refused`);
    }
});

test('the ROI baseline only accepts periods and units the calculator knows', () => {
    const base = {
        workflow_id: 'w1', saved_time_seconds: 60, hourly_rate: 50,
        baseline_frequency: 5, baseline_per: 'week',
        baseline_duration: 30, baseline_unit: 'minutes'
    };

    // A period stored here that roi_math.mjs cannot divide is a row whose
    // figure can never be recomputed — so the two lists have to agree, and
    // this is the assertion that notices when they stop agreeing.
    assert.equal(validateRoiEntry({ ...base, baseline_per: 'fortnight' }).ok, false);
    assert.equal(validateRoiEntry({ ...base, baseline_unit: 'seconds' }).ok, false);
    assert.equal(validateRoiEntry({ ...base, baseline_frequency: 0 }).ok, false);
    assert.equal(validateRoiEntry({ ...base, baseline_duration: -5 }).ok, false);
    assert.equal(validateRoiEntry({ ...base, baseline_frequency: 10001 }).ok, false);

    for (const per of ['day', 'week', 'month']) {
        assert.equal(validateRoiEntry({ ...base, baseline_per: per }).ok, true, per);
    }
    for (const unit of ['minutes', 'hours']) {
        assert.equal(validateRoiEntry({ ...base, baseline_unit: unit }).ok, true, unit);
    }
});

// ---------------------------------------------------------------------- logger
test('the logger never prints a secret', () => {
    // Both of these had already leaked through another channel and had to be
    // rotated; the log must not be a third way out.
    //
    // Logged as SYNC rather than an arbitrary component: the console now only
    // narrates a short allowlist of components (see "console is a narrower
    // view" below), and this test wants to see the line arrive on stdout the
    // way an operator watching `docker logs` would, not merely confirm the
    // file sink got it.
    const { logger } = require(path.join(ROOT, 'src/utils/logger'));
    const captured = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
        logger('SYNC').info('boot', {
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
    //
    // Component is arbitrary here on purpose (not in the console allowlist):
    // `error` bypasses it regardless of where it came from, which is the other
    // half of this test.
    const { logger } = require(path.join(ROOT, 'src/utils/logger'));
    const captured = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
        logger('AUTH').error('Sync failed:', new Error('connection refused'));
    } finally {
        process.stderr.write = realWrite;
    }
    assert.match(captured.join(''), /connection refused/);
});

// -------------------------------------------------- logger: console vs file
//
// The logger writes to two places now: a file sink meant to be mounted by
// something else later (Loki, a support bundle), and a console sink meant to
// stay readable while an operator watches `docker logs -f` for the one thing
// that used to be invisible — is the sync still running. They need to
// disagree on purpose (the file gets everything, the console gets a curated
// slice) and both need testing, which means a fresh module instance per
// scenario: logger.js reads its configuration from `process.env` once, at
// `require()` time, the same way `src/config/openai.js` does — so the only way
// to test two different configurations in one process is to bust the require
// cache between them, exactly like `withStubbedModel` does for the AI tests
// further down this file.

const loggerPath = require.resolve(path.join(ROOT, 'src/utils/logger'));

/**
 * Requires a fresh logger.js under a set of environment overrides, runs `fn`
 * against it, then restores the environment and evicts the module again — so
 * a plain `require('.../logger')` anywhere else in this file, before or after,
 * keeps seeing the default configuration rather than whatever a single test
 * happened to set last.
 */
async function withLogger(env, fn) {
    const prior = {};
    for (const key of Object.keys(env)) prior[key] = process.env[key];
    Object.assign(process.env, env);
    delete require.cache[loggerPath];
    try {
        await fn(require(loggerPath));
    } finally {
        for (const key of Object.keys(env)) {
            if (prior[key] === undefined) delete process.env[key];
            else process.env[key] = prior[key];
        }
        delete require.cache[loggerPath];
    }
}

/** A temp dir per test, so parallel test files (and re-runs) never collide. */
function tempLogDir(name) {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), `n8n-log-${name}-`));
    return { dir, file: path.join(dir, 'app.jsonl') };
}

test('a component off the console allowlist still reaches the file, in full', async () => {
    const { dir, file } = tempLogDir('file-sink');
    try {
        await withLogger({
            LOG_FILE: file, LOG_CONSOLE_COMPONENTS: 'SYNC', LOG_LEVEL: 'info', LOG_FORMAT: 'json'
        }, async ({ logger, flush }) => {
            const captured = [];
            const realWrite = process.stdout.write.bind(process.stdout);
            process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
            try {
                // HTTP is not in the allowlist passed above.
                logger('HTTP').info('GET /api/settings 200', { id: 'abc123', ms: 12 });
            } finally {
                process.stdout.write = realWrite;
            }
            await flush();

            assert.equal(captured.join(''), '', 'an unlisted component at info stays off the console');

            const written = fs.readFileSync(file, 'utf8').trim().split('\n');
            assert.equal(written.length, 1, 'but it is still written, once, to the file');
            const entry = JSON.parse(written[0]);
            assert.equal(entry.component, 'HTTP');
            assert.equal(entry.id, 'abc123');
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('warn and error reach the console from any component, allowlisted or not', async () => {
    const { dir, file } = tempLogDir('warn-bypass');
    try {
        await withLogger({
            LOG_FILE: file, LOG_CONSOLE_COMPONENTS: 'SYNC', LOG_FORMAT: 'json'
        }, async ({ logger, flush }) => {
            const captured = [];
            const realWrite = process.stderr.write.bind(process.stderr);
            process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
            try {
                logger('RATELIMIT').warn('Too many login attempts', { ip: '203.0.113.7' });
            } finally {
                process.stderr.write = realWrite;
            }
            await flush();
            assert.match(captured.join(''), /Too many login attempts/,
                'a warning is not silenced just because RATELIMIT is not on the console list');
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the file sink rotates rather than growing without a ceiling', async () => {
    // The file shares a volume with the SQLite replica — history that cannot be
    // re-synced from n8n. Logging must never be the reason that volume fills
    // up, so this is the one property worth a real (tiny) size threshold rather
    // than trusting the arithmetic by inspection.
    const { dir, file } = tempLogDir('rotate');
    try {
        await withLogger({
            LOG_FILE: file, LOG_FILE_MAX_BYTES: '200', LOG_FILE_BACKUPS: '1', LOG_FORMAT: 'json'
        }, async ({ logger, flush }) => {
            const log = logger('SYNC');
            for (let i = 0; i < 40; i++) log.info(`line number ${i} padded out a bit further`);
            await flush();
            // Rotation is asynchronous (the stream has to close before the
            // rename); give the one pending rotation a moment to land.
            await new Promise((r) => { setTimeout(r, 100); });

            assert.ok(fs.existsSync(`${file}.1`), 'a backup exists once the threshold was crossed');
            assert.ok(!fs.existsSync(`${file}.2`),
                'LOG_FILE_BACKUPS=1 means exactly one backup, never a second');
            assert.ok(fs.statSync(file).size < 400, 'the active file is small — it just rotated');
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('LOG_FILE=off disables the file sink cleanly, console unaffected', async () => {
    await withLogger({ LOG_FILE: 'off', LOG_CONSOLE_COMPONENTS: 'SYNC', LOG_FORMAT: 'json' },
        async ({ logger, flush, logFilePath }) => {
            assert.equal(logFilePath, null);

            const captured = [];
            const realWrite = process.stdout.write.bind(process.stdout);
            process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
            try {
                logger('SYNC').info('still narrating the console with the file sink off');
            } finally {
                process.stdout.write = realWrite;
            }
            await flush(); // must resolve even with nothing to flush
            assert.match(captured.join(''), /still narrating/);
        });
});

test('LOG_CONSOLE_COMPONENTS=* mirrors the file onto the console — never a forced either/or', async () => {
    // The console defaulting to a curated slice must not cost anyone the option
    // to see everything live, same as it always could before this file sink
    // existed. The wildcard is that option: every component, every level, on
    // the console too, with the file completely unaffected either way.
    const { dir, file } = tempLogDir('console-all');
    try {
        await withLogger({
            LOG_FILE: file, LOG_CONSOLE_COMPONENTS: '*', LOG_FORMAT: 'json'
        }, async ({ logger, flush }) => {
            const captured = [];
            const realWrite = process.stdout.write.bind(process.stdout);
            process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
            try {
                // Not in any curated list, not warn/error — the case that stays
                // silent by default.
                logger('DAO').info('reading roi settings');
            } finally {
                process.stdout.write = realWrite;
            }
            await flush();
            assert.match(captured.join(''), /reading roi settings/,
                'the wildcard puts an ordinary info line from an arbitrary component on the console');

            const written = fs.readFileSync(file, 'utf8').trim().split('\n');
            assert.equal(written.length, 1, 'and the file still received it exactly once — not doubled');
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const ANSI = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', bold: '\x1b[1m', reset: '\x1b[0m' };

/** Runs `fn` with process.stdout.isTTY forced true, then restores it — even on throw. */
async function withForcedTTY(fn) {
    const prior = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
        return await fn();
    } finally {
        process.stdout.isTTY = prior;
    }
}

/** Captures whatever `fn` writes to process.stdout while it runs. */
async function captureStdout(fn) {
    const captured = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
        await fn();
    } finally {
        process.stdout.write = realWrite;
    }
    return captured;
}

test('a field keeps its own colour when the message does not already say it', async () => {
    // `ms` on a SYNC pass, not an HTTP line — the message ("ETL pass ok") does
    // not repeat the number, so it stays a field and keeps the colour
    // `fieldColour` gives it. This is deliberately independent of the
    // HTTP-message special case below: `fieldColour` has to work for any
    // component's `status`/`ms`, and this is the one that is NOT also
    // duplicated into its own message.
    await withLogger({ LOG_FORMAT: 'pretty', LOG_CONSOLE_COMPONENTS: '*' }, async ({ logger }) => {
        const captured = await withForcedTTY(() => captureStdout(() => {
            logger('SYNC').info('ETL pass ok', { ms: 5 });
            logger('SYNC').info('ETL pass ok', { ms: 1200 });
        }));
        assert.ok(captured[0].includes(`ms=${ANSI.green}5${ANSI.reset}`), 'a fast pass is green');
        assert.ok(captured[1].includes(`ms=${ANSI.red}1200${ANSI.reset}`),
            'a slow one is red, though the LEVEL is still info');
    });
});

test('an HTTP request line colours the method and status IN the message, and drops the duplicate fields', async () => {
    // requestLog.js builds its message as `${method} ${path} ${status}` and
    // ALSO puts method/path/status in the fields object, so the line used to
    // say everything twice: once in the message, once again as
    // `method=GET path=/api/x status=200`. Postman-style: the method is bold
    // and coloured by verb, the status is coloured the same way `status=`
    // used to be — just moved onto the copy that is actually shown — and the
    // three duplicate fields are gone from the tail of the line. `ms`, `id`
    // and `user` are NOT duplicated anywhere in the message, so they stay.
    await withLogger({ LOG_FORMAT: 'pretty', LOG_CONSOLE_COMPONENTS: '*' }, async ({ logger }) => {
        const captured = await withForcedTTY(() => captureStdout(() => {
            logger('HTTP').info('GET /api/ai-tag-options 200', {
                id: 'b0c1f63f', method: 'GET', path: '/api/ai-tag-options', status: 200,
                ms: 2, user: 'u-1'
            });
        }));
        const line = captured[0];

        assert.ok(
            line.includes(`[HTTP] ${ANSI.bold}${ANSI.green}GET${ANSI.reset} /api/ai-tag-options ` +
                `${ANSI.green}200${ANSI.reset}`),
            `method bold+green, status green, in the message: ${line}`
        );
        assert.ok(!line.includes('method='), 'method= no longer echoed — the message already said it');
        assert.ok(!line.includes('path='), 'path= no longer echoed');
        assert.ok(!line.includes('status='), 'status= no longer echoed');
        assert.ok(line.includes('id=b0c1f63f'), 'id is not in the message, so it stays');
        assert.ok(line.includes('user=u-1'), 'user is not in the message, so it stays');
        assert.ok(line.includes(`ms=${ANSI.green}2${ANSI.reset}`), 'ms stays too, and keeps its own colour');
    });
});

test('a DELETE line is red like Postman colours it, and an unknown verb is dim rather than uncoloured', async () => {
    await withLogger({ LOG_FORMAT: 'pretty', LOG_CONSOLE_COMPONENTS: '*' }, async ({ logger }) => {
        const captured = await withForcedTTY(() => captureStdout(() => {
            logger('HTTP').info('DELETE /api/ai-memories/3 204', {});
            logger('HTTP').info('PURGE /api/x 200', {}); // not a real HTTP verb, but the shape still matches
        }));
        assert.ok(captured[0].includes(`${ANSI.bold}${ANSI.red}DELETE${ANSI.reset}`));
        assert.ok(captured[1].includes(`${ANSI.bold}\x1b[90mPURGE${ANSI.reset}`),
            'an unrecognised verb still gets bolded, dim rather than left plain');
    });
});

test('the pretty format never leaks an escape code when stdout is not actually a terminal', async () => {
    // The normal case for anything piped or redirected — must read exactly as
    // plain text, because nothing downstream of a real pipe strips ANSI codes
    // for you.
    await withLogger({ LOG_FORMAT: 'pretty', LOG_CONSOLE_COMPONENTS: '*' }, async ({ logger }) => {
        const captured = await captureStdout(() => {
            logger('HTTP').info('GET /api/settings 200', { status: 200, ms: 5 });
        });
        assert.equal(captured.join('').includes('\x1b['), false);
    });
});

test('the json file is never trimmed — every field survives, redundant or not', async () => {
    // The console dropping method/path/status must not mean the FILE lost
    // them too. The file is written from `entry` before any of the console
    // filtering runs, and this is the assertion that keeps that true.
    const { dir, file } = tempLogDir('http-file-complete');
    try {
        await withLogger({ LOG_FILE: file, LOG_CONSOLE_COMPONENTS: '*', LOG_FORMAT: 'pretty' },
            async ({ logger, flush }) => {
                logger('HTTP').info('GET /api/ai-tag-options 200', {
                    id: 'b0c1f63f', method: 'GET', path: '/api/ai-tag-options', status: 200, ms: 2
                });
                await flush();
                const entry = JSON.parse(fs.readFileSync(file, 'utf8').trim());
                assert.equal(entry.method, 'GET');
                assert.equal(entry.path, '/api/ai-tag-options');
                assert.equal(entry.status, 200);
                assert.equal(entry.ms, 2);
                assert.equal(entry.id, 'b0c1f63f');
            });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
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
const { PASS_STEPS, batchLimitFor, EXEC_BATCH_LIMIT, ID_OVERLAP } =
    require(path.join(ROOT, 'src/config/syncJob'));

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

// ----------------------------------------------- M-34 · the execution batch
test('a sync batch is always big enough to clear its own overlap window', () => {
    // The incremental fetch starts at `lastId - ID_OVERLAP`, so the first
    // ID_OVERLAP rows of every batch are rows the replica already holds. A batch
    // limit that does not clear them is consumed entirely by re-reading:
    // MAX(id) does not move, the next cycle asks the identical question, and the
    // sync stalls FOREVER while reporting a healthy "N rows read" every time.
    //
    // Both numbers are environment variables, so that state is one .env edit
    // away — and it is this project's recurring failure shape: silent, and
    // indistinguishable from idle.
    assert.ok(EXEC_BATCH_LIMIT > ID_OVERLAP,
        'the shipped defaults must leave room to advance the watermark');

    // A limit smaller than the overlap is raised, not obeyed.
    assert.ok(batchLimitFor(5, 500) > 500);
    assert.ok(batchLimitFor(100, 500) > 500);

    // A sane limit is left exactly alone — the clamp must not quietly inflate a
    // deliberate choice, because the whole point of the setting is bounding how
    // long one transaction holds the write gate.
    assert.equal(batchLimitFor(20000, 500), 20000);
    assert.equal(batchLimitFor(3000, 500), 3000);

    // Nonsense never yields zero or a negative, which would fetch nothing at all
    // and look exactly like "caught up".
    assert.ok(batchLimitFor(0, 0) >= 1);
    assert.ok(batchLimitFor(undefined, undefined) >= 1);
    assert.ok(batchLimitFor(-100, 500) > 500);
});

test('the execution fetch is bounded on both paths', () => {
    // Read from the source rather than executed, because running it needs a
    // Postgres. The assertion is narrow and it is the one that matters: neither
    // SELECT over execution_entity may be unbounded. The incremental one was,
    // and it worked — 28,636 rows in one pass after a six-day gap — which is
    // exactly the number that shows the shape of the risk rather than hiding it.
    const source = fs.readFileSync(path.join(ROOT, 'src/config/syncJob.js'), 'utf8');
    const fetches = [...source.matchAll(
        /SELECT id, "workflowId", status[\s\S]*?FROM execution_entity[\s\S]*?`/g
    )].map((m) => m[0]);

    assert.equal(fetches.length, 2, 'boot and incremental — if this changes, check the new one too');
    for (const q of fetches) {
        assert.match(q, /LIMIT \$\d/, `an unbounded execution fetch: ${q.slice(0, 120)}`);
    }
});

// ------------------------------------------------- the first-sync experience
//
// A first sync does not finish in one pass and never did: five stages are
// bounded on purpose so no cycle holds the write gate for minutes. What was
// missing is that nothing SAID so — the dashboard showed plausible, quietly
// incomplete numbers, and the remedy a person arrives at unaided is pressing
// "Sync now" over and over.

test('the catch-up percentage only ever moves forward, and says which state it is in', () => {
    const { catchUpState } = require(path.join(ROOT, 'src/dao/insightsDao'))._internal;

    // Nothing owed, and never run, are opposite situations with the same empty
    // backlog. Reporting both as "complete" is how an instance that has not
    // started looks finished.
    const never = catchUpState({ total: 0 }, 0, { passes: 0, hasData: false });
    assert.equal(never.active, false);
    assert.equal(never.phase, 'never_run');
    assert.equal(never.pct, 0);

    const done = catchUpState({ total: 0 }, 0, { passes: 12, hasData: true });
    assert.equal(done.phase, 'complete');
    assert.equal(done.pct, 100);

    // Mid catch-up: half the baseline left is half done.
    const half = catchUpState(
        { total: 50000, stage: 'executions', executions: 50000, mirrored: 0, analytics: 0, fingerprints: 0 },
        100000, { passes: 9, hasData: true }
    );
    assert.equal(half.active, true);
    assert.equal(half.phase, 'catching_up');
    assert.equal(half.pct, 50);
    assert.equal(half.stage, 'executions');

    // An empty replica on its first pass is a different message: the pages are
    // blank and that is not a fault.
    assert.equal(
        catchUpState({ total: 900, stage: 'executions' }, 1000, { passes: 1, hasData: false }).phase,
        'first_run'
    );

    // ── The two ways a percentage lies, both refused ────────────────────
    //
    // Never 100 while work remains: "100%" beside a spinner is the shape that
    // makes somebody stop waiting and start pressing things.
    const nearlyThere = catchUpState({ total: 1 }, 1000000, { passes: 5, hasData: true });
    assert.ok(nearlyThere.pct < 100, 'anything outstanding is never reported as finished');

    // And never 0 once it is under way, which reads as stuck.
    const justStarted = catchUpState({ total: 999999 }, 1000000, { passes: 5, hasData: true });
    assert.ok(justStarted.pct >= 1);

    // A backlog LARGER than the baseline cannot produce a negative percentage.
    // It happens for real: extracting error detail creates the rows the
    // fingerprint walk then has to group, so a later stage adds work the first
    // measurement could not see.
    const grew = catchUpState({ total: 5000 }, 1000, { passes: 3, hasData: true });
    assert.ok(grew.pct >= 1 && grew.pct < 100, `a grown backlog stays in range, got ${grew.pct}`);
});

test('the sync backlog counts what is still to do, not what can never be done', async () => {
    // The bug this protects against was found by looking at the real replica:
    // 404,632 rows have `mode IS NULL` and always will, because n8n pruned the
    // executions they would have been filled from. The walk passes over them and
    // correctly declares itself finished.
    //
    // Counting all null rows would therefore report a backlog that never reaches
    // zero — a catch-up with no end, and a scheduler calling passes until it hit
    // its own safety cap. It counts what the walk will LOOK AT instead: the same
    // `id > cursor` the walk chunks over.
    const localDb = require(path.join(ROOT, 'src/config/localDb'));
    const { syncBacklog, BACKFILL_CURSOR_KEY } = require(path.join(ROOT, 'src/dao/syncDao'));

    const before = await localDb.query(
        'SELECT value FROM dashboard_settings WHERE key = ?', [BACKFILL_CURSOR_KEY]);
    const original = before.rows[0]?.value ?? null;

    const put = (v) => localDb.exclusive(() => localDb.execute(
        'INSERT INTO dashboard_settings (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value', [BACKFILL_CURSOR_KEY, v]));

    try {
        await put('done');
        assert.equal((await syncBacklog()).mirrored, 0, 'a finished walk owes nothing');

        // A cursor partway down owes strictly less than one at the start. This is
        // the assertion that a half-finished walk shows progress at all.
        await put('0');
        const fromStart = (await syncBacklog()).mirrored;
        await put(String(Number.MAX_SAFE_INTEGER));
        const fromEnd = (await syncBacklog()).mirrored;
        assert.equal(fromEnd, 0, 'a cursor past every row owes nothing');
        assert.ok(fromStart >= fromEnd, 'the count follows the cursor rather than the table');
    } finally {
        if (original === null) {
            await localDb.exclusive(() => localDb.execute(
                'DELETE FROM dashboard_settings WHERE key = ?', [BACKFILL_CURSOR_KEY]));
        } else {
            await put(original);
        }
    }
});

// ============================================================ alert headers
//
// F-24 §4. Channels were limited to exactly one custom header pair, so an
// endpoint needing both `Authorization` and `X-Signature` could not be
// configured at all. The list replaces it — and the part worth testing is not
// "can it hold two", it is that per-row blank-means-keep resolves by NAME, so
// reordering or renaming a row cannot move one header's secret onto another.

const {
    validateChannel, validateHeaders, readHeaders, redactConfig, SECRET_MASK, MAX_HEADERS
} = require(path.join(ROOT, 'src/utils/alertValidation'));

const channel = (config, existing) =>
    validateChannel({ name: 'sink', type: 'webhook', config }, existing);

test('a channel can carry more than one custom header', () => {
    const r = channel({
        url: 'https://example.com/hook',
        headers: [
            { name: 'Authorization', value: 'Bearer abc' },
            { name: 'X-Signature', value: 'sha256=deadbeef' }
        ]
    });
    assert.ok(r.ok, r.error);
    assert.deepEqual(r.value.config.headers, [
        { name: 'Authorization', value: 'Bearer abc' },
        { name: 'X-Signature', value: 'sha256=deadbeef' }
    ]);
});

test('the legacy header_name/header_value pair is folded in, never dropped', () => {
    // Silently ignoring it would create a channel that reports success and then
    // delivers without its auth header — a broken integration wearing the look
    // of a working one.
    const r = channel({
        url: 'https://example.com/hook',
        header_name: 'X-Token', header_value: 's3cret'
    });
    assert.ok(r.ok, r.error);
    assert.deepEqual(r.value.config.headers, [{ name: 'X-Token', value: 's3cret' }]);
});

test('readHeaders understands a config stored in the old shape', () => {
    // Existing rows in the database still hold the pair. They must keep
    // delivering without a migration that could lose a secret.
    assert.deepEqual(readHeaders({ header_name: 'X-Token', header_value: 's3cret' }),
        [{ name: 'X-Token', value: 's3cret' }]);
    assert.deepEqual(readHeaders({}), []);
    assert.deepEqual(readHeaders(null), []);
});

test('every header value is redacted, and the names are not', () => {
    // The names have to travel in clear or the form cannot show which headers
    // exist, and nobody could edit one without retyping all of them.
    const out = redactConfig('webhook', {
        url: 'https://example.com/hook',
        headers: [{ name: 'Authorization', value: 'Bearer abc' }, { name: 'X-Signature', value: 'sig' }]
    });
    assert.deepEqual(out.headers, [
        { name: 'Authorization', value: SECRET_MASK },
        { name: 'X-Signature', value: SECRET_MASK }
    ]);
    assert.equal(out.url, 'https://example.com/hook');
});

test('a blank value keeps the stored one for THAT row, matched by name', () => {
    // The bug this guards: with a single pair, "empty means keep" could key off
    // the one field. With a list it must key off the row, and an index is not a
    // row identity — the form can reorder.
    const existing = {
        headers: [
            { name: 'Authorization', value: 'Bearer abc' },
            { name: 'X-Signature', value: 'sig-original' }
        ]
    };
    const r = channel({
        url: 'https://example.com/hook',
        headers: [
            // Deliberately in the opposite order, and one is edited.
            { name: 'X-Signature', value: SECRET_MASK },
            { name: 'Authorization', value: 'Bearer NEW' }
        ]
    }, existing);
    assert.ok(r.ok, r.error);
    const byName = Object.fromEntries(r.value.config.headers.map((h) => [h.name, h.value]));
    assert.equal(byName['X-Signature'], 'sig-original', 'the untouched row kept its own secret');
    assert.equal(byName.Authorization, 'Bearer NEW', 'the edited row took the new value');
});

test('a blank value on a header that does not exist yet is refused', () => {
    // Rather than silently storing an empty header, which would be sent as a
    // present-but-empty header and read very differently at the far end.
    const r = channel({
        url: 'https://example.com/hook',
        headers: [{ name: 'X-New', value: '' }]
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /X-New/);
});

test('reserved headers cannot be overridden', () => {
    for (const name of ['Content-Type', 'content-length', 'Host']) {
        const r = channel({ url: 'https://example.com/hook', headers: [{ name, value: 'x' }] });
        assert.equal(r.ok, false, `${name} should be refused`);
    }
});

test('a header value cannot contain a line break', () => {
    // CRLF in a value is how one request becomes two at the receiving end.
    const r = channel({
        url: 'https://example.com/hook',
        headers: [{ name: 'X-Evil', value: 'a\r\nX-Injected: b' }]
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /line break/);
});

test('an invalid header name is refused', () => {
    for (const name of ['Bad Header', 'has:colon', 'nl\nname', '']) {
        const r = validateHeaders([{ name, value: 'x' }], []);
        // The empty name with a value present is a named error too, not a skip.
        assert.equal(r.ok, false, `${JSON.stringify(name)} should be refused`);
    }
});

test('a wholly blank row is dropped rather than reported as an error', () => {
    // It is what the "add header" button leaves behind before anything is typed.
    const r = validateHeaders([{ name: '', value: '' }, { name: 'X-A', value: '1' }], []);
    assert.ok(r.ok, r.error);
    assert.deepEqual(r.value, [{ name: 'X-A', value: '1' }]);
});

test('the same header cannot be listed twice', () => {
    const r = validateHeaders([{ name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }], []);
    assert.equal(r.ok, false);
});

test('the header list is bounded', () => {
    const many = Array.from({ length: MAX_HEADERS + 1 }, (_, i) => ({ name: `X-${i}`, value: 'v' }));
    assert.equal(validateHeaders(many, []).ok, false);
    const ok = many.slice(0, MAX_HEADERS);
    assert.equal(validateHeaders(ok, []).ok, true);
});

// ============================================================ cURL parsing
//
// F-24 §4 warns about exactly one thing here: a cURL command off the clipboard
// is user input that LOOKS like a command. It is parsed by us, never handed to
// a shell, and the URL it yields goes through the same SSRF check as every
// other channel URL.

const { parseCurl } = require(path.join(ROOT, 'src/utils/curl'));

test('parseCurl reads the URL, method and headers of a normal command', () => {
    const r = parseCurl(`curl -X POST 'https://example.com/hook' \\
        -H 'Authorization: Bearer abc' \\
        -H "X-Signature: sha256=deadbeef" \\
        -d '{"a":1}'`);
    assert.ok(r.ok, r.error);
    assert.equal(r.value.url, 'https://example.com/hook');
    assert.equal(r.value.method, 'POST');
    assert.deepEqual(r.value.headers, [
        { name: 'Authorization', value: 'Bearer abc' },
        { name: 'X-Signature', value: 'sha256=deadbeef' }
    ]);
});

test('parseCurl accepts a bare URL and the --long forms', () => {
    const r = parseCurl('curl --request POST --header "X-A: 1" --url https://example.com/x');
    assert.ok(r.ok, r.error);
    assert.equal(r.value.url, 'https://example.com/x');
    assert.deepEqual(r.value.headers, [{ name: 'X-A', value: '1' }]);
});

test('a paste with a shell operator in it is refused, not half-accepted', () => {
    // Nothing here executes, so this is not about injection. It is about the
    // quieter failure the first draft had: `curl https://example.com/x; rm -rf /`
    // parses fine and `new URL()` keeps the semicolon, producing a channel
    // silently pointed at `https://example.com/x;`. A wrong URL that looks
    // right is worse than an error message.
    const nasty = [
        'curl https://example.com/x; rm -rf /',
        'curl $(whoami).example.com',
        'curl `id`.example.com',
        'curl https://example.com/x && cat /etc/passwd',
        'curl https://example.com/x > /tmp/out'
    ];
    for (const cmd of nasty) {
        const r = parseCurl(cmd);
        assert.equal(r.ok, false, `${cmd} should be refused outright`);
        assert.match(r.error, /unquoted/);
    }
});

test('a quoted shell character is content, not an operator', () => {
    // `&` between query parameters is ordinary and must survive.
    const r = parseCurl(`curl 'https://example.com/x?a=1&b=2' -H 'X-A: a;b'`);
    assert.ok(r.ok, r.error);
    assert.equal(r.value.url, 'https://example.com/x?a=1&b=2');
    assert.deepEqual(r.value.headers, [{ name: 'X-A', value: 'a;b' }]);
});

test('parseCurl refuses input that is not a curl command at all', () => {
    for (const bad of ['', 'wget https://example.com', 'https://example.com', 'curl', null]) {
        assert.equal(parseCurl(bad).ok, false, `${JSON.stringify(bad)} should be refused`);
    }
});

test('parseCurl refuses a header with no colon rather than guessing', () => {
    assert.equal(parseCurl('curl https://e.com -H "NotAHeader"').ok, false);
});

test('toCurl round-trips through parseCurl', () => {
    const { toCurl } = require(path.join(ROOT, 'src/utils/curl'));
    const cmd = toCurl({
        url: 'https://example.com/hook',
        headers: [{ name: 'Authorization', value: 'Bearer abc' }]
    });
    const back = parseCurl(cmd);
    assert.ok(back.ok, back.error);
    assert.equal(back.value.url, 'https://example.com/hook');
    // Content-Type is always emitted: the dashboard only ever POSTs JSON, and a
    // command exported for someone to try in a terminal has to reproduce the
    // real request rather than a simplified one.
    assert.deepEqual(back.value.headers, [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Authorization', value: 'Bearer abc' }
    ]);
});

test('toCurl quotes a value that would otherwise break out of its quotes', () => {
    const { toCurl } = require(path.join(ROOT, 'src/utils/curl'));
    const cmd = toCurl({
        url: 'https://example.com/hook',
        headers: [{ name: 'X-Q', value: "it's \"quoted\"" }]
    });
    // Single quotes inside a single-quoted shell word are the classic escape,
    // and the generated command is something a person pastes into a terminal.
    assert.ok(!/'[^']*'[^']*'\s*$/.test(cmd) || cmd.includes(`'\\''`),
        'a single quote in a value must be escaped for the shell');
    const back = parseCurl(cmd);
    assert.ok(back.ok, back.error);
    assert.deepEqual(back.value.headers, [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'X-Q', value: "it's \"quoted\"" }
    ]);
});

// ============================================== F-24 §6 · streamed AI answers
//
// The pipeline is two model calls and a query; only the second call produces
// its output gradually, so that is what streams. What is worth testing is not
// OpenAI — it is our framing and our ordering:
//
//   · the SQL is emitted BEFORE the answer, so a reader can see what was asked
//     of the database while the prose is still arriving;
//   · a guard refusal after the headers are sent arrives as an `error` EVENT,
//     because the status line is already 200 and cannot say anything any more;
//   · a client that disconnects mid-answer does not get a half-sentence
//     written into its history, where the next turn would feed it back to the
//     model as something it supposedly said.
//
// The provider is stubbed through the require cache. Nothing here reaches the
// network, and nothing here needs an API key.

const Module = require('node:module');

/** Installs a fake `src/config/openai` and returns a fresh aiController. */
function withStubbedModel(replies) {
    const openaiPath = require.resolve(path.join(ROOT, 'src/config/openai'));
    const controllerPath = require.resolve(path.join(ROOT, 'src/controllers/aiController'));

    const calls = [];
    const stub = {
        chat: {
            completions: {
                create: async (args) => {
                    calls.push(args);
                    const reply = replies[calls.length - 1] || { chunks: [''] };
                    if (reply.throws) throw new Error(reply.throws);

                    // The runner streams every call, so the stub does too — and
                    // it fragments tool calls the way the real API does: the
                    // name in one chunk, the arguments across several, keyed by
                    // index. Handing them over whole would have let a
                    // reassembly bug pass.
                    return (async function* () {
                        if (reply.toolCalls) {
                            for (let i = 0; i < reply.toolCalls.length; i++) {
                                const t = reply.toolCalls[i];
                                yield { choices: [{ delta: { tool_calls: [{
                                    index: i, id: `call_${i}`, type: 'function',
                                    function: { name: t.name, arguments: '' }
                                }] } }] };
                                const json = JSON.stringify(t.args || {});
                                for (let c = 0; c < json.length; c += 7) {
                                    yield { choices: [{ delta: { tool_calls: [{
                                        index: i,
                                        function: { arguments: json.slice(c, c + 7) }
                                    }] } }] };
                                }
                            }
                            return;
                        }
                        for (const piece of reply.chunks || [reply.content || '']) {
                            yield { choices: [{ delta: { content: piece } }] };
                        }
                    })();
                }
            }
        }
    };

    // Seed the cache with the stub, then force the controller to be re-required
    // so it binds to it.
    require.cache[openaiPath] = new Module(openaiPath, null);
    require.cache[openaiPath].filename = openaiPath;
    require.cache[openaiPath].loaded = true;
    require.cache[openaiPath].exports = stub;
    delete require.cache[controllerPath];

    const controller = require(controllerPath);
    return { controller, calls, restore: () => {
        delete require.cache[openaiPath];
        delete require.cache[controllerPath];
    } };
}

/**
 * The calls that were steps of the tool loop, as opposed to the housekeeping.
 *
 * A turn spends one extra model call naming its conversation, on the opening
 * exchange only — see src/ai/title.js. It is not a step and must not be counted
 * as one, and it is distinguishable without a flag: every call the runner makes
 * carries the tool list, and nothing else does.
 */
const toolLoopCalls = (calls) => calls.filter((c) => Array.isArray(c.tools));

/** A minimal res that records the SSE frames written to it. */
function recordingRes() {
    const written = [];
    const listeners = {};
    return {
        headers: null,
        statusCode: 200,
        jsonBody: null,
        ended: false,
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; },
        write(chunk) { written.push(chunk); return true; },
        end() { this.ended = true; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.jsonBody = body; this.ended = true; return this; },
        on(evt, fn) { listeners[evt] = fn; },
        get raw() { return written.join(''); },
        /** Parses the recorded stream back into [{event, data}]. */
        get events() {
            return written.join('').split('\n\n').filter(Boolean).map((frame) => {
                let event = 'message', payload = '';
                for (const line of frame.split('\n')) {
                    if (line.startsWith('event: ')) event = line.slice(7);
                    else if (line.startsWith('data: ')) payload += line.slice(6);
                }
                return { event, data: JSON.parse(payload) };
            });
        }
    };
}

/** Polls a condition rather than guessing at a delay. */
async function waitFor(condition, what, timeoutMs = 8000) {
    const started = Date.now();
    while (!condition()) {
        if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => { setTimeout(r, 5); });
    }
}

/**
 * Runs a streamed turn to its end.
 *
 * `chatStream` returns as soon as the work is handed to the turn registry —
 * that separation is the feature, since it is what lets an answer survive the
 * reader navigating away — so a test that awaited only the controller would be
 * asserting against a stream containing nothing but the turn id.
 */
async function runStream(controller, req, res) {
    await controller.chatStream(req, res);
    if (res.statusCode >= 400) return res;          // refused before any stream
    await waitFor(() => res.ended, 'the stream to close');
    return res;
}

// dashboard_chat_history.user_id is a foreign key into users, so the fake
// callers below have to exist before anything can be persisted for them.
// Without this the pipeline runs correctly and then fails on the final INSERT,
// which is a fixture problem that looks exactly like a streaming bug.
test('seed the users the streaming tests write history for', async () => {
    const localDb = require(path.join(ROOT, 'src/config/localDb'));
    for (const id of ['u-stream-test', 'u-abort-test']) {
        await localDb.execute('INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)',
            [id, `${id}@test.local`]);
    }
});

const streamReq = (message, extra = {}) => ({
    body: { message },
    user: { id: 'u-stream-test' },
    scope: { unrestricted: true },
    on() {},
    ...extra
});

test('the stream narrates its steps before the prose', async () => {
    // What is announced first changed with the pipeline. It used to be the
    // generated SQL, because the SQL was the reasoning. The assistant no longer
    // writes queries — it chooses among the dashboard's own analyses — so the
    // thing worth showing, and worth showing FIRST, is which ones it chose.
    const { controller, restore } = withStubbedModel([
        { toolCalls: [{ name: 'search_catalog', args: { query: 'call center' } }] },
        { toolCalls: [{ name: 'get_analytics', args: { metric: 'kpis' } }] },
        { chunks: ['There ', 'are ', 'some ', 'workflows.'] }
    ]);
    const res = recordingRes();
    await runStream(controller, streamReq('how is call center doing?'), res);
    restore();

    const events = res.events;
    const names = events.map((e) => e.event);

    assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
    // Nginx buffers proxied responses by default, which turns a stream back into
    // one delayed blob — the header that disables it is part of the contract.
    assert.equal(res.headers['X-Accel-Buffering'], 'no');

    // Two frames of prelude before any work is reported, and both are addresses
    // rather than content: the turn id is how a client that has navigated
    // somewhere else finds this same answer, and the conversation id is which
    // thread to draw it into when it gets there.
    assert.deepEqual(names.slice(0, 2), ['turn', 'conversation']);
    assert.ok(events[0].data.id, 'the turn carries an id to reattach with');
    assert.ok(events[1].data.id, 'and the conversation says which thread this is');
    assert.equal(names[2], 'step', 'then what is being looked up');
    assert.ok(names.indexOf('step') < names.indexOf('delta'), 'which precedes the answer');
    assert.equal(names[names.length - 1], 'done');

    const steps = events.filter((e) => e.event === 'step');
    assert.equal(steps.length, 2);
    assert.equal(steps[0].data.tool, 'search_catalog');
    // The label is what a reader sees, so it is in their vocabulary and not the
    // tool's.
    assert.match(steps[0].data.label, /Looking up call center/);
    assert.equal(steps[1].data.tool, 'get_analytics');

    const answer = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.equal(answer, 'There are some workflows.');

    const done = events[events.length - 1].data;
    assert.equal(done.answer, 'There are some workflows.');
    assert.equal(done.steps.length, 2, 'the final frame carries the real arguments');
    assert.equal(done.steps[0].args.query, 'call center');
    assert.ok(res.ended);
});

test('a refused query comes back as a failed step, not as a dead stream', async () => {
    // The guard used to end the turn: the model wrote the SQL, the SQL was
    // rejected, the request was over. Now the query is one tool among several,
    // so a refusal is something the model can be told about and work around —
    // and the user still gets an answer.
    const { controller, restore } = withStubbedModel([
        { toolCalls: [{ name: 'run_sql', args: { sql: 'DROP TABLE workflow_entity', purpose: 'x' } }] },
        { chunks: ['I could not run that.'] }
    ]);
    const res = recordingRes();
    await runStream(controller, streamReq('delete everything'), res);
    restore();

    const events = res.events;
    const steps = events.filter((e) => e.event === 'step');
    assert.equal(steps.length, 1);
    assert.equal(steps[0].data.tool, 'run_sql');
    assert.equal(steps[0].data.ok, false, 'the refusal is visible as a failed step');

    // The stream survived it.
    assert.equal(events[events.length - 1].event, 'done');
    assert.equal(events[events.length - 1].data.answer, 'I could not run that.');
    assert.ok(res.ended);
});

test('DML hidden inside a CTE is refused by the query tool', async () => {
    const { controller, restore } = withStubbedModel([
        { toolCalls: [{ name: 'run_sql', args: {
            sql: 'WITH x AS (DELETE FROM execution_entity RETURNING 1) SELECT * FROM x',
            purpose: 'clean up'
        } }] },
        { chunks: ['No.'] }
    ]);
    const res = recordingRes();
    await runStream(controller, streamReq('clean up'), res);
    restore();

    const step = res.events.find((e) => e.event === 'step');
    assert.equal(step.data.ok, false);
    assert.equal(res.events[res.events.length - 1].event, 'done');
});

test('a scoped user now gets an answer, restricted to what they can see', async () => {
    // The inverse of the test this replaces. The assistant used to answer 403 to
    // every project member, because free-form SQL could not be narrowed — a
    // subquery or a UNION steps around an appended filter. It no longer writes
    // that SQL: every tool takes the caller's scope, and the read-only views
    // carry it inside the relation. So the refusal is gone, which was the point
    // of H-06 step 6.
    const { controller, restore } = withStubbedModel([
        { toolCalls: [{ name: 'get_analytics', args: { metric: 'workflows' } }] },
        { chunks: ['You have no workflows.'] }
    ]);
    const res = recordingRes();
    await runStream(controller, 
        streamReq('what do I have?', {
            scope: { unrestricted: false, userId: 'u-stream-test' }
        }), res);
    restore();

    assert.notEqual(res.statusCode, 403, 'a project member is no longer refused outright');
    assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
    assert.equal(res.events[res.events.length - 1].event, 'done');
    assert.equal(res.events[res.events.length - 1].data.answer, 'You have no workflows.');
});

test('an over-long message is refused before any stream is opened', async () => {
    const { controller, restore } = withStubbedModel([]);
    const res = recordingRes();
    await runStream(controller, streamReq('x'.repeat(2001)), res);
    restore();
    assert.equal(res.statusCode, 400);
    assert.equal(res.headers, null);
});

// ============================================ turns that outlive the request
//
// This block replaces a test that asserted the opposite, and the reversal is
// deliberate rather than a regression. The old rule was "a client that
// disconnects mid-answer writes nothing to the history", and it was right while
// a disconnection could only mean the reader had given up.
//
// It cannot mean only that any more. The assistant is a panel on every page of a
// multi-page app, so the ordinary gesture — ask, then go and look at the page the
// answer is about — is a disconnection, and it was destroying the answer and the
// tokens that paid for it. The run belongs to the turn registry now; a lost
// client is a detached subscriber.
//
// What survives from the old rule is the part that was really about half
// sentences: a CANCELLED turn still writes nothing.

const aiTurns = require(path.join(ROOT, 'src/ai/turns'));

/** Reads a body's worth of history for one user. */
async function historyCount(userId) {
    const localDb = require(path.join(ROOT, 'src/config/localDb'));
    const r = await localDb.query(
        'SELECT COUNT(*) AS n FROM dashboard_chat_history WHERE user_id = ?', [userId]);
    return r.rows[0].n;
}

test('a reader who navigates away still gets their answer', async () => {
    const { controller, restore } = withStubbedModel([
        { toolCalls: [{ name: 'describe_instance', args: {} }] },
        { chunks: ['The answer ', 'finished anyway.'] }
    ]);
    const before = await historyCount('u-abort-test');

    let fireClose = null;
    const res = recordingRes();
    const req = streamReq('a question', {
        user: { id: 'u-abort-test' },
        on(evt, fn) { if (evt === 'close') fireClose = fn; }
    });

    await controller.chatStream(req, res);
    const turnId = res.events[0].data.id;
    assert.ok(turnId, 'the client is told the id before anything else');

    // The reader clicks a link. In an MPA that is a full document load, and the
    // socket goes with it.
    fireClose();

    await waitFor(() => aiTurns._internal.turns.get(turnId)?.status === 'done',
        'the orphaned turn to finish');
    restore();

    const turn = aiTurns._internal.turns.get(turnId);
    assert.equal(turn.state.answer, 'The answer finished anyway.',
        'the model kept writing with nobody watching');
    assert.equal(await historyCount('u-abort-test'), before + 2,
        'and the question and the answer are both in the history');
});

test('the next page attaches to the same turn and picks the answer up', async () => {
    const { controller, restore } = withStubbedModel([{ chunks: ['Carried across.'] }]);

    const first = recordingRes();
    await runStream(controller, streamReq('a question', { user: { id: 'u-abort-test' } }), first);
    const turnId = first.events[0].data.id;
    restore();

    // A fresh document, a fresh request, the same turn.
    const second = recordingRes();
    await controller.attachTurn(
        { params: { id: turnId }, user: { id: 'u-abort-test' }, on() {} }, second);

    const events = second.events;
    assert.equal(events[0].event, 'turn');
    // Replayed as ONE delta rather than as the fragments it arrived in: holding
    // every frame so a late client can be told the same string a few characters
    // at a time is memory spent for no difference on screen.
    const delta = events.find((e) => e.event === 'delta');
    assert.equal(delta.data.text, 'Carried across.');
    assert.equal(events[events.length - 1].event, 'done');
    assert.ok(second.ended, 'a finished turn closes the reattached stream immediately');
});

test('a turn belonging to somebody else is absent, not forbidden', async () => {
    // "Forbidden" confirms it exists. A turn id streams a private conversation.
    const { controller, restore } = withStubbedModel([{ chunks: ['Mine.'] }]);
    const res = recordingRes();
    await runStream(controller, streamReq('mine', { user: { id: 'u-abort-test' } }), res);
    const turnId = res.events[0].data.id;
    restore();

    const stolen = recordingRes();
    await controller.attachTurn(
        { params: { id: turnId }, user: { id: 'u-stream-test' }, on() {} }, stolen);
    assert.equal(stolen.statusCode, 404);
});

test('a cancelled turn still writes nothing to the history', async () => {
    // The half-sentence rule, applied to the case it was always about. A reader
    // who presses stop does not want the answer; one who navigates does.
    const { controller, restore } = withStubbedModel([
        { toolCalls: [{ name: 'describe_instance', args: {} }] },
        { chunks: ['half a sen', 'tence'] }
    ]);
    const before = await historyCount('u-abort-test');

    const res = recordingRes();
    const req = streamReq('a question', { user: { id: 'u-abort-test' } });
    await controller.chatStream(req, res);
    const turnId = res.events[0].data.id;

    const cancelRes = recordingRes();
    await controller.cancelTurn(
        { params: { id: turnId }, user: { id: 'u-abort-test' } }, cancelRes);
    assert.equal(cancelRes.jsonBody.cancelled, true);

    await waitFor(() => res.ended, 'the cancelled stream to close');
    restore();

    assert.equal(res.events[res.events.length - 1].event, 'cancelled',
        'the client is told it stopped rather than being left to guess');
    assert.equal(await historyCount('u-abort-test'), before,
        'a cancelled answer is not a record of anything');
});

// ============================================================== @tags · H-06 §4
//
// Two gestures under one symbol, and they fail in different directions:
//
//   @tool:docs      must actually COMPEL the call. The reason this is not a
//                   sentence in the prompt is that a sentence in the prompt is
//                   what the model already ignored.
//   @workflow:X     must be re-resolved server-side. The id the client sends is
//                   never the id that is used, because a hand-written request
//                   would otherwise pin the answer to another project's work.
//
// The parser is tested against the things that merely LOOK like tags, because
// an email address in a question must not become one.

const aiTags = require(path.join(ROOT, 'src/ai/tags'));
const aiToolsFor = (opts) => require(path.join(ROOT, 'src/ai/tools')).build(opts);

test('a tag is recognised by its category, so an address is not one', () => {
    const found = aiTags.parse(
        'mail me at ops@acme.com about @workflow:Billing and @nonsense:x — @tool:docs please'
    );
    assert.deepEqual(
        found.map((t) => `${t.category}:${t.value}`),
        ['workflow:Billing', 'tool:docs'],
        'an unknown category is not a tag, and neither is host:port or an address'
    );
});

test('quotes are what let a workflow name have spaces in it', () => {
    // Bare values stop at whitespace, so without this `@workflow:Call Center`
    // would silently mean the workflow "Call".
    const [quoted] = aiTags.parse('how is @workflow:"Call Center Per Minute" doing?');
    assert.equal(quoted.value, 'Call Center Per Minute');
    const [bare] = aiTags.parse('how is @workflow:CallCenter doing?');
    assert.equal(bare.value, 'CallCenter');
});

test('the same tag written twice is one tag', () => {
    const found = aiTags.parse('@workflow:Billing vs @Workflow:billing');
    assert.equal(found.length, 1, 'case and repetition do not multiply the work');
});

test('a tool tag for a tool that is not on the list is refused, not forced', async () => {
    // The failure this prevents is a `tool_choice` naming a function the model
    // was never given — which is a provider error mid-turn, in front of the
    // user, for a tag they were allowed to type.
    const tools = aiToolsFor({ sqlEnabled: true, docsEnabled: false });
    const ctx = { scope: null, visibleIds: null, userId: 'u-tag-test' };

    const out = await aiTags.resolve(aiTags.parse('@tool:docs @tool:sql why?'), { ctx, tools });

    assert.deepEqual(out.forced, ['run_sql'], 'only what is actually available is compelled');
    assert.equal(out.rejected.length, 1);
    assert.equal(out.rejected[0].raw, '@tool:docs');
    assert.match(out.preamble, /not available in this conversation/);
});

test('a name that resolves to nothing is reported rather than quietly dropped', async () => {
    // Dropping it would produce an answer about the instance as a whole that
    // reads exactly like an answer about the thing that was tagged.
    const tools = aiToolsFor({ sqlEnabled: true, docsEnabled: false });
    const ctx = { scope: null, visibleIds: null, userId: 'u-tag-test' };

    const out = await aiTags.resolve(
        aiTags.parse('what happened to @workflow:"ZzNoSuchWorkflowZz"?'), { ctx, tools }
    );

    assert.equal(out.resolved.length, 0);
    assert.equal(out.rejected.length, 1);
    assert.match(out.rejected[0].why, /no workflow you can see/);
    assert.match(out.preamble, /Say so plainly/);
});

test('a tag is resolved against the caller\'s scope, not against the instance', async (t) => {
    // The rule the whole feature rests on. Same tag, same text, two callers:
    // the one who can see the workflow resolves it, the one who cannot is
    // refused — and nothing about the request itself differs.
    const ro = require(path.join(ROOT, 'src/config/readonlyDb'));
    // A name that belongs to exactly one workflow. Duplicates are ordinary here
    // — an archived copy beside the live one — and they are the subject of the
    // next test rather than a complication in this one.
    const [any] = await ro.query(
        `SELECT MIN(id) AS id, name FROM ai_workflows
          GROUP BY lower(name) HAVING COUNT(*) = 1 LIMIT 1`, [], { scope: null });
    if (!any) return t.skip('the replica holds no uniquely named workflow to tag');

    const tools = aiToolsFor({ sqlEnabled: true, docsEnabled: false });
    const byName = aiTags.parse(`about @workflow:"${any.name.replace(/"/g, '')}"`);
    const byId = aiTags.parse(`about @workflow:${any.id}`);
    const asUser = (visibleIds) => ({
        ctx: { scope: null, visibleIds, userId: 'u-tag-test' }, tools
    });

    const unrestricted = await aiTags.resolve(byName, asUser(null));
    assert.equal(unrestricted.resolved.length, 1, 'the owner resolves it');
    assert.equal(unrestricted.resolved[0].entry.id, any.id, 'and the id comes from the catalogue');

    // What the dropdown actually inserts, since names are not unique.
    const idForm = await aiTags.resolve(byId, asUser(null));
    assert.equal(idForm.resolved.length, 1, 'an id resolves through the same path as a name');
    assert.equal(idForm.resolved[0].entry.name, any.name);

    // An empty visible set is a real caller: a user who belongs to no project.
    // The id is spelled correctly and still buys nothing, which is the point —
    // it is re-resolved rather than believed.
    for (const tagged of [byName, byId]) {
        const scoped = await aiTags.resolve(tagged, asUser([]));
        assert.equal(scoped.resolved.length, 0, 'a caller who cannot see it does not');
        assert.equal(scoped.rejected.length, 1);
    }
});

test('a name two workflows share is refused with both ids, not guessed between', async (t) => {
    // Found in the real replica: "Saved Messages v2" is an archived workflow AND
    // a live one. Answering about either without saying so is a wrong answer
    // that reads exactly like a right one.
    const ro = require(path.join(ROOT, 'src/config/readonlyDb'));
    const [dupe] = await ro.query(
        `SELECT name, COUNT(*) AS n FROM ai_workflows
          GROUP BY lower(name) HAVING n > 1 LIMIT 1`, [], { scope: null });
    if (!dupe) return t.skip('no duplicated workflow name in the replica');

    const out = await aiTags.resolve(
        aiTags.parse(`about @workflow:"${dupe.name.replace(/"/g, '')}"`),
        { ctx: { scope: null, visibleIds: null, userId: 'u-tag-test' },
            tools: aiToolsFor({ sqlEnabled: true, docsEnabled: false }) }
    );

    assert.equal(out.resolved.length, 0);
    assert.match(out.rejected[0].why, /tag one by id instead/,
        'the way out is named, because the user can act on it');
});

test('the resolved tags arrive as their own system turn, and are never persisted', async () => {
    const { controller, calls, restore } = withStubbedModel([{ chunks: ['Nothing to report.'] }]);
    const res = recordingRes();
    await runStream(controller, streamReq('what about @workflow:"ZzNoSuchWorkflowZz"?'), res);
    restore();

    const msgs = calls[0].messages;
    const at = msgs.findIndex(
        (m) => m.role === 'system' && String(m.content).includes('Tags in this question')
    );
    assert.ok(at > 0, 'the preamble is a system turn, not a prefix on the question');
    assert.equal(msgs[at + 1].role, 'user', 'and it sits immediately before the question');

    // The client learns what stuck before the first step runs, because the chips
    // are already on screen.
    const tagEvent = res.events.find((e) => e.event === 'tags');
    assert.ok(tagEvent, 'the stream says what happened to the tags');
    assert.equal(tagEvent.data.rejected.length, 1);
    const names = res.events.map((e) => e.event);
    assert.ok(names.indexOf('tags') < (names.indexOf('step') + 1 || Infinity),
        'and says it before the first step');
    assert.ok(names.indexOf('tags') < names.indexOf('delta'), 'and before the answer');

    // Replaying resolved ids into a later, unrelated question is how a tag leaks
    // forward into a turn nobody tagged.
    const localDb = require(path.join(ROOT, 'src/config/localDb'));
    const rows = await localDb.query(
        "SELECT COUNT(*) AS n FROM dashboard_chat_history WHERE user_id = ? AND content LIKE '%Tags in this question%'",
        ['u-stream-test']);
    assert.equal(rows.rows[0].n, 0);
});

test('a tool tag becomes tool_choice on the first step, then lets go', async () => {
    const { controller, calls, restore } = withStubbedModel([
        { toolCalls: [{ name: 'describe_instance', args: {} }] },
        { chunks: ['That is what I cover.'] }
    ]);
    const res = recordingRes();
    await runStream(controller, streamReq('@tool:instance what do you cover?'), res);
    restore();

    const steps = toolLoopCalls(calls);
    assert.deepEqual(steps[0].tool_choice, { type: 'function', function: { name: 'describe_instance' } },
        'the tag compels the call rather than suggesting it');
    assert.equal(steps[1].tool_choice, 'auto', 'and the demand is spent once it is met');
    assert.equal(steps.length, 2);
});

test('a provider that ignores tool_choice does not cost the user their answer', async () => {
    // And in particular does not show them two openings: prose from a compelled
    // step is not forwarded, so dropping the demand and asking again cannot
    // stream a first sentence that the real answer then contradicts.
    const { controller, calls, restore } = withStubbedModel([
        { chunks: ['I would rather ', 'not.'] },
        { chunks: ['Real answer.'] }
    ]);
    const res = recordingRes();
    await runStream(controller, streamReq('@tool:instance what do you cover?'), res);
    restore();

    const streamed = res.events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.equal(streamed, 'Real answer.', 'the refused step is not shown to the reader');
    assert.equal(toolLoopCalls(calls).length, 2, 'and the turn continues instead of insisting');
});

test('an untagged message costs nothing', async () => {
    // Resolution reads the one serialised read-only connection. If it ran for
    // every message it would rebuild the catalogue index in front of questions
    // that never named anything.
    const out = await aiTags.resolve(aiTags.parse('how many executions failed yesterday?'), {
        ctx: { scope: null, visibleIds: null, userId: 'u-tag-test' },
        tools: aiToolsFor({ sqlEnabled: true, docsEnabled: false })
    });
    assert.equal(out.preamble, null);
    assert.deepEqual(out.forced, []);
});

// ================================================ conversations and memory
//
// The chat was one endless thread per user, and the model's context was "your
// last ten messages" whatever they were about. Two things replace that, and they
// answer different questions:
//
//   a conversation   scopes the transcript. Monday's queue-lag table stops
//                    arriving attached to Thursday's question about errors.
//   a memory         crosses conversations on purpose, because starting a new
//                    thread should not mean re-explaining who you are.
//
// What the model reads of a thread is the thread itself now, not a recent window
// plus a model-written summary of everything before it. The part worth testing
// hardest moved with that: it is no longer the seam between quoted and folded,
// it is that the budget cuts at a whole exchange and SAYS it cut, and that the
// tool lines beside each answer stay outside the answer.

const convos = require(path.join(ROOT, 'src/dao/conversationsDao'));
const aiHistory = require(path.join(ROOT, 'src/ai/history'));

const CONVO_USER = 'u-convo-test';

test('seed the user the conversation tests write for', async () => {
    const localDb = require(path.join(ROOT, 'src/config/localDb'));
    await localDb.execute('INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)',
        [CONVO_USER, `${CONVO_USER}@test.local`]);
});

test('a conversation id from somebody else starts a new thread, not theirs', async () => {
    // A conversation id names a private transcript. The check is the same one
    // tags get: an id is re-resolved against the caller, never taken at its
    // word — and a foreign one reads as absent rather than as forbidden.
    const mine = await convos.create(CONVO_USER);
    const resolved = await convos.resolveFor('u-stream-test', mine.id);
    assert.notEqual(resolved.id, mine.id, 'somebody else\'s thread is not resumed');

    // And no id at all starts a new one rather than picking up the last —
    // resuming whatever you last talked about is the behaviour threads exist to
    // remove.
    const fresh = await convos.resolveFor(CONVO_USER, null);
    assert.notEqual(fresh.id, mine.id);

    await convos.remove(mine.id, CONVO_USER);
    await convos.remove(fresh.id, CONVO_USER);
    await convos.remove(resolved.id, 'u-stream-test');
});

test('a whole thread reaches the model, with the analyses beside each answer', async () => {
    const c = await convos.create(CONVO_USER, 'thread');
    for (let i = 1; i <= 30; i++) {
        await convos.addMessage({
            conversationId: c.id, userId: CONVO_USER,
            role: i % 2 ? 'user' : 'ai',
            content: `message ${i}`,
            steps: i % 2 ? null : `get_analytics: kpis · workflow WF${i}`
        });
    }

    const loaded = await convos.history(c.id);
    assert.equal(loaded.messages.length, 30, 'nothing is dropped while it fits the budget');
    assert.equal(loaded.truncated, 0);
    assert.equal(loaded.messages[0].content, 'message 1', 'oldest first');

    // The column is `sql_used` and has been misnamed since the model stopped
    // writing SQL. What matters is that it comes back AT ALL: it is the only
    // record of which analysis produced which number, and the fold that used to
    // stand here read role and content only.
    assert.match(loaded.messages[1].steps, /workflow WF2/);

    await convos.remove(c.id, CONVO_USER);
});

test('a thread too long for the budget is cut at a question, and says it was cut', async () => {
    // Two failures in one test, because they are the same failure. A history cut
    // silently is one the model answers from as though the conversation began
    // there; a history cut mid-exchange leaves an answer with no question above
    // it, which reads as something the assistant volunteered.
    const c = await convos.create(CONVO_USER, 'long');
    for (let i = 1; i <= 10; i++) {
        await convos.addMessage({
            conversationId: c.id, userId: CONVO_USER,
            role: i % 2 ? 'user' : 'ai', content: 'x'.repeat(500)
        });
    }

    const loaded = await convos.history(c.id, { chars: 1600 });
    assert.ok(loaded.messages.length < 10, 'the budget bites');
    assert.ok(loaded.truncated > 0, 'and the shortfall is reported rather than inferred');
    assert.equal(loaded.messages[0].role, 'user', 'the oldest thing kept is a question');
    assert.equal(
        loaded.messages[loaded.messages.length - 1].content.length, 500,
        'and the newest message is always kept'
    );

    // The note is not optional decoration: it is the only thing standing between
    // a truncated thread and a model that describes it as the whole one.
    const built = aiHistory.build(loaded);
    assert.equal(built[0].role, 'system');
    assert.match(built[0].content, /not shown/i);

    await convos.remove(c.id, CONVO_USER);
});

test('the analyses behind an answer are a note about it, never part of it', async () => {
    // The failure this prevents is specific and was the reason the steps were
    // kept beside the message in the first place: a model reading its own turn
    // treats every word of it as something it said out loud, so an answer
    // ending in a tool line starts producing tool lines as prose, to the reader.
    const built = aiHistory.build({
        messages: [
            { role: 'user', content: 'how is call center doing?' },
            { role: 'ai', content: 'It ran 4,000 times.', steps: 'get_analytics: kpis · workflow WF1' }
        ],
        truncated: 0
    });

    assert.deepEqual(built.map((m) => m.role), ['user', 'assistant', 'system']);
    assert.equal(built[1].content, 'It ran 4,000 times.', 'the answer is exactly what was said');
    assert.match(built[2].content, /get_analytics: kpis · workflow WF1/);
    // And the note has to tell the model what the ids are FOR, or it resolves
    // the name again anyway, which is the wasted step this whole thing removes.
    assert.match(built[2].content, /pass the id straight to the tool/i);

    // A turn that called nothing adds nothing.
    const bare = aiHistory.build({ messages: [{ role: 'ai', content: 'I cannot.' }], truncated: 0 });
    assert.equal(bare.length, 1);
});

test('the ids a thread has measured are read from the same lines the transcript is', async () => {
    // Two readers of one stored format is one of them drifting. The subject note
    // and the transcript both parse `· workflow <id>`, so they parse it in one
    // place — and newest first, because a thread that has moved on should point
    // a pronoun at what it moved to.
    const ids = aiHistory.workflowIds([
        { steps: 'get_analytics: kpis · workflow OLD' },
        { steps: 'get_analytics: errors · workflow NEW\ndrill_down: trace' }
    ]);
    assert.deepEqual(ids, ['NEW', 'OLD']);
});

test('a thread is named from its first question, without the tag syntax', async () => {
    // Now the FALLBACK under the model-written title rather than the whole
    // scheme — see src/ai/title.js. It is still tested, and tested first,
    // because it is what stands between a provider timeout and a list of
    // threads all called "Untitled".
    assert.equal(
        convos.titleFrom('why did @workflow:281VZtHUACXi9tPH fail last night?'),
        'why did fail last night?'
    );
    assert.equal(convos.titleFrom('   '), 'New conversation');
    assert.ok(convos.titleFrom('x'.repeat(200)).length <= 60);
});

test('a title the model writes is tidied, and never overwrites one a person chose', async () => {
    const aiTitle = require(path.join(ROOT, 'src/ai/title'));

    // What a model actually returns when told to reply with a title and nothing
    // else. Each of these was a real shape: a label prefix, surrounding quotes,
    // a trailing stop, and an explanation on the second line — which unhandled
    // becomes a two-line entry in a one-line list.
    assert.equal(aiTitle._internal.clean('"Call Center overnight failures."'),
        'Call Center overnight failures');
    assert.equal(aiTitle._internal.clean('Title: Queue lag on Monday'), 'Queue lag on Monday');
    assert.equal(aiTitle._internal.clean('Queue lag\n\nThis names the thread about…'),
        'Queue lag');
    assert.ok(aiTitle._internal.clean('x'.repeat(200)).length <= aiTitle.MAX_TITLE_CHARS);

    // A title passed to create() is one somebody chose — the eval harness names
    // its scenarios and finds them again by that name — so it is settled from
    // the start rather than replaced after the first answer.
    const named = await convos.create(CONVO_USER, 'eval · S18 · a scenario');
    assert.equal(await convos.setGeneratedTitle(named.id, CONVO_USER, 'Something else'), false);
    assert.equal((await convos.find(named.id, CONVO_USER)).title, 'eval · S18 · a scenario');
    await convos.remove(named.id, CONVO_USER);

    // The flag, and the race it exists for: somebody renaming a thread while the
    // answer is still streaming has decided, and the naming pass that lands a
    // second later must not helpfully improve it back.
    const c = await convos.create(CONVO_USER);
    assert.equal(await convos.setGeneratedTitle(c.id, CONVO_USER, 'What the model chose'), true);
    assert.equal((await convos.find(c.id, CONVO_USER)).title, 'What the model chose');
    assert.equal(await convos.setGeneratedTitle(c.id, CONVO_USER, 'A second opinion'), false,
        'the naming pass runs once and does not rename a thread as it goes');

    await convos.rename(c.id, CONVO_USER, 'Mine');
    assert.equal(await convos.setGeneratedTitle(c.id, CONVO_USER, 'The model again'), false);
    assert.equal((await convos.find(c.id, CONVO_USER)).title, 'Mine');

    await convos.remove(c.id, CONVO_USER);
});

test('a memory is kept once, capped, and removable by the person it is about', async () => {
    await convos.forgetAll(CONVO_USER);

    const first = await convos.remember(CONVO_USER, '  Reports on the Call Center folder. ');
    assert.equal(first.ok, true);
    assert.equal(first.content, 'Reports on the Call Center folder.', 'whitespace is normalised');

    // The same thing said again is not a second memory — and it is not an error
    // either, because from where the model is standing it succeeded.
    const again = await convos.remember(CONVO_USER, 'reports on the CALL CENTER folder.');
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true);
    assert.equal((await convos.memories(CONVO_USER)).length, 1);

    // A refusal comes back as a reason rather than as a throw: the caller is a
    // tool call, and the model can act on an explanation.
    const tooLong = await convos.remember(CONVO_USER, 'x'.repeat(convos.MAX_MEMORY_CHARS + 1));
    assert.equal(tooLong.ok, false);
    assert.match(tooLong.reason, /under \d+ characters/);
    assert.equal((await convos.remember(CONVO_USER, 'no')).ok, false, 'and too short is refused');

    const [saved] = await convos.memories(CONVO_USER);
    assert.equal(await convos.forget(CONVO_USER, saved.id), true);
    assert.equal((await convos.memories(CONVO_USER)).length, 0);
});

test('memories reach the prompt as their own turn, ahead of the conversation', async () => {
    const { memoryBlock, historyBlock } = require(path.join(ROOT, 'src/ai/prompt'));
    assert.equal(memoryBlock([]), null, 'nothing remembered adds nothing to the prompt');

    const block = memoryBlock([{ content: 'Wants absolute counts beside every rate.' }]);
    assert.match(block, /Wants absolute counts beside every rate\./);
    // The caveat is the point: people change their minds, and a note from March
    // must not outrank what they are saying now.
    assert.match(block, /what they say now wins/);

    // The transcript is introduced before it starts, because the step notes in
    // it are not something anybody said and an unlabelled note is one the model
    // reads back to the reader as prose.
    assert.match(historyBlock(), /never quote one/i);
    assert.match(historyBlock(), /reuse it directly/i);
});

// ============================================================ the ROI calculator
//
// The one piece of real arithmetic on the ROI page, and the only browser-layer
// module in this suite. It is an `.mjs` for exactly that reason: the browser
// does not care about the extension when a module imports it, and Node will
// load it as ESM from a CommonJS package, so one file serves both instead of
// the logic being duplicated into something testable.
//
// What is being protected here is not the multiplication. It is that a
// workflow with no recent executions gets a REFUSAL rather than a number.

test('the calculator turns a manual job into a per-execution figure', async () => {
    const { perExecutionSeconds } = await import(
        `file://${path.join(ROOT, 'public/logic/roi/roi_math.mjs').replace(/\\/g, '/')}`
    );

    // A person did it 5 times a week, 30 minutes each. That is 30/7 × 5 ≈ 21.43
    // manual runs a month, or 38,571 seconds of human work — spread across the
    // 1,000 times n8n actually ran, which is 39 seconds per execution.
    const r = perExecutionSeconds({
        frequency: 5, per: 'week', duration: 30, unit: 'minutes', executions30d: 1000
    });
    assert.equal(r.ok, true);
    assert.equal(r.secondsPerExecution, 39);
    assert.equal(Math.round(r.humanSecondsPerMonth), 38571);

    // The intermediates come back because the UI shows every step. A calculator
    // that returns only its answer is one the reader has to trust rather than
    // check, which is the thing the old one got wrong.
    assert.equal(Math.round(r.manualRunsPerMonth), 21);
    assert.equal(r.executions30d, 1000);

    // Volume is the divisor, so the SAME manual job across ten times the traffic
    // is worth a tenth as much per run. This is the property that makes the
    // stored figure track reality instead of an estimate made once — and the one
    // nobody could see in the old UI.
    const busier = perExecutionSeconds({
        frequency: 5, per: 'week', duration: 30, unit: 'minutes', executions30d: 10000
    });
    assert.equal(busier.secondsPerExecution, 4);
});

test('a workflow that has not run is refused, not divided by one', async () => {
    const { perExecutionSeconds } = await import(
        `file://${path.join(ROOT, 'public/logic/roi/roi_math.mjs').replace(/\\/g, '/')}`
    );

    // The bug this replaced. `Math.max(1, executions)` meant a workflow n8n had
    // not run in thirty days was told a single execution absorbed an entire
    // month of human labour: 38,571 seconds per run, which then multiplied
    // against every historical execution on the Overview tab. Silent, enormous,
    // and indistinguishable from a real answer.
    const idle = perExecutionSeconds({
        frequency: 5, per: 'week', duration: 30, unit: 'minutes', executions30d: 0
    });
    assert.equal(idle.ok, false);
    assert.match(idle.reason, /has not run/);

    // And the refusals that are merely incomplete input say which field.
    assert.match(perExecutionSeconds({
        frequency: 0, per: 'week', duration: 30, unit: 'minutes', executions30d: 10
    }).reason, /how often/);
    assert.match(perExecutionSeconds({
        frequency: 5, per: 'week', duration: 0, unit: 'minutes', executions30d: 10
    }).reason, /how long/);
    assert.match(perExecutionSeconds({
        frequency: 5, per: 'fortnight', duration: 3, unit: 'hours', executions30d: 10
    }).reason, /period and a unit/);

    // A tiny saving still stores as one second rather than rounding to nothing.
    // Zero means "not configured" everywhere else on the page — the badge, the
    // coverage tile, the filter — so a real measurement must never land on it.
    const tiny = perExecutionSeconds({
        frequency: 1, per: 'month', duration: 1, unit: 'minutes', executions30d: 100000
    });
    assert.equal(tiny.ok, true);
    assert.equal(tiny.secondsPerExecution, 1);
});

test('what the server will store, the browser can still divide', async () => {
    // Two lists, in two languages, that have to mean the same thing: the
    // periods and units validate.js is willing to persist, and the ones
    // roi_math.mjs knows how to turn into a figure.
    //
    // Drift here is not a crash. A period accepted by the server and unknown to
    // the calculator produces a stored baseline that reopens as "Pick a period
    // and a unit" forever, on a row already wearing a Configured badge — and
    // the two files are far enough apart that nobody would connect them.
    const { PER_MONTH, UNIT_SECONDS } = await import(
        `file://${path.join(ROOT, 'public/logic/roi/roi_math.mjs').replace(/\\/g, '/')}`
    );

    const entry = (over) => validateRoiEntry({
        workflow_id: 'w1', saved_time_seconds: 60, hourly_rate: 50,
        baseline_frequency: 5, baseline_per: 'week',
        baseline_duration: 30, baseline_unit: 'minutes',
        ...over
    });

    // Everything the calculator understands must survive validation…
    for (const per of Object.keys(PER_MONTH)) {
        assert.equal(entry({ baseline_per: per }).ok, true,
            `roi_math knows "${per}" but validate.js refuses it`);
    }
    for (const unit of Object.keys(UNIT_SECONDS)) {
        assert.equal(entry({ baseline_unit: unit }).ok, true,
            `roi_math knows "${unit}" but validate.js refuses it`);
    }

    // …and nothing else may be stored, or it comes back undividable.
    for (const per of ['fortnight', 'year', 'hour', '']) {
        assert.equal(entry({ baseline_per: per }).ok, false,
            `validate.js accepts "${per}" but roi_math cannot divide it`);
    }
    for (const unit of ['seconds', 'days', '']) {
        assert.equal(entry({ baseline_unit: unit }).ok, false,
            `validate.js accepts "${unit}" but roi_math cannot divide it`);
    }
});

// =========================================== the assistant's own configuration
//
// The key and the model moved out of the environment and into the replica, so
// that installing this next to an n8n instance does not also mean editing a file
// on the host and restarting a process to try a different model.
//
// The whole risk of that move is in one sentence: `GET /api/settings` returns
// every row of dashboard_settings to any authenticated page. A key in that table
// would have been readable by anything signed in, in a response nobody would
// audit. So the key is in dashboard_secrets, and the tests below are about what
// leaves the DAO rather than about what it stores.

const aiConfig = require(path.join(ROOT, 'src/dao/aiConfigDao'));

test('the stored key never comes back out of the reader a page uses', async () => {
    const localDb = require(path.join(ROOT, 'src/config/localDb'));
    const secret = `sk-proj-${'z'.repeat(40)}abcd`;
    const priorEnv = process.env.OPENAI_API_KEY;

    await aiConfig.setApiKey(secret, 'u-convo-test');
    try {
        const shown = await aiConfig.describe();

        // The one thing that must never happen, asserted against the whole
        // object rather than against the field somebody remembered to check —
        // a second field added later that carries the value would pass a
        // narrower test.
        assert.ok(!JSON.stringify(shown).includes(secret), 'no path out of describe() has it');
        assert.equal(shown.configured, true);
        assert.equal(shown.keyHint, '…abcd', 'the last four, and only the last four');
        assert.equal(shown.keySource, 'settings');
        assert.equal(shown.updated_by, 'u-convo-test');

        // And the reader that IS allowed to have it, which nothing answering a
        // request calls.
        assert.equal(await aiConfig.apiKey(), secret);

        // Stored wins over the environment. An operator who saves one here while
        // an old one sits in the server's environment has to be told which is
        // answering their questions, or the first surprising bill has no
        // explanation.
        process.env.OPENAI_API_KEY = 'sk-environment-key-that-should-lose';
        assert.equal(await aiConfig.apiKey(), secret);
        assert.equal((await aiConfig.describe()).keySource, 'settings');

        // Clearing falls BACK to the environment rather than turning the
        // assistant off. A page is not the right authority to override the
        // host's own configuration.
        await aiConfig.clearApiKey();
        const after = await aiConfig.describe();
        assert.equal(after.configured, true);
        assert.equal(after.keySource, 'environment');
    } finally {
        await localDb.execute('DELETE FROM dashboard_secrets WHERE key = ?', [aiConfig.KEY_SECRET]);
        if (priorEnv === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = priorEnv;
    }
});

test('the model falls back settings → environment → default, and says which', async () => {
    const localDb = require(path.join(ROOT, 'src/config/localDb'));
    const priorEnv = process.env.AI_MODEL;
    delete process.env.AI_MODEL;

    try {
        assert.equal(await aiConfig.model(), aiConfig.DEFAULT_MODEL);
        assert.equal((await aiConfig.describe()).modelSource, 'default');

        process.env.AI_MODEL = 'gpt-from-the-environment';
        assert.equal(await aiConfig.model(), 'gpt-from-the-environment');

        await localDb.execute(
            'INSERT INTO dashboard_settings (key, value) VALUES (?, ?) ' +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            [aiConfig.MODEL_SETTING, 'gpt-from-settings']
        );
        assert.equal(await aiConfig.model(), 'gpt-from-settings');
        assert.equal((await aiConfig.describe()).modelSource, 'settings');
    } finally {
        await localDb.execute('DELETE FROM dashboard_settings WHERE key = ?',
            [aiConfig.MODEL_SETTING]);
        if (priorEnv === undefined) delete process.env.AI_MODEL;
        else process.env.AI_MODEL = priorEnv;
    }
});

test('history written before conversations existed is adopted, once', async () => {
    const localDb = require(path.join(ROOT, 'src/config/localDb'));
    await localDb.execute(
        'INSERT INTO dashboard_chat_history (user_id, role, content) VALUES (?, ?, ?)',
        [CONVO_USER, 'user', 'a question from before the upgrade']
    );

    const adopted = await convos.adoptOrphans(CONVO_USER);
    assert.ok(adopted, 'the orphaned messages get a thread');
    assert.equal(adopted.title, 'Earlier conversations',
        'labelled for what it is rather than split into guesses');

    const left = await localDb.query(
        'SELECT COUNT(*) AS n FROM dashboard_chat_history WHERE user_id = ? AND conversation_id IS NULL',
        [CONVO_USER]);
    assert.equal(left.rows[0].n, 0);
    // Idempotent: the second call finds nothing to adopt and creates nothing.
    assert.equal(await convos.adoptOrphans(CONVO_USER), null);

    await convos.remove(adopted.id, CONVO_USER);
});

test('remove what the conversation tests wrote', async () => {
    const localDb = require(path.join(ROOT, 'src/config/localDb'));
    await convos.forgetAll(CONVO_USER);
    await localDb.execute('DELETE FROM dashboard_chat_history WHERE user_id = ?', [CONVO_USER]);
    await localDb.execute('DELETE FROM dashboard_chat_conversations WHERE user_id = ?', [CONVO_USER]);
    await localDb.execute('DELETE FROM users WHERE id = ?', [CONVO_USER]);
    const left = await localDb.query(
        'SELECT COUNT(*) AS n FROM dashboard_chat_conversations WHERE user_id = ?', [CONVO_USER]);
    assert.equal(left.rows[0].n, 0);
});

test('remove what the streaming tests wrote', async () => {
    // The replica holds real data; a test that leaves rows behind in it is a
    // test that slowly makes the real thing wrong.
    const localDb = require(path.join(ROOT, 'src/config/localDb'));
    for (const id of ['u-stream-test', 'u-abort-test']) {
        await localDb.execute('DELETE FROM dashboard_chat_history WHERE user_id = ?', [id]);
        // The conversations these turns created. Not left to the foreign key:
        // SQLite enforces one only when `PRAGMA foreign_keys` is on, and a test
        // that depends on a pragma being set somewhere else is a test that
        // silently stops cleaning up.
        await localDb.execute('DELETE FROM dashboard_chat_conversations WHERE user_id = ?', [id]);
        await localDb.execute('DELETE FROM dashboard_user_memories WHERE user_id = ?', [id]);
        await localDb.execute('DELETE FROM users WHERE id = ?', [id]);
    }
    const left = await localDb.query(
        "SELECT COUNT(*) AS n FROM dashboard_chat_history WHERE user_id LIKE 'u-%-test'", []);
    assert.equal(left.rows[0].n, 0);
});

// ================================================= H-06 · what the AI can reach
//
// The three mechanisms that replaced "the assistant may run any SELECT". They
// are tested here rather than through the chat endpoint because each is a
// property of the data layer, and asserting them through a model call would
// make a security guarantee depend on what a model happened to ask for.
//
//   OPEN_READONLY   it cannot write, whatever the statement says
//   the ai_* views  the payload columns are not there to be selected
//   ai_scope        the restriction is INSIDE the relation, so a subquery or a
//                   UNION meets it rather than stepping around it
//
// The third is the one H-06 called impossible: "το ελεύθερο SQL δεν στενεύεται
// με φίλτρο — ένα subquery ή UNION το προσπερνά". That is true of an appended
// clause and false of a view definition, which is the whole change.

test('the assistant cannot write to the replica, whatever it asks', async () => {
    const ro = require(path.join(ROOT, 'src/config/readonlyDb'));
    await assert.rejects(
        () => ro.query('CREATE TABLE ai_should_not_exist (a)', [], { scope: null }),
        /SQLITE_READONLY/
    );
});

test('the payload columns are absent from the views, not filtered out of them', async () => {
    const ro = require(path.join(ROOT, 'src/config/readonlyDb'));
    // `no such column` from SQLite, not a rejection from our own parser. The
    // distinction matters: a parser can be spelled around, a missing column
    // cannot.
    for (const column of ['input_data', 'error_stack', 'error_message']) {
        await assert.rejects(
            () => ro.query(`SELECT ${column} FROM ai_errors LIMIT 1`, [], { scope: null }),
            /no such column/,
            `${column} is reachable through ai_errors`
        );
    }
    await assert.rejects(
        () => ro.query('SELECT normalized_message FROM ai_error_groups LIMIT 1', [], { scope: null }),
        /no such column/
    );
});

test('a scope restriction survives a subquery and a UNION', async () => {
    const ro = require(path.join(ROOT, 'src/config/readonlyDb'));

    const all = await ro.query('SELECT COUNT(*) AS n FROM ai_workflows', [], { scope: null });
    const total = all[0].n;
    assert.ok(total >= 2, 'need at least two workflows to tell scoped from unscoped');

    const two = (await ro.query('SELECT id FROM ai_workflows LIMIT 2', [], { scope: null }))
        .map((r) => r.id);

    const scoped = await ro.query('SELECT COUNT(*) AS n FROM ai_workflows', [], { scope: two });
    assert.equal(scoped[0].n, 2, 'the view itself is narrowed');

    // The two shapes H-06 named. Both must see the narrowed relation.
    const unioned = await ro.query(
        'SELECT COUNT(*) AS n FROM (SELECT id FROM ai_workflows UNION ALL SELECT id FROM ai_workflows)',
        [], { scope: two }
    );
    assert.equal(unioned[0].n, 4, `a UNION reached ${unioned[0].n} rows instead of 4`);

    const subqueried = await ro.query(
        'SELECT COUNT(*) AS n FROM ai_workflows WHERE id IN (SELECT id FROM ai_workflows)',
        [], { scope: two }
    );
    assert.equal(subqueried[0].n, 2);
});

test('a forgotten scope is refused rather than defaulting to everything', async () => {
    const ro = require(path.join(ROOT, 'src/config/readonlyDb'));
    await assert.rejects(
        () => ro.query('SELECT 1', []),
        /explicit scope/,
        'an omitted scope must not quietly mean unrestricted'
    );
});

test('the catalogue resolves a name a query would have had to guess', async () => {
    // The gap this closes: asked about "the Call Center errors", the model has
    // no way to learn that Call Center is a FOLDER rather than a workflow, and
    // a guessed id returns an empty result that reads as "nothing happened".
    const catalog = require(path.join(ROOT, 'src/ai/catalog'));
    const hits = await catalog.search({ query: 'call center', scope: null, limit: 20 });
    const kinds = new Set(hits.map((h) => h.kind));
    assert.ok(hits.length > 0, 'the catalogue found nothing');
    assert.ok(kinds.size >= 1);
    for (const h of hits) {
        assert.ok(h.id && h.name && h.kind, 'every hit carries what the other tools need');
    }
});

test('every metric the tool offers actually runs', async () => {
    // The enum in the tool description is what the model chooses from, so a
    // metric listed there that cannot execute is a promise the assistant makes
    // and then breaks mid-answer.
    const { execute } = require(path.join(ROOT, 'src/ai/execute'));
    const { METRICS } = require(path.join(ROOT, 'src/ai/tools/analytics'));
    const localDb = require(path.join(ROOT, 'src/config/localDb'));
    const ctx = { scope: { unrestricted: true }, visibleIds: null, userId: 'u-stream-test' };

    // Looked up rather than hard-coded: a metric declaring `requires` needs a
    // real id, and an id pinned in a test file is one that stops existing the
    // day somebody deletes that workflow.
    const [anyWorkflow] = (await localDb.query('SELECT id FROM workflow_entity LIMIT 1')).rows;

    for (const [metric, spec] of Object.entries(METRICS)) {
        const args = { metric };
        if (spec.requires === 'workflow') {
            assert.ok(anyWorkflow, 'the replica needs at least one workflow for this test');
            args.workflow = anyWorkflow.id;
        }
        const result = await execute('get_analytics', args, ctx);
        assert.ok(result !== undefined && result !== null, `${metric} returned nothing`);
    }
});

test('a metric about ONE thing refuses to answer about everything', async () => {
    // `workflow_failure_history` came from DRILLDOWNS, where its id was a
    // mandatory positional argument. Every other metric here treats a missing
    // `workflow` as "the whole instance" — so without an explicit declaration
    // the move would have turned a required input into a silent instance-wide
    // answer, reported under a heading naming one workflow. That is the same
    // failure the memory block and the scope filter were both written against,
    // arriving through a third door.
    const { execute } = require(path.join(ROOT, 'src/ai/execute'));
    const { METRICS } = require(path.join(ROOT, 'src/ai/tools/analytics'));
    const { DRILLDOWNS } = require(path.join(ROOT, 'src/ai/tools/drilldown'));
    const ctx = { scope: { unrestricted: true }, visibleIds: null, userId: 'u-stream-test' };

    await assert.rejects(
        () => execute('get_analytics', { metric: 'workflow_failure_history' }, ctx),
        /needs a `workflow` id/,
        'a required filter is enforced, not defaulted to instance-wide'
    );

    // And it really did leave the other registry, so the two lists cannot both
    // claim it — which is what made the model spend a recovered step every time.
    assert.ok(!DRILLDOWNS.workflow_failure_history);
    assert.ok(METRICS.workflow_failure_history);

    // Both wrong addresses redirect to the right one rather than to a list of
    // twenty alternatives.
    await assert.rejects(
        () => execute('drill_down', { kind: 'workflow_failure_history', id: 'x' }, ctx),
        /Call get_analytics with metric="workflow_failure_history"/
    );
    await assert.rejects(
        () => execute('get_analytics', { metric: 'workflow_errors' }, ctx),
        /Call get_analytics with metric="workflow_failure_history"/
    );
});

test('a grouping id that names nothing is refused, in the assistant too', async () => {
    // The system prompt already warned about this — "a guessed id does not fail,
    // it returns an empty result that reads exactly like nothing happened" — and
    // that warning was the only defence. A model resolving a half-remembered
    // name would pass an id belonging to nothing and describe the zeroes as a
    // finding.
    //
    // Thrown rather than returned: runner.js hands tool errors back as a step
    // the model can correct, so the next step is a search_catalog instead of a
    // fluent paragraph about a workflow that does not exist.
    const { execute } = require(path.join(ROOT, 'src/ai/execute'));
    const ctx = { scope: { unrestricted: true }, visibleIds: null, userId: 'u-stream-test' };

    await assert.rejects(
        () => execute('get_analytics', { metric: 'kpis', workflow: 'NotARealWorkflow' }, ctx),
        /No workflow with id "NotARealWorkflow"/
    );
    await assert.rejects(
        () => execute('get_analytics', { metric: 'kpis', folder: 'NotARealFolder' }, ctx),
        /No folder with id/
    );

    // Unfiltered still works — the check must not cost the common case anything.
    assert.ok(await execute('get_analytics', { metric: 'kpis' }, ctx));
});

test('the tool list is built from the same registry the prompt describes', async () => {
    const { build } = require(path.join(ROOT, 'src/ai/tools'));
    const { METRICS } = require(path.join(ROOT, 'src/ai/tools/analytics'));

    const tools = build({ sqlEnabled: true });
    const analytics = tools.find((t) => t.function.name === 'get_analytics');
    assert.deepEqual(
        analytics.function.parameters.properties.metric.enum,
        Object.keys(METRICS),
        'a metric added to the registry must appear in the tool without a second edit'
    );

    // The escape hatch is conditional, and the model must not be shown a tool
    // it cannot use.
    const without = build({ sqlEnabled: false });
    assert.ok(!without.some((t) => t.function.name === 'run_sql'));
});

// ==================================== H-06 · the documentation tool's own edges
//
// Three things that were wrong when this was first written, each found by
// calling the real service rather than by reading the code.

test('the docs tool refuses to pick anything that writes', async () => {
    // The service offers `give_feedback` alongside its search tool. That posts a
    // message to the n8n team — an outward-facing write on somebody else's
    // service, sent under this user's credential — and an assistant must not be
    // able to reach for it on its own. The first version picked
    // "whatever looks likely, else tools[0]", which would have chosen it the day
    // the server reordered its list.
    const docs = require(path.join(ROOT, 'src/ai/tools/docs'));
    const { argumentsFor } = docs._internal;
    assert.equal(typeof argumentsFor, 'function');

    // The picker is not exported on its own, so this asserts the shape of the
    // rule it applies: a name that writes must not match, whatever else it says.
    const writes = ['give_feedback', 'submit_report', 'send_docs_feedback', 'create_doc_query'];
    const reads = ['search_n8n_knowledge_sources', 'ask_docs', 'query_documentation'];
    const looksReadable = (n) => /search|retriev|ask|query|docs?/i.test(n)
        && !/feedback|report|submit|create|write|send/i.test(n);

    for (const name of writes) assert.equal(looksReadable(name), false, `${name} was selectable`);
    for (const name of reads) assert.equal(looksReadable(name), true, `${name} was rejected`);
});

test('the docs question is shaped by the tool\'s own schema, not by guesswork', () => {
    // The first attempt sent { query, question } to cover either spelling. The
    // service declares `additionalProperties: false`, so the extra key was not
    // ignored — the whole call was rejected, and the rejection arrived as an
    // opaque "Error calling tool" naming nothing.
    const { argumentsFor } = require(path.join(ROOT, 'src/ai/tools/docs'))._internal;

    const real = {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false
    };
    assert.deepEqual(argumentsFor(real, 'why'), { query: 'why' },
        'sent a key the schema does not allow');

    // A server that calls it something else must still work.
    assert.deepEqual(
        argumentsFor({ properties: { question: { type: 'string' } }, required: ['question'] }, 'why'),
        { question: 'why' }
    );
    // And an absent or unusable schema falls back rather than throwing.
    assert.deepEqual(argumentsFor(undefined, 'why'), { query: 'why' });
    assert.deepEqual(argumentsFor({ properties: { n: { type: 'number' } } }, 'why'), { query: 'why' });
});

test('describe_views exists, and reports only what run_sql can actually read', async () => {
    // It was promised in the run_sql description before it existed. The model
    // would have called it and been told "Unknown tool" mid-answer — the exact
    // failure the conditional registration elsewhere is designed to avoid.
    const { execute } = require(path.join(ROOT, 'src/ai/execute'));
    const { ALLOWED_VIEWS } = require(path.join(ROOT, 'src/config/aiViews'));
    const ctx = { scope: { unrestricted: true }, visibleIds: null, userId: 'u-stream-test' };

    const all = await execute('describe_views', {}, ctx);
    assert.equal(all.views.length, ALLOWED_VIEWS.size);
    for (const v of all.views) {
        assert.ok(ALLOWED_VIEWS.has(v.view), `${v.view} is described but not readable`);
        assert.ok(v.columns.length > 0, `${v.view} reported no columns`);
    }

    // The columns it advertises must be the ones that exist — this is generated
    // from PRAGMA rather than written down precisely so it cannot drift, and
    // this asserts that it did not.
    const errors = all.views.find((v) => v.view === 'ai_errors');
    assert.ok(errors.columns.includes('error_category'));
    for (const hidden of ['input_data', 'error_stack', 'error_message']) {
        assert.ok(!errors.columns.includes(hidden), `${hidden} was advertised as readable`);
    }

    const one = await execute('describe_views', { view: 'ai_workflows' }, ctx);
    assert.equal(one.views.length, 1);
});
