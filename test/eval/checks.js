/**
 * The four dimensions, as functions that return a verdict.
 *
 * Three of the four are decided from facts rather than from an opinion, and
 * that is the point of the file. "Did it call the right tool, scoped the right
 * way" is recorded in the steps. "Did it say the right number" is a comparison
 * against the DAO. Only "is the prose actually an answer" needs a judge, and a
 * judge that is only asked the question it is needed for is a judge whose
 * verdicts are worth reading.
 */

/** `10076` also matches `10,076` and `10.076` — every way a number reaches prose. */
function saysExactly(text, n) {
    if (n === null || n === undefined) return false;
    const digits = String(Math.round(n));
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '[.,\\s]?');
    return new RegExp(`(?<![\\d.,])${grouped}(?![\\d])`).test(text);
}

/**
 * Every number in the prose, however it was punctuated.
 *
 * Needed because an exact match is the wrong test on a live instance. The
 * window is a rolling seven days and this one runs about 1,440 executions a
 * day, so the count moves between the moment ground truth is read and the
 * moment the model runs its own query — 10,073 against an expected 10,074 is
 * the harness being wrong, not the assistant.
 *
 * The tolerance is deliberately tiny. It has to absorb a few seconds of drift
 * and it must NOT absorb the failure this whole file exists to catch: the
 * instance's 32,963 reported as one workflow's 10,074 is a factor of three, and
 * no honest tolerance reaches that far.
 */
const TOLERANCE = 0.005;

function numbersIn(text) {
    return [...text.matchAll(/(?<![\d.,])(\d{1,3}(?:[.,\s]\d{3})+|\d+)(?![\d])/g)]
        .map((m) => Number(m[1].replace(/[.,\s]/g, '')))
        .filter((n) => Number.isFinite(n));
}

function saysNumber(text, n) {
    if (n === null || n === undefined) return false;
    if (saysExactly(text, n)) return true;
    const slack = Math.max(2, Math.abs(n) * TOLERANCE);
    return numbersIn(text).some((seen) => Math.abs(seen - n) <= slack);
}

/**
 * TOOL USAGE — decided from the recorded calls, never from the prose.
 *
 * `expect` entries are `{ tool, args }`, where each arg value is either a
 * literal to match or a function taking the actual value. `forbid` is a list of
 * tool names that must not appear at all.
 */
function matches(step, want) {
    if (step.tool !== want.tool) return false;
    if (!want.args) return true;
    return Object.entries(want.args).every(([k, v]) => {
        const actual = (step.args || {})[k];
        return typeof v === 'function' ? v(actual) : actual === v;
    });
}

function toolUsage(steps, { expect = [], forbid = [], oneOf = [] } = {}) {
    const problems = [];

    // `oneOf` is for a question with more than one defensible answer. "Is this
    // isolated or does it happen often" can be answered by counting failures
    // across workflows OR by reading one workflow's failure history, and a
    // harness that insists on whichever the model picked the day the scenario
    // was written is measuring its author's memory rather than the assistant.
    if (oneOf.length && !oneOf.some((want) => steps.some((s) => matches(s, want)))) {
        problems.push(`called none of ${oneOf.map((w) => `\`${w.tool}\``).join(' / ')}`);
    }

    for (const want of expect) {
        const candidates = steps.filter((s) => s.tool === want.tool);
        if (!candidates.length) {
            problems.push(`never called \`${want.tool}\``);
            continue;
        }
        if (!want.args) continue;

        const ok = candidates.some((s) => matches(s, want));
        if (!ok) {
            const seen = candidates.map((s) => JSON.stringify(s.args || {})).join(' | ');
            problems.push(`\`${want.tool}\` was called but never with ${JSON.stringify(want.args)} — saw ${seen}`);
        }
    }

    for (const name of forbid) {
        if (steps.some((s) => s.tool === name)) problems.push(`called \`${name}\`, which this question does not need`);
    }

    const failed = steps.filter((s) => s.ok === false);
    for (const s of failed) problems.push(`\`${s.tool}\` failed: ${s.error || 'unknown error'}`);

    return { pass: !problems.length, problems };
}

/**
 * STATISTICS — every figure that must appear, and every figure that must not.
 *
 * The traps are the half that catches the failure this was written for. An
 * answer about one workflow that quotes the instance's total is wrong in the
 * most dangerous way available: fluent, specific, and off by a factor of three.
 * Checking only for the right number would pass it, because the right number
 * was in the same answer, in a different table.
 */
function statistics(answer, { must = [], traps = [] } = {}) {
    const problems = [];

    for (const { label, value } of must) {
        if (!saysNumber(answer, value)) problems.push(`does not state ${label} (${value})`);
    }
    for (const { label, value } of traps) {
        // Exact, unlike the `must` side above: a trap asks whether one specific
        // wrong number was quoted, and a tolerance around it would start
        // catching numbers that merely land nearby.
        if (saysExactly(answer, value)) {
            problems.push(`states ${value}, which is ${label} — not what was asked about`);
        }
    }

    return { pass: !problems.length, problems };
}

/**
 * CONTEXT — did the turn stay on the subject the conversation established.
 *
 * Checked by naming: a follow-up about "its errors" that names three other
 * workflows has lost the thread, and that is decidable without asking anyone's
 * opinion. `subject` must appear; anything in `strangers` must not.
 */
function context(answer, { subject = null, strangers = [] } = {}) {
    const problems = [];

    if (subject && !answer.includes(subject)) {
        problems.push(`never names \`${subject}\`, which the conversation is about`);
    }

    // Only names long enough to be unambiguous. A workflow called "Test" would
    // otherwise match the word "test" in any sentence.
    const named = strangers.filter((n) => n && n.length >= 6 && answer.includes(n));
    if (named.length) {
        problems.push(`brings in ${named.slice(0, 4).map((n) => `\`${n}\``).join(', ')} — not the subject`);
    }

    return { pass: !problems.length, problems };
}

/**
 * CONTRADICTION — the same quantity, twice, differently, in one answer.
 *
 * This is a check the observed transcript demands: one answer opened with
 * "Total executions: 0" and closed with "1 error in 10,070 executions" about
 * the same workflow. Neither half is checkable against a rubric; together they
 * are obviously broken, and a reader who only reads one half is misled.
 */
function contradiction(answer, { quantity = 'executions' } = {}) {
    const problems = [];
    const zeroish = /(?:total|συνολικ\w*)[^.\n]{0,40}?[:\s]\s*0\b/i.test(answer);
    const bigNumber = /(?<![\d.,])\d{1,3}(?:[.,]\d{3})+(?![\d])/.test(answer);
    if (zeroish && bigNumber) {
        problems.push(`states a total of 0 ${quantity} and also quotes a figure in the thousands`);
    }
    return { pass: !problems.length, problems };
}

module.exports = { toolUsage, statistics, context, contradiction, saysNumber, saysExactly };
