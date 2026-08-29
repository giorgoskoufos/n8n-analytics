// --- SECTION 3: DATA FETCHING ---
window.applyPreset = (hours) => {
    const todayLocal = new Date();
    const startLocal = new Date(todayLocal.getTime() - (hours * 3600000));

    const toLocalISO = (date) => {
        const offset = date.getTimezoneOffset() * 60000;
        return new Date(date.getTime() - offset).toISOString().split('T')[0];
    };

    const startVal = toLocalISO(startLocal);
    const endVal = toLocalISO(todayLocal);

    const elStart = document.getElementById('rangeStart');
    const elEnd = document.getElementById('rangeEnd');

    if (elStart && elEnd) {
        elStart.value = startVal;
        elEnd.value = endVal;
        window.lastPresetHours = hours;
        refreshData();
    }
};

window.setConcPreset = (hours) => {
    const trafficDate = document.getElementById('trafficDate');
    if (trafficDate) trafficDate.value = ''; // Clear date for rolling window

    // UI Feedback
    const btn = document.getElementById('btnConc24h');
    if (btn) {
        btn.classList.add('bg-indigo-600/20', 'text-indigo-400');
        btn.classList.remove('bg-gray-800/40', 'text-gray-400');
    }

    fetchConcurrency(null); // Fetch rolling 24h
};

/**
 * The trigger-type filter (F-02).
 *
 * Read from one place because it has to reach three endpoints — the KPI row, the
 * executions table and the volume chart. The volume chart in particular: if the
 * bars were filtered and the drill-down behind them was not, clicking a bar of
 * height 12 would open a list of 30, which is exactly the bug L-30 fixed.
 */
window.currentMode = () => document.getElementById('modeFilter')?.value || '';

window.toggleArchived = function () {
    window.showArchived = !window.showArchived;
    const btn = document.getElementById('archivedToggle');
    if (btn) {
        btn.classList.toggle('text-indigo-300', window.showArchived);
        btn.classList.toggle('text-gray-600', !window.showArchived);
        btn.title = window.showArchived ? 'Hide archived workflows' : 'Show archived workflows';
    }
    populateDropdown(window.lastTopWorkflows);
};

window.fetchMetricsData = async function() {
    const wfFilter = document.getElementById('workflowFilter')?.value || '';
    const rangeStart = document.getElementById('rangeStart')?.value || '';
    const rangeEnd = document.getElementById('rangeEnd')?.value || '';

    // Selective Pulse: Only blink the one we are actually loading
    let targetId = 'customRangeContainer';
    if (window.lastPresetHours === 24) targetId = 'btn24h';
    else if (window.lastPresetHours === 48) targetId = 'btn48h';
    else if (window.lastPresetHours === 168) targetId = 'btn7d';
    
    document.getElementById(targetId)?.classList.add('filter-loading-pulse');

    const params = new URLSearchParams();
    if (wfFilter) params.append('workflow', wfFilter);
    if (window.currentMode()) params.append('mode', window.currentMode());

    if (window.lastPresetHours) {
        // STRICT PRECISION: Use exact rolling window
        const now = new Date();
        const start = new Date(now.getTime() - (window.lastPresetHours * 3600000));
        params.append('startDate', start.toISOString());
        params.append('endDate', now.toISOString());
    } else if (rangeStart && rangeEnd) {
        // Day Precision fallback
        params.append('startDate', rangeStart);
        params.append('endDate', rangeEnd);
    } else {
        // Fallback: Default to 7 days
        const today = new Date();
        const start = new Date(today.getTime() - (168 * 3600000));
        const toISO = (d) => new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
        params.append('startDate', toISO(start));
        params.append('endDate', toISO(today));
    }

    try {
        const response = await fetchWithAuth(`/api/analytics/metrics?${params.toString()}`);
        const data = await response.json();

        updateKpiCards(data.summary);
        updateLineChart(data.hourlyData);
        updateDoughnutChart(data.topWorkflows);
        lastTopWorkflows = data.topWorkflows;
        populateDropdown(data.topWorkflows);
    } catch (err) {
        console.error("Error fetching metrics:", err);
    } finally {
        // Note: updateActiveFilterStyles() inside updateLineChart removes pulse and restores solid color
        updateActiveFilterStyles();
    }
}

window.fetchExecutions = async function(offset, limit) {
    try {
        const params = new URLSearchParams();
        params.append('offset', offset);
        params.append('limit', limit);

        const workflow = document.getElementById('execWorkflowFilter')?.value;
        const status = document.getElementById('execStatusFilter')?.value;
        const execId = document.getElementById('execIdFilter')?.value?.trim();
        const startDt = parseExecDate(document.getElementById('execStartFilter')?.value);
        const endDt = parseExecDate(document.getElementById('execEndFilter')?.value);
        const minDur = document.getElementById('execMinDurFilter')?.value;

        if (workflow) params.append('workflow', workflow);
        if (status) params.append('status', status);
        if (execId && !isNaN(parseInt(execId))) params.append('execId', parseInt(execId));
        if (startDt) params.append('from', startDt.toISOString());
        if (endDt) params.append('toStop', endDt.toISOString());
        if (minDur && parseFloat(minDur) > 0) params.append('minDuration', parseFloat(minDur));
        if (window.currentMode()) params.append('mode', window.currentMode());

        const response = await fetchWithAuth(`/api/analytics/executions?${params.toString()}`);
        return response.ok ? await response.json() : [];
    } catch (err) {
        console.error("Error fetching executions:", err);
        return [];
    }
}

