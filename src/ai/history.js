/**
 * The thread, turned into the messages the model reads.
 *
 * ── What this replaced ───────────────────────────────────────────────────
 *
 * A recent window of prose plus a summary of everything older, produced by a
 * second model call after each answer. The summary bounded the prompt and lost
 * two things: the transcript, which was the only checkable part of the context,
 * and the tool calls, which the fold never read at all. See the header of
 * dao/conversationsDao for the longer version.
 *
 * What is here instead is the thread itself, and beside each answer the
 * analyses it was built from.
 *
 * ── Why the steps are their own message and not part of the answer ───────
 *
 * The obvious shape is to append the tool list to the assistant's own message.
 * It is wrong, and the reason is not stylistic: a model reading its own turn
 * treats every word of it as something it wrote and said out loud. Give it an
 * answer ending in "get_analytics: kpis · workflow 6v295G18HhxEYZe9" and it
 * starts writing that line into the next answer, to the reader, as prose. This
 * was the whole point of keeping the steps beside the message rather than folded
 * into it, and it survives the change.
 *
 * They are also not `tool` messages, which is the other obvious shape. A `tool`
 * message must answer a `tool_call` on the assistant turn above it and carry
 * that call's id and its RESULT — and the result is the one thing not stored.
 * Manufacturing the envelope with the payload missing produces a transcript that
 * is malformed on some providers and, on the rest, says the tool returned
 * nothing. A note about the turn is what this is, so it is written as one.
 *
 * ── The positioning is the feature ───────────────────────────────────────
 *
 * Each note sits immediately after the answer it describes, so "and its errors?"
 * arrives with the id three lines above it rather than in a block at the end
 * summarising four turns at once. That is what lets the model reuse an id
 * instead of resolving the name from scratch on every turn — which is what it
 * did, measurably, when the history was prose only.
 */

/** How many analysis lines are quoted per answer. */
const MAX_STEP_LINES = 8;

/**
 * One stored `sql_used` blob, as the note that follows its answer.
 *
 * Failed steps keep their `!` marker. A turn that tried something and recovered
 * is a turn whose next question should not try the same thing, and hiding the
 * failure loses that.
 */
function stepNote(steps) {
    const lines = String(steps || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return null;

    const shown = lines.slice(0, MAX_STEP_LINES);
    const rest = lines.length - shown.length;

    return [
        'What the answer above was built from — the analyses that turn ran, with what each was ' +
        'narrowed to. A line beginning `!` is one that failed.',
        '',
        ...shown.map((l) => `- ${l}`),
        ...(rest > 0 ? ['', `(and ${rest} more)`] : []),
        '',
        'Ids here are already resolved and already inside this user\'s scope. If this question ' +
        'is about the same thing, pass the id straight to the tool rather than looking the name ' +
        'up again.'
    ].join('\n');
}

/**
 * Says out loud that the front of the thread did not fit.
 *
 * A budget that drops messages silently produces a model that answers as though
 * the conversation began where its context does — confidently, and about a
 * thread whose first half established the thing being asked about.
 */
function truncationNote(count) {
    return [
        `## The start of this conversation is not shown`,
        '',
        `${count} earlier ${count === 1 ? 'message' : 'messages'} in this thread ` +
        'came before what follows and are too long to include. Nothing here summarises them — ' +
        'they are simply absent. If the question turns on something that was established before ' +
        'the first message below, say that you cannot see that part of the thread and ask, ' +
        'rather than answering from what is left.'
    ].join('\n');
}

/**
 * Rows from `conversationsDao.history` → chat messages.
 *
 * @param {object} loaded  { messages, truncated }
 * @returns {object[]} in order: the truncation note if there was one, then each
 *                     message, each answer followed by its analyses.
 */
function build({ messages = [], truncated = 0 } = {}) {
    const out = [];
    if (truncated > 0) out.push({ role: 'system', content: truncationNote(truncated) });

    for (const row of messages) {
        if (row.role === 'ai') {
            out.push({ role: 'assistant', content: row.content });
            const note = stepNote(row.steps);
            if (note) out.push({ role: 'system', content: note });
        } else {
            out.push({ role: 'user', content: row.content });
        }
    }
    return out;
}

/**
 * Every workflow id this thread has already measured, newest first.
 *
 * Pulled out here rather than in the controller because it reads the same stored
 * lines `build` does, and two readers of one format is one of them drifting.
 */
function workflowIds(rows = [], limit = 3) {
    const ids = [];
    for (let i = rows.length - 1; i >= 0 && ids.length < limit; i--) {
        for (const m of String(rows[i].steps || '').matchAll(/· workflow ([A-Za-z0-9_-]{1,64})/g)) {
            if (!ids.includes(m[1])) ids.push(m[1]);
            if (ids.length >= limit) break;
        }
    }
    return ids;
}

module.exports = { build, workflowIds, MAX_STEP_LINES, _internal: { stepNote, truncationNote } };
