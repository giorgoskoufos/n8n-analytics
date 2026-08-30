/**
 * The application logger.
 *
 * Before this, everything went through console.log. Three consequences, all of
 * which showed up while debugging this codebase:
 *
 *   - No levels. There was no way to turn detail up while chasing a problem or
 *     down to stop a five-minute cron filling the container log, so the ETL
 *     printed the same eight lines forever and the interesting ones were lost
 *     among them.
 *   - Nothing machine-readable. `docker logs | grep` is the only tool that works
 *     on prose, and prose changes.
 *   - No way to connect lines. A 500 in the log had no thread back to the
 *     request that caused it, the user who sent it, or how long it took.
 *
 * Written here rather than pulling in pino. pino is a good library, but it
 * brings worker-thread transports and a plugin surface to a program that emits a
 * few dozen lines a minute — and this project has already taken the position
 * that a dependency has to earn its place (see vendorAssets.js). The whole
 * implementation is below and does exactly what the app needs.
 *
 * ── Two sinks, and why one process needs both ────────────────────────────
 *
 * The console used to be the only sink, and it had two jobs that pull in
 * opposite directions: showing an operator what the ETL is doing right now, and
 * being a complete record of everything the process did. Turning LOG_FORMAT to
 * json for the second job made the first one unreadable — an operator watching
 * `docker logs -f` for "is it still syncing" got a firehose of one JSON object
 * per HTTP request instead.
 *
 * So they are separated. The CONSOLE stays a narrative: the sync narrating
 * itself (`SYNC`), the process narrating its own lifecycle (`SERVER`, `LOCK` —
 * which is also part of the sync story, since it is the reason a given instance
 * did or did not run one), and anything urgent from anywhere (`warn`/`error`,
 * always, regardless of component — a problem in `HTTP` or `AI` must not require
 * someone to already be tailing a file to notice it).
 *
 * The FILE is the complete record, unconditionally JSON — one line per entry,
 * every component, every level down to the configured threshold. It exists to
 * be mounted by something else later: a Promtail sidecar, a `tail -f` into
 * Loki, `docker cp` for a support bundle. It writes into the SAME directory as
 * the SQLite replica by default, which means the volume this project already
 * requires you to mount for the database (see localDb.js) carries the logs too
 * — nothing new to configure to get a persistent, moutable log file.
 *
 * Format:
 *   LOG_LEVEL=info|warn|error|debug   the threshold BOTH sinks share
 *   LOG_FORMAT=json|pretty            how the CONSOLE renders a line that
 *                                     clears the filter below. The file is
 *                                     always json — pretty is for a human
 *                                     reading a terminal, and nothing else ever
 *                                     reads the file's lines one at a time.
 *   LOG_CONSOLE_COMPONENTS            comma list of components shown on the
 *                                     console at every level. Default
 *                                     SYNC,SERVER,LOCK — the sync story. Every
 *                                     component still reaches the file, and
 *                                     warn/error from ANY component still
 *                                     reaches the console regardless of this
 *                                     list.
 *   LOG_FILE                         path to the json-lines file, or `off` to
 *                                     disable it outright. Defaults to a
 *                                     `logs/` folder beside the SQLite replica.
 *   LOG_FILE_MAX_BYTES, LOG_FILE_BACKUPS
 *                                     rotation. See the note above `rotate()` —
 *                                     this file shares a volume with data that
 *                                     cannot be re-synced, so it must not be
 *                                     allowed to grow without a ceiling.
 */
const fs = require('fs');
const path = require('path');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configuredLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[configuredLevel] !== undefined ? LEVELS[configuredLevel] : LEVELS.info;

const format = (process.env.LOG_FORMAT || '').toLowerCase() ||
    (process.stdout.isTTY ? 'pretty' : 'json');

/**
 * Which components narrate on the console regardless of level.
 *
 * Matched against the part of a component name before a `:` — `logger('SYNC')`
 * and a future `logger('SYNC').child('ANALYTICS')` (component `SYNC:ANALYTICS`)
 * both match an allowlist entry of `SYNC`.
 */
const consoleComponents = new Set(
    (process.env.LOG_CONSOLE_COMPONENTS || 'SYNC,SERVER,LOCK')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
);

/**
 * Keys whose values never reach the log, whatever they contain.
 *
 * A denial rather than a promise to be careful: the fields below have all been
 * within one console.log of the log at some point in this codebase — the JWT is
 * in every request header, the Postgres password is in the connection config,
 * and the OpenAI key is on the client object. Two of the three had already
 * leaked through a different channel and had to be rotated. Applied once, to
 * the one `entry` object both sinks write from — there is no second path a
 * secret could take to only one of them.
 */
const REDACTED_KEYS = /^(password|passwd|pass|token|authorization|auth|secret|apikey|api_key|jwt|cookie|set-cookie|dashboard_db_pass|openai_api_key|dashboard_jwt_secret)$/i;

function redact(value, depth = 0) {
    if (value === null || typeof value !== 'object' || depth > 4) return value;
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = REDACTED_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
}

// ANSI only when the output is a terminal; a log file full of escape codes is
// worse than no colour at all.
const COLOURS = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
const RESET = '\x1b[0m';

// ==========================================================================
// The file sink
// ==========================================================================

/**
 * Where the json-lines file lives when nobody says otherwise.
 *
 * Resolved independently rather than imported from localDb.js, which already
 * requires this module — importing it back would be circular. The duplication
 * is one line and it mirrors localDb's own default exactly on purpose: same
 * environment variable, same fallback, so "where is my database" and "where
 * are my logs" agree without either module knowing about the other.
 *
 * Landing beside the replica means the volume this project already requires
 * you to mount (see the CAUTION in README's Docker section) carries the logs
 * for free — nothing new to provision to make them survive a redeploy or to be
 * mountable by a second container later.
 */
function defaultLogFilePath() {
    const dbPath = process.env.DASHBOARD_DB_PATH
        ? path.resolve(process.env.DASHBOARD_DB_PATH)
        : path.resolve(__dirname, '../../dashboard.sqlite');
    return path.join(path.dirname(dbPath), 'logs', 'app.jsonl');
}

const rawLogFile = process.env.LOG_FILE || '';
let fileDisabled = rawLogFile.toLowerCase() === 'off';
const LOG_FILE = fileDisabled ? null : path.resolve(rawLogFile || defaultLogFilePath());

// Kept generous but bounded: this file shares a volume with the SQLite replica,
// which holds execution history that cannot be re-synced from n8n. Logging must
// never be the reason that volume fills up. 10 MB × (1 active + 2 backups) is
// ~30 MB at the default — a rounding error next to a replica measured in
// hundreds of megabytes, and enough history to be useful after the fact.
const MAX_FILE_BYTES = Number(process.env.LOG_FILE_MAX_BYTES) || 10 * 1024 * 1024;
const FILE_BACKUPS = Number(process.env.LOG_FILE_BACKUPS) || 2;

let fileStream = null;
let fileBytes = 0;
let rotating = false;
let warnedOnce = false;

/**
 * Disables the file sink after one explanation.
 *
 * Not routed through emit(): the file sink just failed, so sending this
 * message back through the thing that failed either recurses or silently loses
 * the one line that explains why logging to disk stopped. It goes straight to
 * stderr, once, and the process keeps running on the console sink alone — a
 * dashboard that stops answering requests because its OWN log file could not be
 * opened would be a strange kind of outage to explain.
 */
function disableFile(action, err) {
    if (warnedOnce) return;
    warnedOnce = true;
    fileDisabled = true;
    process.stderr.write(
        `[LOGGER] Could not ${action} ${LOG_FILE} (${err && (err.code || err.message)}). ` +
        'File logging is disabled for the rest of this process; console output is unaffected.\n'
    );
}

function openFileStream() {
    if (fileDisabled || fileStream) return;
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fileStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
        fileStream.on('error', (err) => disableFile('write to', err));
        // Seeded from what is already on disk, so a process restart remembers
        // how close the file was to rotating instead of resetting the count and
        // letting the real file grow past the limit by however much survived.
        try {
            fileBytes = fs.statSync(LOG_FILE).size;
        } catch {
            fileBytes = 0;
        }
    } catch (err) {
        disableFile('open', err);
    }
}

/**
 * Renames the active file to `.1`, the old `.1` to `.2`, and so on, discarding
 * whatever falls off the end. The classic logrotate shape, done by hand because
 * the entire policy is a dozen lines and a dependency would be a build step.
 *
 * The stream is closed and its callback awaited before any rename — on Linux a
 * rename under an open file descriptor is safe (the descriptor keeps writing to
 * the same inode regardless of its name), but doing it this way is correct
 * everywhere, including the Windows machine this was developed on, and it costs
 * nothing: rotation happens once every 10 MB, not on a hot path.
 *
 * New lines that arrive while a rotation is in flight are dropped rather than
 * queued. They are operational telemetry, not the record this application
 * exists to keep — that is the SQLite replica, which nothing here touches —
 * and losing a handful of lines during a sub-second window once every 10 MB is
 * a better trade than adding a write queue to a logger.
 */
function rotate() {
    if (rotating || !fileStream) return;
    rotating = true;
    const closing = fileStream;
    fileStream = null;

    closing.end(() => {
        try {
            for (let i = FILE_BACKUPS; i >= 1; i--) {
                const src = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
                const dst = `${LOG_FILE}.${i}`;
                if (!fs.existsSync(src)) continue;
                try {
                    fs.unlinkSync(dst);
                } catch {
                    // dst did not exist, which is the common case.
                }
                fs.renameSync(src, dst);
            }
            fileBytes = 0;
        } catch (err) {
            disableFile('rotate', err);
            return;
        } finally {
            rotating = false;
        }
        openFileStream();
    });
}

function writeToFile(jsonLine) {
    if (fileDisabled || rotating) return;
    if (!fileStream) openFileStream();
    if (!fileStream) return; // opening just failed; disableFile already explained why

    const chunk = jsonLine + '\n';
    fileStream.write(chunk);
    fileBytes += Buffer.byteLength(chunk);
    if (fileBytes >= MAX_FILE_BYTES) rotate();
}

/**
 * Resolves once everything written so far has been flushed to the file.
 *
 * `process.exit()` does not wait for an `fs.WriteStream`'s internal buffer to
 * drain — it can and does truncate the last few lines of a log file on a clean
 * shutdown, which is exactly the moment a "stopped cleanly" line matters most.
 * A zero-length write's callback only fires after everything queued ahead of it
 * has been handed to the OS, which is the drain guarantee a caller about to
 * call `process.exit()` needs, without adding a queue or a dependency for it.
 */
function flush() {
    return new Promise((resolve) => {
        if (!fileStream) {
            resolve();
            return;
        }
        fileStream.write('', () => resolve());
    });
}

// ==========================================================================
// Shared formatting
// ==========================================================================

/**
 * Turns a console-style argument list into a message plus fields.
 *
 * Deliberately permissive, because every call site in this codebase was written
 * against console.log and passes whatever it had: a trailing Error, a stray
 * number, an object. A logger that quietly dropped those extras would erase the
 * detail that makes the line worth logging — an Error object in particular has
 * no enumerable properties, so treating it as a fields object loses the message
 * and the stack together.
 */
function normalise(message, rest) {
    let text = String(message);
    const fields = {};

    for (const arg of rest) {
        if (arg instanceof Error) {
            fields.err = arg.message;
            if (arg.code) fields.code = arg.code;
            if (threshold >= LEVELS.debug && arg.stack) fields.stack = arg.stack;
        } else if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
            Object.assign(fields, arg);
        } else if (arg !== undefined) {
            text += ' ' + (typeof arg === 'string' ? arg : fmt(arg));
        }
    }
    return { text, fields };
}

function emit(level, component, message, fields) {
    if (LEVELS[level] > threshold) return;

    const entry = {
        time: new Date().toISOString(),
        level,
        component,
        message: String(message),
        ...redact(fields || {})
    };
    const jsonLine = JSON.stringify(entry);

    // Every entry that clears the level threshold reaches the file, whatever
    // component it came from — that is the whole point of the file existing.
    writeToFile(jsonLine);

    // The console is a narrower view: the sync story, plus anything urgent from
    // anywhere. `warn`/`error` bypass the allowlist on purpose — a problem in a
    // component nobody put on the console list must not require someone to
    // already be tailing the file to find out about it.
    const base = component.split(':')[0].toUpperCase();
    if (!consoleComponents.has(base) && level !== 'warn' && level !== 'error') return;

    const line = format === 'json'
        ? jsonLine
        : `${process.stdout.isTTY ? COLOURS[level] : ''}${level.toUpperCase().padEnd(5)}${process.stdout.isTTY ? RESET : ''} ` +
          `[${component}] ${entry.message}` +
          (fields && Object.keys(fields).length
              ? ' ' + Object.entries(redact(fields)).map(([k, v]) => `${k}=${fmt(v)}`).join(' ')
              : '');

    // stderr for problems, stdout for everything else — so `2>` separates them
    // and an orchestrator's error stream means something.
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

function fmt(v) {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'object') return JSON.stringify(v);
    const s = String(v);
    return /\s/.test(s) ? JSON.stringify(s) : s;
}

/**
 * A logger bound to one component, so every line it writes is attributable
 * without the caller repeating the name.
 *
 *   const log = logger('SYNC');
 *   log.info('Synced workflows', { count: 163 });
 */
function logger(component) {
    const at = (level) => (message, ...rest) => {
        if (LEVELS[level] > threshold) return;   // skip normalise() entirely when filtered out
        const { text, fields } = normalise(message, rest);
        emit(level, component, text, fields);
    };
    return {
        error: at('error'),
        warn: at('warn'),
        info: at('info'),
        debug: at('debug'),
        /** For a sub-area of the same component, e.g. logger('SYNC').child('ANALYTICS'). */
        child: (sub) => logger(`${component}:${sub}`)
    };
}

module.exports = {
    logger,
    LEVELS,
    level: configuredLevel,
    format,
    /** Null when LOG_FILE=off. Read by server.js to say so once at boot. */
    logFilePath: fileDisabled ? null : LOG_FILE,
    flush
};
