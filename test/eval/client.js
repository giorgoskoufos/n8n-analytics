/**
 * The thing that talks to a running dashboard as if it were the chat UI.
 *
 * Separate from the checks and from the scenarios because it is the only part
 * that knows about HTTP, and because it is the part that has to be boring: an
 * evaluation whose harness is itself suspect tells you nothing.
 *
 * It reads the SSE stream the same way `chat-core.js` does, and keeps the two
 * things a check can look at:
 *
 *   answer  the prose, assembled from the `delta` frames
 *   steps   every tool call, with the ARGUMENTS the model chose
 *
 * The steps are the half that makes this worth writing. "Did it use the right
 * tool, scoped the right way" is a question with a factual answer, and it is
 * recorded — so it can be asserted rather than judged. Only the prose needs an
 * opinion.
 */

const jwt = require('jsonwebtoken');

const BASE = process.env.EVAL_BASE_URL || 'http://localhost:3000';

/**
 * A token for whoever the eval is running as.
 *
 * Minted rather than obtained by logging in, because logging in reaches the
 * production Postgres to check the password and this needs neither the network
 * nor the credentials. The claims are the ones `authenticateToken` reads.
 */
function tokenFor({ id, email, role = 'global:owner' }) {
    const secret = process.env.DASHBOARD_JWT_SECRET;
    if (!secret) throw new Error('DASHBOARD_JWT_SECRET is not set; the eval cannot authenticate.');
    return jwt.sign({ id, email, firstName: 'Eval', role, jti: `eval-${Date.now()}` }, secret, {
        expiresIn: '1h'
    });
}

async function api(token, path, { method = 'GET', body } = {}) {
    const res = await fetch(BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
        throw new Error(`${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json();
}

/**
 * Sends one message and returns when the turn is over.
 *
 * The SSE frames arrive split across chunks at arbitrary boundaries, so the
 * buffer is drained on the blank line that separates frames rather than per
 * chunk — the same reason the UI parses it this way. A frame split down the
 * middle of a JSON payload is otherwise a parse error that only happens under
 * load, which is the worst kind.
 */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function ask(token, { message, conversationId, tools, onWait }) {
    let res;
    // `aiLimiter` allows five AI requests a minute per user, and an eval is a
    // burst by construction. Waiting it out is the right answer: raising the
    // limit so a test can pass would be changing what production does to suit
    // the test, and the limiter is there because a turn costs money.
    for (let attempt = 0; ; attempt++) {
        res = await fetch(`${BASE}/api/ai-chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ message, conversationId, tools })
        });
        if (res.status !== 429 || attempt >= 6) break;
        await res.text();
        if (onWait) onWait(attempt);
        await sleep(13000);
    }
    if (!res.ok) {
        throw new Error(`stream -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    }

    const out = { answer: '', steps: [], tags: null, error: null, turnId: null, conversationId };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let cut;
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);

            const event = /^event: (.+)$/m.exec(frame)?.[1];
            const raw = /^data: (.*)$/m.exec(frame)?.[1];
            if (!event || raw === undefined) continue;

            let data;
            try {
                data = JSON.parse(raw);
            } catch {
                continue;
            }

            if (event === 'delta') out.answer += data.text || '';
            else if (event === 'step') out.steps.push(data);
            else if (event === 'tags') out.tags = data;
            else if (event === 'turn') out.turnId = data.id;
            else if (event === 'conversation') out.conversationId = data.id || conversationId;
            else if (event === 'error') out.error = data;
            else if (event === 'done') {
                // The live `step` frames carry `{tool, label, ok}` — the phrase
                // shown while the call runs — and the terminal frame carries the
                // same calls with their ARGUMENTS. Only the second can answer
                // "was this scoped to the right workflow", which is most of what
                // this harness exists to ask, so the final list replaces the
                // running one rather than being appended to it.
                if (Array.isArray(data.steps)) out.steps = data.steps;
                if (data.answer) out.answer = data.answer;
                out.partial = Boolean(data.partial);
            } else if (event === 'failed') out.error = data;
            else if (event === 'cancelled') out.error = { message: 'cancelled' };
        }
    }

    return out;
}

/** A conversation of its own per scenario — otherwise scenario N inherits N-1. */
async function newConversation(token, title) {
    const created = await api(token, '/api/ai-conversations', { method: 'POST', body: { title } });
    return created.id || created.conversation?.id || created.conversationId;
}

module.exports = { BASE, tokenFor, api, ask, newConversation };
