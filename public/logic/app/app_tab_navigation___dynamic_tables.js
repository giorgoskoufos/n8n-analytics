// --- SECTION 7: TAB NAVIGATION & DYNAMIC TABLES ---
//
// F-17: archived workflows keep their history in these aggregates — it is real
// and it happened — but nothing else on the page says they are retired, and
// "why is a dead workflow in my slowest list" is a question worth answering in
// the row itself.
const archivedBadge = (isArchived) => isArchived
    ? ' ' + window.UI.badge('archived', { tone: 'neutral', title: 'This workflow is archived in n8n. Its history still counts here.' })
    : '';

window.switchTab = async function(tabName) {
    if (currentTab === tabName) return;
    currentTab = tabName;

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
    });

    const activeBtn = document.querySelector(`[data-action="switchTab"][data-arg="${tabName}"]`);
    if (activeBtn) {
        activeBtn.classList.add('active');
        activeBtn.setAttribute('aria-selected', 'true');
    }

    const thead = document.getElementById('tableHeader') || document.getElementById('table-head');
    const tbody = document.getElementById('executionsTableBody') || document.getElementById('table-body');
    const scrollTrigger = document.getElementById('scrollTrigger') || document.getElementById('scroll-trigger');

    // Loading is its own state, and it is a row inside the table rather than a
    // grey word where the data will be — so the header stays put and the panel
    // does not collapse and re-expand on every tab change.
    const cols = thead?.querySelectorAll('th').length || 6;
    if (tbody) tbody.innerHTML = window.UI.rowState(cols, window.UI.loading());

    if (tabName === 'executions') {
        initExecutionsHeader(); // rebuild filter row + wire events
        if (scrollTrigger) {
            scrollTrigger.style.display = 'block';
            scrollTrigger.innerHTML = '';
        }
        loadMoreExecutions(true);

    } else if (tabName === 'slowest') {
        if (thead) thead.innerHTML = `
            <tr>
                <th>Workflow</th>
                <th class="num">Avg run time (7d)</th>
                <th class="num">Slowest run</th>
                <th class="num">Total runs (7d)</th>
                <th class="num">Timeline</th>
            </tr>`;
        if (scrollTrigger) scrollTrigger.style.display = 'none';

        try {
            const res = await fetchWithAuth('/api/analytics/slowest');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            if (!tbody) return;
            if (!data.length) {
                tbody.innerHTML = window.UI.rowState(5, window.UI.empty(
                    'No completed runs in the last 7 days',
                    'Nothing finished in this window, so there is no duration to rank.', 'fa-stopwatch'));
                return;
            }

            const ms = window.Viz.unit('ms');
            tbody.innerHTML = data.map(row => {
                const avgMs = parseFloat(row.avg_duration) * 1000;
                const maxMs = parseFloat(row.max_duration) * 1000;

                // F-24 §5 · "Where the time went" belongs here too.
                //
                // A slow execution has no error to show — only time — which is
                // exactly what the trace panel renders. The endpoint (F-12) and
                // the renderer both already existed; what was missing was an
                // execution id on this tab, and now the row carries its own
                // worst run.
                const traceBtn = row.slowest_exec_id
                    ? `<button class="btn btn-sm" data-action="openTrace"
                               data-arg="${escapeHtml(row.slowest_exec_id)}:${escapeHtml(row.name)}"
                               title="Node-by-node timings for the slowest run">
                           <i class="fa-solid fa-stopwatch"></i> Trace
                       </button>`
                    : '<span class="label">—</span>';

                // An average made of consistently slow runs and one dragged up
                // by a single outlier are different problems with different
                // fixes, and the average alone cannot tell them apart.
                const skewed = maxMs > avgMs * 3
                    ? ' ' + window.UI.badge('outlier', {
                        tone: 'warning',
                        title: `The slowest run is ${(maxMs / avgMs).toFixed(1)}× the average — this workflow is usually faster than its average suggests.`
                    })
                    : '';

                return `
                    <tr class="row-link">
                        <td style="color:var(--ink-1);font-weight:600">${escapeHtml(row.name)}${archivedBadge(row.is_archived)}</td>
                        <td class="num">${escapeHtml(ms.fmt(avgMs))}</td>
                        <td class="num">${escapeHtml(ms.fmt(maxMs))}${skewed}</td>
                        <td class="num">${parseInt(row.total_runs).toLocaleString()}</td>
                        <td class="num">${traceBtn}</td>
                    </tr>`;
            }).join('');
        } catch (err) {
            console.error('[TABS] slowest:', err);
            if (tbody) tbody.innerHTML = window.UI.rowState(5, window.UI.failed());
        }

    } else if (tabName === 'errors') {
        if (thead) thead.innerHTML = `
            <tr>
                <th>Workflow</th>
                <th class="num">Errors (7d)</th>
                <th class="num">Total runs (7d)</th>
                <th class="num">Error rate</th>
            </tr>`;
        if (scrollTrigger) scrollTrigger.style.display = 'none';

        try {
            const res = await fetchWithAuth('/api/analytics/errors');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            if (!tbody) return;
            if (!data.length) {
                tbody.innerHTML = window.UI.rowState(4, window.UI.empty(
                    'No workflow failed in the last 7 days',
                    'This is a measured zero — every run in the window succeeded.', 'fa-circle-check'));
                return;
            }

            tbody.innerHTML = data.map(row => {
                const errCount = parseInt(row.error_count);
                const totalRuns = parseInt(row.total_runs);
                const rate = (errCount / totalRuns) * 100;
                // Rate is a status, not a series: the colour means "this is
                // bad", so it comes from the status tokens and always sits
                // beside the number rather than replacing it.
                const tone = rate >= 10 ? 'critical' : rate >= 2 ? 'warning' : 'neutral';
                return `
                    <tr class="row-link">
                        <td style="color:var(--ink-1);font-weight:600">${escapeHtml(row.name)}${archivedBadge(row.is_archived)}</td>
                        <td class="num" style="color:var(--critical-ink)">${errCount.toLocaleString()}</td>
                        <td class="num">${totalRuns.toLocaleString()}</td>
                        <td class="num">${window.UI.badge(window.Viz.unit('percent').fmt(rate), { tone })}</td>
                    </tr>`;
            }).join('');
        } catch (err) {
            console.error('[TABS] errors:', err);
            if (tbody) tbody.innerHTML = window.UI.rowState(4, window.UI.failed());
        }
    }
}
