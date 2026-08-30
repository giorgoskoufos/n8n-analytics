/**
 * Conversations, and what the assistant remembers between them.
 *
 * ── Why threads at all ───────────────────────────────────────────────────
 *
 * The chat was one endless log per user and the context was "your last ten
 * messages", whatever they happened to be about. That is worse than it sounds.
 * Ask about queue lag on Monday and error rates on Thursday, and Thursday's
 * answer arrives with Monday's table still in the prompt — and a model handed an
 * unrelated earlier result does not ignore it, it reconciles it. The wrong
 * numbers do not appear as noise; they appear as a comparison nobody asked for.
 *
 * ── The two things that reach the model, and where each stops ────────────
 *
 *   memories    per USER, cross-thread, small. "Reports on the Call Center
 *               folder." Written by the assistant through a tool, visible and
 *               deletable in Settings.
 *   history     per CONVERSATION. The thread itself — every message verbatim,
 *               and beside each answer the analyses it was built from.
 *
 * ── The summary that used to sit between them, and why it is gone ────────
 *
 * Everything past a recent window used to be folded into a paragraph of prose
 * by a second model call, and only that paragraph reached the next turn. It
 * bounded the prompt, and it lost the two things a follow-up question actually
 * needs.
 *
 * The first is the transcript. A summary is the one part of the context nobody
 * can check: it is not a message anybody said, and by the time it is wrong the
 * originals are no longer in the prompt to contradict it. "Established: 33
 * failures" is a sentence a model wrote about a sentence a model wrote.
 *
 * The second is the work. The fold read `role` and `content` and nothing else,
 * so every record of WHICH analysis produced a number was dropped on the floor
 * — and the thread's own steps are the only place the arguments survive. An
 * assistant that can see what it said and not what it looked at re-resolves the
 * same workflow name on every turn, or answers about the instance and labels it
 * with the workflow's name. Both were observed, and the subject note existed to
 * paper over the first of them.
 *
 * So the thread is sent as the thread: messages in order, each answer followed
 * by the analyses behind it. `AI_HISTORY_CHARS` is what bounds it now — a budget
 * spent from the newest end backwards, dropping whole exchanges off the front
 * and SAYING SO when it does, because a context silently cut is one the model
 * treats as the whole conversation.
 */

const crypto = require('node:crypto');
const localDb = require('../config/localDb');
const log = require('../utils/logger').logger('CHAT-DAO');

/**
 * The ceiling on a thread's own history in one prompt.
 *
 * Two bounds rather than one, because they fail differently. The character
 * budget is what actually protects the bill and the context window; the message
 * count is what stops a thread of four hundred one-word exchanges from being
 * read out of the database in full to discover that it fits.
 *
 * The budget is generous on purpose. This replaced a fold that cost a whole
 * extra model call per turn, so the comparison is not "cheap versus expensive" —
 * it is a larger prompt against a second round trip plus a paragraph nobody can
 * verify, and the larger prompt wins on both accuracy and latency.
 */
const HISTORY_CHARS = Number(process.env.AI_HISTORY_CHARS) || 30_000;
const HISTORY_MESSAGES = Number(process.env.AI_HISTORY_MESSAGES) || 80;

/**
 * How many memories one user may accumulate.
 *
 * A cap rather than a growth curve, because these go into every prompt of every
 * conversation. Unbounded memory is a second system prompt that nobody wrote and
 * nobody reviews.
 */
const MAX_MEMORIES = Number(process.env.AI_MAX_MEMORIES) || 40;
const MAX_MEMORY_CHARS = 240;

const now = () => new Date().toISOString();

// ==========================================================================
// Conversations
// ==========================================================================

/**
 * A new thread.
 *
 * A title passed in here is a title somebody CHOSE — the eval harness names its
 * scenarios, and `POST /api/ai-conversations` honours a `title` in the body — so
 * it settles the name exactly as `rename` does. Without that, the naming pass
 * would helpfully replace it after the first answer, and a caller that finds its
 * own threads by the name it gave them would stop finding them.
 */
async function create(userId, title = null) {
    const id = crypto.randomUUID();
    const stamp = now();
    const settled = title ? 1 : 0;
    await localDb.execute(
        `INSERT INTO dashboard_chat_conversations
            (id, user_id, title, title_generated, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, userId, title, settled, stamp, stamp]
    );
    return {
        id, user_id: userId, title, title_generated: settled,
        created_at: stamp, updated_at: stamp
    };
}

/** One conversation, if it belongs to this user. Ownership is checked here. */
async function find(id, userId) {
    if (!id) return null;
    const r = await localDb.query(
        'SELECT * FROM dashboard_chat_conversations WHERE id = ? AND user_id = ?',
        [id, userId]
    );
    return r.rows[0] || null;
}

/**
 * The switcher's list: newest activity first, with a count and a preview.
 *
 * `last_at` comes from the messages rather than from `updated_at`, because a
 * conversation that was renamed is not a conversation that was used.
 */
async function list(userId, { limit = 20 } = {}) {
    const r = await localDb.query(
        `SELECT c.id, c.title, c.created_at, c.archived,
                COUNT(h.id)      AS messages,
                MAX(h.created_at) AS last_at
           FROM dashboard_chat_conversations c
           LEFT JOIN dashboard_chat_history h ON h.conversation_id = c.id
          WHERE c.user_id = ? AND c.archived = 0
          GROUP BY c.id
          ORDER BY COALESCE(MAX(h.created_at), c.created_at) DESC
          LIMIT ?`,
        [userId, Math.min(Math.max(Number(limit) || 20, 1), 50)]
    );
    return r.rows;
}

/**
 * The conversation a new question belongs to.
 *
 * Resolution order, and each step is a deliberate refusal to guess:
 *
 *   1. An id the client sent — but only if it is this user's. A conversation id
 *      names somebody's private thread, so a foreign one is treated as absent
 *      rather than as forbidden.
 *   2. Otherwise a new one. NOT "the most recent" — resuming whatever the user
 *      last talked about is exactly the behaviour threads exist to remove, and
 *      it is the one the client can always ask for explicitly.
 */
async function resolveFor(userId, requestedId) {
    const existing = await find(requestedId, userId);
    if (existing) return existing;
    return create(userId);
}

/**
 * A title somebody chose, which is the end of the matter.
 *
 * `title_generated` is set here as well as by the naming pass, and that is the
 * point of the flag: a person who renames a thread has settled its name, and the
 * pass that runs after the next answer must not helpfully improve it back.
 */
async function rename(id, userId, title) {
    const clean = String(title || '').trim().slice(0, 120);
    if (!clean) return null;
    await localDb.execute(
        'UPDATE dashboard_chat_conversations SET title = ?, title_generated = 1, updated_at = ? ' +
        'WHERE id = ? AND user_id = ?',
        [clean, now(), id, userId]
    );
    return find(id, userId);
}

/**
 * The title the model wrote from the opening exchange.
 *
 * Separate from `rename` because it is a different act with a different loser.
 * `rename` is a person deciding; this is the assistant proposing, and it may
 * write only while nobody has decided — hence `title_generated = 0` in the WHERE
 * clause rather than a read-then-write, which would race with a rename typed
 * while the answer was still streaming.
 *
 * @returns {Promise<boolean>} whether it stuck
 */
async function setGeneratedTitle(id, userId, title) {
    const clean = String(title || '').trim().slice(0, 120);
    if (!clean) return false;
    const r = await localDb.execute(
        'UPDATE dashboard_chat_conversations SET title = ?, title_generated = 1, updated_at = ? ' +
        'WHERE id = ? AND user_id = ? AND title_generated = 0',
        [clean, now(), id, userId]
    );
    return r.changes > 0;
}

/**
 * Archived, not deleted.
 *
 * The rows stay because a conversation is a record of what somebody was told,
 * and because "delete" on a thread the assistant may have written memories from
 * would leave those memories citing nothing. Settings deletes for real; this is
 * the everyday gesture.
 */
async function archive(id, userId) {
    const r = await localDb.execute(
        'UPDATE dashboard_chat_conversations SET archived = 1, updated_at = ? WHERE id = ? AND user_id = ?',
        [now(), id, userId]
    );
    return r.changes > 0;
}

async function remove(id, userId) {
    const conversation = await find(id, userId);
    if (!conversation) return false;
    await localDb.execute('DELETE FROM dashboard_chat_history WHERE conversation_id = ?', [id]);
    await localDb.execute('DELETE FROM dashboard_chat_conversations WHERE id = ?', [id]);
    return true;
}

/**
 * Names a thread from its first question, by truncating it.
 *
 * This was the whole naming scheme and is now the fallback under it — see
 * ai/title.js. It is kept, and kept exactly as it was, because the thing that
 * replaced it is a model call, and a model call can fail, time out, or come back
 * empty. A thread called "why did the Call Center workflow fail last" is worse
 * than one called "Call Center failures overnight"; both are enormously better
 * than one called "Untitled".
 */
function titleFrom(question) {
    const clean = String(question || '')
        // Tags are addressed to the server, not to the reader of a list.
        .replace(/@[a-z_]{2,12}:(?:"[^"]*"|[^\s"@,;]+)/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!clean) return 'New conversation';
    return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}

// ==========================================================================
// Messages
// ==========================================================================

async function addMessage({ conversationId, userId, role, content, steps }) {
    await localDb.execute(
        `INSERT INTO dashboard_chat_history (user_id, conversation_id, role, content, sql_used)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, conversationId, role, content, steps || null]
    );
    await localDb.execute(
        'UPDATE dashboard_chat_conversations SET updated_at = ? WHERE id = ?',
        [now(), conversationId]
    );
}

/** Everything in one thread, oldest first — what the panel replays. */
async function messages(conversationId, { limit = 200 } = {}) {
    const r = await localDb.query(
        `SELECT id, role, content, sql_used, created_at
           FROM dashboard_chat_history
          WHERE conversation_id = ?
          ORDER BY id ASC
          LIMIT ?`,
        [conversationId, limit]
    );
    return r.rows;
}

/**
 * The thread as the model reads it: every message, newest-first budget, oldest
 * first on the way out.
 *
 * ── What comes back and why each field is here ───────────────────────
 *
 * `sql_used` holds one line per analysis an answer was built from — see the note
 * on `persist` in aiController. It comes back beside the message because a
 * follow-up needs to know what the previous turn LOOKED AT, not only what it
 * said, and this column is the only place the arguments survive at all. It is
 * returned as `steps` rather than under its storage name because the storage
 * name has been wrong since the model stopped writing SQL.
 *
 * ── The budget is spent backwards, and the seam is a whole exchange ──────
 *
 * Rows are taken from the newest end until the budget runs out. Then the cut is
 * pushed back to a USER message, so the oldest thing kept is a question rather
 * than half of an answer to a question that is no longer there — an assistant
 * message with no prompt above it reads as something the model volunteered.
 *
 * `truncated` is returned rather than inferred by the caller, because the caller
 * has to say so in the prompt. A history quietly cut at the front is one the
 * model describes as the whole conversation.
 *
 * @returns {Promise<{messages: object[], truncated: number}>}
 */
async function history(conversationId, { chars = HISTORY_CHARS, limit = HISTORY_MESSAGES } = {}) {
    const r = await localDb.query(
        `SELECT id, role, content, sql_used AS steps, created_at
           FROM dashboard_chat_history
          WHERE conversation_id = ?
          ORDER BY id DESC LIMIT ?`,
        [conversationId, limit]
    );

    const kept = [];
    let spent = 0;
    for (const row of r.rows) {
        const cost = (row.content || '').length + (row.steps || '').length;
        // The newest message is kept whatever it costs. A budget that can return
        // nothing at all is a budget that turns one long answer into no context.
        if (kept.length > 0 && spent + cost > chars) break;
        spent += cost;
        kept.push(row);
    }

    // Oldest first from here on.
    kept.reverse();

    // Push the seam forward to a question. At most one row is dropped, and only
    // when the oldest kept row is an answer whose question did not fit.
    if (kept.length > 1 && r.rows.length > kept.length && kept[0].role === 'ai') kept.shift();

    return { messages: kept, truncated: Math.max(r.rows.length - kept.length, 0) };
}

/**
 * Adopts the history written before conversations existed.
 *
 * One conversation for all of it, done once, lazily, the first time a user opens
 * the chat after the upgrade. Splitting a year of messages into plausible
 * threads would mean guessing where each one ended, and a wrong guess is a
 * conversation that reads as though somebody changed the subject mid-answer.
 * One clearly-labelled thread is honest about what it is.
 */
async function adoptOrphans(userId) {
    const orphans = await localDb.query(
        'SELECT COUNT(*) AS n FROM dashboard_chat_history WHERE user_id = ? AND conversation_id IS NULL',
        [userId]
    );
    if (!orphans.rows[0].n) return null;

    const conversation = await create(userId, 'Earlier conversations');
    await localDb.execute(
        'UPDATE dashboard_chat_history SET conversation_id = ? WHERE user_id = ? AND conversation_id IS NULL',
        [conversation.id, userId]
    );
    log.info(`Adopted ${orphans.rows[0].n} pre-existing messages for ${userId}.`);
    return conversation;
}

// ==========================================================================
// Memory
// ==========================================================================

/**
 * Everything this user has had remembered about them.
 *
 * Read on every turn, so it is capped and short. Ordered oldest first because
 * that is the order they were learned in, and a later memory that contradicts an
 * earlier one should read as the correction it is.
 */
async function memories(userId) {
    const r = await localDb.query(
        // `source_conversation_id` comes back because it answers "where did it
        // get that?" for a reader, and because it is the only stable handle a
        // caller has on a note whose WORDING the model chose — an eval trying to
        // remove what it just wrote cannot match on content it did not write.
        `SELECT id, content, source_conversation_id, created_at FROM dashboard_user_memories
          WHERE user_id = ? ORDER BY id ASC LIMIT ?`,
        [userId, MAX_MEMORIES]
    );
    return r.rows;
}

/**
 * Writes one memory.
 *
 * @returns {object} { ok, reason } — a refusal is returned rather than thrown,
 *                   because the caller is a tool call and the model can act on
 *                   an explanation.
 */
async function remember(userId, content, conversationId) {
    const clean = String(content || '').replace(/\s+/g, ' ').trim();
    if (clean.length < 4) return { ok: false, reason: 'That is too short to be worth keeping.' };
    if (clean.length > MAX_MEMORY_CHARS) {
        return {
            ok: false,
            reason: `A memory must be under ${MAX_MEMORY_CHARS} characters. ` +
                'Keep the fact, drop the explanation.'
        };
    }

    const existing = await localDb.query(
        'SELECT COUNT(*) AS n FROM dashboard_user_memories WHERE user_id = ?', [userId]
    );
    if (existing.rows[0].n >= MAX_MEMORIES) {
        return {
            ok: false,
            reason: `This user already has ${MAX_MEMORIES} memories, which is the limit. ` +
                'Nothing was saved; they can remove some in Settings.'
        };
    }

    try {
        await localDb.execute(
            `INSERT INTO dashboard_user_memories (user_id, content, source_conversation_id, created_at)
             VALUES (?, ?, ?, ?)`,
            [userId, clean, conversationId || null, now()]
        );
        return { ok: true, content: clean };
    } catch (err) {
        // The unique index. Remembering something already remembered is a
        // success from where the model is standing.
        if (String(err.message).includes('UNIQUE')) {
            return { ok: true, content: clean, duplicate: true };
        }
        throw err;
    }
}

async function forget(userId, id) {
    const r = await localDb.execute(
        'DELETE FROM dashboard_user_memories WHERE user_id = ? AND id = ?', [userId, id]
    );
    return r.changes > 0;
}

async function forgetAll(userId) {
    const r = await localDb.execute(
        'DELETE FROM dashboard_user_memories WHERE user_id = ?', [userId]
    );
    return r.changes;
}

module.exports = {
    create, find, list, resolveFor, rename, setGeneratedTitle, archive, remove, titleFrom,
    addMessage, messages, history, adoptOrphans,
    memories, remember, forget, forgetAll,
    HISTORY_CHARS, HISTORY_MESSAGES, MAX_MEMORIES, MAX_MEMORY_CHARS
};
