/**
 * Naming a thread from the exchange that opened it.
 *
 * ── What was wrong with truncating the question ──────────────────────────
 *
 * A thread used to be named by taking the first question, stripping the `@`
 * tags out of it and cutting it at sixty characters. It cost nothing and it was
 * available instantly, which is why it was the right first version — and in a
 * switcher listing a dozen threads it produced:
 *
 *     why did the ΑΑΑ_Processor workflow fail last night, and is …
 *     is there anything that stopped running without erroring in…
 *     how is the instance doing this week compared to last week …
 *
 * Every one of them true, none of them distinguishable at a glance, and the
 * distinguishing part is always past the cut — because a question puts its
 * subject at the end and its throat-clearing at the front.
 *
 * ── Why the ANSWER is in the input and not just the question ─────────────
 *
 * This is the part worth keeping. The question is what somebody wanted; the
 * first answer is what the thread turned out to be ABOUT, and those differ more
 * often than not. "Is anything broken?" is a question with no subject at all
 * until the answer says the subject is a credential expiring on Tuesday. A title
 * written from the question alone can only ever restate the question.
 *
 * So both go in, and the instruction asks for the subject rather than for a
 * summary — a summary of a question is the question.
 *
 * ── When it runs ─────────────────────────────────────────────────────────
 *
 * Once, on the opening exchange, awaited before the turn's terminal frame so the
 * name can travel with it. The prose has already streamed to the reader by then,
 * so the wait is invisible: what it delays is the `done` frame, which carries a
 * copy of an answer that is already on screen.
 *
 * It is deliberately NOT retried on a later turn. A thread that renames itself
 * as it goes is one nobody can find again — somebody scanning the switcher for
 * the conversation they had this morning is looking for a name that has since
 * moved on, and a list that reorders under a reader is worse than a list of
 * mediocre names.
 */

const log = require('../utils/logger').logger('AI-TITLE');
const conversations = require('../dao/conversationsDao');

/** Short enough to read in a switcher without truncating a second time. */
const MAX_TITLE_CHARS = 60;

/** What the model is shown of each side. Enough for the subject, not the detail. */
const MAX_QUESTION_CHARS = 600;
const MAX_ANSWER_CHARS = 1200;

const INSTRUCTION =
    'You name conversations for a switcher list in an n8n analytics dashboard. You are given ' +
    'the first question somebody asked and the first answer they got.\n\n' +
    'Reply with the title and nothing else.\n\n' +
    'What makes a good one here:\n' +
    '- Name the SUBJECT, not the act. "Call Center overnight failures", never "Question about ' +
    'failures" or "Analysis of the Call Center workflow".\n' +
    '- Use the specific thing the exchange turned out to be about — the workflow, the folder, ' +
    'the error, the period. That is usually clearer in the answer than in the question.\n' +
    '- Keep the wording that was used. If they said "queue lag", the title says queue lag.\n' +
    `- Under ${MAX_TITLE_CHARS} characters, three to six words, no trailing full stop, ` +
    'no surrounding quotes.\n' +
    '- Write it in the language the question was asked in.\n\n' +
    'Never invent a subject the exchange does not mention, and never write a title that would ' +
    'fit any other conversation ("Dashboard question", "Workflow analysis"). If the exchange ' +
    'genuinely has no subject — a greeting, a refusal — name what was asked for in their own ' +
    'words and stop.';

/**
 * Strips what a model puts around a title when it has been asked not to.
 *
 * Surrounding quotes, a leading "Title:", a trailing full stop, and any second
 * line. The last one matters most: an explanation on line two is the common
 * failure, and unhandled it becomes a two-line entry in a one-line list.
 */
function clean(raw) {
    return String(raw || '')
        .split('\n')[0]
        .replace(/^\s*(?:title|τίτλος)\s*[:：]\s*/i, '')
        .replace(/^["'«“”]+|["'»“”]+$/g, '')
        .replace(/[.。]\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_TITLE_CHARS);
}

/**
 * Names one conversation, if it still needs a name.
 *
 * @param {object} opts
 * @param {object} opts.openai
 * @param {string} opts.model
 * @param {object} opts.conversation  the row, including `title_generated`
 * @param {string} opts.question      what was asked this turn
 * @param {string} opts.answer        what was answered this turn
 * @returns {Promise<?string>} the title now on the thread, or null if unchanged
 */
async function name({ openai, model, conversation, question, answer }) {
    if (!conversation || conversation.title_generated) return null;

    // The fallback goes on first, and it is the reason a failure below costs
    // nothing. A thread with a truncated name is findable; one called "Untitled"
    // while a model call times out is not, and the timeout is the case this
    // ordering exists for.
    const fallback = conversations.titleFrom(question);

    let title = null;
    try {
        const reply = await openai.chat.completions.create({
            model,
            messages: [
                { role: 'system', content: INSTRUCTION },
                {
                    role: 'user',
                    content: `QUESTION:\n${String(question || '').slice(0, MAX_QUESTION_CHARS)}\n\n` +
                        `ANSWER:\n${String(answer || '').slice(0, MAX_ANSWER_CHARS)}`
                }
            ],
            // Zero, like the fold it replaced. A title is a label, and there is
            // nothing here worth being surprised by.
            //
            // Deliberately no token cap. `max_tokens: 32` was here and it cost
            // the feature on the recommended model, which rejects the parameter
            // outright in favour of `max_completion_tokens` — a 400 on every
            // opening exchange, silently absorbed by the fallback, so every
            // thread went back to being named by truncation and nothing looked
            // broken. Sending whichever name a given model accepts means a
            // provider-detection branch in the one place that has no business
            // knowing about providers. The length is already enforced twice, by
            // the instruction above and by `clean` below, and neither of them
            // can 400.
            temperature: 0
        });
        title = clean(reply.choices?.[0]?.message?.content);
    } catch (err) {
        log.warn(`Could not name ${conversation.id}: ${err.message}`);
    }

    const chosen = title || fallback;
    const stuck = await conversations.setGeneratedTitle(
        conversation.id, conversation.user_id, chosen
    );
    // Not stuck means somebody renamed the thread while the answer was being
    // written. Their name wins and there is nothing to report.
    return stuck ? chosen : null;
}

/**
 * The same thing, made safe to forget about.
 *
 * For the non-streaming endpoint, which has already sent its JSON and has
 * nowhere to put a rejection.
 */
function nameQuietly(opts) {
    name(opts).catch((err) => {
        log.warn(`Could not name ${opts.conversation?.id}: ${err.message}`);
    });
}

module.exports = { name, nameQuietly, MAX_TITLE_CHARS, _internal: { clean, INSTRUCTION } };
