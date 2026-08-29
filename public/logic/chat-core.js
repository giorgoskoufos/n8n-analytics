/**
 * chat-core.js — F-24 §6. One chat implementation, two shells.
 *
 * There were two: `chat-widget.js` (365 lines, the floating panel) and
 * `chat.js` (159, the full page). They talked to the same endpoint and had
 * separately written copies of the same six functions, and they had already
 * drifted in a way anyone could see:
 *
 *   · the widget rendered answers through `renderMarkdownSafely`;
 *   · the full page rendered them through `escapeHtml`.
 *
 * The server prompt says "if the data has 2 or more columns, ALWAYS use a
 * Markdown table". So on the full-page chat every tabular answer arrived as a
 * screenful of literal pipe characters, and had done since the day markdown
 * rendering was added to the other one. That is the cost of two
 * implementations, in one bug, on the feature's main surface.
 *
 * This file owns everything that is not layout. A shell hands it the elements
 * it should use and gets back a `send()`; it decides nothing about what a
 * message looks like.
 *
 * Two things the shells no longer get to disagree about:
 *
 *   · The SQL that ran is displayed. It has always been stored
 *     (`dashboard_chat_history.sql_used`) and was returned by the endpoint, and
 *     both shells did show it — but each with its own markup, its own font size
 *     and its own decision about whether history entries got it too. It is one
 *     component now, collapsed by default, and it arrives BEFORE the answer
 *     when streaming, which is the order in which it is useful.
 *
 *   · Streaming. The answer is written as it is produced, with a graceful fall
 *     back to the non-streaming endpoint — an old server, a proxy that buffers,
 *     a browser without streaming fetch. The fallback is not a silent one: the
 *     result is identical, it simply arrives all at once.
 */

(function () {
    'use strict';

    const esc = (v) => window.escapeHtml(v);

    /**
     * The SQL disclosure.
     *
     * Collapsed, because most of the time the answer is the point and the query
     * is reassurance. Present always, because an answer produced by SQL nobody
     * can see is an answer nobody can check — and this assistant writes its own
     * queries.
     */
    function sqlBlock(sql) {
        if (!sql) return '';
        return `<details class="mt-3 pt-3" style="border-top:1px solid var(--line)">
            <summary class="label cursor-pointer select-none">
                <i class="fa-solid fa-database mr-1.5"></i>The query that produced this
            </summary>
            <pre class="mono mt-2 p-2.5 rounded overflow-x-auto whitespace-pre-wrap custom-scrollbar"
                 style="background:var(--surface-0);color:var(--ink-2);max-height:220px">${esc(sql)}</pre>
        </details>`;
    }

    function avatar(icon, tone) {
        return `<div class="shrink-0 flex items-center justify-center rounded-full mt-0.5"
                     style="width:32px;height:32px;background:color-mix(in srgb, var(--${tone}) 16%, transparent);
                            border:1px solid color-mix(in srgb, var(--${tone}) 32%, transparent)">
                    <i class="fa-solid ${icon} text-sm" style="color:var(--${tone})"></i>
                </div>`;
    }

    /**
     * Creates a chat bound to a set of elements.
     *
     * @param {object} el   { box, input, send }
     * @param {object} opts { compact: boolean }
     */
    function mount(el, opts = {}) {
        const { box, input, send: sendBtn } = el;
        if (!box || !input || !sendBtn) return null;

        const textSize = opts.compact ? 'text-xs' : 'text-sm';
        const bubbleMax = opts.compact ? '88%' : '85%';

        function scrollToBottom() {
            box.scrollTop = box.scrollHeight;
        }

        function bubble(role, text, sql) {
            const wrap = document.createElement('div');
            wrap.className = 'flex w-full gap-3 items-start';

            if (role === 'user') {
                wrap.classList.add('justify-end');
                wrap.innerHTML = `
                    <div class="p-3 rounded-2xl" style="max-width:${bubbleMax};
                         background:var(--brand);color:#1a0c09;border-top-right-radius:4px">
                        <p class="${textSize} leading-relaxed whitespace-pre-wrap">${esc(text)}</p>
                    </div>`;
                box.appendChild(wrap);
                scrollToBottom();
                return wrap;
            }

            const isError = role === 'error';
            const tone = isError ? 'critical-ink' : 'brand';
            const body = document.createElement('div');
            body.className = 'p-3 rounded-2xl w-full prose-chat ' + textSize;
            body.style.cssText = `max-width:${bubbleMax};background:var(--surface-1);` +
                `border:1px solid ${isError
                    ? 'color-mix(in srgb, var(--critical-mark) 35%, transparent)'
                    : 'var(--line)'};border-top-left-radius:4px`;

            // Markdown for the assistant, escaped text for an error.
            //
            // This is the line the two implementations disagreed about. An error
            // is a message from this dashboard, not from the model, so it is not
            // markdown and must not be parsed as any.
            const content = document.createElement('div');
            content.className = 'leading-relaxed';
            if (isError) {
                content.textContent = text;
            } else {
                content.innerHTML = window.renderMarkdownSafely(text);
            }
            body.appendChild(content);

            const sqlHost = document.createElement('div');
            sqlHost.innerHTML = sqlBlock(sql);
            body.appendChild(sqlHost);

            wrap.innerHTML = avatar(isError ? 'fa-triangle-exclamation' : 'fa-robot', tone);
            wrap.appendChild(body);
            box.appendChild(wrap);
            scrollToBottom();

            // Handed back so a streaming answer can keep writing into it.
            return { wrap, content, sqlHost };
        }

        function typing() {
            const wrap = document.createElement('div');
            wrap.className = 'flex w-full gap-3 items-start';
            wrap.innerHTML = avatar('fa-robot', 'brand') +
                `<div class="p-3.5 rounded-2xl flex items-center gap-1.5"
                      style="background:var(--surface-1);border:1px solid var(--line);border-top-left-radius:4px">
                    ${[0, 150, 300].map((d) =>
        `<span style="width:6px;height:6px;border-radius:999px;background:var(--ink-3);
                      animation:sk-shimmer 1s ${d}ms infinite alternate"></span>`).join('')}
                </div>`;
            box.appendChild(wrap);
            scrollToBottom();
            return wrap;
        }

        /**
         * Reads the SSE stream.
         *
         * Returns false if streaming is unavailable at all, so the caller can
         * fall back. A stream that opened and then failed does NOT come back
         * here as false — it has already written a partial answer, and running
         * the whole request again would append a second copy of it.
         */
        async function streamAnswer(text, target) {
            const res = await window.fetchWithAuth('/api/ai-chat/stream', {
                method: 'POST',
                body: JSON.stringify({ message: text })
            });

            // A refusal (403 for a scoped user, 400 for a bad message) still
            // arrives as JSON with a status, because it happens before any
            // streaming starts.
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                return { failed: true, error: body.error || `HTTP ${res.status}`, details: body.details, sql: body.sqlUsed };
            }
            if (!res.body || !res.body.getReader) return null;   // no streaming here

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let answer = '';
            let sql = null;
            let failure = null;

            const handle = (event, data) => {
                if (event === 'sql') {
                    sql = data.sql;
                    // Rendered the moment it is known, ahead of the prose it
                    // produced — which is the ordering that makes it useful.
                    target.sqlHost.innerHTML = sqlBlock(sql);
                } else if (event === 'delta') {
                    answer += data.text;
                    target.content.innerHTML = window.renderMarkdownSafely(answer);
                    scrollToBottom();
                } else if (event === 'done') {
                    answer = data.answer || answer;
                    target.content.innerHTML = window.renderMarkdownSafely(answer);
                    if (data.sqlUsed) target.sqlHost.innerHTML = sqlBlock(data.sqlUsed);
                } else if (event === 'error') {
                    failure = data;
                }
            };

            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                // SSE frames are separated by a blank line. A chunk boundary can
                // land anywhere, so only whole frames are consumed and the tail
                // stays in the buffer.
                let sep;
                while ((sep = buffer.indexOf('\n\n')) !== -1) {
                    const frame = buffer.slice(0, sep);
                    buffer = buffer.slice(sep + 2);
                    let event = 'message';
                    let payload = '';
                    for (const line of frame.split('\n')) {
                        if (line.startsWith('event: ')) event = line.slice(7).trim();
                        else if (line.startsWith('data: ')) payload += line.slice(6);
                    }
                    if (!payload) continue;
                    try { handle(event, JSON.parse(payload)); } catch (ignored) { /* partial frame */ }
                }
            }

            return failure ? { streamed: true, failure, sql } : { streamed: true, answer, sql };
        }

        async function submit() {
            const text = input.value.trim();
            if (!text) return;

            bubble('user', text);
            input.value = '';
            input.style.height = 'auto';
            input.disabled = true;
            sendBtn.disabled = true;

            const indicator = typing();

            try {
                // The bubble is created up front and written into, so the answer
                // appears where it will stay rather than jumping when it lands.
                let target = null;
                const openTarget = () => {
                    if (target) return target;
                    indicator.remove();
                    target = bubble('ai', '');
                    return target;
                };

                let result = null;
                try {
                    result = await streamAnswer(text, {
                        get content() { return openTarget().content; },
                        get sqlHost() { return openTarget().sqlHost; }
                    });
                } catch (streamErr) {
                    console.warn('[CHAT] streaming unavailable, falling back:', streamErr);
                }

                if (result && result.failed) {
                    indicator.remove();
                    bubble('error', result.error + (result.details ? ` — ${result.details}` : ''), result.sql);
                    return;
                }
                if (result && result.streamed) {
                    if (result.failure) {
                        // The stream opened and then reported a problem. Whatever
                        // was written stays; the error is appended beside it
                        // rather than replacing it, because a partial answer is
                        // evidence about what went wrong.
                        bubble('error',
                            result.failure.error + (result.failure.details ? ` — ${result.failure.details}` : ''),
                            result.failure.sqlUsed);
                    }
                    return;
                }

                // Fallback: the whole answer at once. Identical result, no
                // progressive rendering.
                const res = await window.fetchWithAuth('/api/ai-chat', {
                    method: 'POST',
                    body: JSON.stringify({ message: text })
                });
                const data = await res.json();
                indicator.remove();
                if (target) target.wrap.remove();
                if (res.ok) bubble('ai', data.answer, data.sqlUsed);
                else bubble('error', data.error || 'The assistant could not answer.', data.sqlUsed);
            } catch (err) {
                indicator.remove();
                bubble('error', 'Connection failed. Please try again.');
                console.error('[CHAT]', err);
            } finally {
                input.disabled = false;
                sendBtn.disabled = false;
                input.focus();
            }
        }

        // ---- wiring ----
        sendBtn.addEventListener('click', submit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
            }
        });
        input.addEventListener('input', function () {
            this.style.height = 'auto';
            this.style.height = `${this.scrollHeight}px`;
        });

        /** Replays what this user has already asked. */
        async function loadHistory() {
            try {
                const res = await window.fetchWithAuth('/api/chat-history');
                if (!res.ok) return;
                const history = await res.json();
                if (!history.length) return;
                box.innerHTML = '';
                for (const msg of history) bubble(msg.role, msg.content, msg.sql_used);
            } catch (err) {
                console.warn('[CHAT] history unavailable:', err);
            }
        }

        return { submit, bubble, loadHistory, scrollToBottom };
    }

    window.ChatCore = { mount };
})();
