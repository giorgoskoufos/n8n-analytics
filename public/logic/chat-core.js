/**
 * chat-core.js — the conversation. One implementation, two shells.
 *
 * F-24 §6 collapsed `chat-widget.js` and `chat.js` into this file because they
 * were two copies of the same six functions that had already drifted: the widget
 * rendered markdown and the full page did not, so every table the server prompt
 * asks for arrived on the full page as a screenful of pipe characters.
 *
 * That rule holds. A shell hands this file a set of elements and gets back a
 * conversation; it decides layout and nothing else.
 *
 * ── What changed with the portable panel ─────────────────────────────────
 *
 * The assistant now lives on every page, and every link in a multi-page app is a
 * full document load. So a turn is no longer something this file owns from
 * beginning to end — it is something the server owns (src/ai/turns.js) and this
 * file ATTACHES to. Three consequences run through everything below:
 *
 *   · The first frame of a stream is a turn id, and it is written down before
 *     anything else happens. It is what the next page uses to find the answer.
 *   · On boot, this asks what is still in flight and reattaches. The question is
 *     replayed from the turn rather than from the history, because the history
 *     row is not written until the answer completes.
 *   · Losing the connection is not an error any more. It is a page navigation,
 *     and the correct response is to say nothing and pick the answer up on the
 *     other side.
 *
 * ── Rendering is batched, and highlighted only once ──────────────────────
 *
 * Re-parsing the whole answer on every token was tolerable when an answer was
 * prose. It is not once code blocks are decorated and coloured. Deltas are
 * accumulated and flushed on an animation frame, and the highlighter runs a
 * single time, when the answer is complete — half-written code lexes as
 * different code, so a block would recolour itself several times a second.
 */

(function () {
    'use strict';


    // ---------------------------------------------------------------- steps

    const STEP_ICONS = {
        search_catalog: 'fa-magnifying-glass',
        describe_instance: 'fa-circle-info',
        get_analytics: 'fa-chart-simple',
        drill_down: 'fa-diagram-project',
        run_sql: 'fa-terminal',
        describe_views: 'fa-table-list',
        ask_n8n_docs: 'fa-book',
        remember: 'fa-bookmark'
    };

    function node(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    function stepDetail(args) {
        const a = args || {};
        return a.metric || a.kind || a.query || a.purpose || a.question || '';
    }

    /**
     * What the assistant did, collapsed.
     *
     * This replaced a panel showing the generated SQL, which was right while the
     * SQL WAS the reasoning. It is not any more — the assistant chooses among
     * the dashboard's own analyses — so what is worth showing is which ones it
     * chose, in what order, and whether any of them failed. Still always
     * present, still collapsed: the answer is the point, this is how you check
     * it.
     */
    function stepsBlock(steps) {
        if (!steps || !steps.length) return null;
        const details = node('details', 'assistant-steps');
        const summary = node('summary');
        summary.appendChild(node('i', 'fa-solid fa-list-check'));
        summary.appendChild(node('span', null,
            ` How this was worked out (${steps.length} step${steps.length === 1 ? '' : 's'})`));
        details.appendChild(summary);

        const list = node('ul');
        for (const s of steps) {
            const li = node('li', s.ok === false ? 'failed' : null);
            li.appendChild(node('i', `fa-solid ${STEP_ICONS[s.tool] || 'fa-circle'}`));
            const text = node('span', null, String(s.tool).replace(/_/g, ' '));
            const detail = stepDetail(s.args);
            if (detail) {
                text.appendChild(node('span', 'detail', ` · ${detail}`));
            }
            li.appendChild(text);
            list.appendChild(li);
        }
        details.appendChild(list);
        return details;
    }

    function liveStep(label) {
        const row = node('div', 'assistant-live');
        row.appendChild(node('i', 'fa-solid fa-circle-notch fa-spin'));
        row.appendChild(node('span', null, label));
        return row;
    }

    // ------------------------------------------------------------------ SSE

    /**
     * Reads an SSE body, frame by frame.
     *
     * Frames are separated by a blank line and a chunk boundary can land
     * anywhere, so only whole frames are consumed and the tail stays buffered.
     */
    async function readStream(res, handle) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

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
                try {
                    handle(event, JSON.parse(payload));
                } catch (ignored) { /* a frame we could not parse is a frame we skip */ }
            }
        }
    }

    // ---------------------------------------------------------------- mount

    /**
     * @param {object} refs { log, input, send, stop, status, jump, strip, menu,
     *                        toolsButton, toolHint }
     * @param {object} opts { compact, onBusy, onAnswer }
     */
    function mount(refs, opts = {}) {
        const { log, input, send: sendBtn } = refs;
        if (!log || !input || !sendBtn) return null;

        const store = window.ChatStore;
        const tagUi = refs.strip && refs.menu
            ? window.ChatTags.attach({
                input,
                strip: refs.strip,
                menu: refs.menu,
                toolsButton: refs.toolsButton,
                toolHint: refs.toolHint
            })
            : null;

        let activeTurn = null;      // { id, abort }
        let pinned = true;          // is the reader at the bottom?
        let conversationId = null;  // which thread the composer is writing into

        // ---- threads ----
        //
        // The switcher's whole job is to make "which conversation am I in"
        // answerable without opening a menu. So the current title is the
        // control: it names the thread and it is the thing you click to change
        // it, rather than a label beside a button that does.

        function setConversation(conversation) {
            conversationId = conversation ? conversation.id : null;
            store.patchSession({ conversationId });
            if (!refs.threadTitle) return;
            refs.threadTitle.textContent = (conversation && conversation.title) || 'New conversation';
        }

        /** Starts an empty thread. Nothing is created server-side until a question. */
        function newConversation() {
            setConversation(null);
            log.replaceChildren();
            emptyState();
            closeThreads();
            input.focus();
        }

        async function openConversation(id) {
            closeThreads();
            await loadHistory(id);
            pinned = true;
            log.scrollTop = log.scrollHeight;
        }

        function closeThreads() {
            if (!refs.threadMenu) return;
            refs.threadMenu.hidden = true;
            refs.threadMenu.replaceChildren();
            if (refs.threadButton) refs.threadButton.setAttribute('aria-expanded', 'false');
        }

        function relative(iso) {
            if (!iso) return '';
            const ms = Date.now() - Date.parse(iso);
            if (!Number.isFinite(ms)) return '';
            const mins = Math.round(ms / 60000);
            if (mins < 60) return `${Math.max(mins, 1)}m`;
            if (mins < 1440) return `${Math.round(mins / 60)}h`;
            return `${Math.round(mins / 1440)}d`;
        }

        async function toggleThreads() {
            if (!refs.threadMenu) return;
            if (!refs.threadMenu.hidden) {
                closeThreads();
                return;
            }
            const menu = refs.threadMenu;
            menu.replaceChildren();

            const head = node('div', 'tag-menu-head');
            head.appendChild(node('span', null, 'Conversations'));
            menu.appendChild(head);

            const fresh = node('button', 'tag-option');
            fresh.type = 'button';
            fresh.appendChild(node('i', 'fa-solid fa-pen-to-square'));
            fresh.appendChild(node('span', 'name', 'New conversation'));
            fresh.addEventListener('click', newConversation);
            menu.appendChild(fresh);

            menu.hidden = false;
            if (refs.threadButton) refs.threadButton.setAttribute('aria-expanded', 'true');

            try {
                const res = await window.fetchWithAuth('/api/ai-conversations');
                if (!res.ok) return;
                const { conversations: list } = await res.json();
                for (const c of list) {
                    const row = node('button', 'tag-option');
                    row.type = 'button';
                    row.setAttribute('aria-selected', String(c.id === conversationId));
                    row.appendChild(node('i', c.id === conversationId
                        ? 'fa-solid fa-comment-dots' : 'fa-regular fa-comment'));
                    row.appendChild(node('span', 'name', c.title || 'Untitled'));
                    row.appendChild(node('span', 'detail', relative(c.last_at)));
                    row.addEventListener('click', () => openConversation(c.id));
                    menu.appendChild(row);
                }
                if (!list.length) {
                    menu.appendChild(node('div', 'tag-menu-empty', 'Nothing yet.'));
                }
            } catch (err) {
                console.warn('[CHAT] could not list conversations:', err);
                menu.appendChild(node('div', 'tag-menu-empty', 'Could not load the list.'));
            }
        }

        // ---- scrolling ----
        //
        // Following the answer is only correct while the reader is already at
        // the bottom. Someone who has scrolled up to re-read a table is reading
        // it, and dragging them away is the rudest thing a chat can do.

        function atBottom() {
            return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
        }

        function follow() {
            if (!pinned) {
                if (refs.jump) refs.jump.hidden = false;
                return;
            }
            log.scrollTop = log.scrollHeight;
        }

        log.addEventListener('scroll', () => {
            pinned = atBottom();
            if (pinned && refs.jump) refs.jump.hidden = true;
        });

        if (refs.jump) {
            refs.jump.addEventListener('click', () => {
                pinned = true;
                refs.jump.hidden = true;
                log.scrollTop = log.scrollHeight;
            });
        }

        function announce(text) {
            if (refs.status) refs.status.textContent = text;
        }

        // ---- messages ----

        function avatar(icon) {
            const a = node('span', 'msg-avatar');
            a.setAttribute('aria-hidden', 'true');
            a.appendChild(node('i', `fa-solid ${icon}`));
            return a;
        }

        /**
         * Adds one message and returns the handles a streaming answer writes to.
         */
        function bubble(role, text, steps, tagReport) {
            const wrap = node('div', `msg msg-${role === 'user' ? 'user' : role}`);

            if (role === 'user') {
                const body = node('div', 'msg-body');
                body.textContent = text;
                wrap.appendChild(body);
                log.appendChild(wrap);
                if (tagReport) attachTagRow(wrap, tagReport);
                follow();
                return { wrap };
            }

            const isError = role === 'error';
            wrap.appendChild(avatar(isError ? 'fa-triangle-exclamation' : 'fa-robot'));

            // No size class. The reading size is a property of the shell — the
            // panel and the full page want different ones — and it is declared
            // once in CSS as `--chat-fs` rather than decided here, per message,
            // where two message types could disagree about it.
            const body = node('div', 'msg-body prose-chat');
            const content = node('div');
            // An error is a message from this dashboard, not from the model, so
            // it is not markdown and must not be parsed as any.
            if (isError) content.textContent = text;
            else if (text) window.ChatRender.renderInto(content, text, { final: true });
            body.appendChild(content);

            const stepHost = node('div');
            const block = stepsBlock(steps);
            if (block) stepHost.appendChild(block);
            body.appendChild(stepHost);

            wrap.appendChild(body);
            log.appendChild(wrap);
            follow();
            return { wrap, content, stepHost };
        }

        /** The chips that were on the question, and what became of them. */
        function attachTagRow(wrap, report) {
            const items = [
                ...(report.resolved || []).map((t) => ({
                    category: t.category, value: t.value, label: t.name
                })),
                ...(report.forced || []).map((name) => ({
                    category: 'tool', value: name, label: name.replace(/_/g, ' ')
                })),
                ...(report.rejected || []).map((t) => ({
                    category: t.category, value: t.raw, label: t.raw,
                    rejected: true, why: t.why
                }))
            ];
            if (!items.length) return;
            const row = node('div', 'tag-strip');
            row.style.cssText = 'margin-top:0.35rem;justify-content:flex-end';
            window.ChatTags.renderChips(row, items);
            wrap.appendChild(row);
        }

        function typing() {
            const wrap = node('div', 'msg msg-ai');
            wrap.appendChild(avatar('fa-robot'));
            const body = node('div', 'msg-body');
            body.appendChild(liveStep('Thinking'));
            wrap.appendChild(body);
            log.appendChild(wrap);
            follow();
            return wrap;
        }

        // ---- one turn ----

        function busy(on) {
            sendBtn.hidden = on;
            if (refs.stop) refs.stop.hidden = !on;
            input.setAttribute('aria-busy', String(on));
            if (opts.onBusy) opts.onBusy(on);
        }

        /**
         * Consumes one turn's stream into one answer bubble.
         *
         * Shared by a new question and by reattaching to one already running,
         * because from here they are the same thing: a sequence of frames about
         * an answer that may already be partly written.
         */
        async function consume(res, target) {
            let answer = '';
            let steps = [];
            let pendingFrame = null;
            let outcome = { status: 'done' };

            const flush = () => {
                pendingFrame = null;
                window.ChatRender.renderInto(target.content, answer, { final: false });
                follow();
            };

            const handle = (event, data) => {
                switch (event) {
                case 'turn':
                    activeTurn = { id: data.id };
                    store.patchSession({ turnId: data.id });
                    break;
                case 'conversation':
                    // The server decides which thread this landed in — a first
                    // question has no id yet, and the answer is where the client
                    // learns the one it was given.
                    //
                    // Sent TWICE on the opening exchange, and that is not a bug
                    // to be deduplicated. The first carries the id, as early as
                    // it is known, so a reader who navigates away can be put
                    // back in the right thread. The second carries the title the
                    // model wrote from the question and its answer, which does
                    // not exist until there is an answer. Both are the same
                    // shape and the later one simply wins.
                    setConversation(data);
                    break;
                case 'tags':
                    if (target.onTags) target.onTags(data);
                    break;
                case 'step':
                    steps.push({ tool: data.tool, ok: data.ok, args: { purpose: data.label } });
                    target.stepHost.replaceChildren(liveStep(data.label));
                    announce(data.label);
                    follow();
                    break;
                case 'delta':
                    answer += data.text;
                    // Batched: one render per frame at most, not one per token.
                    if (!pendingFrame) pendingFrame = requestAnimationFrame(flush);
                    break;
                case 'done':
                    answer = data.answer || answer;
                    steps = data.steps || steps;
                    outcome = { status: 'done' };
                    break;
                case 'cancelled':
                    outcome = { status: 'cancelled' };
                    break;
                case 'failed':
                case 'error':
                    outcome = { status: 'failed', error: data.error, details: data.details };
                    break;
                default:
                    break;      // `ping` keeps proxies from closing an idle turn
                }
            };

            await readStream(res, handle);
            if (pendingFrame) cancelAnimationFrame(pendingFrame);

            // The final render is the only one that colours code.
            window.ChatRender.renderInto(target.content, answer, { final: true });
            const block = stepsBlock(steps);
            target.stepHost.replaceChildren(...(block ? [block] : []));

            if (outcome.status === 'cancelled') {
                target.stepHost.appendChild(node('div', 'assistant-live', 'Stopped.'));
            }
            announce(outcome.status === 'done' ? 'Answer complete.' : 'The answer stopped.');
            follow();
            return { ...outcome, answer, steps };
        }

        async function ask(text) {
            bubble('user', text);
            input.value = '';
            input.style.height = 'auto';
            store.patchSession({ draft: '' });
            if (tagUi) { tagUi.close(); tagUi.paintChips(); }

            const indicator = typing();
            busy(true);
            announce('Working on it.');

            let target = null;
            const openTarget = () => {
                if (target) return target;
                indicator.remove();
                target = bubble('ai', '');
                target.onTags = (report) => {
                    // Attached to the QUESTION, not to the answer: the tags were
                    // part of what was asked.
                    const question = target.wrap.previousElementSibling;
                    if (question) attachTagRow(question, report);
                };
                return target;
            };

            try {
                const res = await window.fetchWithAuth('/api/ai-chat/stream', {
                    method: 'POST',
                    body: JSON.stringify({
                        message: text,
                        conversationId,
                        tools: store.toolPreferences()
                    })
                });

                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    indicator.remove();
                    bubble('error', body.error || `The assistant could not answer (${res.status}).`);
                    return;
                }
                if (!res.body || !res.body.getReader) {
                    indicator.remove();
                    await askWithoutStreaming(text);
                    return;
                }

                const result = await consume(res, {
                    get content() { return openTarget().content; },
                    get stepHost() { return openTarget().stepHost; },
                    set onTags(fn) { openTarget().onTags = fn; },
                    get onTags() { return openTarget().onTags; }
                });

                if (result.status === 'failed') {
                    bubble('error', result.error + (result.details ? ` — ${result.details}` : ''));
                }
            } catch (err) {
                // A navigation aborts the fetch. The turn is still running on the
                // server and the next page will find it, so this is not an error
                // and must not be shown as one.
                if (err.name === 'AbortError') return;
                indicator.remove();
                if (target) target.wrap.remove();
                console.error('[CHAT]', err);
                bubble('error', 'The connection failed. Your question was not sent.');
            } finally {
                busy(false);
                activeTurn = null;
                store.patchSession({ turnId: null });
                input.focus();
            }
        }

        /** The whole answer at once — an old server, or a browser without streams. */
        async function askWithoutStreaming(text) {
            const res = await window.fetchWithAuth('/api/ai-chat', {
                method: 'POST',
                body: JSON.stringify({ message: text, conversationId, tools: store.toolPreferences() })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) bubble('ai', data.answer, data.steps, data.tags);
            else bubble('error', data.error || 'The assistant could not answer.');
        }

        /**
         * Picks up an answer that was already being written when this page
         * loaded.
         */
        async function resume(turn) {
            bubble('user', turn.question);
            const target = bubble('ai', '');
            busy(true);
            announce('Picking up where the answer had got to.');

            try {
                const res = await window.fetchWithAuth(`/api/ai-chat/turn/${turn.id}`);
                if (!res.ok || !res.body) return;
                const result = await consume(res, target);
                if (result.status === 'failed') {
                    bubble('error', result.error || 'The assistant could not answer.');
                }
                if (opts.onAnswer) opts.onAnswer();
            } catch (err) {
                if (err.name !== 'AbortError') console.warn('[CHAT] could not reattach:', err);
            } finally {
                busy(false);
                activeTurn = null;
                store.patchSession({ turnId: null });
            }
        }

        async function stop() {
            if (!activeTurn) return;
            try {
                await window.fetchWithAuth(`/api/ai-chat/turn/${activeTurn.id}/cancel`,
                    { method: 'POST' });
            } catch (err) {
                console.warn('[CHAT] could not stop the turn:', err);
            }
        }

        // ---- history and boot ----

        /**
         * Replays what this user has already asked.
         *
         * The server is the authoritative copy — per user, not per browser — so
         * this is also what makes the conversation the same on every page and on
         * every device.
         */
        async function loadHistory(conversationId) {
            try {
                const url = conversationId
                    ? `/api/chat-history?conversationId=${encodeURIComponent(conversationId)}`
                    : '/api/chat-history';
                const res = await window.fetchWithAuth(url);
                if (!res.ok) return;
                const body = await res.json();
                const history = body.messages || [];

                setConversation(body.conversation);
                log.replaceChildren();
                if (!history.length) {
                    emptyState();
                    return;
                }
                for (const msg of history) {
                    // `sql_used` keeps its column name and now holds one line per
                    // analysis. Rendered as the same disclosure a live answer
                    // gets, so history and the present look alike.
                    const steps = msg.sql_used
                        ? String(msg.sql_used).split('\n').filter(Boolean).map((line) => ({
                            tool: line.replace(/^! /, '').split(':')[0].trim(),
                            ok: !line.startsWith('! '),
                            args: { purpose: (line.split(':')[1] || '').trim() }
                        }))
                        : null;
                    bubble(msg.role === 'ai' ? 'ai' : 'user', msg.content, steps);
                }
                pinned = true;
                log.scrollTop = log.scrollHeight;
            } catch (err) {
                console.warn('[CHAT] history unavailable:', err);
            }
        }

        /**
         * What an empty conversation says.
         *
         * Named examples rather than a greeting. An open-ended box invites
         * open-ended questions, and this assistant is good at a narrow set of
         * them — showing three real ones sets the scope faster than a paragraph
         * claiming it can help with anything.
         */
        function emptyState() {
            const wrap = node('div', 'msg msg-ai');
            wrap.appendChild(avatar('fa-robot'));
            const body = node('div', 'msg-body prose-chat');
            body.appendChild(node('p', null,
                'I read this dashboard\'s own analyses — the same numbers the pages show.'));

            const list = node('div', 'tag-strip');
            list.style.marginTop = '0.5rem';
            // Real questions, not a greeting. An open box invites open questions
            // and this assistant is good at a narrow set of them, so three it
            // can actually answer set the scope faster than a paragraph
            // claiming it can help with anything. None of them shows tag syntax
            // half-typed — the placeholder says `@` and the picker does the rest.
            for (const example of [
                'Which workflows failed most this week?',
                'What is the slowest step in my busiest workflow?',
                'Has anything got worse since last month?'
            ]) {
                const btn = node('button', 'tag-chip is-suggestion', example);
                btn.type = 'button';
                btn.addEventListener('click', () => {
                    input.value = example;
                    input.focus();
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                });
                list.appendChild(btn);
            }
            body.appendChild(list);
            wrap.appendChild(body);
            log.appendChild(wrap);
        }

        /** Anything still being written for this user, from any page. */
        async function resumeInFlight() {
            try {
                const res = await window.fetchWithAuth('/api/ai-chat/turns');
                if (!res.ok) return false;
                const body = await res.json();
                // Only a RUNNING turn. A finished one has already written both
                // its rows to the history, and replaying it would show the
                // exchange twice.
                const live = (body.turns || []).find((t) => t.status === 'running');
                if (!live) return false;

                // The answer being written may belong to a different thread than
                // the one that opened — the reader asked it, navigated, and the
                // panel came back to whatever was most recent. Append it to the
                // conversation it is actually in, not to the one on screen.
                if (live.conversationId && live.conversationId !== conversationId) {
                    await loadHistory(live.conversationId);
                }
                await resume(live);
                return true;
            } catch (err) {
                console.warn('[CHAT] could not check for answers in progress:', err);
                return false;
            }
        }

        // ---- composer wiring ----

        function submit() {
            const text = input.value.trim();
            if (!text || input.getAttribute('aria-busy') === 'true') return;
            ask(text);
        }

        sendBtn.addEventListener('click', submit);
        if (refs.stop) refs.stop.addEventListener('click', stop);
        if (refs.threadButton) refs.threadButton.addEventListener('click', toggleThreads);
        if (refs.newButton) refs.newButton.addEventListener('click', newConversation);
        document.addEventListener('click', (e) => {
            if (!refs.threadMenu || refs.threadMenu.hidden) return;
            const inside = refs.threadMenu.contains(e.target) ||
                (refs.threadButton && refs.threadButton.contains(e.target));
            if (!inside) closeThreads();
        });

        input.addEventListener('keydown', (e) => {
            // The tag picker owns Enter while it is open — it completes a tag.
            // Its listener runs in the capture phase and stops this one.
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                submit();
            }
        });

        input.addEventListener('input', function () {
            this.style.height = 'auto';
            this.style.height = `${Math.min(this.scrollHeight, 128)}px`;
            store.patchSession({ draft: this.value });
            paintSendState();
        });

        /**
         * The send button's state IS the validation message.
         *
         * There is nothing useful to say about an empty box, so nothing is said:
         * the button is simply not available until there is a question in it.
         */
        function paintSendState() {
            sendBtn.disabled = !input.value.trim();
        }

        // A draft is per browser and per tab, and it is the one thing a reader
        // would have to retype.
        if (store.session.draft && !input.value) {
            input.value = store.session.draft;
            if (tagUi) tagUi.paintChips();
        }
        paintSendState();

        return {
            submit, bubble, loadHistory, resumeInFlight, stop, newConversation,
            get conversationId() { return conversationId; },
            scrollToBottom: () => { pinned = true; log.scrollTop = log.scrollHeight; },
            get busy() { return input.getAttribute('aria-busy') === 'true'; }
        };
    }

    window.ChatCore = { mount };
})();
