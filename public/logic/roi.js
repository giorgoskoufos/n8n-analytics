document.addEventListener('DOMContentLoaded', loadRoiMetrics);

async function loadRoiMetrics() {
    const kpiTotalTime = document.getElementById('kpiTotalTime');
    const kpiTotalMoney = document.getElementById('kpiTotalMoney');
    const kpiExecutions = document.getElementById('kpiExecutions');
    const tableBody = document.getElementById('roiWorkflowsTable');
    const filterEl = document.getElementById('roiTimeRangeFilter');
    const timeRange = filterEl ? filterEl.value : 'all';

    try {
        const response = await fetchWithAuth(`/api/analytics/roi?timeRange=${timeRange}`);
        if (!response.ok) throw new Error("Failed to fetch ROI metrics");
        
        const data = await response.json();
        
        // Update KPIs
        const totalSecs = parseInt(data.summary.total_time_saved_seconds) || 0;
        kpiTotalTime.innerText = formatTimeExtensive(totalSecs);
        
        const totalMoney = parseFloat(data.summary.total_money_saved) || 0;
        if (kpiTotalMoney) kpiTotalMoney.innerText = formatCurrency(totalMoney);

        kpiExecutions.innerText = (parseInt(data.summary.total_executions) || 0).toLocaleString();

        // Update Table
        if (data.topWorkflows && data.topWorkflows.length > 0) {
            tableBody.innerHTML = data.topWorkflows.map(wf => `
                <tr class="hover:bg-n8n-dark/30 transition-colors">
                    <td class="py-3 pr-4 font-medium text-white">${escapeHtml(wf.name)}</td>
                    <td class="py-3 px-4 text-right text-ink-2 font-mono">${(parseInt(wf.executions) || 0).toLocaleString()}</td>
                    <td class="py-3 px-4 text-right text-green-400 font-bold">${formatTimeExtensive(wf.time_saved_seconds)}</td>
                    <td class="py-3 pl-4 text-right text-emerald-400 font-bold">${formatCurrency(wf.money_saved)}</td>
                </tr>
            `).join('');
        } else {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="4" class="py-12 text-center text-ink-3">
                        <i class="fa-solid fa-clock-rotate-left text-4xl mb-3 opacity-20 block"></i>
                        <p>No ROI data available.</p>
                        <a href="settings.html" class="text-indigo-400 hover:text-indigo-300 text-sm mt-2 inline-block underline">Configure Time Saved in Settings</a>
                    </td>
                </tr>
            `;
        }

    } catch (err) {
        console.error(err);
        kpiTotalTime.innerText = 'Err';
        if (kpiTotalMoney) kpiTotalMoney.innerText = 'Err';
        kpiExecutions.innerText = 'Err';
        tableBody.innerHTML = `<tr><td colspan="4" class="py-6 text-center text-red-500">Failed to load ROI data. <button data-action="loadRoiMetrics" class="underline text-red-400 hover:text-white ml-2">Retry</button></td></tr>`;
    }
}

// Listen for filter changes
document.addEventListener('DOMContentLoaded', () => {
    const filterEl = document.getElementById('roiTimeRangeFilter');
    if (filterEl) {
        filterEl.addEventListener('change', loadRoiMetrics);
    }
});

// Helper: Convert seconds to "X d, Y h, Z m" format
function formatTimeExtensive(totalSeconds) {
    if (!totalSeconds || totalSeconds <= 0) return '0 m';

    const days = Math.floor(totalSeconds / (3600 * 24));
    totalSeconds -= days * 3600 * 24;
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds -= hours * 3600;
    const minutes = Math.floor(totalSeconds / 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);

    return parts.join(' ');
}

// escapeHtml lives in global_functions.js, loaded before this file.


// Helper: Format Currency
function formatCurrency(amount) {
    const value = parseFloat(amount);
    if (!value || value <= 0) return '$0.00';
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2
    }).format(value);
}
