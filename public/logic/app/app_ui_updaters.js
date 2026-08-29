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

    // Update Trend Badges
    const trendTotalEl = document.getElementById('trendTotal');
    const trendErrorEl = document.getElementById('trendError');

    if (trendTotalEl && summary.trend_total_pct !== undefined) {
        const pct = parseFloat(summary.trend_total_pct);
        trendTotalEl.classList.remove('hidden', 'bg-green-900/30', 'text-green-400', 'bg-red-900/30', 'text-red-400', 'bg-gray-800', 'text-gray-400');
        if (pct > 0) {
            trendTotalEl.classList.add('bg-green-900/30', 'text-green-400');
            trendTotalEl.innerText = `+${pct.toFixed(1)}%`;
        } else if (pct < 0) {
            trendTotalEl.classList.add('bg-red-900/30', 'text-red-400');
            trendTotalEl.innerText = `${pct.toFixed(1)}%`;
        } else {
            trendTotalEl.classList.add('bg-gray-800', 'text-gray-400');
            trendTotalEl.innerText = `0%`;
        }
    }

    if (trendErrorEl && summary.trend_error_pct !== undefined) {
        const pct = parseFloat(summary.trend_error_pct);
        trendErrorEl.classList.remove('hidden', 'bg-green-900/30', 'text-green-400', 'bg-red-900/30', 'text-red-400', 'bg-gray-800', 'text-gray-400');
        if (pct < 0) {
            // Negative error trend is GOOD (Green)
            trendErrorEl.classList.add('bg-green-900/30', 'text-green-400');
            trendErrorEl.innerText = `${pct.toFixed(1)}%`;
        } else if (pct > 0) {
            // Positive error trend is BAD (Red)
            trendErrorEl.classList.add('bg-red-900/30', 'text-red-400');
            trendErrorEl.innerText = `+${pct.toFixed(1)}%`;
        } else {
            trendErrorEl.classList.add('bg-gray-800', 'text-gray-400');
            trendErrorEl.innerText = `0%`;
        }
    }
}

window.updateLineChart = function(chartData) {
    if (!chartData || chartData.length === 0) return;

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

window.updateActiveFilterStyles = function() {
    const btn24h = document.getElementById('btn24h');
    const btn48h = document.getElementById('btn48h');
    const btn7d = document.getElementById('btn7d');
    const customContainer = document.getElementById('customRangeContainer');

    // Remove all states
    [btn24h, btn48h, btn7d, customContainer].forEach(el => {
        el?.classList.remove('filter-active-glow', 'filter-loading-pulse');
    });

    // Apply solid glow to active
    if (window.lastPresetHours === 24) btn24h?.classList.add('filter-active-glow');
    else if (window.lastPresetHours === 48) btn48h?.classList.add('filter-active-glow');
    else if (window.lastPresetHours === 168) btn7d?.classList.add('filter-active-glow');
    else {
        // If no preset, custom container is active
        customContainer?.classList.add('filter-active-glow');
    }
}

window.updateDoughnutChart = function(workflows) {
    if (!workflows || workflows.length === 0) return;

    let cumulativePercentage = 0;
    const labels = [];
    const dataValues = [];
    let restCount = 0;

    workflows.forEach(wf => {
        const pct = parseFloat(wf.percentage);
        const count = parseInt(wf.execution_count);

        if (cumulativePercentage < 90) {
            labels.push(wf.workflow_name);
            dataValues.push(count);
            cumulativePercentage += pct;
        } else {
            restCount += count;
        }
    });

    if (restCount > 0) {
        labels.push('Rest Workflows');
        dataValues.push(restCount);
    }

    window.doughnutChart.data.labels = labels;
    window.doughnutChart.data.datasets[0].data = dataValues;

    const colors = ['#ff6f5c', '#00c07f', '#ff9f43', '#00b8d9', '#6554c0', '#f16a75'];
    const backgroundColors = labels.map((label, index) => label === 'Rest Workflows' ? '#374151' : colors[index % colors.length]);

    window.doughnutChart.data.datasets[0].backgroundColor = backgroundColors;
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
    window.concurrencyChart.update();
    document.getElementById('concurrencySk')?.classList.add('done');
}

window.fetchConcurrencyDetails = async function(timestamp, windowSize = 5) {
    const modal = document.getElementById('detailsModal');
    const tbody = document.getElementById('detailsTableBody');
    const subtitle = document.getElementById('detailsModalSubtitle');

    if (!modal) return;

    tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-gray-500 italic">Fetching executions starting at ${escapeHtml(timestamp)}...</td></tr>`;

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
            tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-gray-500 italic">No executions found precisely at this 5m interval.</td></tr>`;
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
            <tr class="hover:bg-gray-800/30 transition-colors border-b border-gray-800/50">
                <td class="p-4 text-white font-semibold text-sm truncate max-w-[200px]">${escapeHtml(exec.workflow_name)}</td>
                <td class="p-4"><span class="${statusColor} text-[10px] font-bold uppercase tracking-tight"><i class="fa-solid ${statusIcon} mr-1"></i> ${escapeHtml(exec.status)}</span></td>
                <td class="p-4 text-gray-400 text-xs">${escapeHtml(timeString)}</td>
                <td class="p-4 text-gray-500 text-[10px] font-mono">${escapeHtml(durationStr)}</td>
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
    thead.innerHTML = `
        <tr class="text-gray-400 text-xs uppercase tracking-widest border-b border-gray-800/50">
            <th class="px-4 pt-3 pb-1 font-medium text-gray-600">#</th>
            <th class="px-4 pt-3 pb-1 font-medium">Workflow</th>
            <th class="px-4 pt-3 pb-1 font-medium">Status</th>
            <th class="px-4 pt-3 pb-1 font-medium">Started</th>
            <th class="px-4 pt-3 pb-1 font-medium">Ended</th>
            <th class="px-4 pt-3 pb-1 font-medium">Run Time</th>
            <th class="px-4 pt-3 pb-1 font-medium"></th>
        </tr>
        <tr class="bg-black/20 border-b border-gray-800/50">
            <td class="px-3 py-3">
                <input type="number" id="execIdFilter" min="1" placeholder="ID…"
                    class="bg-black/40 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-indigo-500 w-16 text-center" />
            </td>
            <td class="px-3 py-3">
                <select id="execWorkflowFilter"
                    class="bg-black/40 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-indigo-500 w-full max-w-[180px] cursor-pointer">
                    <option value="">All Workflows</option>
                </select>
            </td>
            <td class="px-3 py-3">
                <select id="execStatusFilter"
                    class="bg-black/40 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-indigo-500 w-full cursor-pointer">
                    <option value="">Any Status</option>
                    <option value="success">Success</option>
                    <option value="error">Error</option>
                    <option value="canceled">Canceled</option>
                    <option value="crashed">Crashed</option>
                </select>
            </td>
            <td class="px-3 py-3">
                <input type="text" id="execStartFilter" placeholder="DD/MM/YYYY HH:mm"
                    class="bg-black/40 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-indigo-500 font-mono w-36" />
            </td>
            <td class="px-3 py-3">
                <input type="text" id="execEndFilter" placeholder="DD/MM/YYYY HH:mm"
                    class="bg-black/40 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-indigo-500 font-mono w-36" />
            </td>
            <td class="px-3 py-3">
                <div class="flex items-center gap-1">
                    <span class="text-gray-600 text-[10px]">&gt;</span>
                    <input type="number" id="execMinDurFilter" min="0" step="0.1" placeholder="—"
                        class="bg-black/40 border border-gray-700 rounded px-1.5 py-1 text-xs text-gray-300 focus:outline-none focus:border-indigo-500 w-12 text-center" />
                    <span class="text-gray-600 text-[10px]">s</span>
                </div>
            </td>
            <td class="px-3 py-3">
                <div class="flex flex-col items-center gap-1">
                    <button data-action="applyExecFilters" title="Apply filters"
                        class="w-[26px] h-[22px] text-[9px] bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-600/50 hover:border-indigo-400/60 active:bg-indigo-600/70 transition-colors rounded flex items-center justify-center">
                        <i class="fa-solid fa-check"></i>
                    </button>
                    <button data-action="clearExecFilters" title="Clear all filters"
                        class="w-[26px] h-[22px] text-[9px] bg-gray-700/20 border border-gray-600/30 text-gray-400 hover:bg-n8n-primary/20 hover:border-n8n-primary/40 hover:text-n8n-primary active:bg-n8n-primary/30 active:border-n8n-primary/60 transition-colors rounded flex items-center justify-center">
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

