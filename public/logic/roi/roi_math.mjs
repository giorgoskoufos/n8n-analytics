/**
 * The one piece of real arithmetic on the ROI page.
 *
 * ── What it answers ──────────────────────────────────────────────────────
 *
 * Nobody knows how many seconds a single workflow run saves. That is the
 * number the database wants, and asking for it directly is asking somebody to
 * invent one — which is what the field did, and which is why so many workflows
 * were left at zero.
 *
 * What people DO know is the job the automation replaced: how often a person
 * used to do it, and how long it took them. This converts the second into the
 * first, by dividing a month of human work by the number of times n8n actually
 * ran in the same month.
 *
 *     human seconds per month
 *     ───────────────────────  =  seconds saved per execution
 *     executions in 30 days
 *
 * ── Why it divides by REAL executions ────────────────────────────────────
 *
 * This is the part worth keeping and the part that was never explained. A
 * workflow that replaced five manual runs a week but is triggered ten thousand
 * times a month did not save five runs' worth of work ten thousand times over —
 * it saved five runs' worth of work, spread across ten thousand executions. The
 * per-execution figure has to shrink accordingly, or the ROI page multiplies an
 * honest estimate by an execution count and reports a number off by three
 * orders of magnitude.
 *
 * Dividing by measured volume also makes the figure self-correcting: if the
 * workflow's traffic doubles next month, the total time saved doubles without
 * anybody revisiting the setting, because the per-execution figure was derived
 * against real volume rather than guessed.
 *
 * ── The zero case is a refusal, not a fallback ───────────────────────────
 *
 * The previous version divided by `Math.max(1, executions)`. On a workflow n8n
 * has not run in thirty days that says one execution absorbed an entire month
 * of human labour — a per-run figure in the tens of thousands of seconds, which
 * then multiplies against every historical execution on the Overview tab. It
 * was silent, it was enormous, and it was indistinguishable from a real answer.
 *
 * So there is no fallback. Nothing ran, so there is nothing to divide by, and
 * the caller is told that instead of being handed a number.
 */

/** How many times a "per day / week / month" figure happens in 30 days. */
const PER_MONTH = { day: 30, week: 30 / 7, month: 1 };

const UNIT_SECONDS = { minutes: 60, hours: 3600 };

/**
 * @param {object} input
 * @param {number} input.frequency    how often the manual job was done
 * @param {string} input.per          'day' | 'week' | 'month'
 * @param {number} input.duration     how long one manual run took
 * @param {string} input.unit         'minutes' | 'hours'
 * @param {number} input.executions30d  what n8n actually ran, last 30 days
 *
 * @returns {{ok: true, secondsPerExecution: number, humanSecondsPerMonth: number,
 *            manualRunsPerMonth: number, executions30d: number}
 *         | {ok: false, reason: string}}
 */
export function perExecutionSeconds({ frequency, per, duration, unit, executions30d }) {
    const freq = Number(frequency);
    const dur = Number(duration);
    const execs = Math.floor(Number(executions30d) || 0);

    if (!Number.isFinite(freq) || freq <= 0) {
        return { ok: false, reason: 'Say how often the job used to be done.' };
    }
    if (!Number.isFinite(dur) || dur <= 0) {
        return { ok: false, reason: 'Say how long it used to take.' };
    }
    if (!PER_MONTH[per] || !UNIT_SECONDS[unit]) {
        return { ok: false, reason: 'Pick a period and a unit.' };
    }
    if (execs <= 0) {
        return {
            ok: false,
            reason: 'n8n has not run this workflow in the last 30 days, so there is nothing ' +
                'to divide the manual work across. Enter the per-run figure by hand, or come ' +
                'back once it has run.'
        };
    }

    const manualRunsPerMonth = freq * PER_MONTH[per];
    const humanSecondsPerMonth = manualRunsPerMonth * dur * UNIT_SECONDS[unit];

    return {
        ok: true,
        // Rounded here rather than at the call site: this is the value that gets
        // stored, and a stored figure that disagrees with the one the reader was
        // shown is the whole class of bug this page exists to avoid.
        secondsPerExecution: Math.max(1, Math.round(humanSecondsPerMonth / execs)),
        humanSecondsPerMonth,
        manualRunsPerMonth,
        executions30d: execs
    };
}

export { PER_MONTH, UNIT_SECONDS };
