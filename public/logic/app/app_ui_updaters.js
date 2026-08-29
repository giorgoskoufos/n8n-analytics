// --- SECTION 4: UI UPDATERS ---
window.updateKpiCards = function(summary) {
    if (!summary) return;
    const total = parseInt(summary.total) || 0;
    const errors = parseInt(summary.error) || 0;
    const errorRate = total > 0 ? ((errors / total) * 100).toFixed(1) : 0;
    const avgTime = parseFloat(summary.avg_duration || 0).toFixed(2);

    const elTotal = document.getElementById('kpi-total') || document.getElementById('totalExecutions');
    const elFailed = document.getElementById('kpi-failed') || document.getElementById('errorCount');
    const elRate = document.getElementById('kpi-error-rate');
    const elTime = document.getElementById('kpi-time') || document.getElementById('avgDuration');

    if (elTotal) elTotal.innerText = total.toLocaleString();
    if (elFailed) elFailed.innerText = errors.toLocaleString();
    if (elRate) elRate.innerText = errorRate + '%';
    if (elTime) elTime.innerText = avgTime + 's';
    ['kpiSk1', 'kpiSk2', 'kpiSk3'].forEach(id => document.getElementById(id)?.classList.add('done'));

    // Trend badges, through the shared component.
    //
    // These were two near-identical blocks that each added and removed six
    // Tailwind classes by hand, and they disagreed about the same thing in
    // opposite directions on purpose: executions falling is bad, errors falling
    // is good. That polarity is the only real difference between them, so it is
    // the only thing stated here — `goodWhenDown` — and the colours come from
    // the status tokens rather than from twelve class names typed twice.
    const paintTrend = (elId, pct, opts) => {
        const el = document.getElementById(elId);
        if (!el || pct === undefined) return;
        const html = window.UI.trend(parseFloat(pct).toFixed(1), opts);
        el.classList.toggle('hidden', !html);
        el.innerHTML = html;
    };

    paintTrend('trendTotal', summary.trend_total_pct, {
        title: 'Compared with the preceding period of the same length'
    });
    paintTrend('trendError', summary.trend_error_pct, {
        goodWhenDown: true,
        title: 'Compared with the preceding period of the same length'
    });
}

window.updateLineChart = function(chartData) {
    // An empty response and a quiet period are different facts, and the chart
    // used to render them identically — by returning early and leaving whatever
    // was on the canvas, or on first load an empty grid that reads as measured
    // zero. It now says which one it is.
    if (!chartData || chartData.length === 0) {
        window.Viz.setEmpty(window.lineChart, false, 'No executions in this range',
            'Nothing ran between these dates — this is an absence, not a count of zero.');
        window.lineChart?.update();
        document.getElementById('lineChartSk')?.classList.add('done');
        return;
    }
    window.Viz.setEmpty(window.lineChart, true);

    const labels = [];
    const successData = [];
    const errorData = [];

    chartData.forEach(row => {
        labels.push(row.time_val);
        successData.push(parseInt(row.success_count) || 0);
        errorData.push(parseInt(row.error_count) || 0);
    });

    // Dynamic X-Axis Formatting based on range duration
    const first = new Date(labels[0]);
    const last = new Date(labels[labels.length - 1]);
    const durationDays = (last - first) / 86400000;

    window.lineChart.options.scales.x.ticks.maxTicksLimit = 8;
    window.lineChart.options.scales.x.ticks.callback = function (value, index, values) {
        // Through formatTime like every other timestamp: these labels are UTC
        // bucket boundaries, and reading them in the browser's zone put the axis
        // out of step with the table underneath it.
        const label = this.getLabelForValue(value);
        return durationDays > 2.1
            ? window.formatTime(label, { month: 'short', day: 'numeric' })
            : window.formatTime(label, { hour: '2-digit', minute: '2-digit' });
    };

    window.lineChart.data.labels = labels;
    window.lineChart.data.datasets[0].data = successData;
    window.lineChart.data.datasets[1].data = errorData;
    window.lineChart.update();

    updateActiveFilterStyles();
    document.getElementById('lineChartSk')?.classList.add('done');
}

/**
 * Marks which time range is in force.
 *
 * The selected preset used to be a `.filter-active-glow` class — a green wash
 * that said nothing to assistive technology, so a screen-reader user could not
 * tell which of the three ranges the numbers on the page described. The state
 * lives on `aria-pressed` now and the CSS reads it, so there is one fact rather
 * than a visual claim and an invisible one that can drift apart.
 */
window.updateActiveFilterStyles = function() {
    const byPreset = { 24: 'btn24h', 48: 'btn48h', 168: 'btn7d' };
    const activeId = byPreset[window.lastPresetHours];

    Object.values(byPreset).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.setAttribute('aria-pressed', String(id === activeId));
    });

    // No preset means the custom range is what is in force.
    const custom = document.getElementById('customRangeContainer');
    if (custom) custom.classList.toggle('filter-active-glow', !activeId);
}

/**
 * Top workflows.
 *
 * Two things were wrong here and they are the same thing twice.
 *
 * The palette was six literal hexes indexed by ROW POSITION
 * (`colors[index % colors.length]`), so the colour a workflow got depended on
 * how it happened to rank in the current filter. Change the date range, and the
 * workflow that was coral is now green — while the reader is still holding
 * "coral is the invoice sync" in their head. Colour has to follow the entity,
 * and `Viz.colorFor` keys it on the workflow name for exactly that reason.
 *
 * And `% colors.length` meant a seventh workflow silently reused the first
 * colour. Two slices, identical hue, no indication. The tail folds into "Other"
 * now — past eight slots no palette can keep the pairs apart under
 * colour-vision deficiency, so generating a ninth colour is not a smaller
 * problem than admitting the cap.
 */
window.updateDoughnutChart = function(workflows) {
    if (!workflows || workflows.length === 0) {
        window.Viz.setEmpty(window.doughnutChart, false, 'No workflows ran',
            'No execution in this range belongs to a workflow that still exists.');
        window.doughnutChart?.update();
        document.getElementById('doughnutSk')?.classList.add('done');
        return;
    }
    window.Viz.setEmpty(window.doughnutChart, true);

    const MAX_SLICES = 8;
    let cumulativePercentage = 0;
    const labels = [];
    const dataValues = [];
    let restCount = 0;
    let restWorkflows = 0;

    workflows.forEach(wf => {
        const pct = parseFloat(wf.percentage);
        const count = parseInt(wf.execution_count);

        if (cumulativePercentage < 90 && labels.length < MAX_SLICES) {
            labels.push(wf.workflow_name);
            dataValues.push(count);
            cumulativePercentage += pct;
        } else {
            restCount += count;
            restWorkflows += 1;
        }
    });

    const REST = restWorkflows === 1 ? 'Other (1 workflow)' : `Other (${restWorkflows} workflows)`;
    if (restCount > 0) {
        labels.push(REST);
        dataValues.push(restCount);
    }

    window.doughnutChart.data.labels = labels;
    window.doughnutChart.data.datasets[0].data = dataValues;
    window.doughnutChart.data.datasets[0].backgroundColor = labels.map(label =>
        label === REST ? window.Viz.tokens().surface3 : window.Viz.colorFor('workflow', label)
    );
    window.doughnutChart.update();
    document.getElementById('doughnutSk')?.classList.add('done');
}

window.updateConcurrencyChart = function(data) {
    if (!data || !window.concurrencyChart) return;

    // 1. Cache the raw data for re-filtering
    lastRawConcurrency = data;

    // 2. Get current interval preference
    const intervalMins = parseInt(document.getElementById('concurrencyInterval')?.value) || 5;

    const now = new Date();
    const intervalMs = intervalMins * 60000;

    let processedLabels = [];
    let processedData = [];

    if (intervalMins === 5) {
        data.forEach(d => {
            const bucketStart = new Date(d.timestamp);
            if (bucketStart.getTime() + intervalMs <= now.getTime()) {
                processedLabels.push(d.timestamp);
                processedData.push(d.started_count);
            }
        });
    } else {
        // Aggregate 5m points into 10m or 30m blocks using SUM (Volume)
        const pointsPerBlock = intervalMins / 5;
        for (let i = 0; i < data.length; i += pointsPerBlock) {
            const block = data.slice(i, i + pointsPerBlock);
            if (block.length === 0) continue;

            const bucketStart = new Date(block[0].timestamp);
            // Hide if the entire block hasn't passed yet
            if (bucketStart.getTime() + intervalMs <= now.getTime()) {
                const sum = block.reduce((acc, b) => acc + (parseInt(b.started_count) || 0), 0);
                processedLabels.push(block[0].timestamp);
                processedData.push(sum);
            }
        }
    }

    window.concurrencyChart.data.labels = processedLabels;
    window.concurrencyChart.data.datasets[0].data = processedData;

    // F-24 §1, the axis bug.
    //
    // The item is explicit that the ask is NOT "a smaller max" — that crops the
    // peak, which is lying in the other direction. It is that the rule must not
    // be hidden by the exception. So: clamp the axis to the 98th percentile so
    // the body of the distribution uses the full height, mark every column that
    // was clipped with a caret, and print how many there are and how high the
    // real peak goes. A well-behaved series gets no clamp and no caveat — the
    // helper returns `max: null` and the axis simply fits.
    const clamp = window.Viz.clampMax(processedData);
    window.concurrencyChart.options.scales.y.max = clamp.max ?? undefined;
    window.concurrencyChart.options.plugins.outlierMarks = clamp.max
        ? { max: clamp.max, clipped: clamp.clipped, peak: clamp.peak, unit: 'count' }
        : { max: null };

    window.Viz.setEmpty(window.concurrencyChart, processedData.length > 0,
        'No executions started here',
        'No run began in this window. A flat line at zero would be a measurement; this is not one.');

    window.concurrencyChart.update();
    document.getElementById('concurrencySk')?.classList.add('done');

    // The table-view twin — every value reachable without hovering the right
    // pixel, which is both the accessibility requirement and the fastest way to
    // answer "what exactly was that spike".
    const host = document.getElementById('concurrencyTable');
    if (host) {
        host.innerHTML = window.Viz.tableFor(window.concurrencyChart, {
            unit: 'count',
            axisLabel: 'Bucket start',
            labelFormat: { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
        });
    }
}

window.fetchConcurrencyDetails = async function(timestamp, windowSize = 5) {
    const modal = document.getElementById('detailsModal');
    const tbody = document.getElementById('detailsTableBody');
    const subtitle = document.getElementById('detailsModalSubtitle');

    if (!modal) return;

    tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-ink-3 italic">Fetching executions starting at ${escapeHtml(timestamp)}...</td></tr>`;

    // Display range in subtitle
    const startDate = new Date(timestamp);
    const endDate = new Date(startDate.getTime() + windowSize * 60000);
    const startStr = window.formatTime(startDate.toISOString(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    const endStr = window.formatTime(endDate.toISOString(), { hour: '2-digit', minute: '2-digit', hour12: false });

    subtitle.innerText = `${startStr} - ${endStr} (${windowSize}min)`;

    document.body.style.overflow = 'hidden'; // Lock background
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    setTimeout(() => document.getElementById('detailsModalContainer').classList.remove('scale-95'), 10);

    try {
        const modeParam = window.currentMode && window.currentMode()
            ? `&mode=${encodeURIComponent(window.currentMode())}` : '';
        const response = await fetchWithAuth(`/api/analytics/execution-volume/details?time=${encodeURIComponent(timestamp)}&window=${windowSize}${modeParam}`);
        const data = await response.json();

        if (data.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-ink-3 italic">No executions found precisely at this 5m interval.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(exec => {
            const isError = exec.status !== 'success';
            const statusColor = isError ? 'text-red-400' : (exec.status === 'running' ? 'text-blue-400 animate-pulse' : 'text-green-400');
            const statusIcon = isError ? 'fa-xmark' : (exec.status === 'running' ? 'fa-spinner fa-spin' : 'fa-check');

            const timeString = window.formatTime(exec.startedAt, { hour: '2-digit', minute: '2-digit' });

            const durationSec = parseFloat(exec.current_duration);
            const durationStr = durationSec < 60 ? `${Math.round(durationSec)}s` : `${Math.round(durationSec / 60)}m`;

            let actionBtn = '';
            if (isError) {
                actionBtn = `
                    <button data-error-exec-id="${escapeHtml(exec.exec_id)}" class="text-red-500 hover:text-red-400 transition-colors" title="View Error Log">
                        <i class="fa-solid fa-arrow-right"></i>
                    </button>
                `;
            } else if (exec.n8nBaseUrl && exec.workflow_id) {
                const link = `${exec.n8nBaseUrl}/workflow/${encodeURIComponent(exec.workflow_id)}/executions/${encodeURIComponent(exec.exec_id)}`;
                actionBtn = `
                    <a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" class="text-indigo-400 hover:text-indigo-300 transition-colors" title="Open Execution in n8n">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i>
                    </a>
                `;
            }

            return `
            <tr class="hover:bg-gray-800/30 transition-colors border-b border-line/50">
                <td class="p-4 text-white font-semibold text-sm truncate max-w-[200px]">${escapeHtml(exec.workflow_name)}</td>
                <td class="p-4"><span class="${statusColor} text-[10px] font-bold uppercase tracking-tight"><i class="fa-solid ${statusIcon} mr-1"></i> ${escapeHtml(exec.status)}</span></td>
                <td class="p-4 text-ink-2 text-xs">${escapeHtml(timeString)}</td>
                <td class="p-4 text-ink-3 text-[10px] font-mono">${escapeHtml(durationStr)}</td>
                <td class="p-4 text-right">
                    ${actionBtn}
                </td>
            </tr>
            `;
        }).join('');

    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-red-500 italic">Error fetching concurrency details.</td></tr>`;
    }
}

window.closeDetailsModal = function() {
    const modal = document.getElementById('detailsModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
        document.getElementById('detailsModalContainer').classList.add('scale-95');
        document.body.style.overflow = 'auto'; // Unlock
    }
}

/**
 * The workflows a picker should offer (F-17).
 *
 * Archived ones are dropped unless the toggle is on. Their executions still
 * count everywhere else — the charts and totals are built from the same rows
 * they always were — but offering a workflow that was retired weeks ago as a
 * filter is offering an empty result.
 *
 * A workflow already selected is never removed from its own dropdown, or
 * toggling archived off while filtering by an archived workflow would silently
 * reset the page to "All Workflows" while the chart underneath still showed one.
 */
window.visibleWorkflows = function(workflows, keepName) {
    if (!workflows) return [];
    return workflows.filter(wf =>
        window.showArchived || !wf.is_archived || wf.workflow_name === keepName);
}

function fillWorkflowSelect(select, workflows, limit) {
    if (!select) return;
    const selected = select.value;
    const list = window.visibleWorkflows(workflows, selected);
    while (select.options.length > 1) select.remove(1);
    (limit ? list.slice(0, limit) : list).forEach(wf => {
        const option = document.createElement('option');
        option.value = wf.workflow_name;
        // Marked rather than hidden when it is the current selection, so the
        // reason the list is short is visible in the list itself.
        option.innerText = wf.is_archived ? `${wf.workflow_name} (archived)` : wf.workflow_name;
        select.appendChild(option);
    });
    // Restore the selection if it survived the rebuild.
    if (selected && [...select.options].some(o => o.value === selected)) select.value = selected;
}

window.populateDropdown = function(workflows) {
    // Rebuilt on every refresh rather than only when empty. It used to be filled
    // once, from whatever the first window happened to return, and never again —
    // so changing the date range left a picker describing a range that was no
    // longer on screen.
    fillWorkflowSelect(document.getElementById('workflowFilter'), workflows, 15);
    populateExecWorkflowDropdown(workflows);
}

window.populateExecWorkflowDropdown = function(workflows) {
    // Always rebuild — select is recreated each time the tab renders
    fillWorkflowSelect(document.getElementById('execWorkflowFilter'), workflows, null);
}

window.clearExecFilters = function() {
    ['execWorkflowFilter', 'execStatusFilter', 'execIdFilter',
        'execStartFilter', 'execEndFilter', 'execMinDurFilter'
    ].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    loadMoreExecutions(true);
}

// --- Date helpers for free-text timestamp inputs ---

// Parse "DD/MM/YYYY HH:mm" → Date, returns null if invalid or empty
window.parseExecDate = function(str) {
    if (!str || !str.trim()) return null;
    const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const dt = new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]), parseInt(m[4]), parseInt(m[5]));
    return isNaN(dt.getTime()) ? null : dt;
}

// Format Date → "DD/MM/YYYY HH:mm"
window.formatExecDate = function(d) {
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Apply button handler — the ONLY way to trigger a filtered reload
window.applyExecFilters = function() {
    loadMoreExecutions(true);
}

// Builds the two-row executions thead (headers + filter row) and wires events.
// Called on first page load AND every time the executions tab is activated.
window.initExecutionsHeader = function() {
    const thead = document.getElementById('tableHeader') || document.getElementById('table-head');
    if (!thead) return;

    // One control style, from the token layer, instead of a 180-character
    // Tailwind class string re-typed at every input (F-24 §7). The filter row
    // was rendering as a run of mismatched boxes and two stacked 22px buttons
    // for exactly this reason: nothing here had ever been decided in one place.
    const CTL = 'width:100%;background:var(--surface-0);border:1px solid var(--line);' +
        'border-radius:var(--r-sm);padding:.3rem .5rem;font-size:11px;color:var(--ink-1)';

    thead.innerHTML = `
        <tr>
            <th style="width:90px">#</th>
            <th>Workflow</th>
            <th style="width:130px">Status</th>
            <th style="width:170px">Started</th>
            <th style="width:170px">Ended</th>
            <th class="num" style="width:120px">Run time</th>
            <th style="width:86px"></th>
        </tr>
        <tr class="filter-row">
            <td><input type="number" id="execIdFilter" min="1" placeholder="ID…" aria-label="Filter by execution id" style="${CTL}"></td>
            <td>
                <select id="execWorkflowFilter" aria-label="Filter by workflow" style="${CTL}">
                    <option value="">All workflows</option>
                </select>
            </td>
            <td>
                <select id="execStatusFilter" aria-label="Filter by status" style="${CTL}">
                    <option value="">Any status</option>
                    <option value="success">Success</option>
                    <option value="error">Error</option>
                    <option value="canceled">Canceled</option>
                    <option value="crashed">Crashed</option>
                </select>
            </td>
            <td><input type="text" id="execStartFilter" placeholder="DD/MM/YYYY HH:mm"
                       aria-label="Started after" class="mono" style="${CTL}"></td>
            <td><input type="text" id="execEndFilter" placeholder="DD/MM/YYYY HH:mm"
                       aria-label="Ended before" class="mono" style="${CTL}"></td>
            <td>
                <div class="flex items-center gap-1.5">
                    <span class="label shrink-0">&gt;</span>
                    <input type="number" id="execMinDurFilter" min="0" step="0.1" placeholder="—"
                           aria-label="Minimum run time in seconds" style="${CTL};text-align:right">
                    <span class="label shrink-0">s</span>
                </div>
            </td>
            <td>
                <!-- Side by side, not stacked. Two 22px-tall buttons in a
                     vertical stack were both below the minimum comfortable hit
                     target and unreadable as a pair. -->
                <div class="flex items-center gap-1.5">
                    <button data-action="applyExecFilters" title="Apply filters" aria-label="Apply filters"
                            class="btn btn-sm" style="padding:0 .45rem">
                        <i class="fa-solid fa-check"></i>
                    </button>
                    <button data-action="clearExecFilters" title="Clear all filters" aria-label="Clear all filters"
                            class="btn btn-sm" style="padding:0 .45rem">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </td>
        </tr>
    `;
    // Populate workflow dropdown from cache
    populateExecWorkflowDropdown(lastTopWorkflows);
    // Auto-fill end = start + 10 min when start is typed and end is still empty
    const startEl = document.getElementById('execStartFilter');
    const endEl = document.getElementById('execEndFilter');
    if (startEl && endEl) {
        startEl.addEventListener('change', () => {
            const d = parseExecDate(startEl.value);
            if (d && !endEl.value.trim()) {
                endEl.value = formatExecDate(new Date(d.getTime() + 10 * 60 * 1000));
            }
        });
    }
    // Enter key on any filter input/select fires Apply
    thead.querySelectorAll('input, select').forEach(el => {
        el.addEventListener('keydown', e => { if (e.key === 'Enter') applyExecFilters(); });
        if (el.tagName === 'SELECT') {
            el.addEventListener('change', applyExecFilters);
        }
    });
}



window.addEventListener('click', (event) => {
    const detailsModal = document.getElementById('detailsModal');
    if (detailsModal && event.target === detailsModal) {
        closeDetailsModal();
    }
});

