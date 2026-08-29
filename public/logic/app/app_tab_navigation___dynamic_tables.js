// --- SECTION 7: TAB NAVIGATION & DYNAMIC TABLES ---
// F-17: archived workflows keep their history in these aggregates — it is real
// and it happened — but nothing else on the page says they are retired, and
// "why is a dead workflow in my slowest list" is a question worth answering in
// the row itself.
const archivedBadge = (isArchived) => isArchived
    ? ' <span class="text-[9px] uppercase tracking-widest text-gray-600 border border-gray-700 rounded px-1 py-0.5 ml-1">archived</span>'
    : '';

window.switchTab = async function(tabName) {
    if (currentTab === tabName) return;
    currentTab = tabName;

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    const activeBtn = document.querySelector(`[data-action="switchTab"][data-arg="${tabName}"]`);
    if (activeBtn) {
        activeBtn.classList.add('active');
    }

    const thead = document.getElementById('tableHeader') || document.getElementById('table-head');
    const tbody = document.getElementById('executionsTableBody') || document.getElementById('table-body');
    const scrollTrigger = document.getElementById('scrollTrigger') || document.getElementById('scroll-trigger');

    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-gray-500">Loading...</td></tr>';

    if (tabName === 'executions') {
        initExecutionsHeader(); // rebuild filter row + wire events
        const scrollTrigger = document.getElementById('scrollTrigger') || document.getElementById('scroll-trigger');
        if (scrollTrigger) {
            scrollTrigger.style.display = 'block';
            scrollTrigger.innerHTML = '';
        }
        loadMoreExecutions(true);

    } else if (tabName === 'slowest') {
        if (thead) thead.innerHTML = `
            <tr class="text-gray-400 text-sm">
                <th class="p-4 font-medium">Workflow</th>
                <th class="p-4 font-medium">Avg Run Time (7d)</th>
                <th class="p-4 font-medium">Total Runs (7d)</th>
            </tr>
        `;
        if (scrollTrigger) scrollTrigger.style.display = 'none';

        const res = await fetchWithAuth('/api/analytics/slowest');
        const data = await res.json();
        if (tbody) {
            // Built once, assigned once. Only ten rows land here, so the cost is
            // not the point — leaving `innerHTML +=` in the file is, because it is
            // the pattern the next table gets copied from.
            tbody.innerHTML = data.map(row => {
                const avgTime = parseFloat(row.avg_duration).toFixed(3) + 's';
                return `
                    <tr class="hover:bg-gray-800/30 transition-colors text-sm border-b border-gray-800/50">
                        <td class="p-4 text-white">${escapeHtml(row.name)}${archivedBadge(row.is_archived)}</td>
                        <td class="p-4 text-orange-400 font-mono">${escapeHtml(avgTime)}</td>
                        <td class="p-4 text-n8n-text">${parseInt(row.total_runs).toLocaleString()}</td>
                    </tr>
                `;
            }).join('');
        }

    } else if (tabName === 'errors') {
        if (thead) thead.innerHTML = `
            <tr class="text-gray-400 text-sm">
                <th class="p-4 font-medium">Workflow</th>
                <th class="p-4 font-medium">Errors (7d)</th>
                <th class="p-4 font-medium">Total Runs (7d)</th>
                <th class="p-4 font-medium">Error Rate</th>
            </tr>
        `;
        if (scrollTrigger) scrollTrigger.style.display = 'none';

        const res = await fetchWithAuth('/api/analytics/errors');
        const data = await res.json();
        if (tbody) {
            tbody.innerHTML = data.map(row => {
                const errCount = parseInt(row.error_count);
                const totalRuns = parseInt(row.total_runs);
                const rate = ((errCount / totalRuns) * 100).toFixed(1) + '%';
                return `
                    <tr class="hover:bg-gray-800/30 transition-colors text-sm border-b border-gray-800/50">
                        <td class="p-4 text-white">${escapeHtml(row.name)}${archivedBadge(row.is_archived)}</td>
                        <td class="p-4 text-n8n-danger font-bold">${errCount.toLocaleString()}</td>
                        <td class="p-4 text-n8n-text">${totalRuns.toLocaleString()}</td>
                        <td class="p-4 text-n8n-text">${rate}</td>
                    </tr>
                `;
            }).join('');
        }
    }
}