/**
 * error-modal.js — the execution snapshot, and the trace panel it used to own.
 *
 * Three F-24 items land in this file, and two of them are the same mistake made
 * twice: a thing that belonged to one place was written into another.
 *
 *   §5 · The copy button overlapped the scrollbar. `#modalErrorMessage` scrolls
 *        (`overflow-y-auto`) and the button was positioned `top-3 right-3` over
 *        it, so it sat on the scrollbar track. `pr-12` made room for the text,
 *        not for the bar. Moving it out of the scroll region's optical space
 *        entirely — up into the label row, which does not scroll — is the fix;
 *        an offset large enough to clear a scrollbar is a guess about a width
 *        that differs per platform.
 *
 *   §3 · An HTML error response was shown as `<!DOCTYPE html>…`. F-07 already
 *        collapses these to `<HTML: {title}>` for the FINGERPRINT, which is why
 *        grouping works; nothing ever changed what was displayed. Rendering is
 *        `UI.errorMessage`, shared with the errors page so both surfaces show
 *        the same thing.
 *
 *   §5 · "Where the time went" now works standalone, so the Slowest tab can
 *        open it. `renderTrace` takes a container; the modal is one caller of
 *        it and `openTrace` is another.
 */

(function () {
    // 1. Injected styles for the scale transition.
    if (!document.getElementById('error-modal-styles')) {
        const style = document.createElement('style');
        style.id = 'error-modal-styles';
        style.textContent = `
            #errorModal.flex, #traceModal.flex { display: flex !important; }
            #errorModal .scale-95, #traceModal .scale-95 { transform: scale(0.95); }
            #errorModal .scale-100, #traceModal .scale-100 { transform: scale(1.00); }
        `;
        document.head.appendChild(style);
    }

    // The raw text behind whatever is currently rendered in the message box.
    // The box may now hold structured markup (a parsed HTML error), so "copy"
    // cannot read it back out of the DOM the way it used to.
    let currentRawMessage = '';

    // 2. Markup.
    const modalHTML = `
    <div id="errorModal" class="fixed inset-0 z-[9999] hidden items-center justify-center p-4"
         style="background:rgba(0,0,0,.85);backdrop-filter:blur(6px)" role="dialog" aria-modal="true"
         aria-labelledby="errorModalTitle">
        <div class="card w-full max-w-2xl overflow-hidden shadow-2xl scale-95 transition-transform duration-300" id="modalContainer">
            <div class="card-head">
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-lg flex items-center justify-center"
                         style="background:color-mix(in srgb, var(--critical-mark) 20%, transparent);border:1px solid color-mix(in srgb, var(--critical-mark) 38%, transparent)">
                        <i class="fa-solid fa-triangle-exclamation" style="color:var(--critical-ink)"></i>
                    </div>
                    <div>
                        <h3 id="errorModalTitle" class="text-base font-bold" style="color:var(--ink-1)">Execution snapshot</h3>
                        <p class="label" id="modalTimestamp">Post-mortem analysis</p>
                    </div>
                </div>
                <button data-action="closeErrorModal" class="btn btn-sm" aria-label="Close">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <div class="p-4 sm:p-6 max-h-[75dvh] overflow-y-auto custom-scrollbar">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                    <div>
                        <p class="label mb-1">Failing node</p>
                        <div id="modalNodeName" class="text-[13px] font-semibold p-2.5 rounded"
                             style="color:var(--ink-1);background:var(--surface-0);border:1px solid var(--line)">--</div>
                    </div>
                    <div>
                        <p class="label mb-1">Execution ID</p>
                        <div id="modalExecId" class="mono p-2.5 rounded"
                             style="color:var(--ink-2);background:var(--surface-0);border:1px solid var(--line)">--</div>
                    </div>
                </div>

                <!--
                  The label row owns the copy button. It is outside the scroll
                  region, so there is no scrollbar for it to sit on and no
                  padding guess to maintain.
                -->
                <div class="flex items-center justify-between mb-1.5">
                    <p class="label">Error description</p>
                    <button data-action="copyErrorMessage" class="btn btn-sm" title="Copy the raw error text">
                        <i id="copyIcon" class="fa-regular fa-copy"></i> Copy
                    </button>
                </div>
                <div id="modalErrorMessage" class="p-3.5 rounded-lg text-xs leading-relaxed mb-6 max-h-72 overflow-y-auto custom-scrollbar"
                     style="background:color-mix(in srgb, var(--critical-mark) 8%, transparent);border:1px solid color-mix(in srgb, var(--critical-mark) 22%, transparent)">
                    Loading…
                </div>

                <!-- F-12 · where this execution spent its time. Filled from
                     /api/executions/:id/trace, which returns counts and
                     durations only — never payload. Hidden until it answers, so
                     an execution whose trace n8n has pruned shows nothing
                     rather than an empty box. -->
                <div id="modalTrace" class="hidden mb-6"></div>

                <div class="flex flex-col sm:flex-row justify-between items-center gap-3">
                    <p class="text-[11px]" style="color:var(--ink-3)">
                        <i class="fa-solid fa-lightbulb mr-1" style="color:var(--warning-ink)"></i>
                        Snapshot captured via the n8n error workflow
                    </p>
                    <div class="flex gap-2">
                        <button id="deepDiveBtn" class="btn btn-sm">
                            <i class="fa-solid fa-magnifying-glass-plus"></i> Fetch raw trace
                        </button>
                        <a id="n8nLink" href="#" target="_blank" rel="noopener" class="btn btn-sm btn-primary">
                            Open in n8n <i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>
                        </a>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!--
      The trace on its own. F-24 §5 asks for "Where the time went" on the
      Slowest tab, where there is no error to wrap it in — only time.
    -->
    <div id="traceModal" class="fixed inset-0 z-[9999] hidden items-center justify-center p-4"
         style="background:rgba(0,0,0,.85);backdrop-filter:blur(6px)" role="dialog" aria-modal="true"
         aria-labelledby="traceModalTitle">
        <div class="card w-full max-w-2xl overflow-hidden shadow-2xl scale-95 transition-transform duration-300" id="traceModalContainer">
            <div class="card-head">
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-lg flex items-center justify-center"
                         style="background:var(--brand-dim);border:1px solid color-mix(in srgb, var(--brand) 32%, transparent)">
                        <i class="fa-solid fa-stopwatch" style="color:var(--brand)"></i>
                    </div>
                    <div>
                        <h3 id="traceModalTitle" class="text-base font-bold" style="color:var(--ink-1)">Where the time went</h3>
                        <p class="label" id="traceModalSubtitle">—</p>
                    </div>
                </div>
                <button data-action="closeTraceModal" class="btn btn-sm" aria-label="Close">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="p-6 max-h-[75vh] overflow-y-auto custom-scrollbar">
                <div id="traceModalBody"></div>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    // ─────────────────────────────────────────────────────────────────────

    function setMessage(raw) {
        currentRawMessage = String(raw ?? '');
        const box = document.getElementById('modalErrorMessage');
        if (!box) return;
        // Through the shared renderer so the modal and the errors page agree
        // about what an HTML error body looks like. It escapes everything it
        // interpolates; the parsed document is inert and never re-inserted.
        box.innerHTML = window.UI
            ? window.UI.errorMessage(currentRawMessage)
            : `<pre class="mono whitespace-pre-wrap">${window.escapeHtml(currentRawMessage)}</pre>`;
    }

    function setPlain(text) {
        currentRawMessage = String(text ?? '');
        const box = document.getElementById('modalErrorMessage');
        if (box) box.textContent = currentRawMessage;
    }

    window.showErrorSnapshot = async function (execId) {
        const modal = document.getElementById('errorModal');
        const container = document.getElementById('modalContainer');
        const idBox = document.getElementById('modalExecId');
        const nodeBox = document.getElementById('modalNodeName');
        const timestampBox = document.getElementById('modalTimestamp');
        const n8nLink = document.getElementById('n8nLink');
        const deepDiveBtn = document.getElementById('deepDiveBtn');

        if (!modal) return;

        if (typeof window.closeDetailsModal === 'function') window.closeDetailsModal();

        idBox.textContent = execId;
        nodeBox.textContent = '--';
        setPlain('Loading snapshot…');
        timestampBox.textContent = 'Analysing trace…';
        if (n8nLink) n8nLink.style.display = 'none';
        const trace = document.getElementById('modalTrace');
        if (trace) { trace.classList.add('hidden'); trace.innerHTML = ''; }

        deepDiveBtn.onclick = () => window.fetchDetailedError(execId);

        openModal(modal, container);

        // Fired alongside the snapshot rather than after it: they are two
        // different queries against two different things, and the node timeline
        // arriving late must not hold up the message someone opened this for.
        renderTrace(trace, execId);

        try {
            const response = await fetchWithAuth(`/api/execution-error/${execId}`);
            const data = await response.json();

            // A 404 here is either a pruned payload or an execution outside this
            // user's projects — the server answers both the same way on purpose.
            // Rendering it as "Unknown Node" made a refusal look like a parsing
            // failure and sent people looking for a bug in the trace.
            if (!response.ok) {
                nodeBox.textContent = '--';
                setPlain(data.error || 'This execution is not available.');
                timestampBox.textContent = '';
                return;
            }

            nodeBox.textContent = data.nodeName || 'Unknown node';
            setMessage(data.message || 'Snapshot unavailable. Try fetching the raw trace.');
            timestampBox.textContent = data.timestamp
                ? window.formatTime(data.timestamp)
                : 'Post-mortem analysis';

            if (n8nLink && data.workflowId && data.n8nBaseUrl) {
                // Built through the URL API so a hostile id cannot break out of
                // the path, and rejected unless it is http(s) — an href is one
                // of the few places a javascript: scheme still executes.
                try {
                    const target = new URL(
                        `workflow/${encodeURIComponent(data.workflowId)}/executions/${encodeURIComponent(execId)}`,
                        data.n8nBaseUrl.endsWith('/') ? data.n8nBaseUrl : data.n8nBaseUrl + '/'
                    );
                    if (target.protocol === 'http:' || target.protocol === 'https:') {
                        n8nLink.href = target.href;
                        n8nLink.style.display = 'inline-flex';
                    }
                } catch (e) {
                    console.warn('[MODAL] Could not build n8n link:', e);
                }
            }
        } catch (err) {
            setPlain('No instant snapshot found. Use "Fetch raw trace" for a deep inspection.');
            timestampBox.textContent = 'Trace empty';
        }
    };

    /**
     * F-12 · The node-by-node breakdown of one execution, into any container.
     *
     * Silent on failure by design when it is decoration beside an error message
     * someone is already reading. `opts.loud` turns that off for the standalone
     * panel, where the trace is the entire reason the dialog is open and
     * rendering nothing would leave an empty box with no explanation.
     */
    async function renderTrace(panel, execId, opts = {}) {
        if (!panel) return false;
        const esc = window.escapeHtml || ((v) => String(v));
        const ms = (n) => (window.Viz ? window.Viz.unit('ms').fmt(n) : `${Math.round(n)} ms`);

        if (opts.loud) panel.innerHTML = window.UI ? window.UI.loading() : 'Loading…';

        try {
            const res = await fetchWithAuth(`/api/executions/${execId}/trace`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const t = await res.json();

            if (t.unreadable || !t.has_run_data || !t.nodes.length) {
                if (opts.loud) {
                    panel.innerHTML = window.UI
                        ? window.UI.empty('No timeline for this run',
                            'n8n keeps per-node timings only while it keeps the execution data. This run has been pruned, or it never stored any.',
                            'fa-stopwatch')
                        : '';
                    panel.style.position = 'relative';
                    panel.style.minHeight = '180px';
                    panel.classList.remove('hidden');
                }
                return false;
            }

            const max = Math.max(...t.nodes.map((n) => n.ms), 1);

            const rows = t.nodes.map((n) => {
                const pct = Math.max(1, Math.round((n.ms / max) * 100));
                const bad = n.failed_runs > 0;
                const ink = bad ? 'var(--critical-ink)' : 'var(--ink-1)';
                return `
                <div class="px-3 py-2" style="border-bottom:1px solid var(--line)">
                    <div class="flex items-center justify-between gap-3 mb-1.5">
                        <span class="text-xs truncate" style="color:${ink}">
                            ${esc(n.name)}${n.runs > 1
        ? `<span class="ml-2 text-[10px]" style="color:var(--warning-ink)">${n.runs}×</span>` : ''}${
    n.is_sub_node ? '<span class="ml-2 badge badge-neutral">sub</span>' : ''}
                        </span>
                        <span class="mono shrink-0" style="color:${bad ? 'var(--critical-ink)' : 'var(--ink-3)'}">
                            ${esc(ms(n.ms))}${n.items_out === null ? '' : ` · ${n.items_out} items`}
                        </span>
                    </div>
                    <div class="h-1 rounded overflow-hidden" style="background:var(--surface-3)">
                        <div class="h-full" style="width:${pct}%;background:${bad ? 'var(--critical-mark)' : 'var(--series-1)'}"></div>
                    </div>
                </div>`;
            }).join('');

            const summaryParts = [`${t.node_count} nodes`, `${ms(t.total_node_ms)} of node time`];
            // Over 1 means branches ran at the same time. Shown as a fact rather
            // than hidden, because it is the reason the numbers below can add up
            // to more than the execution took.
            if (t.overlap_ratio && t.overlap_ratio > 1.05) {
                summaryParts.push(`${t.overlap_ratio}× the wall clock — branches ran in parallel`);
            }

            const notes = [];
            // A node can fail inside an execution the database calls successful.
            // Every error rate in this dashboard is computed from that status,
            // so this is the only place such a failure is visible at all.
            if (t.failed_nodes > 0 && t.status !== 'error' && t.status !== 'crashed') {
                notes.push(`<span style="color:var(--warning-ink)"><i class="fa-solid fa-triangle-exclamation mr-1"></i>` +
                    `${t.failed_nodes} node(s) failed inside an execution recorded as ` +
                    `${esc(t.status)} — no error rate counts this.</span>`);
            }
            if (t.error && t.error.item_index !== null) {
                notes.push(`Failed on item <strong style="color:var(--ink-1)">#${t.error.item_index}</strong> of the batch.`);
            }
            if (t.error && t.error.chain && t.error.chain.length > 1) {
                notes.push('Caused by: ' + t.error.chain.slice(1)
                    .map((c) => esc(c.message || c.name || '?')).join(' ← '));
            }
            const changed = (t.flow || []).filter((e) => e.lost !== 0);
            if (changed.length) {
                notes.push('Item count changed: ' + changed.slice(0, 3).map((e) =>
                    `${esc(e.from)} → ${esc(e.to)} (${e.items_in}→${e.items_out})`).join(', '));
            }

            panel.innerHTML = `
                <div class="flex items-baseline justify-between mb-2 gap-3">
                    <p class="label">Where the time went</p>
                    <span class="text-[10px] text-right" style="color:var(--ink-3)">${esc(summaryParts.join(' · '))}</span>
                </div>
                <div class="rounded-lg overflow-hidden max-h-72 overflow-y-auto custom-scrollbar"
                     style="background:var(--surface-0);border:1px solid var(--line)">${rows}</div>
                ${notes.length ? `<div class="mt-2 text-[10px] leading-relaxed" style="color:var(--ink-3)">${notes.join('<br>')}</div>` : ''}`;
            panel.classList.remove('hidden');
            return true;
        } catch (err) {
            if (opts.loud) {
                panel.innerHTML = window.UI ? window.UI.failed('The trace endpoint did not answer.') : '';
                panel.style.position = 'relative';
                panel.style.minHeight = '180px';
                panel.classList.remove('hidden');
            } else {
                console.warn('[MODAL] trace unavailable:', err);
            }
            return false;
        }
    }

    window.renderExecutionTrace = renderTrace;

    /**
     * The standalone trace panel — the Slowest tab's entry point.
     *
     * `data-arg` carries `execId` or `execId:label`, because the tab knows
     * which workflow the run belongs to and the dialog does not.
     */
    window.openTrace = function (arg) {
        const [execId, ...rest] = String(arg).split(':');
        if (!execId) return;
        const modal = document.getElementById('traceModal');
        const container = document.getElementById('traceModalContainer');
        const subtitle = document.getElementById('traceModalSubtitle');
        const body = document.getElementById('traceModalBody');
        if (!modal || !body) return;

        subtitle.textContent = rest.length
            ? `${rest.join(':')} · execution ${execId}`
            : `Execution ${execId}`;
        body.innerHTML = '';
        openModal(modal, container);
        renderTrace(body, execId, { loud: true });
    };

    window.closeTraceModal = function () {
        closeModal(document.getElementById('traceModal'), document.getElementById('traceModalContainer'));
    };

    // Alias for backward compatibility
    window.showError = window.showErrorSnapshot;

    window.fetchDetailedError = async function (execId) {
        setPlain('Fetching the raw JSON dump from Postgres… (this may take a moment)');
        try {
            const response = await fetchWithAuth(`/api/execution-error/${execId}?full=true`);
            const data = await response.json();
            setMessage(data.fullError || data.message || 'Full trace unavailable.');
        } catch (e) {
            setPlain('Error fetching the raw trace from the production database.');
        }
    };

    // ─────────────────────────────────────────────────────────────────────

    function openModal(modal, container) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        document.body.style.overflow = 'hidden';
        setTimeout(() => {
            container.classList.remove('scale-95');
            container.classList.add('scale-100');
        }, 10);
    }

    function closeModal(modal, container) {
        if (!modal) return;
        container.classList.add('scale-95');
        container.classList.remove('scale-100');
        setTimeout(() => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            // Only release the page if nothing else is still open — closing the
            // trace over an error snapshot used to unlock scrolling underneath a
            // dialog that was still up.
            if (!document.querySelector('#errorModal.flex, #traceModal.flex, #detailsModal.flex')) {
                document.body.style.overflow = 'auto';
            }
        }, 300);
    }

    window.closeErrorModal = function () {
        closeModal(document.getElementById('errorModal'), document.getElementById('modalContainer'));
        const icon = document.getElementById('copyIcon');
        if (icon) icon.className = 'fa-regular fa-copy';
        // Back to the row they opened this from (F-24 §7).
        window.UI?.scroll.restore('index', document.getElementById('appMain'));
    };

    window.copyErrorMessage = async function () {
        const icon = document.getElementById('copyIcon');
        // The raw text, not what is rendered. A parsed HTML error shows its
        // title and body text; the thing worth pasting into a ticket is the
        // response that produced them.
        if (!currentRawMessage || /^(Loading|Analysing|Fetching)/.test(currentRawMessage)) return;

        try {
            await navigator.clipboard.writeText(currentRawMessage);
            if (icon) {
                icon.className = 'fa-solid fa-check';
                icon.style.color = 'var(--good-ink)';
                setTimeout(() => { icon.className = 'fa-regular fa-copy'; icon.style.color = ''; }, 2000);
            }
        } catch (err) {
            console.error('Failed to copy text:', err);
        }
    };

    // Backdrop click, and Escape.
    window.addEventListener('click', (event) => {
        if (event.target === document.getElementById('errorModal')) window.closeErrorModal();
        if (event.target === document.getElementById('traceModal')) window.closeTraceModal();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (document.getElementById('traceModal')?.classList.contains('flex')) window.closeTraceModal();
        else if (document.getElementById('errorModal')?.classList.contains('flex')) window.closeErrorModal();
    });

    // Delegated handler for every "open the error snapshot" affordance.
    // Rows and buttons carry data-error-exec-id instead of an inline onclick, so
    // execution ids never get concatenated into executable markup and the page
    // does not depend on script-src 'unsafe-inline'.
    document.addEventListener('click', (event) => {
        const trigger = event.target.closest('[data-error-exec-id]');
        if (!trigger) return;
        event.preventDefault();
        window.showErrorSnapshot(trigger.getAttribute('data-error-exec-id'));
    });
})();
