/**
 * Error Intelligence Dashboard — Complete Rewrite
 * Sections: KPIs, Trend Timeline, Category Donut, Workflow Health, Deduplicated Error Groups
 */

document.addEventListener('DOMContentLoaded', initErrorIntelligence);

// ── Category Config ──────────────────────────────────────────
const CATEGORY_CONFIG = {
    auth:       { label: 'Auth & Credentials', icon: 'fa-key',              color: '#ff6b6b', nature: 'structural' },
    rate_limit: { label: 'Rate Limited',       icon: 'fa-gauge-high',       color: '#fbbf24', nature: 'transient'  },
    network:    { label: 'Network & Timeout',  icon: 'fa-wifi',             color: '#60a5fa', nature: 'transient'  },
    upstream:   { label: 'Upstream Error',      icon: 'fa-server',           color: '#a78bfa', nature: 'transient'  },
    config:     { label: 'Configuration',       icon: 'fa-gear',             color: '#fb923c', nature: 'structural' },
    data:       { label: 'Data & Validation',   icon: 'fa-database',         color: '#22d3ee', nature: 'structural' },
    logic:      { label: 'Logic & Code',        icon: 'fa-code',             color: '#f472b6', nature: 'structural' },
    unknown:    { label: 'Uncategorized',        icon: 'fa-circle-question',  color: '#6b7280', nature: 'unknown'    }
};

const ALL_CATEGORIES = Object.keys(CATEGORY_CONFIG);

// F-08. What the fingerprint has been observed to do, rather than what its
// category implies. 'unknown' is a real answer and says so: five occurrences is
// the floor below which a recovery rate means nothing.
// F-15. What someone decided about a fingerprint, as opposed to what it is
// doing. An error page that only ever grows is a page nobody reads; a decision
// is what takes a row off the list without pretending it did not happen.
const LIFECYCLE = {
    open: { label: 'Open', cls: 'bg-gray-800 text-gray-400' },
    acknowledged: { label: 'Acknowledged', cls: 'bg-indigo-900/40 text-indigo-300' },
    resolved: { label: 'Resolved', cls: 'bg-green-900/30 text-green-400' },
    ignored: { label: 'Ignored', cls: 'bg-gray-800/60 text-gray-500' }
};

const BEHAVIOUR_BADGE = {
    transient: '<span class="text-[9px] px-1.5 py-0.5 rounded bg-indigo-600/20 text-indigo-400 font-semibold ml-2" title="Almost always passes on the next run">⚡ Self-healing</span>',
    intermittent: '<span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-600/20 text-amber-400 font-semibold ml-2" title="Passes sometimes — worth watching">◐ Intermittent</span>',
    structural: '<span class="text-[9px] px-1.5 py-0.5 rounded bg-red-900/30 text-red-400 font-semibold ml-2" title="Has essentially never passed">🔧 Fix</span>',
    unknown: '<span class="text-[9px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500 font-semibold ml-2" title="Too few occurrences to tell">? Unproven</span>'
};

let trendChart = null;
let categoryChart = null;
let currentRange = { startDate: null, endDate: null };

// ── Initialization ───────────────────────────────────────────
async function initErrorIntelligence() {
    // Every value this page renders is a timestamp, so the timezone has to be
    // known before the first one is drawn — otherwise the page paints in the
    // browser's zone and silently re-paints in the configured one.
    await window.settingsReady;
    initCharts();
    setErrorRange(168); // Default: 7 days

    // Delegated so rows carry a data attribute instead of an inline onclick.
    document.addEventListener('click', (event) => {
        const row = event.target.closest('[data-group-toggle]');
        // Ignore clicks on the nested "Inspect" buttons — those open the snapshot.
        if (!row || event.target.closest('[data-error-exec-id]')) return;
        toggleGroupDetail(row);
    });

    // Custom date range listeners
    const startInput = document.getElementById('errorRangeStart');
    const endInput = document.getElementById('errorRangeEnd');
    if (startInput && endInput) {
        startInput.addEventListener('change', applyCustomRange);
        endInput.addEventListener('change', applyCustomRange);
    }
}

function setErrorRange(hours) {
    const now = new Date();
    const start = new Date(now.getTime() - hours * 60 * 60 * 1000);

    currentRange.startDate = start.toISOString();
    currentRange.endDate = now.toISOString();

    // Update button styles
    const mapping = { 24: 'btn24h', 48: 'btn48h', 168: 'btn7d', 336: 'btn14d', 720: 'btn30d' };
    document.querySelectorAll('#presetRangeContainer button').forEach(btn => {
        btn.classList.remove('border-n8n-primary/30', 'text-n8n-primary');
        btn.classList.add('border-gray-800', 'text-gray-500');
    });
    const activeBtn = document.getElementById(mapping[hours]);
    if (activeBtn) {
        activeBtn.classList.remove('border-gray-800', 'text-gray-500');
        activeBtn.classList.add('border-n8n-primary/30', 'text-n8n-primary');
    }

    fetchErrorData();
}

function applyCustomRange() {
    const startInput = document.getElementById('errorRangeStart');
    const endInput = document.getElementById('errorRangeEnd');
    if (!startInput.value || !endInput.value) return;

    currentRange.startDate = new Date(startInput.value + 'T00:00:00').toISOString();
    currentRange.endDate = new Date(endInput.value + 'T23:59:59').toISOString();

    // Clear preset highlights
    document.querySelectorAll('#presetRangeContainer button').forEach(btn => {
        btn.classList.remove('border-n8n-primary/30', 'text-n8n-primary');
        btn.classList.add('border-gray-800', 'text-gray-500');
    });

    fetchErrorData();
}

// ── Data Fetching ────────────────────────────────────────────
async function fetchErrorData() {
    try {
        const url = `/api/analytics/error-intelligence?startDate=${encodeURIComponent(currentRange.startDate)}&endDate=${encodeURIComponent(currentRange.endDate)}`;
        const res = await fetchWithAuth(url);
        if (!res.ok) throw new Error('Failed to fetch');
        const data = await res.json();

        renderKPIs(data.summary);
        renderTrendChart(data.trend);
        renderCategoryChart(data.categories, data.summary.total_errors);
        renderWorkflowHealth(data.workflows);
        renderErrorGroups(data.errorGroups);
    } catch (e) {
        console.error('[ERROR PAGE]', e);
    }
}

// ── KPI Rendering ────────────────────────────────────────────
function renderKPIs(summary) {
    document.getElementById('kpiTotalErrors').textContent = (summary.total_errors || 0).toLocaleString();
    document.getElementById('kpiErrorRate').textContent = (summary.error_rate || 0) + '%';
    // Measured, not mapped from the category (F-08).
    document.getElementById('kpiTransient').textContent =
        (summary.transient_observed || 0).toLocaleString();
    document.getElementById('kpiStructural').textContent =
        (summary.structural_observed || 0).toLocaleString();

    const mislabelEl = document.getElementById('kpiMislabelled');
    if (mislabelEl) {
        const n = summary.mislabelled_groups || 0;
        mislabelEl.textContent = n ? `${n} group${n === 1 ? '' : 's'} behave against their category` : '';
        mislabelEl.classList.toggle('hidden', n === 0);
    }

    // Trend badge
    const trendEl = document.getElementById('kpiTrend');
    const pct = summary.trend_pct || 0;
    if (pct !== 0) {
        trendEl.classList.remove('hidden');
        const isUp = pct > 0;
        trendEl.textContent = `${isUp ? '↑' : '↓'} ${Math.abs(pct)}%`;
        trendEl.className = `text-xs font-semibold px-2 py-0.5 rounded-full ${isUp ? 'bg-red-900/40 text-red-400' : 'bg-green-900/40 text-green-400'}`;
    } else {
        trendEl.classList.add('hidden');
    }
}

// ── Trend Chart ──────────────────────────────────────────────
function renderTrendChart(trendData) {
    if (!trendData || trendData.length === 0) return;

    // The API returns date(timestamp), a bare YYYY-MM-DD in UTC. Appending only
    // 'T00:00:00' made the browser read it as LOCAL midnight, so west of UTC every
    // bar was labelled with the previous day.
    const labels = trendData.map(d =>
        window.formatTime(d.day + 'T00:00:00Z', { month: 'short', day: 'numeric' })
    );

    const datasets = ALL_CATEGORIES.filter(cat => {
        return trendData.some(d => d[cat]);
    }).map(cat => ({
        label: CATEGORY_CONFIG[cat].label,
        data: trendData.map(d => d[cat] || 0),
        backgroundColor: CATEGORY_CONFIG[cat].color + '80',
        borderColor: CATEGORY_CONFIG[cat].color,
        borderWidth: 1,
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHitRadius: 10
    }));

    trendChart.data.labels = labels;
    trendChart.data.datasets = datasets;
    trendChart.update();
}

// ── Category Donut ───────────────────────────────────────────
function renderCategoryChart(categories, totalErrors) {
    if (!categories || categories.length === 0) return;

    const labels = categories.map(c => CATEGORY_CONFIG[c.error_category]?.label || c.error_category);
    const data = categories.map(c => c.count);
    const colors = categories.map(c => CATEGORY_CONFIG[c.error_category]?.color || '#6b7280');

    categoryChart.data.labels = labels;
    categoryChart.data.datasets[0].data = data;
    categoryChart.data.datasets[0].backgroundColor = colors;
    categoryChart.update();
}

// ── Workflow Health ──────────────────────────────────────────
function renderWorkflowHealth(workflows) {
    const body = document.getElementById('healthTableBody');
    if (!workflows || workflows.length === 0) {
        body.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-gray-500 text-sm italic">No failing workflows in this period.</td></tr>';
        return;
    }

    body.innerHTML = workflows.map(wf => {
        const score = wf.health_score || 0;
        let barColor = 'bg-green-500';
        let textColor = 'text-green-400';
        if (score < 80) { barColor = 'bg-red-500'; textColor = 'text-red-400'; }
        else if (score < 95) { barColor = 'bg-orange-400'; textColor = 'text-orange-400'; }

        return `
            <tr class="hover:bg-gray-800/30 transition-colors text-xs">
                <td class="p-4 font-semibold text-white truncate max-w-[200px]">${escapeHtml(wf.name)}</td>
                <td class="p-4 text-center text-n8n-danger font-bold">${wf.error_count}</td>
                <td class="p-4 text-center text-gray-400">${wf.total_runs}</td>
                <td class="p-4">
                    <div class="flex items-center gap-3">
                        <div class="flex-1 bg-gray-800 rounded-full h-2 overflow-hidden">
                            <div class="${barColor} h-full rounded-full transition-all duration-500" style="width: ${score}%"></div>
                        </div>
                        <span class="${textColor} text-[11px] font-bold w-12 text-right">${score}%</span>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

// ── Error Groups ─────────────────────────────────────────────
function renderErrorGroups(groups) {
    const body = document.getElementById('errorGroupsBody');
    const countEl = document.getElementById('groupCount');
    
    if (!groups || groups.length === 0) {
        body.innerHTML = '<tr><td colspan="7" class="p-12 text-center text-gray-500 text-sm italic">No errors in this period.</td></tr>';
        countEl.textContent = '0 groups';
        return;
    }

    countEl.textContent = `${groups.length} groups`;

    body.innerHTML = groups.map((g, i) => {
        const cat = CATEGORY_CONFIG[g.error_category] || CATEGORY_CONFIG.unknown;
        const statusBadge = g.activity === 'active'
            ? '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-900/40 text-red-400 text-[10px] font-bold"><span class="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse"></span>Active</span>'
            : '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-900/20 text-indigo-400 text-[10px] font-bold">Recurring</span>';

        // A fingerprint nobody had ever seen before this window. The single most
        // actionable label on the page: everything else here has been happening
        // for a while.
        const newBadge = g.is_new
            ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold ml-2 uppercase tracking-widest">new</span>'
            : '';

        // One fingerprint can span categories when the same message arrives with
        // different HTTP codes. Saying so is better than picking one silently.
        const spanNote = g.category_count > 1
            ? `<span class="text-[9px] text-gray-600 ml-2">+${g.category_count - 1} more</span>`
            : '';

        // F-08: the badge is measured, not inferred from the wording of the
        // message. The old version read the category and guessed; on this
        // instance that guess was wrong for four of the six error groups with
        // enough occurrences to judge.
        const natureBadge = BEHAVIOUR_BADGE[g.behaviour] || BEHAVIOUR_BADGE.unknown;

        // Where the measurement contradicts the label every other tool shows.
        const disagreeBadge = g.label_disagrees
            ? `<span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 font-semibold ml-2"
                     title="The category says otherwise — this is what it actually does">↯ relabelled</span>`
            : '';

        const life = LIFECYCLE[g.status] || LIFECYCLE.open;
        // Only shown once it is not simply 'open': a badge saying "Open" on
        // every row is noise, and its absence already means the same thing.
        const lifecycleBadge = g.status && g.status !== 'open'
            ? `<span class="ml-2 text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded ${life.cls}">${life.label}</span>`
            : '';

        const workflows = (g.workflow_names || []).map(n => escapeHtml(n)).join(', ');
        const firstSeen = formatTimeNice(g.first_seen);
        const lastSeen = formatTimeNice(g.last_seen);

        return `
            <tr class="hover:bg-gray-800/30 transition-colors text-xs border-b border-gray-800/20 cursor-pointer group" data-group-toggle>
                <td class="p-4 text-gray-600 group-hover:text-gray-400 transition-colors"><i class="fa-solid fa-chevron-right text-[10px] transition-transform duration-200"></i></td>
                <td class="p-4">
                    <span class="inline-flex items-center gap-2">
                        <i class="fa-solid ${cat.icon}" style="color:${cat.color}"></i>
                        <span style="color:${cat.color}" class="font-semibold">${cat.label}</span>
                        ${natureBadge}${disagreeBadge}${spanNote}
                    </span>
                </td>
                <td class="p-4">
                    <span class="inline-block bg-gray-800 text-gray-300 px-3 py-1.5 rounded text-[10px] font-mono border border-gray-700 whitespace-nowrap">${escapeHtml(g.node_name)}</span>
                </td>
                <td class="p-4 text-red-400/80 max-w-md truncate">${escapeHtml(g.error_summary)}${newBadge}</td>
                <td class="p-4 text-center font-bold text-white">${g.count.toLocaleString()}</td>
                <td class="p-4 text-center text-indigo-400 font-semibold">${g.affected_workflows}</td>
                <td class="p-4 text-right">${statusBadge}${lifecycleBadge}</td>
            </tr>
            <tr class="hidden bg-black/20 border-b border-gray-800/20" data-detail-row data-loaded="false"
                data-fingerprint="${escapeHtml(g.fingerprint)}">
                <td colspan="7" class="p-4 pl-12">
                    <div class="flex flex-wrap gap-6 text-[11px] text-gray-400">
                        <div><span class="text-gray-600 uppercase font-bold text-[9px] block mb-1">First Seen</span>${firstSeen}</div>
                        <div><span class="text-gray-600 uppercase font-bold text-[9px] block mb-1">Last Seen</span>${lastSeen}</div>
                        <div><span class="text-gray-600 uppercase font-bold text-[9px] block mb-1">Node Type</span><code class="font-mono text-gray-500">${escapeHtml(g.node_type || 'Unknown')}</code></div>
                        <div><span class="text-gray-600 uppercase font-bold text-[9px] block mb-1">Affected Workflows</span>${workflows || 'Unknown'}</div>
                        <div><span class="text-gray-600 uppercase font-bold text-[9px] block mb-1">First Seen Ever</span>${formatTimeNice(g.ever_first_seen)}</div>
                        <div><span class="text-gray-600 uppercase font-bold text-[9px] block mb-1">Fingerprint</span><code class="font-mono text-gray-500">${escapeHtml(g.fingerprint)}</code></div>
                        <div><span class="text-gray-600 uppercase font-bold text-[9px] block mb-1">Recovers</span>${
    g.recovery_rate === null
        ? `<span class="text-gray-600">too few to judge (${g.observed})</span>`
        : `${g.recovery_rate}% <span class="text-gray-600">(${g.recovered} of ${g.observed} followed by a success)</span>`
}</div>
                    </div>
                    <div class="mt-3 text-[10px] text-gray-500">
                        <span class="text-gray-600 uppercase font-bold text-[9px]">Grouped as</span>
                        <code class="font-mono ml-2 text-gray-400">${escapeHtml(g.normalized_message || '')}</code>
                    </div>
                    <div class="mt-3 p-3 bg-n8n-dark/50 rounded-lg border border-gray-800/50 overflow-x-auto">
                        <pre class="text-[11px] text-red-400/80 whitespace-pre-wrap font-mono leading-relaxed">${escapeHtml(g.error_summary)}</pre>
                    </div>
                    <!-- Triage (F-15) -->
                    <div class="mt-4 flex items-center gap-2 flex-wrap">
                        <span class="text-[10px] text-gray-500 font-bold uppercase tracking-widest mr-1">Triage</span>
                        ${['acknowledge', 'resolve', 'ignore', 'reopen'].map(action => `
                            <button data-action="setFingerprintStatus"
                                    data-arg="${escapeHtml(g.fingerprint)}:${action}"
                                    class="px-2 py-1 text-[10px] font-bold uppercase tracking-widest rounded border border-gray-700 text-gray-400 hover:border-indigo-500/50 hover:text-indigo-300 transition-colors">
                                ${action}
                            </button>`).join('')}
                        <span class="text-[10px] text-gray-600 ml-2">${
    g.status && g.status !== 'open'
        ? `${escapeHtml(life.label.toLowerCase())}${g.notes ? ` — ${escapeHtml(g.notes)}` : ''}`
        : 'not triaged yet'}</span>
                    </div>

                    <!-- Executions Feed Container -->
                    <div class="mt-4">
                        <h4 class="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-2">Recent Occurrences</h4>
                        <div class="executions-container bg-n8n-card border border-gray-800 rounded-lg overflow-hidden">
                            <div class="p-4 text-center text-gray-500 text-xs"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading executions...</div>
                        </div>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

async function toggleGroupDetail(row) {
    const detailRow = row.nextElementSibling;
    if (!detailRow || !detailRow.hasAttribute('data-detail-row')) return;

    const icon = row.querySelector('.fa-chevron-right');
    if (detailRow.classList.contains('hidden')) {
        detailRow.classList.remove('hidden');
        if (icon) icon.style.transform = 'rotate(90deg)';

        // Fetch executions if not loaded
        if (detailRow.getAttribute('data-loaded') !== 'true') {
            await fetchGroupExecutions(detailRow);
        }
    } else {
        detailRow.classList.add('hidden');
        if (icon) icon.style.transform = 'rotate(0deg)';
    }
}

async function fetchGroupExecutions(detailRow) {
    const container = detailRow.querySelector('.executions-container');
    const fingerprint = detailRow.getAttribute('data-fingerprint');

    try {
        const url = `/api/analytics/error-group-executions`;
        const payload = {
            fingerprint,
            startDate: currentRange.startDate,
            endDate: currentRange.endDate
        };

        const res = await fetchWithAuth(url, {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error('Failed to load executions');
        const data = await res.json();
        
        detailRow.setAttribute('data-loaded', 'true');
        
        if (!data.executions || data.executions.length === 0) {
            container.innerHTML = '<div class="p-4 text-center text-gray-500 text-xs">No executions found.</div>';
            return;
        }

        container.innerHTML = `
            <table class="w-full text-left text-xs">
                <thead class="bg-black/30 text-gray-500 uppercase tracking-wider text-[9px] font-bold">
                    <tr>
                        <th class="p-3">Time</th>
                        <th class="p-3">Workflow</th>
                        <th class="p-3 text-right">Action</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-gray-800/50">
                    ${data.executions.map(ex => `
                        <tr class="hover:bg-gray-800/30 transition-colors">
                            <td class="p-3 text-gray-400">${formatTimeNice(ex.timestamp)}</td>
                            <td class="p-3 font-semibold text-gray-300">${escapeHtml(ex.workflow_name)}</td>
                            <td class="p-3 text-right">
                                <button data-error-exec-id="${escapeHtml(ex.exec_id)}" class="bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded transition-colors text-[10px] font-bold shadow">
                                    <i class="fa-solid fa-magnifying-glass mr-1"></i> Inspect
                                </button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    } catch (err) {
        console.error(err);
        container.innerHTML = '<div class="p-4 text-center text-red-400 text-xs">Failed to load executions.</div>';
    }
}


// ── Chart Initialization ─────────────────────────────────────
function initCharts() {
    // Trend Chart (stacked area)
    const trendCanvas = document.getElementById('trendChart');
    if (trendCanvas) {
        trendChart = new Chart(trendCanvas.getContext('2d'), {
            type: 'line',
            data: { labels: [], datasets: [] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: {
                        grid: { color: '#ffffff08' },
                        ticks: { color: '#6b7280', font: { size: 10, family: "'Open Sans'" } }
                    },
                    y: {
                        stacked: true,
                        grid: { color: '#ffffff08' },
                        ticks: { color: '#6b7280', font: { size: 10, family: "'Open Sans'" } },
                        beginAtZero: true
                    }
                },
                plugins: {
                    legend: {
                        position: 'top',
                        align: 'end',
                        labels: { color: '#9ca3af', boxWidth: 10, padding: 15, font: { size: 10, family: "'Open Sans'" } }
                    },
                    tooltip: {
                        backgroundColor: '#1a1a1a',
                        borderColor: '#333',
                        borderWidth: 1,
                        titleColor: '#fff',
                        bodyColor: '#9ca3af',
                        padding: 12,
                        cornerRadius: 8
                    }
                }
            }
        });
    }

    // Category Donut
    const catCanvas = document.getElementById('categoryChart');
    if (catCanvas) {
        categoryChart = new Chart(catCanvas.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: [],
                datasets: [{ data: [], backgroundColor: [], borderWidth: 0, hoverOffset: 12 }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '62%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { color: '#9ca3af', boxWidth: 10, padding: 12, font: { size: 10, family: "'Open Sans'" } }
                    },
                    tooltip: {
                        backgroundColor: '#1a1a1a',
                        borderColor: '#333',
                        borderWidth: 1,
                        padding: 10,
                        cornerRadius: 8,
                        callbacks: {
                            label: function(ctx) {
                                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                                const pct = ((ctx.parsed / total) * 100).toFixed(1);
                                return ` ${ctx.label}: ${ctx.parsed.toLocaleString()} (${pct}%)`;
                            }
                        }
                    }
                }
            }
        });
    }
}

// ── Helpers ──────────────────────────────────────────────────
// Through the shared formatter, so this page honours the timezone setting like
// the rest of the dashboard. It never did: formatTime lived in app_globals.js and
// errors.html does not load app.js.
function formatTimeNice(isoStr) {
    if (!isoStr) return '—';
    return window.formatTime(isoStr, {
        month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
}

// escapeHtml now lives in global_functions.js so every page shares one implementation.


// ── F-15 · Triage ────────────────────────────────────────────

/**
 * Records a decision about a fingerprint.
 *
 * Resolving asks for a note, because "resolved" with no reason is the state
 * least likely to survive contact with the same error next month — and the note
 * is what the person who meets it again needs. Acknowledging does not: it means
 * "seen, working on it", and demanding an explanation for that is friction with
 * no payoff.
 */
window.setFingerprintStatus = async function (arg) {
    const [fingerprint, action] = String(arg).split(':');
    if (!fingerprint || !action) return;

    let note = null;
    if (action === 'resolve' || action === 'ignore') {
        note = window.prompt(
            action === 'resolve'
                ? 'What fixed it? (This is what the next person will read if it comes back.)'
                : 'Why is this being ignored?'
        );
        // Cancelled, as opposed to deliberately left blank.
        if (note === null) return;
    }

    try {
        const res = await fetchWithAuth(`/api/fingerprints/${encodeURIComponent(fingerprint)}/status`, {
            method: 'POST',
            body: JSON.stringify({ action, note: note || undefined })
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            alert(body.error || 'Could not record that.');
            return;
        }
        // Reload rather than patch the row: resolving changes what the alert
        // rules will do next, and a stale page that still offers "resolve" on
        // something already resolved invites a second, contradictory decision.
        await fetchErrorData();
    } catch (err) {
        console.error('[TRIAGE]', err);
    }
};
