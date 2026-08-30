/**
 * A turn that outlives the request that started it.
 *
 * ── The problem this exists for ──────────────────────────────────────────
 *
 * The assistant lives in a floating panel on every page of a multi-page app, so
 * the ordinary thing a user does is ask a question and then go look at the page
 * the answer is about. Every one of those navigations is a full document load,
 * and until now it killed the answer mid-sentence: `chatStream` aborted on
 * `req.on('close')` and deliberately persisted nothing, so the work was spent
 * and the reader got neither the answer nor a record that they had asked.
 *
 * The same thing happened, less visibly, every time somebody closed the panel
 * while it was still writing.
 *
 * ── What changed ─────────────────────────────────────────────────────────
 *
 * The run is no longer owned by the response. It is owned by this registry, and
 * a response merely SUBSCRIBES to it. Losing the client detaches a subscriber
 * and nothing else: the model keeps working, the answer completes, it is written
 * to the history, and the next page attaches to the same turn and picks the
 * answer up where it is.
 *
 * ── Why a snapshot rather than an event log ──────────────────────────────
 *
 * The obvious shape is to buffer every SSE frame and replay them all. A long
 * answer is thousands of `delta` frames of a few characters each, and holding
 * every one of them so a reattaching client can be told the same string one
 * fragment at a time is a lot of memory for no difference on screen.
 *
 * So the turn holds STATE — the steps so far, the answer so far — and a
 * reattaching client is handed that state as one delta. Live subscribers still
 * get their deltas incrementally, because for them the incremental arrival is
 * the whole point. Memory per turn is one answer string.
 *
 * ── What is deliberately not solved here ─────────────────────────────────
 *
 * The registry is in-process. Two Node processes without sticky routing would
 * let a reattach land on the one that never heard of the turn — which surfaces
 * as "your answer vanished", the exact failure this file removes. This
 * deployment runs one process; if that changes, this needs a shared store
 * before the second process does.
 */

const crypto = require('node:crypto');
const log = require('../utils/logger').logger('AI-TURN');

// A finished turn stays attachable for a while, because the whole point is that
// the client is somewhere else when it finishes. A full page load plus a boot is
// seconds; a minute is generous and still bounded.
const KEEP_AFTER_FINISH_MS = Number(process.env.AI_TURN_KEEP_MS) || 60_000;

// Concurrency, per user and in total. The turn survives the request, so the
// usual backstop — the client going away — no longer applies, and something has
// to say no.
const MAX_PER_USER = Number(process.env.AI_TURNS_PER_USER) || 3;
const MAX_ACTIVE = Number(process.env.AI_TURNS_MAX) || 50;

// Proxies close a connection that has said nothing for long enough, and a tool
// chain can genuinely be quiet for a while. A comment frame is ignored by every
// SSE parser, including the one in chat-core.
const HEARTBEAT_MS = Number(process.env.AI_TURN_HEARTBEAT_MS) || 15_000;

/** turnId → turn. */
const turns = new Map();

function activeFor(userId) {
    let n = 0;
    for (const t of turns.values()) {
        if (t.userId === userId && t.status === 'running') n++;
    }
    return n;
}

/**
 * Opens a turn.
 *
 * @returns {object|null} the turn, or null when the caller already has too many
 *                        in flight — which the controller reports rather than
 *                        queueing, because a queued question is one the user has
 *                        stopped watching for.
 */
function create({ userId, question }) {
    if (turns.size >= MAX_ACTIVE || activeFor(userId) >= MAX_PER_USER) return null;

    const turn = {
        id: crypto.randomUUID(),
        userId,
        question,
        status: 'running',
        // Everything a late subscriber needs to catch up, and nothing else.
        //
        // `steps` and `finalSteps` are two different shapes and are kept apart
        // on purpose. A live step carries the phrase shown while it runs
        // ("Looking up Call Center"); the finished list carries the real
        // arguments instead. Storing the second over the first is what made a
        // reattaching client replay a row of `undefined` — it was reading a
        // label off an object that had never had one.
        state: {
            tags: null, steps: [], finalSteps: null, conversation: null,
            answer: '', error: null, partial: false
        },
        subscribers: new Set(),
        startedAt: Date.now(),
        finishedAt: null,
        sweep: null
    };
    turns.set(turn.id, turn);
    return turn;
}

/**
 * The turn with this id, if it belongs to this caller.
 *
 * A turn id is a capability — it streams a private conversation — so ownership
 * is checked here rather than trusted from the URL, and a turn belonging to
 * somebody else is reported as absent rather than as forbidden. "Forbidden"
 * confirms it exists.
 */
function get(id, userId) {
    const turn = turns.get(id);
    if (!turn || turn.userId !== userId) return null;
    return turn;
}

/** Records an event on the turn and forwards it to whoever is watching. */
function emit(turn, event, data) {
    const s = turn.state;
    if (event === 'delta') s.answer += data.text;
    else if (event === 'step') s.steps.push(data);
    else if (event === 'tags') s.tags = data;
    else if (event === 'conversation') s.conversation = data;
    else if (event === 'error') s.error = data;

    for (const send of turn.subscribers) {
        try {
            send(event, data);
        } catch (err) {
            // A dead socket is not this turn's problem. It will be detached by
            // its own close handler; swallowing here keeps one broken subscriber
            // from taking the answer away from the others.
            log.warn(`Subscriber write failed on ${turn.id}: ${err.message}`);
        }
    }
}

/**
 * Closes the turn and starts the clock on forgetting it.
 *
 * @param {string} status  'done' | 'failed' | 'cancelled'
 */
function finish(turn, status, final = {}) {
    if (turn.status !== 'running') return;
    turn.status = status;
    turn.finishedAt = Date.now();
    if (final.answer) turn.state.answer = final.answer;
    if (final.steps) turn.state.finalSteps = final.steps;
    turn.state.partial = Boolean(final.partial);

    // Every ending sends a terminal frame, including the ones that ended badly.
    // A subscriber has no other way to learn that nothing more is coming, and a
    // stream that simply stops looks exactly like a stream that is still
    // thinking — which is the failure mode that leaves a panel spinning forever.
    const [event, payload] = terminalFrame(turn);
    for (const send of turn.subscribers) {
        try {
            send(event, payload);
        } catch (ignored) { /* detached mid-write */ }
    }

    turn.sweep = setTimeout(() => turns.delete(turn.id), KEEP_AFTER_FINISH_MS);
    // Nothing here should hold the process open at shutdown.
    if (turn.sweep.unref) turn.sweep.unref();
}

/** How a finished turn announces itself, to a live subscriber or a late one. */
function terminalFrame(turn) {
    const s = turn.state;
    if (turn.status === 'cancelled') return ['cancelled', { answer: s.answer }];
    if (turn.status === 'failed') {
        return ['failed', s.error || { error: 'The assistant could not answer.' }];
    }
    return ['done', {
        answer: s.answer, steps: s.finalSteps || s.steps, tags: s.tags, partial: s.partial
    }];
}

/** The three events after which nothing else arrives. */
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

/**
 * Marks a turn cancelled. The runner notices on its next step.
 *
 * Cancelling is not the same as disconnecting, and only one of them stops the
 * work: a user who navigates away still wants the answer, and a user who presses
 * stop does not.
 */
function cancel(turn) {
    if (turn.status !== 'running') return false;
    turn.cancelled = true;
    finish(turn, 'cancelled');
    return true;
}

/**
 * Points one response at a turn: what has happened, then what happens next.
 *
 * @returns {function} detach — safe to call more than once
 */
function attach(turn, send) {
    // Catch-up first, in the order the client's renderer expects: what the tags
    // resolved to, then the steps, then the prose as a single delta.
    // The thread first: a client that reattached from another page has to know
    // which conversation it has landed in before it draws anything into one.
    if (turn.state.conversation) send('conversation', turn.state.conversation);
    if (turn.state.tags) send('tags', turn.state.tags);
    for (const step of turn.state.steps) send('step', step);
    if (turn.state.answer) send('delta', { text: turn.state.answer });

    if (turn.status !== 'running') {
        // Already over. The same terminal frame a live subscriber would have
        // seen, so a client that arrives late and one that was there throughout
        // run the identical code path.
        const [event, payload] = terminalFrame(turn);
        send(event, payload);
        return () => {};
    }

    turn.subscribers.add(send);
    const beat = setInterval(() => {
        try {
            send('ping', {});
        } catch (ignored) { /* the close handler will detach it */ }
    }, HEARTBEAT_MS);
    if (beat.unref) beat.unref();

    let detached = false;
    return () => {
        if (detached) return;
        detached = true;
        clearInterval(beat);
        turn.subscribers.delete(send);
    };
}

/** Turns this user still has open — what the widget asks for on boot. */
function openFor(userId) {
    const out = [];
    for (const t of turns.values()) {
        if (t.userId !== userId) continue;
        if (t.status !== 'running' && t.status !== 'done') continue;
        out.push({
            id: t.id,
            question: t.question,
            status: t.status,
            startedAt: t.startedAt,
            conversationId: t.conversationId || (t.state.conversation && t.state.conversation.id)
        });
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
}

module.exports = {
    create, get, emit, finish, cancel, attach, openFor, TERMINAL,
    _internal: { turns, terminalFrame, MAX_PER_USER, MAX_ACTIVE, KEEP_AFTER_FINISH_MS }
};
