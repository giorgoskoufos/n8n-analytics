/**
 * The tool-calling loop.
 *
 * The old pipeline was fixed: one model call to write SQL, run it, a second
 * model call to describe the rows. It could only ever answer questions that fit
 * a single query, and it could not check anything — if the first query was
 * aimed at the wrong workflow, the second call described the wrong answer
 * fluently.
 *
 * This runs the model until it stops asking for tools. That is what lets it
 * resolve a name, then measure, then look at the one thing that stood out —
 * which is how a person would answer the same question.
 *
 * ── The bounds, and why each exists ──────────────────────────────────────
 *
 * MAX_STEPS   a model that keeps calling tools without concluding is a loop
 *             that bills per turn. Six is enough for resolve → measure →
 *             drill → confirm, and short enough that a stuck one stops.
 * MAX_RESULT  tool output goes back into the context. `workflows` returns 164
 *             rows; the whole storage forecast is larger still. Truncated with
 *             a note saying so, because a silently cut list is one the model
 *             will summarise as complete.
 *
 * Tool failures are returned to the model rather than thrown. A rejected SQL
 * statement or an unknown metric is something it can correct on the next step,
 * and turning that into a 500 would throw away a conversation over a typo.
 *
 * ── Forced tools ─────────────────────────────────────────────────────────
 *
 * `@tool:docs` in the question is not a suggestion, so it is not implemented as
 * one. A forced tool becomes `tool_choice` on its own step, which the provider
 * honours; a line in the prompt saying "please call the documentation" is what
 * the model already ignored, and that is why this exists at all.
 *
 * One per step, in the order the user wrote them, then back to `auto`. They
 * cannot all be forced at once — `tool_choice` names a single function — and
 * queueing them is the only reading under which tagging two tools calls both.
 */

const { execute } = require('./execute');
const log = require('../utils/logger').logger('AI-RUN');

const MAX_STEPS = Number(process.env.AI_MAX_STEPS) || 6;
const MAX_RESULT_CHARS = Number(process.env.AI_MAX_RESULT_CHARS) || 12_000;

function serialise(result) {
    const text = JSON.stringify(result === undefined ? null : result);
    if (text.length <= MAX_RESULT_CHARS) return text;
    return text.slice(0, MAX_RESULT_CHARS) +
        `\n\n[truncated — the full result was ${text.length} characters. ` +
        'Narrow the window or the filter if you need the rest; do not describe ' +
        'this as the complete list.]';
}

/**
 * Runs the conversation to a final answer.
 *
 * @param {object}   opts
 * @param {object}   opts.openai      the client
 * @param {string}   opts.model
 * @param {object[]} opts.messages    system + history + the new question
 * @param {object[]} opts.tools       from tools/index.build()
 * @param {object}   opts.ctx         { scope, userId }
 * @param {function} [opts.onStep]    called with each tool call and its outcome
 * @param {function} [opts.onDelta]   called with each token of the final answer
 * @param {function} [opts.isAborted] returns true when the client has gone
 * @param {string[]}  [opts.forced]  tool names to compel, one per step, in order
 */
async function run({ openai, model, messages, tools, ctx, onStep, onDelta, isAborted, forced = [] }) {
    const convo = [...messages];
    const used = [];
    const pending = [...forced];

    for (let step = 0; step < MAX_STEPS; step++) {
        if (isAborted && isAborted()) return { aborted: true, steps: used };

        const compelled = pending[0] || null;

        // One streaming call per iteration, not two.
        //
        // The obvious implementation asks without streaming, checks whether the
        // reply wanted tools, and — when it did not — asks AGAIN with streaming
        // so the prose arrives gradually. That is a whole extra model round trip
        // on every single turn, paid to learn something the first reply already
        // contained. Streaming from the start and accumulating the tool-call
        // fragments costs a few lines here and removes it.
        const stream = await openai.chat.completions.create({
            model,
            messages: convo,
            tools,
            tool_choice: compelled
                ? { type: 'function', function: { name: compelled } }
                : 'auto',
            temperature: 0,
            stream: true
        });

        // Prose from a compelled step is not forwarded. A forced step normally
        // produces none, but when it does it is preamble to a call the user
        // already asked for — and showing it would mean the reader sees one
        // opening sentence now and a second, different one when the real answer
        // starts. Suppressing it also makes the fallback below safe: nothing was
        // displayed, so nothing is displayed twice.
        const { content, calls } = await consume(stream, compelled ? null : onDelta, isAborted);
        if (isAborted && isAborted()) return { aborted: true, answer: content, steps: used };

        if (calls.length === 0) {
            if (compelled) {
                // The provider ignored `tool_choice`. Rather than insisting and
                // burning the remaining steps on the same refusal, drop the
                // demand and let the turn continue on its own terms.
                log.warn(`Forced ${compelled} was not called; continuing without it.`);
                pending.shift();
                continue;
            }
            // It answered rather than asking for anything, and the answer has
            // already been streamed out.
            return { answer: content, steps: used };
        }

        if (compelled && calls.some((c) => c.function.name === compelled)) pending.shift();

        convo.push({
            role: 'assistant',
            content: content || null,
            tool_calls: calls.map((c) => ({
                id: c.id, type: 'function',
                function: { name: c.function.name, arguments: c.function.arguments }
            }))
        });

        for (const call of calls) {
            let args = {};
            try {
                args = JSON.parse(call.function.arguments || '{}');
            } catch (err) {
                // Malformed arguments are the model's mistake to fix, so they
                // go back as a tool result rather than ending the turn.
                convo.push({
                    role: 'tool', tool_call_id: call.id,
                    content: `Could not parse the arguments: ${err.message}`
                });
                continue;
            }

            const record = { tool: call.function.name, args };
            try {
                const result = await execute(call.function.name, args, ctx);
                record.ok = true;
                convo.push({
                    role: 'tool', tool_call_id: call.id, content: serialise(result)
                });
            } catch (err) {
                record.ok = false;
                record.error = err.message;
                log.warn(`${call.function.name} failed: ${err.message}`);
                convo.push({
                    role: 'tool', tool_call_id: call.id,
                    content: `That call failed: ${err.message}`
                });
            }
            used.push(record);
            if (onStep) onStep(record);
        }
    }

    // Out of steps. Rather than returning nothing, ask for the best answer
    // available from what has been gathered — and say that it is partial.
    convo.push({
        role: 'user',
        content: 'Stop looking things up and answer from what you have. If it is incomplete, ' +
            'say which part you could not establish.'
    });
    return finalAnswer({ openai, model, convo, onDelta, isAborted, used, exhausted: true });
}

/**
 * Reads one streamed reply into its prose and its tool calls.
 *
 * Tool calls arrive in fragments: an index, then a name, then the arguments a
 * few characters at a time across many chunks. They are reassembled by index,
 * which is the only thing that identifies which call a fragment belongs to when
 * the model asks for more than one at once.
 *
 * Content deltas are forwarded as they arrive. A model that says "let me check
 * that" before calling a tool will have that sentence shown, which is honest —
 * it is what it said — and reads as narration rather than as a wrong answer.
 */
async function consume(stream, onDelta, isAborted) {
    let content = '';
    const byIndex = new Map();

    for await (const chunk of stream) {
        if (isAborted && isAborted()) break;
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (!delta) continue;

        if (delta.content) {
            content += delta.content;
            if (onDelta) onDelta(delta.content);
        }

        for (const part of delta.tool_calls || []) {
            const idx = part.index === undefined ? 0 : part.index;
            if (!byIndex.has(idx)) {
                byIndex.set(idx, { id: part.id, function: { name: '', arguments: '' } });
            }
            const call = byIndex.get(idx);
            if (part.id) call.id = part.id;
            if (part.function && part.function.name) call.function.name += part.function.name;
            if (part.function && part.function.arguments) {
                call.function.arguments += part.function.arguments;
            }
        }
    }

    return { content, calls: [...byIndex.values()] };
}

async function finalAnswer({ openai, model, convo, onDelta, isAborted, used, exhausted = false }) {
    const stream = await openai.chat.completions.create({
        model, messages: convo, temperature: 0.4, stream: true
    });

    const { content } = await consume(stream, onDelta, isAborted);
    if (isAborted && isAborted()) return { aborted: true, answer: content, steps: used };
    return { answer: content, steps: used, exhausted };
}

module.exports = { run, MAX_STEPS, _internal: { serialise } };
