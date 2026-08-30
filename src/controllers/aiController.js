/**
 * The assistant — H-06.
 *
 * ── What changed, and why the old shape had to go ────────────────────────
 *
 * This endpoint used to ask a model to write SQL against a two-table schema
 * prompt, run whatever came back on the main connection, and hand the rows to a
 * second model call to describe. Three things were wrong with that at once:
 *
 *   1. The guard allowed any SELECT over the whole replica, so
 *      `SELECT input_data FROM execution_error_analytics` returned 3 MB of real
 *      customer payloads. That is H-06.
 *   2. The schema prompt described 2 of 29 tables, so the model was inventing
 *      approximations of analyses this application already computes correctly —
 *      badly, and in a way that disagreed with the pages.
 *   3. Free-form SQL could not be scoped, so every project member got a 403.
 *
 * All three are answered by the same change: the model no longer writes the
 * analysis. It chooses one, from `src/ai/tools`, and those run the same DAO
 * functions the pages run. SQL survives only as a narrow, guarded escape hatch
 * for questions no metric covers — see utils/sqlGuard and config/aiViews.
 *
 * Because every tool takes the caller's scope, the 403 is gone: a project
 * member gets answers about their own workflows.
 *
 * ── The query is no longer shown ─────────────────────────────────────────
 *
 * F-24 §6 displayed the generated SQL beside the answer, which was right when
 * the SQL *was* the reasoning. It is not any more — the reasoning is which
 * analysis was chosen — so what is surfaced is the steps, and the query text
 * stops being part of the interface.
 *
 * ── Tags ─────────────────────────────────────────────────────────────────
 *
 * `@workflow:X` and `@tool:docs` are resolved here, before the model sees
 * anything — see `src/ai/tags.js` for why resolution has to happen server-side
 * and why an id sent by the client is never taken at its word.
 */

const openai = require('../config/openai');
const settingsDao = require('../dao/settingsDao');
const { build: buildTools } = require('../ai/tools');
const docs = require('../ai/tools/docs');
const tags = require('../ai/tags');
const catalog = require('../ai/catalog');
const turns = require('../ai/turns');
const { systemPrompt, memoryBlock, historyBlock } = require('../ai/prompt');
const conversations = require('../dao/conversationsDao');
const aiConfig = require('../dao/aiConfigDao');
const transcript = require('../ai/history');
const naming = require('../ai/title');
const { describeInstance } = require('../ai/execute');
const { run } = require('../ai/runner');
const { visibleWorkflowIds } = require('../utils/scope');
const log = require('../utils/logger').logger('AI');

/**
 * Which model answers, read per turn rather than captured at boot.
 *
 * It was `process.env.AI_MODEL` in a module-level constant, which is correct
 * exactly while the model cannot change without a restart. It is a settings
 * field now (dao/aiConfigDao), so a constant would mean an operator changing the
 * model in Settings, seeing it saved, and being answered by the old one until
 * somebody restarted the process — a discrepancy with no symptom to chase.
 *
 * One indexed read of the local SQLite file per turn, against a turn that is
 * about to spend seconds in the provider. It is not a cost worth caching around.
 */
async function currentModel() {
    try {
        return await aiConfig.model();
    } catch (err) {
        // The assistant answering with the default beats it not answering at
        // all, and the log line is what makes the fallback visible.
        log.warn(`Could not read the configured model: ${err.message}`);
        return aiConfig.DEFAULT_MODEL;
    }
}

// Said once, at boot, and again whenever it changes — see logModel. Which model
// answered is the first thing anyone wants when an answer is wrong, and now that
// it is settable from a page there is no environment file to read it off.
let lastLoggedModel = null;

function logModel(model) {
    if (model === lastLoggedModel) return;
    lastLoggedModel = model;
    log.info(`Assistant model: ${model}`);
}
const SQL_ESCAPE_HATCH = process.env.AI_SQL_TOOL !== 'off';

// ==========================================================================
// Shared
// ==========================================================================

function refuse(req) {
    const userMessage = req.body.message;
    if (!userMessage) return { status: 400, body: { error: 'Message is required' } };
    if (typeof userMessage !== 'string' || userMessage.length > 2000) {
        return { status: 400, body: { error: 'Message must be a string under 2000 characters.' } };
    }
    return null;
}

/**
 * THIS conversation, as the model reads it.
 *
 * Two changes from what was here, and they are the same change twice.
 *
 * It used to be "this user's last ten messages", across every conversation they
 * had ever had — so Thursday's question about error rates arrived with Monday's
 * queue-lag table still attached, and a model handed an unrelated earlier result
 * does not ignore it, it reconciles it. Conversations fixed that by scoping the
 * window to one thread.
 *
 * Then everything older than the window was folded into a paragraph of prose by
 * a second model call, and only the paragraph survived. That fixed the length
 * and lost the substance: the fold read `role` and `content`, so the record of
 * which analysis produced which number — the one thing a follow-up needs and the
 * only place a tool's arguments are kept — was dropped every time. What reached
 * the next turn was a summary of what had been SAID about the work, written by a
 * model, unverifiable against originals that were no longer in the prompt.
 *
 * So the thread is sent as the thread, bounded by a character budget rather than
 * by a message count, with each answer's analyses beside it and any shortfall
 * declared. See ai/history.js for the shape, and dao/conversationsDao.history
 * for where the budget is spent.
 */
async function loadContext(conversation) {
    const loaded = await conversations.history(conversation.id);
    return {
        messages: transcript.build(loaded),
        rows: loaded.messages,
        truncated: loaded.truncated
    };
}

/**
 * What this thread has been about, as ids the next turn can reuse.
 *
 * The problem it solved, stated plainly: the history sent to the model used to
 * be prose only. A turn that resolved "ΑΑΑ_Processor" to an id, measured it and
 * wrote three paragraphs left behind three paragraphs. The next question — "και
 * τα σφάλματά του;" — arrived with a pronoun and nothing for it to point at, so
 * the model either resolved the name from scratch (a wasted step, every turn,
 * observed) or answered about the instance and labelled it with the workflow's
 * name (wrong, and fluent, and also observed).
 *
 * The transcript now carries the steps itself, so this is no longer the only
 * thing standing between a pronoun and a wrong answer. It stays because it does
 * something the steps cannot: it turns ids back into NAMES, by resolving each
 * one through the scoped catalogue. `workflow 6v295G18HhxEYZe9` in a step line
 * is not recognisable as the thing the person has been calling ΑΑΑ_Processor,
 * and a model that cannot connect the two resolves the name again anyway.
 *
 * ── Why this is not the tag preamble again ───────────────────────────────
 *
 * `resolution.preamble` is deliberately never written to the history, because a
 * tag describes ONE question and replaying it would pin a later, unrelated
 * question to ids nobody asked about. This is the opposite object: it is not
 * what someone typed, it is what this conversation has already done, and it is
 * rebuilt from that conversation's own record on every turn. It also says
 * "probably" rather than "use these" — a question that names something else has
 * to win, or the thread can never change subject.
 *
 * ── Why it cannot leak ───────────────────────────────────────────────────
 *
 * Every id here was used by an earlier turn of THIS conversation, which means it
 * was already resolved through the scoped catalogue at the time. It is resolved
 * through the scoped catalogue again here anyway, and anything that does not
 * come back is dropped — so a workflow that has since left the caller's scope
 * stops being mentioned rather than being named from a stale record.
 */
const SUBJECT_LIMIT = 3;

async function subjectBlock(rows, ctx) {
    // Most recent first: if the thread has moved on, the newest subject is the
    // one the pronoun in this question is most likely pointing at. The parsing
    // lives in ai/history.js beside the code that renders the same lines into
    // the transcript — two readers of one stored format is one of them drifting.
    const ids = transcript.workflowIds(rows, SUBJECT_LIMIT);
    if (!ids.length) return null;

    const named = [];
    for (const id of ids) {
        try {
            const rows = await catalog.resolveExact({ kind: 'workflow', value: id, scope: ctx.visibleIds });
            if (rows.length) named.push(`- ${rows[0].name} (workflow id \`${id}\`)`);
        } catch (err) {
            // A subject nobody can name is not worth mentioning, and failing to
            // read the catalogue must not cost the answer.
            log.warn(`Could not name earlier subject ${id}: ${err.message}`);
        }
    }
    if (!named.length) return null;

    return [
        '## What this conversation has been about',
        '',
        'Earlier turns in this thread measured:',
        '',
        ...named,
        '',
        'If this question does not name a subject of its own — "and its errors?", ' +
        '"give me three examples" — it is almost certainly still about these. Pass the id ' +
        'as the `workflow` filter rather than resolving the name again; you already have it. ' +
        'If the question does name something else, that wins.'
    ].join('\n');
}

/**
 * Everything one turn needs, assembled once.
 *
 * `describe_instance` is also a tool, and it is called here anyway: the freshness
 * and coverage facts belong in the system prompt because they change how every
 * answer should be worded, not just the ones that think to ask.
 */
async function prepare(req) {
    // Both shapes, because they are not the same object — see the note at the
    // top of ai/execute.js.
    const visibleIds = await visibleWorkflowIds(req.scope);

    // Which thread this belongs to, decided before anything is loaded — every
    // other thing here is scoped to it. An id from the client is honoured only
    // if it is this user's; anything else starts a new one rather than resuming
    // whatever they last talked about.
    const conversation = await conversations.resolveFor(req.user.id, req.body.conversationId);
    const ctx = {
        scope: req.scope, visibleIds, userId: req.user.id, conversationId: conversation.id
    };

    // Parsed before anything is built, because a tool tag decides whether that
    // tool is on the list at all.
    const tagged = tags.parse(req.body.message);
    const taggedTools = new Set(tags.forcedAliases(tagged));

    // The `+` menu turns tools off. It can only ever turn one off: docs still
    // requires this user to have connected it, and sql still requires the
    // deployment to allow it. A client that sends `{docs: true}` having never
    // authorised kapa gets no docs tool rather than a broken one — the `&&` is
    // the whole shape of that, and the client's half of it is a preference.
    const wanted = req.body.tools && typeof req.body.tools === 'object' ? req.body.tools : {};
    const docsEnabled = docs.isConfigured(req.user.id) &&
        (wanted.docs !== false || taggedTools.has('ask_n8n_docs'));
    const sqlEnabled = SQL_ESCAPE_HATCH &&
        (wanted.sql !== false || taggedTools.has('run_sql'));

    const tools = buildTools({ sqlEnabled, docsEnabled });

    const [facts, settings, history, memories] = await Promise.all([
        describeInstance(ctx).catch((err) => {
            // Not fatal. Without it the prompt loses its freshness caveats,
            // which is worse than nothing but far better than no answer.
            log.warn(`describe_instance failed: ${err.message}`);
            return null;
        }),
        settingsDao.getGlobalSettings().catch(() => ({})),
        loadContext(conversation),
        conversations.memories(req.user.id).catch((err) => {
            // An assistant with no memory is an assistant. One that refuses to
            // answer because it could not read its notes is not.
            log.warn(`Could not read memories for ${req.user.id}: ${err.message}`);
            return [];
        })
    ]);

    // Sequential rather than folded into the group above: this and
    // `describe_instance` both read the one serialised read-only connection, and
    // resolution rebuilds the catalogue index on it. An untagged message never
    // reaches the database here at all, so the ordering costs nothing in the
    // case that is almost every case.
    const resolution = await tags.resolve(tagged, { ctx, tools });

    const system = systemPrompt(facts, { sqlEnabled, docsEnabled, timezone: settings.timezone });

    // Chronological, oldest context first: what is known about the person, then
    // how to read the thread, then the thread, then what the tags in this
    // question resolved to, then the question. A reader could follow it in that
    // order, which is the test.
    //
    // `historyBlock` is only sent when there IS a thread. On the first question
    // of a new conversation it would describe a transcript that does not follow,
    // which is how a model comes to answer the question it was told to expect.
    const before = [memoryBlock(memories), history.messages.length ? historyBlock() : null]
        .filter(Boolean)
        .map((content) => ({ role: 'system', content }));

    // After the messages rather than before them: it is a note ABOUT what was
    // just read, and it is the last thing said before the tags and the question.
    const subject = await subjectBlock(history.rows, ctx);

    return {
        ctx,
        tools,
        conversation,
        model: await currentModel(),
        forced: resolution.forced,
        resolution,
        messages: [
            { role: 'system', content: system },
            ...before,
            ...history.messages,
            ...(subject ? [{ role: 'system', content: subject }] : []),
            // After the history and before the question: it describes THIS turn,
            // and it is never written to the history itself — replaying resolved
            // ids into a later, unrelated question is how a tag leaks forward.
            ...(resolution.preamble ? [{ role: 'system', content: resolution.preamble }] : []),
            { role: 'user', content: req.body.message }
        ]
    };
}

/** What the client needs to draw the chips: what stuck, and what did not. */
function tagReport(resolution) {
    if (!resolution) return null;
    const { resolved, rejected, forced } = resolution;
    if (!resolved.length && !rejected.length && !forced.length) return null;
    return {
        forced,
        resolved: resolved.map((t) => ({
            raw: t.raw, category: t.category, value: t.value,
            id: String(t.entry.id), name: t.entry.name || String(t.entry.id)
        })),
        rejected: rejected.map((t) => ({ raw: t.raw, category: t.category, why: t.why }))
    };
}

async function persist(conversation, userMessage, answer, steps) {
    const common = { conversationId: conversation.id, userId: conversation.user_id };
    await conversations.addMessage({ ...common, role: 'user', content: userMessage });
    // `sql_used` keeps its name and its column; what it holds is now the list of
    // analyses the answer was built from. Renaming it would be a migration for a
    // cosmetic gain, and the meaning — "how this answer was reached" — has not
    // actually changed.
    await conversations.addMessage({
        ...common, role: 'ai', content: answer, steps: summariseSteps(steps)
    });
}

/**
 * Writes the turn to the history.
 *
 * Never allowed to take the answer with it. The answer has already been
 * streamed to the reader by the time this runs, so a failure here — a full
 * disk, a foreign key, a locked database — must not turn a delivered answer
 * into an error message. It is logged and the turn completes; the cost is a
 * missing history row, which is visible and recoverable, against losing work
 * the user already watched arrive.
 */
async function persistQuietly(conversation, userMessage, answer, steps) {
    try {
        await persist(conversation, userMessage, answer, steps);
    } catch (err) {
        log.error(`Could not write chat history for ${conversation.user_id}: ${err.message}`);
    }
}

/**
 * Which of a call's arguments narrowed it, as one phrase.
 *
 * Only the first: these compose, but a line meant to be read at a glance in
 * "How this was worked out" does not want four of them, and the first is the
 * one that answers "what was this about".
 */
const SCOPE_KEYS = ['workflow', 'folder', 'tag', 'project'];

function scopeOf(args = {}) {
    for (const key of SCOPE_KEYS) {
        if (args[key]) return `${key} ${args[key]}`;
    }
    return '';
}

/**
 * One readable line per tool call, for the history and the UI.
 *
 * The scope is on the line for two reasons, and the second is the one that
 * matters. It belongs in the UI because "get_analytics: kpis" does not say
 * WHICH workflow was measured, and that was precisely the thing going wrong.
 * And it belongs in the stored history because this string is the only record
 * of what a turn actually did — the answer's prose is kept, the arguments are
 * not — so without it a follow-up question arrives at a model that can see what
 * it said and not what it looked at, and has to resolve the name again from
 * scratch. Which is what it did, on every single turn.
 */
function summariseSteps(steps) {
    if (!steps || steps.length === 0) return null;
    return steps.map((s) => {
        const detail = s.args.metric || s.args.kind || s.args.query || s.args.purpose || '';
        const scope = scopeOf(s.args);
        return `${s.ok ? '' : '! '}${s.tool}${detail ? `: ${detail}` : ''}${scope ? ` · ${scope}` : ''}`;
    }).join('\n');
}

// ==========================================================================
// Non-streaming
// ==========================================================================

exports.chat = async (req, res) => {
    const refusal = refuse(req);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    try {
        const { ctx, tools, messages, forced, resolution, conversation, model } = await prepare(req);
        logModel(model);
        const result = await run({ openai, model, messages, tools, ctx, forced });

        await persistQuietly(conversation, req.body.message, result.answer, result.steps);
        const title = await nameSafely({
            openai, model, conversation, question: req.body.message, answer: result.answer
        });
        res.json({
            answer: result.answer,
            steps: (result.steps || []).map((s) => ({ tool: s.tool, ok: s.ok, args: s.args })),
            tags: tagReport(resolution),
            conversationId: conversation.id,
            conversationTitle: title || conversation.title,
            partial: Boolean(result.exhausted)
        });
    } catch (error) {
        // Unconfigured is not broken, and the two need different sentences. An
        // operator who has not pasted a key yet is told to paste one; anyone
        // else gets the generic message, because the details of a provider
        // failure are not the caller's business.
        if (error.notConfigured) return res.status(503).json({ error: error.message });
        log.error('AI pipeline error:', error);
        res.status(500).json({ error: 'AI communication failed.' });
    }
};

/**
 * Names the thread, and never costs the answer.
 *
 * A title is a nicety on top of a reply the reader already has. Every failure
 * mode here — a provider timeout, a full disk on the rename, a model that
 * returns nothing — has to end in "no new title", never in a 500 over an answer
 * that was written correctly. ai/title.js already falls back to the truncated
 * question internally; this is the belt to that brace.
 */
async function nameSafely(opts) {
    try {
        return await naming.name(opts);
    } catch (err) {
        log.warn(`Could not name ${opts.conversation?.id}: ${err.message}`);
        return null;
    }
}

// ==========================================================================
// Streaming — F-24 §6
// ==========================================================================

/**
 * The same pipeline, delivered as it happens.
 *
 * What streams has changed with the pipeline. It used to be: the SQL, then the
 * prose. Now each tool call is announced as it is made — "looking up Call
 * Center", "reading error intelligence" — and the prose streams once the model
 * stops looking things up. That is a better progress indicator than a query
 * was, because it is in the user's vocabulary rather than the database's.
 *
 * Server-Sent Events over POST, read with fetch rather than EventSource:
 * EventSource cannot set an Authorization header, and this endpoint is
 * authenticated like every other one.
 *
 * Errors after the headers are sent cannot be an HTTP status any more — the
 * response is already 200 — so they travel as an `error` event. An error that
 * arrived as a silent disconnection would leave the widget spinning forever.
 *
 * ── The response no longer owns the work ─────────────────────────────────
 *
 * The assistant is a panel on every page of a multi-page app, so the ordinary
 * thing a reader does is ask, then navigate to the page the answer is about —
 * and that used to destroy the answer. The run belongs to `src/ai/turns.js` now;
 * this response is one subscriber to it. Losing the client detaches a
 * subscriber, nothing more: the answer finishes, it is written to the history,
 * and the next page attaches to the same turn.
 *
 * The first frame is therefore the turn id, because it is what makes the answer
 * findable from somewhere else.
 */
exports.chatStream = async (req, res) => {
    const refusal = refuse(req);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    const turn = turns.create({ userId: req.user.id, question: req.body.message });
    if (!turn) {
        return res.status(429).json({
            error: 'You already have answers being written. Wait for one to finish.'
        });
    }

    subscribe(turn, req, res);

    // Deliberately NOT awaited. The response's life and the turn's are now
    // separate things — that separation is the whole feature — so this hands the
    // work to the registry and returns.
    runTurn(turn, req);
};

/**
 * Runs one turn to completion, whether or not anybody is still watching.
 *
 * Errors are reported onto the turn rather than thrown, because there is no
 * request left to reject: by the time this runs the status line is long since
 * 200, and the only channel back to any reader is the stream itself.
 */
async function runTurn(turn, req) {
    try {
        const { ctx, tools, messages, forced, resolution, conversation, model } = await prepare(req);
        logModel(model);

        // Which thread this answer belongs to, said as early as it is known. A
        // reader who navigates and reattaches has to land back in the same
        // conversation, and the turn id alone does not say which one that is.
        turn.conversationId = conversation.id;
        turns.emit(turn, 'conversation', { id: conversation.id, title: conversation.title });

        // Before the first step, because the chips are already on screen and
        // this is what says whether they held. A tag the server threw out has to
        // stop looking accepted the moment the server knows it did not.
        const report = tagReport(resolution);
        if (report) turns.emit(turn, 'tags', report);

        const result = await run({
            openai,
            model,
            messages,
            tools,
            ctx,
            forced,
            // Only an explicit stop ends the work now. A client that went away is
            // a client that navigated, and it still wants the answer.
            isAborted: () => Boolean(turn.cancelled),
            onStep: (s) => turns.emit(turn, 'step', {
                tool: s.tool,
                label: stepLabel(s),
                ok: s.ok !== false
            }),
            onDelta: (text) => turns.emit(turn, 'delta', { text })
        });

        if (turn.cancelled || result.aborted) {
            // A half sentence in the history is worse than no record: the next
            // turn feeds it back to the model as something it supposedly said.
            // That rule survives — it just applies to a cancellation now rather
            // than to a disconnection, which is the case it was always about.
            return;
        }

        // `error` travels with the step it belongs to. Without it a failed
        // call reaches "How this was worked out" as a red line with no reason —
        // decoration where information was available — and reaches anyone
        // debugging as "unknown error". It is the same sentence the model was
        // already shown, so nothing new is being exposed.
        const steps = (result.steps || []).map((s) => ({
            tool: s.tool, ok: s.ok, args: s.args, ...(s.error ? { error: s.error } : {})
        }));
        // Written before the `done` frame rather than after it: this is the copy
        // that outlives the panel, and for a reader who has already navigated
        // away it is the only copy there will be.
        await persistQuietly(conversation, turn.question, result.answer, result.steps);

        // Named here, before the terminal frame, and awaited.
        //
        // The wait looks wrong and is not: the prose finished streaming to the
        // reader token by token some time ago, so what this delays is the `done`
        // frame, which carries a copy of an answer already on screen. Against
        // that, doing it after `finish` would mean the title arriving at a
        // stream with no subscribers left — the panel would keep showing "New
        // conversation" until something else reloaded the list, which is the
        // sort of staleness nobody reports and everybody notices.
        const title = await nameSafely({
            openai, model, conversation, question: turn.question, answer: result.answer
        });
        if (title) turns.emit(turn, 'conversation', { id: conversation.id, title });

        turns.finish(turn, 'done', {
            answer: result.answer, steps, partial: Boolean(result.exhausted)
        });
    } catch (error) {
        if (error.notConfigured) {
            turns.emit(turn, 'error', { error: error.message });
            turns.finish(turn, 'failed');
            return;
        }
        log.error('AI pipeline error (stream):', error);
        turns.emit(turn, 'error', { error: 'AI communication failed.' });
        turns.finish(turn, 'failed');
    }
}

// ==========================================================================
// Reattaching — F-24 §6, the part that makes the panel portable
// ==========================================================================

/** The SSE frame writer, and the headers that keep a proxy from ruining it. */
function sseWriter(res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Nginx buffers proxied responses by default, which turns a stream back
        // into a single delayed blob and makes this feature look broken in
        // exactly the deployments most likely to use it.
        'X-Accel-Buffering': 'no'
    });
    return (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
}

/**
 * Points one response at a turn, and closes it when the turn ends.
 *
 * The closing is the part that is easy to leave out. `turns` notifies its
 * subscribers of a terminal frame but knows nothing about HTTP, so without this
 * the socket would stay open after the last word — and a stream that has stopped
 * arriving is indistinguishable, from the client, from a stream still thinking.
 */
function subscribe(turn, req, res) {
    const send = sseWriter(res);
    // The id first: it is what makes this answer findable from another page.
    send('turn', { id: turn.id });

    let closed = false;
    let detach = () => {};
    const close = () => {
        if (closed) return;
        closed = true;
        detach();
        res.end();
    };

    const relay = (event, data) => {
        send(event, data);
        if (turns.TERMINAL.has(event)) close();
    };

    // A turn that had already finished replays and terminates inside this call,
    // so `close` may already have run by the time attach returns its detach.
    detach = turns.attach(turn, relay);
    if (closed) detach();

    // Losing the client is a detach and nothing more. The run continues.
    req.on('close', () => {
        closed = true;
        detach();
    });
}

/**
 * Picks an answer back up on the page the reader landed on.
 *
 * A turn that has already finished replays as state and closes immediately —
 * which is the common case, because a page load takes longer than the last
 * sentence of an answer.
 */
exports.attachTurn = async (req, res) => {
    const turn = turns.get(req.params.id, req.user.id);
    // Absent rather than forbidden: a turn id streams a private conversation, so
    // "you may not have this one" is itself information.
    if (!turn) return res.status(404).json({ error: 'No such answer in progress.' });
    subscribe(turn, req, res);
};

/** The stop button. Unlike a disconnection, this really does end the work. */
exports.cancelTurn = async (req, res) => {
    const turn = turns.get(req.params.id, req.user.id);
    if (!turn) return res.status(404).json({ error: 'No such answer in progress.' });
    res.json({ cancelled: turns.cancel(turn) });
};

/** What is still in flight for this user — asked once, when the panel boots. */
exports.openTurns = async (req, res) => {
    res.json({ turns: turns.openFor(req.user.id) });
};

/**
 * What the user sees while a step runs.
 *
 * In their words, not the tool's. "Looking up Call Center" is a progress
 * indicator; "search_catalog({query:...})" is a stack trace.
 */
function stepLabel(step) {
    const a = step.args || {};
    switch (step.tool) {
    case 'search_catalog': return `Looking up ${a.query}`;
    case 'describe_instance': return 'Checking what data is available';
    case 'get_analytics': return `Reading ${String(a.metric || '').replace(/_/g, ' ')}`;
    case 'drill_down': return `Examining ${String(a.kind || '').replace(/_/g, ' ')} ${a.id || ''}`.trim();
    case 'run_sql': return a.purpose || 'Working something out';
    case 'ask_n8n_docs': return 'Checking the n8n documentation';
    // Quoted, and shown rather than summarised. This is the one step that
    // changes what the assistant will do in later conversations, so the reader
    // sees the exact sentence it is keeping.
    case 'remember': return `Remembering: ${a.fact || ''}`.trim();
    default: return 'Working';
    }
};

// ==========================================================================
// Autocomplete — what `@` offers
// ==========================================================================

/** Which catalogue kinds a tag may name, and the word the picker shows for each. */
const TAGGABLE_KINDS = new Set(Object.values(tags.ENTITY_KINDS));

/**
 * The dropdown behind `@`.
 *
 * Deliberately not a new search. `search_catalog` already resolves a name on
 * this instance, already reads the scoped index, and is already rebuilt from the
 * replica on a short TTL — so the picker and the model look at exactly one list.
 * A second index built for the UI would be a second thing that can be wrong, and
 * the way it would be wrong is offering the user a workflow the answer then says
 * does not exist.
 *
 * The id it returns is a convenience, not a capability: it is re-resolved on the
 * way back in, through this same scoped index. See `src/ai/tags.js`.
 */
exports.searchCatalog = async (req, res) => {
    const query = String(req.query.q || '').trim();
    // An empty box is not a search. Returning the first ten of everything would
    // be a list nobody asked for, and would rebuild the index to produce it.
    if (query.length === 0) return res.json({ results: [] });
    if (query.length > 120) return res.status(400).json({ error: 'Query too long.' });

    const kind = TAGGABLE_KINDS.has(req.query.kind) ? req.query.kind : null;

    try {
        const visibleIds = await visibleWorkflowIds(req.scope);
        const rows = await catalog.search({ query, kind, limit: 8, scope: visibleIds });
        res.json({
            results: rows.map((r) => ({
                category: tags.CATEGORY_FOR_KIND[r.kind] || r.kind,
                kind: r.kind,
                id: String(r.id),
                name: r.name,
                detail: r.detail || null
            }))
        });
    } catch (error) {
        log.error('Catalog search error:', error);
        res.status(500).json({ error: 'Catalog search failed.' });
    }
};

/**
 * What the `@` menu and the `+` menu are allowed to offer.
 *
 * Sent rather than hard-coded in the page for the same reason the tool list is
 * built per user: `ask_n8n_docs` exists only for someone who connected it, and a
 * menu offering a tool that will be rejected is a menu that lies.
 */
exports.getTagOptions = async (req, res) => {
    const docsEnabled = docs.isConfigured(req.user.id);
    res.json({
        categories: Object.keys(tags.ENTITY_KINDS)
            .filter((c) => tags.CATEGORY_FOR_KIND[tags.ENTITY_KINDS[c]] === c)
            .concat('execution'),
        tools: [
            { alias: 'analytics', tool: 'get_analytics', available: true },
            { alias: 'search', tool: 'search_catalog', available: true },
            { alias: 'drilldown', tool: 'drill_down', available: true },
            { alias: 'instance', tool: 'describe_instance', available: true },
            { alias: 'sql', tool: 'run_sql', available: SQL_ESCAPE_HATCH },
            { alias: 'docs', tool: 'ask_n8n_docs', available: docsEnabled }
        ].filter((t) => t.available),
        maxTags: tags.MAX_TAGS,
        maxForced: tags.MAX_FORCED
    });
};

// ==========================================================================

/**
 * One thread's messages.
 *
 * Which thread is the caller's choice and defaults to the most recent — the
 * panel opens where the reader left off, which is not the same decision as
 * `resolveFor` makes for a new QUESTION. Reading is a look at what happened;
 * asking is a new act, and defaulting the second to "whatever you last talked
 * about" is exactly what conversations exist to stop.
 */
exports.getHistory = async (req, res) => {
    try {
        // Once per user, the first time they open the chat after the upgrade.
        await conversations.adoptOrphans(req.user.id);

        let conversation = await conversations.find(req.query.conversationId, req.user.id);
        if (!conversation) {
            const [mostRecent] = await conversations.list(req.user.id, { limit: 1 });
            conversation = mostRecent ? await conversations.find(mostRecent.id, req.user.id) : null;
        }
        if (!conversation) return res.json({ conversation: null, messages: [] });

        res.json({
            conversation: {
                id: conversation.id,
                title: conversation.title,
                created_at: conversation.created_at
            },
            messages: await conversations.messages(conversation.id)
        });
    } catch (error) {
        log.error('History fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch chat history.' });
    }
};

// ==========================================================================
// Conversations
// ==========================================================================

exports.listConversations = async (req, res) => {
    try {
        await conversations.adoptOrphans(req.user.id);
        res.json({ conversations: await conversations.list(req.user.id) });
    } catch (error) {
        log.error('Conversation list error:', error);
        res.status(500).json({ error: 'Failed to list conversations.' });
    }
};

exports.createConversation = async (req, res) => {
    try {
        // The title is optional and almost always absent — a thread names itself
        // from its first question. It is honoured when given because the DAO has
        // always taken one and this endpoint quietly dropped it: a body field
        // that is accepted and ignored is worse than one that is rejected, and
        // it cost an afternoon working out why every seeded conversation came
        // back called something else.
        const title = String(req.body?.title || '').trim().slice(0, 120) || null;
        const conversation = await conversations.create(req.user.id, title);
        res.status(201).json({ conversation });
    } catch (error) {
        log.error('Conversation create error:', error);
        res.status(500).json({ error: 'Failed to start a conversation.' });
    }
};

exports.updateConversation = async (req, res) => {
    try {
        const updated = await conversations.rename(req.params.id, req.user.id, req.body.title);
        if (!updated) return res.status(404).json({ error: 'No such conversation.' });
        res.json({ conversation: updated });
    } catch (error) {
        log.error('Conversation rename error:', error);
        res.status(500).json({ error: 'Failed to rename the conversation.' });
    }
};

/**
 * Delete removes; archive hides.
 *
 * Both exist because they answer different wants. "I am done with this" should
 * not destroy a record of what somebody was told — and a thread the assistant
 * wrote a memory from would leave that memory citing nothing.
 */
exports.deleteConversation = async (req, res) => {
    try {
        const permanent = req.query.permanent === '1';
        const done = permanent
            ? await conversations.remove(req.params.id, req.user.id)
            : await conversations.archive(req.params.id, req.user.id);
        if (!done) return res.status(404).json({ error: 'No such conversation.' });
        res.json({ ok: true, permanent });
    } catch (error) {
        log.error('Conversation delete error:', error);
        res.status(500).json({ error: 'Failed to remove the conversation.' });
    }
};

// ==========================================================================
// Memory
// ==========================================================================

/**
 * What the assistant has been told to remember about this person.
 *
 * Readable and deletable by them, which is the condition on the feature
 * existing at all: a note about somebody that they cannot see or remove is not
 * memory, it is a file being kept on them.
 */
exports.listMemories = async (req, res) => {
    try {
        res.json({
            memories: await conversations.memories(req.user.id),
            limit: conversations.MAX_MEMORIES
        });
    } catch (error) {
        log.error('Memory list error:', error);
        res.status(500).json({ error: 'Failed to read memories.' });
    }
};

exports.deleteMemory = async (req, res) => {
    try {
        const gone = req.params.id === 'all'
            ? await conversations.forgetAll(req.user.id)
            : await conversations.forget(req.user.id, req.params.id);
        res.json({ ok: Boolean(gone), removed: gone === true ? 1 : gone });
    } catch (error) {
        log.error('Memory delete error:', error);
        res.status(500).json({ error: 'Failed to forget that.' });
    }
};
