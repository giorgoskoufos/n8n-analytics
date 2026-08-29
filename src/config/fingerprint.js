const crypto = require('crypto');

/**
 * Error fingerprinting. Pure — no I/O, no database handles, no side effects on
 * require, same contract as errorParser.js, so a backfill script or a test can
 * use it without opening anything.
 *
 * The problem it solves: errors were grouped on
 * `(category, node_name, SUBSTR(message, 1, 200))`, which makes "Column
 * 'remedy_id' does not exist" and "Column 'receivedDateTime' does not exist" two
 * unrelated problems. On this instance that turned 14,267 errors into 1,524
 * groups — more groups than anyone can read, and none of them a unit of work.
 * Fingerprinting the same rows produces 98.
 *
 * The measured effect of each rule matters more than its elegance, so the ones
 * here were chosen against real messages from this instance and each is
 * justified below by what it actually collapses.
 */

/**
 * Bump when a rule changes in a way that would give a different fingerprint for
 * the same message.
 *
 * Exactly the reasoning behind CLASSIFIER_VERSION: rows already fingerprinted
 * keep whatever the rules were when they were written, and nothing revisits
 * them, so an improvement would apply to new errors only and quietly split every
 * historical group in two. The sync compares this against what is stored and
 * recomputes once when they differ.
 *
 *   1 — html collapse, url/email/uuid/date/time/quoted/hex/number placeholders
 */
const FINGERPRINT_VERSION = 1;

// Long enough to keep two genuinely different failures apart, short enough that
// a stack trace or a dumped payload cannot make every occurrence unique. The old
// SUBSTR(…, 1, 200) was the same idea applied to un-normalised text, where it
// did nothing at all.
const MAX_NORMALIZED = 300;

/**
 * An error message reduced to its shape.
 *
 * Order is deliberate. Structured forms are recognised before the generic number
 * rule, or a date becomes `<N>-<N>-<N>` and a URL is shredded into fragments.
 */
function normalizeMessage(message) {
    if (message === null || message === undefined) return '';
    let s = String(message);

    // An HTML document is not an error message — it is an upstream service
    // answering with its error *page*, and no two are byte-identical (session
    // ids, timestamps, ray ids in the markup). 300 of this instance's errors are
    // these, and they produced nearly 300 distinct groups. The <title> is the
    // one part that says which failure it was, so it is kept: "not found" and
    // "service suspended" stay apart while the markup around them collapses.
    if (/^\s*<(!doctype\s+html|html[\s>])/i.test(s) || /<\/html\s*>/i.test(s)) {
        const title = (s.match(/<title[^>]*>([^<]{0,80})<\/title>/i) || [])[1];
        return title ? `<HTML: ${title.replace(/\s+/g, ' ').trim().toLowerCase()}>` : '<HTML>';
    }

    s = s.replace(/\s+/g, ' ').trim();

    // Before the number rule, all of these: each contains digits that would
    // otherwise be replaced piecemeal, leaving a shape that still differs.
    s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)\]]+/gi, '<URL>');
    s = s.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<EMAIL>');
    s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>');
    s = s.replace(/\b\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?\b/g, '<DATE>');
    s = s.replace(/\b\d{2}:\d{2}:\d{2}\b/g, '<TIME>');

    // Quoted values are the single biggest source of false distinctions here:
    // "Column 'x' does not exist" appears with a different column name almost
    // every time. Bounded and newline-free so an unbalanced quote cannot swallow
    // the rest of the message.
    s = s.replace(/'[^'\n]{0,200}'/g, '<STR>')
        .replace(/"[^"\n]{0,200}"/g, '<STR>')
        .replace(/`[^`\n]{0,200}`/g, '<STR>');

    // Hashes, tokens and ids before the number rule, or a 40-character hex digest
    // becomes a mixture of <N> and letters that still differs every time.
    s = s.replace(/\b(?:0x)?[0-9a-f]{16,}\b/gi, '<HEX>');

    // Everything numeric last. Row ids, byte offsets, ports, retry-after values:
    // "Row 4821 not found" and "Row 4822 not found" are one problem.
    s = s.replace(/\b\d[\d.,]*\b/g, '<N>');

    s = s.replace(/\s+/g, ' ').trim();
    return s.length > MAX_NORMALIZED ? s.slice(0, MAX_NORMALIZED) : s;
}

// The separator between the three parts of the key. NUL because it cannot occur
// in a node type, an error type, or a normalised message — with a comma or a
// pipe, two different triples could produce the same joined string and therefore
// the same fingerprint. Written as an escape rather than typed literally: a raw
// NUL byte in a source file makes the file binary to every tool that reads it,
// and an escape sequence does not survive every pipe it has to travel through.
const SEPARATOR = String.fromCharCode(0);

/**
 * A stable identity for one kind of failure.
 *
 * Keyed on the normalised message, the node *type* and the error type.
 *
 * node_type rather than node_name: the name is whatever the author typed in the
 * editor, so the same library bug in two workflows would be two fingerprints.
 * The type is what the failure is actually about.
 *
 * error_category is deliberately NOT part of the key even though the current
 * grouping uses it. The category is derived from the message by rules that carry
 * their own version and get recomputed — folding it in would mean a classifier
 * improvement silently changed the identity of every historical error, which is
 * the one thing a fingerprint must not do.
 *
 * Truncated to 16 hex characters: 64 bits, so a collision needs on the order of
 * four billion distinct error shapes before it is even likely. This instance has
 * ninety-eight.
 */
function fingerprintOf(message, nodeType, errorType) {
    const normalized = normalizeMessage(message);
    const key = [normalized, nodeType || '', errorType || ''].join(SEPARATOR);
    return {
        fingerprint: crypto.createHash('sha1').update(key).digest('hex').slice(0, 16),
        normalized
    };
}

module.exports = { normalizeMessage, fingerprintOf, FINGERPRINT_VERSION, MAX_NORMALIZED };
