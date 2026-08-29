// --- SECTION 5: INFINITE SCROLL TABLE ---
window.loadMoreExecutions = async function(reset = false) {
    if (currentTab !== 'executions') return;
    if (isFetchingExecutions) return;
    isFetchingExecutions = true;

    if (reset) {
        currentOffset = 0;
        const tbody = document.getElementById('table-body') || document.getElementById('executionsTableBody');
        if (tbody) tbody.innerHTML = '';
    }

    const executions = await fetchExecutions(currentOffset, LIMIT);
    const tbody = document.getElementById('table-body') || document.getElementById('executionsTableBody');
    const trigger = document.getElementById('scroll-trigger') || document.getElementById('scrollTrigger');

    if (!tbody) {
        isFetchingExecutions = false;
        return;
    }

    if (executions.length > 0) {
        // Rows are collected as strings and appended once. `tbody.innerHTML +=`
        // per row re-serialises the entire table to a string and re-parses it
        // back into DOM nodes on every iteration — quadratic in the number of
        // rows already on screen, and infinite scroll only ever adds more. It
        // also destroys and rebuilds every existing row, which drops any state
        // the browser held on them.
        const rows = [];
        executions.forEach(exec => {
            const startStr = window.formatTime(exec.startedAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
            const endStr = window.formatTime(exec.stoppedAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
            const duration = exec.duration < 1 ? Math.round(exec.duration * 1000) + 'ms' : parseFloat(exec.duration).toFixed(3) + 's';

            const isError = exec.status !== 'success';

            const statusHtml = !isError
                ? `<span class="flex items-center gap-2 text-[#278250]"><svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path></svg> Success</span>`
                : `<span class="flex items-center gap-2 text-[#f16a75] font-bold"><svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"></path></svg> Error</span>`;

            const actionAttr = isError
                ? `data-error-exec-id="${escapeHtml(exec.exec_id)}" style="cursor: pointer;" title="View Error"`
                : '';

            // F-17: an archived workflow is hidden from the pickers but its runs
            // still appear here, because they happened. Marked so the row does
            // not read as a workflow anyone can still open.
            const archivedTag = exec.is_archived
                ? ' <span class="text-[9px] uppercase tracking-widest text-gray-600 border border-gray-700 rounded px-1 py-0.5 ml-1">archived</span>'
                : '';

            rows.push(`
                <tr class="hover:bg-gray-800/30 transition-colors text-sm border-b border-gray-800/50" ${actionAttr}>
                    <td class="p-4 text-gray-500 font-mono">#${escapeHtml(exec.exec_id)}</td>
                    <td class="p-4 text-white">${escapeHtml(exec.name)}${archivedTag}</td>
                    <td class="p-4">${statusHtml}</td>
                    <td class="p-4 text-n8n-text">${escapeHtml(startStr)}</td>
                    <td class="p-4 text-n8n-text">${escapeHtml(endStr)}</td>
                    <td class="p-4 text-n8n-text">${escapeHtml(duration)}</td>
                </tr>
            `);
        });
        // insertAdjacentHTML rather than `innerHTML +=`: it parses only the new
        // markup and leaves the rows already in the table untouched.
        tbody.insertAdjacentHTML('beforeend', rows.join(''));
        currentOffset += LIMIT;
    } else {
        if (trigger) trigger.innerHTML = "No more executions.";
    }

    isFetchingExecutions = false;
}

window.hasActiveFilters = function() {
    return ['execWorkflowFilter', 'execStatusFilter', 'execIdFilter',
        'execStartFilter', 'execEndFilter', 'execMinDurFilter']
        .some(id => {
            const el = document.getElementById(id);
            return el && el.value && el.value.trim() !== '';
        });
}

window.setupInfiniteScroll = function() {
    const trigger = document.getElementById('scrollTrigger') || document.getElementById('scroll-trigger');
    if (!trigger) return;

    const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && currentTab === 'executions' && !isFetchingExecutions) {
            loadMoreExecutions();
        }
    }, {
        root: null,
        threshold: 0.1
    });

    observer.observe(trigger);
}

window.refreshData = async function() {
    const data = await fetchMetricsData();
    if (data) {
        updateKpiCards(data.summary);
        updateLineChart(data.hourlyData);
        if (data.topWorkflows) {
            updateDoughnutChart(data.topWorkflows);
            populateDropdown(data.topWorkflows);
            lastTopWorkflows = data.topWorkflows; // cache for exec filter
        }
    }

    // Fetch Concurrency
    const dateInput = document.getElementById('trafficDate');
    fetchConcurrency(dateInput ? dateInput.value : null);
}

window.fetchConcurrency = async function(dateVal) {
    const params = new URLSearchParams();

    if (dateVal) {
        // Construct Local 00:00:00 to 23:59:59 times
        const start = new Date(dateVal + 'T00:00:00');
        const end = new Date(dateVal + 'T23:59:59.999');
        params.append('start', start.toISOString());
        params.append('end', end.toISOString());
    }
    // Carried through to the drill-down as well, in fetchConcurrencyDetails —
    // a bar and the list behind it have to be counting the same rows.
    if (window.currentMode && window.currentMode()) params.append('mode', window.currentMode());

    const qs = params.toString();
    const url = '/api/analytics/execution-volume' + (qs ? `?${qs}` : '');

    const concRes = await fetchWithAuth(url);
    if (concRes.ok) {
        const concData = await concRes.json();
        updateConcurrencyChart(concData);
    }
}

window.initDateFilter = async function() {
    const rangeStart = document.getElementById('rangeStart');
    const rangeEnd = document.getElementById('rangeEnd');

    try {
        const res = await fetchWithAuth('/api/analytics/first-execution-date');
        let firstDateIso = '';
        if (res.ok) {
            const data = await res.json();
            if (data.firstDate) {
                firstDateIso = data.firstDate.substring(0, 10);
                if (rangeStart) rangeStart.min = firstDateIso;
                if (rangeEnd) rangeEnd.min = firstDateIso;
            }
        }

        // Max is always today
        const todayLocal = new Date();
        const offset = todayLocal.getTimezoneOffset() * 60000;
        const localISOTime = (new Date(todayLocal.getTime() - offset)).toISOString().split('T')[0];
        if (rangeStart) rangeStart.max = localISOTime;
        if (rangeEnd) rangeEnd.max = localISOTime;

        // Custom Range Listeners -> Clear highlights on manual change
        [rangeStart, rangeEnd].forEach(el => {
            el?.addEventListener('change', () => {
                window.lastPresetHours = null;
                refreshData();
            });
        });

        // Concurrency chart listeners
        const trafficDate = document.getElementById('trafficDate');
        const intervalSelect = document.getElementById('concurrencyInterval');
        if (trafficDate) {
            trafficDate.min = firstDateIso;
            trafficDate.max = localISOTime;
            trafficDate.addEventListener('change', (e) => {
                // Clear the sub-preset highlight
                const btn = document.getElementById('btnConc24h');
                if (btn) {
                    btn.classList.replace('bg-indigo-600/20', 'bg-gray-800/40');
                    btn.classList.replace('text-indigo-400', 'text-gray-400');
                }
                fetchConcurrency(e.target.value);
            });
        }
        if (intervalSelect) {
            intervalSelect.addEventListener('change', () => {
                // Interval just re-filters the cached lastRawConcurrency
                updateConcurrencyChart(lastRawConcurrency);
            });
        }

        // Set Default 7d Macro
        applyPreset(168);

    } catch (e) {
        console.error("Date Filter Init failed:", e);
    }
}

;(async () => {
    await initSettings();
    
    // Only run dashboard-specific logic if the core elements exist
    if (!initDashboard()) {
        console.log("[INIT] Non-dashboard page detected. Skipping chart initialization.");
        return;
    }

    initCharts();
    setupInfiniteScroll();
    await initDateFilter();
    initExecutionsHeader(); // Initialize filters on boot

    // 'change', not the click dispatcher: at click time a <select> still holds
    // its previous value, so a dispatched handler would filter by whatever was
    // selected before.
    const wfFilter = document.getElementById('workflowFilter');
    if (wfFilter) wfFilter.addEventListener('change', refreshData);

    const modeFilter = document.getElementById('modeFilter');
    if (modeFilter) modeFilter.addEventListener('change', refreshData);
})();

