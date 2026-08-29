/**
 * Shared Surgical Error Snapshot Modal Component
 * Injects modal HTML and provides global logic.
 */

(function () {
    // 1. Inject CSS for scale transition if not present
    if (!document.getElementById('error-modal-styles')) {
        const style = document.createElement('style');
        style.id = 'error-modal-styles';
        style.textContent = `
            #errorModal.flex { display: flex !important; }
            #errorModal .scale-95 { transform: scale(0.95); }
            #errorModal .scale-100 { transform: scale(1.00); }
        `;
        document.head.appendChild(style);
    }

    // 2. Inject HTML
    const modalHTML = `
    <div id="errorModal" class="fixed inset-0 bg-black/90 backdrop-blur-md z-[9999] hidden items-center justify-center p-4">
        <div class="bg-n8n-card border border-gray-700 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl scale-95 transition-transform duration-300" id="modalContainer">
            <div class="p-6 border-b border-gray-800 flex justify-between items-center bg-black/20">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 bg-red-900/40 rounded-lg flex items-center justify-center border border-red-500/30">
                        <i class="fa-solid fa-triangle-exclamation text-red-400"></i>
                    </div>
                    <div>
                        <h3 class="text-lg font-bold text-white">Surgical Error Snapshot</h3>
                        <p class="text-[10px] text-gray-500 uppercase tracking-widest" id="modalTimestamp">Post-Mortem Analysis</p>
                    </div>
                </div>
                <button data-action="closeErrorModal" class="text-gray-500 hover:text-white transition-colors p-2">
                    <i class="fa-solid fa-xmark text-xl"></i>
                </button>
            </div>
            <div class="p-8">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                    <div>
                        <label class="block text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1">Failing Node</label>
                        <div id="modalNodeName" class="text-white font-semibold text-sm bg-black/30 p-3 rounded border border-gray-800">--</div>
                    </div>
                    <div>
                        <label class="block text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1">Execution ID</label>
                        <div id="modalExecId" class="text-gray-400 font-mono text-sm bg-black/30 p-3 rounded border border-gray-800">--</div>
                    </div>
                </div>

                <label class="block text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1">Error Description</label>
                <div class="relative group">
                    <div id="modalErrorMessage" class="bg-red-900/10 p-4 pr-12 rounded-lg border border-red-500/20 text-red-400 font-mono text-xs leading-relaxed mb-8 max-h-64 overflow-y-auto whitespace-pre-wrap">
                        Loading...
                    </div>
                    <!-- Refined Square Copy Button -->
                    <button data-action="copyErrorMessage" 
                        class="absolute top-3 right-3 w-8 h-8 flex items-center justify-center text-white/40 hover:text-white transition-all bg-black/60 hover:bg-indigo-600 rounded-md border border-white/10 z-20 shadow-lg"
                        title="Copy Error Content">
                        <i id="copyIcon" class="fa-regular fa-copy text-xs"></i>
                    </button>
                </div>

                <!-- F-12 · where this execution spent its time. Filled from
                     /api/executions/:id/trace, which returns counts and
                     durations only — never payload. Hidden until it answers, so
                     an execution whose trace n8n has pruned shows nothing
                     rather than an empty box. -->
                <div id="modalTrace" class="hidden mb-8">
                    <div class="flex items-baseline justify-between mb-2">
                        <label class="block text-[10px] text-gray-500 uppercase font-bold tracking-widest">Where the time went</label>
                        <span id="modalTraceSummary" class="text-[10px] text-gray-600"></span>
                    </div>
                    <div id="modalTraceBody" class="bg-black/30 rounded-lg border border-gray-800 divide-y divide-gray-800/60 max-h-64 overflow-y-auto"></div>
                    <div id="modalTraceFlow" class="mt-2 text-[10px] text-gray-500 leading-relaxed"></div>
                </div>

                <div class="flex flex-col sm:flex-row justify-between items-center gap-4">
                    <p class="text-[11px] text-gray-500 italic"><i class="fa-solid fa-lightbulb text-indigo-400 mr-1"></i> Snapshot captured via n8n Error Workflow</p>
                    <div class="flex gap-3">
                        <button id="deepDiveBtn" class="bg-gray-800 hover:bg-gray-700 text-white px-5 py-2.5 rounded-lg text-sm font-semibold transition-all flex items-center gap-2">
                            <i class="fa-solid fa-magnifying-glass-plus text-xs"></i> Fetch Raw Trace
                        </button>
                        <a id="n8nLink" href="#" target="_blank" class="bg-[#ff6f5c] hover:bg-opacity-90 text-white px-5 py-2.5 rounded-lg text-sm font-bold transition-all flex items-center gap-2">
                            Open n8n <i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>
                        </a>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    // 3. Logic
    window.showErrorSnapshot = async function (execId) {
        const modal = document.getElementById('errorModal');
        const container = document.getElementById('modalContainer');
        const msgBox = document.getElementById('modalErrorMessage');
        const idBox = document.getElementById('modalExecId');
        const nodeBox = document.getElementById('modalNodeName');
        const timestampBox = document.getElementById('modalTimestamp');
        const n8nLink = document.getElementById('n8nLink');
        const deepDiveBtn = document.getElementById('deepDiveBtn');

        if (!modal) return;

        // Dashboard specific cleanup if functions exist globally
        if (typeof window.closeDetailsModal === 'function') {
            window.closeDetailsModal();
        }

        // Reset UI
        idBox.innerText = execId;
        nodeBox.innerText = '--';
        msgBox.innerText = 'Loading snapshot...';
        timestampBox.innerText = 'Analyzing trace...';
        if (n8nLink) n8nLink.style.display = 'none';
        const trace = document.getElementById('modalTrace');
        if (trace) trace.classList.add('hidden');

        deepDiveBtn.onclick = () => window.fetchDetailedError(execId);

        // Show Modal
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        document.body.style.overflow = 'hidden'; 
        
        setTimeout(() => {
            container.classList.remove('scale-95');
            container.classList.add('scale-100');
        }, 10);

        // Fired alongside the snapshot rather than after it: they are two
        // different queries against two different things, and the node timeline
        // arriving late must not hold up the message someone opened this for.
        loadExecutionTrace(execId);

        try {
            const response = await fetchWithAuth(`/api/execution-error/${execId}`);
            const data = await response.json();

            // A 404 here is either a pruned payload or an execution outside this
            // user's projects — the server answers both the same way on purpose.
            // Rendering it as "Unknown Node" made a refusal look like a parsing
            // failure and sent people looking for a bug in the trace.
            if (!response.ok) {
                nodeBox.innerText = '--';
                msgBox.innerText = data.error || 'This execution is not available.';
                timestampBox.innerText = '';
                return;
            }

            nodeBox.innerText = data.nodeName || 'Unknown Node';
            msgBox.innerText = data.message || 'Snapshot unavailable. Try fetching the raw trace.';
            
            if (data.timestamp) {
                timestampBox.innerText = window.formatTime(data.timestamp);
            } else {
                timestampBox.innerText = 'Post-Mortem Analysis';
            }

            if (n8nLink && data.workflowId && data.n8nBaseUrl) {
                // Build through the URL API so a hostile id cannot break out of the
                // path, and reject anything that is not http(s) — an href is one of
                // the few places a javascript: scheme still executes.
                try {
                    const target = new URL(
                        `workflow/${encodeURIComponent(data.workflowId)}/executions/${encodeURIComponent(execId)}`,
                        data.n8nBaseUrl.endsWith('/') ? data.n8nBaseUrl : data.n8nBaseUrl + '/'
                    );
                    if (target.protocol === 'http:' || target.protocol === 'https:') {
                        n8nLink.href = target.href;
                        n8nLink.style.display = 'flex';
                    }
                } catch (e) {
                    console.warn('[MODAL] Could not build n8n link:', e);
                }
            }
        } catch (err) {
            msgBox.innerText = 'No instant snapshot found. Use "Fetch Raw Trace" for a deep inspection.';
            timestampBox.innerText = 'Trace Empty';
        }
    };

    /**
     * F-12 · The node-by-node breakdown of one execution.
     *
     * Silent on failure by design. This is extra context beside an error
     * message someone is already reading; a red box saying the trace could not
     * be fetched would compete with the thing they came for.
     */
    async function loadExecutionTrace(execId) {
        const panel = document.getElementById('modalTrace');
        const body = document.getElementById('modalTraceBody');
        const summary = document.getElementById('modalTraceSummary');
        const flow = document.getElementById('modalTraceFlow');
        if (!panel || !body) return;

        const esc = window.escapeHtml || ((v) => String(v));
        const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);

        try {
            const res = await fetchWithAuth(`/api/executions/${execId}/trace`);
            if (!res.ok) return;
            const t = await res.json();
            if (t.unreadable || !t.has_run_data || !t.nodes.length) return;

            const max = Math.max(...t.nodes.map((n) => n.ms), 1);

            body.innerHTML = t.nodes.map((n) => {
                const pct = Math.max(1, Math.round((n.ms / max) * 100));
                const bad = n.failed_runs > 0;
                return `
                <div class="px-3 py-2">
                    <div class="flex items-center justify-between gap-3 mb-1">
                        <span class="text-xs ${bad ? 'text-rose-300' : 'text-gray-200'} truncate">
                            ${esc(n.name)}${n.runs > 1
        ? `<span class="ml-2 text-[10px] text-amber-300">${n.runs}\u00d7</span>` : ''}${
    n.is_sub_node ? '<span class="ml-2 text-[9px] uppercase tracking-widest text-purple-300">sub</span>' : ''}
                        </span>
                        <span class="text-[11px] font-mono ${bad ? 'text-rose-300' : 'text-gray-400'} shrink-0">
                            ${ms(n.ms)}${n.items_out === null ? '' : ` \u00b7 ${n.items_out} items`}
                        </span>
                    </div>
                    <div class="h-1 rounded bg-gray-800 overflow-hidden">
                        <div class="h-full ${bad ? 'bg-rose-500' : 'bg-cyan-500/70'}" style="width:${pct}%"></div>
                    </div>
                </div>`;
            }).join('');

            if (summary) {
                const parts = [`${t.node_count} nodes`, `${ms(t.total_node_ms)} of node time`];
                // Over 1 means branches ran at the same time. Shown as a fact
                // rather than hidden, because it is the reason the numbers below
                // can add up to more than the execution took.
                if (t.overlap_ratio && t.overlap_ratio > 1.05) {
                    parts.push(`${t.overlap_ratio}\u00d7 the wall clock \u2014 branches ran in parallel`);
                }
                summary.textContent = parts.join(' \u00b7 ');
            }

            const notes = [];

            // A node can fail inside an execution the database calls successful.
            // Every error rate in this dashboard is computed from that status,
            // so this is the only place such a failure is visible at all.
            if (t.failed_nodes > 0 && t.status !== 'error' && t.status !== 'crashed') {
                notes.push(`<span class="text-amber-300"><i class="fa-solid fa-triangle-exclamation mr-1"></i>` +
                    `${t.failed_nodes} node(s) failed inside an execution recorded as ` +
                    `${esc(t.status)} \u2014 no error rate counts this.</span>`);
            }
            if (t.error && t.error.item_index !== null) {
                notes.push(`Failed on item <strong class="text-gray-300">#${t.error.item_index}</strong> of the batch.`);
            }
            if (t.error && t.error.chain && t.error.chain.length > 1) {
                notes.push('Caused by: ' + t.error.chain.slice(1)
                    .map((c) => esc(c.message || c.name || '?')).join(' \u2190 '));
            }
            const changed = (t.flow || []).filter((e) => e.lost !== 0);
            if (changed.length) {
                notes.push('Item count changed: ' + changed.slice(0, 3).map((e) =>
                    `${esc(e.from)} \u2192 ${esc(e.to)} (${e.items_in}\u2192${e.items_out})`).join(', '));
            }
            if (flow) flow.innerHTML = notes.join('<br>');

            panel.classList.remove('hidden');
        } catch (err) {
            console.warn('[MODAL] trace unavailable:', err);
        }
    }

    // Alias for backward compatibility
    window.showError = window.showErrorSnapshot;

    window.fetchDetailedError = async function (execId) {
        const msgBox = document.getElementById('modalErrorMessage');
        msgBox.innerText = 'Fetching raw JSON dump from Postgres... (This may take a moment)';

        try {
            const response = await fetchWithAuth(`/api/execution-error/${execId}?full=true`);
            const data = await response.json();
            msgBox.innerText = data.fullError || data.message || 'Full trace unavailable.';
        } catch (e) {
            msgBox.innerText = 'Error fetching raw trace from production database.';
        }
    };

    window.closeErrorModal = function () {
        const modal = document.getElementById('errorModal');
        const container = document.getElementById('modalContainer');
        if (modal) {
            container.classList.add('scale-95');
            container.classList.remove('scale-100');
            setTimeout(() => {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
                document.body.style.overflow = 'auto';
            }, 300);
            
            // Reset copy icon
            const icon = document.getElementById('copyIcon');
            if (icon) icon.className = 'fa-regular fa-copy';
        }
    };

    window.copyErrorMessage = async function () {
        const msg = document.getElementById('modalErrorMessage')?.innerText;
        const icon = document.getElementById('copyIcon');
        if (!msg || msg === 'Loading...' || msg === 'Analyzing trace...') return;

        try {
            await navigator.clipboard.writeText(msg);
            if (icon) {
                icon.className = 'fa-solid fa-check text-green-400';
                setTimeout(() => {
                    icon.className = 'fa-regular fa-copy';
                }, 2000);
            }
        } catch (err) {
            console.error('Failed to copy text: ', err);
        }
    };

    // Global click listener for backdrop
    window.addEventListener('click', (event) => {
        const modal = document.getElementById('errorModal');
        if (modal && event.target === modal) {
            window.closeErrorModal();
        }
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
