/**
 * cURL in, cURL out — F-24 §4.
 *
 * "Define a channel by pasting a curl, or export the existing one as a curl to
 * try from a terminal."
 *
 * The item attaches a warning to this feature and the warning is the design:
 *
 *   > A `curl` from the clipboard is USER INPUT THAT LOOKS LIKE A COMMAND. It
 *   > must be read by our own parser for -H/-X/-d/URL, NEVER through a shell,
 *   > and the URL must pass the same SSRF check as every other channel
 *   > (`validateUrl`).
 *
 * So: no `child_process`, no `exec`, nothing in this file can run anything. A
 * paste containing `; rm -rf /` is a string with a semicolon in it, and the
 * worst thing that can happen to it here is that it fails to parse.
 *
 * This module deliberately does NOT call validateUrl itself. It is a parser;
 * the caller runs the result through the same channel validation as a
 * hand-typed URL, so there is exactly one place that decides which hosts may
 * receive an alert — and a second entry point could not drift away from it.
 *
 * Pure, no I/O, so the same code could run in the browser if the form ever
 * wants to preview a paste before submitting it.
 */

// What curl calls a "long option" that takes a value, mapped to what we do
// with it. Anything not listed is skipped rather than guessed at: curl has
// dozens of flags and silently misreading one is worse than ignoring it.
const VALUE_FLAGS = new Set([
    '-H', '--header',
    '-X', '--request',
    '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode',
    '--url',
    // Consumed and discarded — they are real curl flags that take a value, and
    // not knowing that would make the NEXT token look like the URL.
    '-A', '--user-agent', '-e', '--referer', '-u', '--user',
    '-b', '--cookie', '-o', '--output', '--connect-timeout', '-m', '--max-time',
    '--retry', '--cacert', '--cert', '--key', '--proxy', '-x'
]);

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * Splits a command line into tokens the way a shell would quote them — and
 * only that.
 *
 * Understands single quotes (literal), double quotes (literal here; we do not
 * expand anything), backslash escapes and line continuations. It expands
 * NOTHING: `$(...)`, backticks and `$VAR` come through as the characters they
 * are made of. That is the difference between a parser and an interpreter, and
 * it is the whole security argument for this file.
 */
function tokenize(input) {
    const tokens = [];
    let cur = '';
    let quote = null;   // null | "'" | '"'
    let has = false;    // distinguishes an empty quoted token from no token

    for (let i = 0; i < input.length; i++) {
        const c = input[i];

        if (quote === "'") {
            if (c === "'") { quote = null; continue; }
            cur += c; continue;
        }

        if (quote === '"') {
            if (c === '\\' && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1])) {
                cur += input[++i]; continue;
            }
            if (c === '"') { quote = null; continue; }
            cur += c; continue;
        }

        if (c === "'" || c === '"') { quote = c; has = true; continue; }

        if (c === '\\') {
            // A backslash before a newline is a line continuation; before
            // anything else it escapes that character.
            if (input[i + 1] === '\n') { i++; continue; }
            if (input[i + 1] === '\r' && input[i + 2] === '\n') { i += 2; continue; }
            if (i + 1 < input.length) { cur += input[++i]; has = true; continue; }
            continue;
        }

        if (/\s/.test(c)) {
            if (cur || has) { tokens.push(cur); cur = ''; has = false; }
            continue;
        }

        cur += c;
        has = true;
    }

    if (quote) return null;              // unterminated quote — refuse, do not guess
    if (cur || has) tokens.push(cur);
    return tokens;
}

/**
 * Does this paste contain an UNQUOTED shell control operator?
 *
 * Nothing here executes, so this is not an injection guard. It guards against
 * something quieter that a test caught: `curl https://example.com/x; rm -rf /`
 * parses perfectly happily, and `new URL()` accepts the trailing semicolon as
 * part of the path. The result is a channel silently pointed at
 * `https://example.com/x;` — a wrong URL that looks like a right one, which is
 * the failure mode this whole codebase keeps being bitten by.
 *
 * A paste with a second command in it is not a webhook definition. Refuse it
 * and say so, rather than keeping the first half and discarding the rest.
 *
 * Quoted occurrences are fine — `&` inside a query string is ordinary, and a
 * quoted `;` in a header value is just a character.
 */
function hasUnquotedControl(input) {
    let quote = null;
    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (quote) {
            if (c === '\\' && quote === '"') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === "'" || c === '"') { quote = c; continue; }
        if (c === '\\') { i++; continue; }
        if (c === ';' || c === '|' || c === '&' || c === '`') return c;
        if (c === '$' && input[i + 1] === '(') return '$(';
        if (c === '>' || c === '<') return c;
    }
    return null;
}

/**
 * Parses a curl command into { url, method, headers, body }.
 *
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
function parseCurl(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
        return { ok: false, error: 'Paste a curl command.' };
    }
    if (raw.length > 8000) {
        return { ok: false, error: 'That command is too long to be a webhook definition.' };
    }

    const control = hasUnquotedControl(raw);
    if (control) {
        return {
            ok: false,
            error: `That paste contains an unquoted "${control}". Paste only the curl command — ` +
                'anything after a shell operator would be silently swallowed into the URL.'
        };
    }

    const tokens = tokenize(raw.trim());
    if (!tokens) return { ok: false, error: 'There is an unclosed quote in that command.' };
    if (!tokens.length || !/^curl(\.exe)?$/i.test(tokens[0])) {
        return { ok: false, error: 'That does not start with `curl`.' };
    }

    let url = null;
    let method = null;
    let body = null;
    const headers = [];

    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];

        // `-H` and `--header=value` are both real curl spellings.
        let flag = t;
        let inline = null;
        const eq = t.indexOf('=');
        if (t.startsWith('--') && eq > 2) {
            flag = t.slice(0, eq);
            inline = t.slice(eq + 1);
        }

        if (VALUE_FLAGS.has(flag)) {
            const value = inline !== null ? inline : tokens[++i];
            if (value === undefined) return { ok: false, error: `${flag} has no value.` };

            if (flag === '-H' || flag === '--header') {
                const colon = value.indexOf(':');
                // No colon is not a header. Guessing — treating the whole thing
                // as a name with an empty value — would produce a channel that
                // sends a header nobody asked for.
                if (colon < 1) {
                    return { ok: false, error: `"${value.slice(0, 40)}" is not a NAME: VALUE header.` };
                }
                const name = value.slice(0, colon).trim();
                const hv = value.slice(colon + 1).trim();
                if (name) headers.push({ name, value: hv });
            } else if (flag === '-X' || flag === '--request') {
                method = String(value).toUpperCase();
            } else if (flag === '--url') {
                url = value;
            } else if (flag.startsWith('-d') || flag.startsWith('--data')) {
                body = value;
                // curl's own rule: a body implies POST unless -X said otherwise.
                if (!method) method = 'POST';
            }
            continue;
        }

        // Bare flags we simply drop: -s, -k, -L, --compressed and friends carry
        // no information a webhook channel can hold.
        if (t.startsWith('-')) continue;

        // The first non-flag token is the URL.
        if (!url) url = t;
    }

    if (!url) return { ok: false, error: 'No URL found in that command.' };

    // Parsed rather than pattern-matched, so what comes out is a URL object's
    // idea of the string and not whatever the paste happened to contain. A
    // token like `$(whoami).example.com` fails here, which is the intended
    // outcome — this is a refusal, never an execution.
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, error: `"${String(url).slice(0, 60)}" is not a URL.` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'Only http and https URLs can receive alerts.' };
    }

    if (method && !METHODS.has(method)) {
        return { ok: false, error: `${method} is not an HTTP method.` };
    }

    return {
        ok: true,
        value: {
            url: parsed.toString(),
            // The dashboard always POSTs JSON; the method is reported so the
            // form can say so when a paste disagrees, rather than silently
            // dropping the difference.
            method: method || 'GET',
            headers,
            body
        }
    };
}

/**
 * Renders a channel as a curl command someone can paste into a terminal.
 *
 * The output is a shell command, so every interpolated value is single-quoted
 * with the standard `'\''` escape. A header value containing a quote is not
 * hypothetical — signatures and base64 tokens contain all sorts — and an
 * unescaped one produces a command that either fails or, worse, runs as
 * something other than what it displays.
 *
 * Secrets are the caller's decision: pass the redacted headers to get a
 * shareable command, or the real ones to get a working one. This function does
 * not know which it has, and deliberately does not guess.
 */
function toCurl({ url, headers = [], body, method = 'POST' }) {
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const parts = [`curl -X ${METHODS.has(String(method).toUpperCase()) ? String(method).toUpperCase() : 'POST'}`];
    parts.push(q(url));
    parts.push(`-H ${q('Content-Type: application/json')}`);
    for (const h of headers) {
        if (!h || !h.name) continue;
        parts.push(`-H ${q(`${h.name}: ${h.value ?? ''}`)}`);
    }
    if (body) parts.push(`-d ${q(typeof body === 'string' ? body : JSON.stringify(body))}`);
    return parts.join(' \\\n  ');
}

module.exports = { parseCurl, toCurl, tokenize, hasUnquotedControl };
