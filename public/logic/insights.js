/**
 * Insights — the questions the replica could not answer with five columns.
 *
 * F-02 trigger types · F-03 queue lag · F-06 concurrency · F-09 silent death ·
 * F-05 reliability · F-16 organisation · F-10 blast radius · F-11 deploys ·
 * F-04 storage growth · F-18 business metadata.
 *
 * One page rather than five panels bolted onto the dashboard, because these
 * answers are read together: a webhook error rate means something different when
 * the queue lag under it is climbing, a peak concurrency of three means
 * something different next to a bucket that started sixteen, and a workflow's
 * payload cost means something different when you can see how often it runs.
 */

document.addEventListener('DOMContentLoaded', initInsights);

// Per-mode colour, fixed rather than assigned by position. A mode that drops out
// of a window would otherwise hand its colour to the next one along, and the
// chart would show webhook traffic turning into schedule traffic.
// F-24 §1 · Execution-mode colours come from the validated ramp, not from nine
// hand-picked hexes.
//
// The old list contained `#22c55e` for schedules and `#ef4444` for the error
// mode — a green and a red sitting beside a green "healthy" badge and a red
// "failed" one, in the same panel. A series colour that looks like a status
// colour is the one confusion the reserved palette exists to prevent, and this
// page had it twice.
//
// Pinned in a fixed order so a mode absent from today's window does not shift
// every colour after it the moment it reappears — "webhook is blue" has to hold
// across a filter change or the legend teaches nothing.
const MODE_ORDER = ['webhook', 'trigger', 'manual', 'integrated', 'retry', 'error', 'cli', 'internal'];
const MODE_LABELS = {
    webhook: 'Webhook',
    trigger: 'Schedule / Trigger',
    manual: 'Manual',
    error: 'Error workflow',
    retry: 'Retry',
    integrated: 'Sub-workflow',
    internal: 'Internal',
    cli: 'CLI',
    evaluation: 'Evaluation'
};
window.Viz.pin('mode', MODE_ORDER);
// Anything past the eight pinned slots — `evaluation`, or a mode a future n8n
// invents — gets the muted ink rather than a ninth generated hue, which would
// be indistinguishable from one of the eight under colour-vision deficiency.
const modeColor = (m) => (MODE_ORDER.includes(m)
    ? window.Viz.colorFor('mode', m)
    : window.Viz.tokens().ink3);
const modeLabel = (m) => MODE_LABELS[m] || m;

let volumeChart = null;
let lagChart = null;
let concurrencyChart = null;
let startedChart = null;
let storageChart = null;
let currentRange = { startDate: null, endDate: null };

// ── Formatting ───────────────────────────────────────────────

/** Bytes, at the largest unit that keeps the number readable. */
function fmtBytes(bytes) {
    const b = Number(bytes) || 0;
    const abs = Math.abs(b);
    if (abs >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    if (abs >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (abs >= 1024) return (b / 1024).toFixed(1) + ' KB';
    return b.toFixed(0) + ' B';
}

/**
 * Durations in milliseconds, which is what queue lag is.
 *
 * Kept in milliseconds until a full second, rather than rendered as "0.02s".
 * The whole point of the metric is the difference between 15 ms and 60 ms, and
 * a unit that shows both as 0.0 hides exactly the signal being measured.
 */
function fmtMs(ms) {
    if (ms === null || ms === undefined) return '—';
    const v = Number(ms);
    if (!Number.isFinite(v)) return '—';
    if (Math.abs(v) >= 1000) return (v / 1000).toFixed(2) + ' s';
    return Math.round(v) + ' ms';
}

const fmtNum = (n) => (Number(n) || 0).toLocaleString();
const fmtPct = (n) => (Number(n) || 0).toFixed(2) + '%';

/** A colour for an error rate, on the same scale everywhere on the page. */
function rateClass(pct) {
    if (pct >= 5) return 'text-red-400';
    if (pct >= 1) return 'text-amber-400';
    return 'text-green-400';
}

// ── Initialization ───────────────────────────────────────────

async function initInsights() {
    // Every timestamp on this page goes through formatTime, so the configured
    // timezone has to be loaded before the first chart is drawn.
    await window.settingsReady;
    initCharts();
    // The range is set; the panels may load now. insights_nav.js holds its
    // loaders until this is true, because it decides visibility synchronously
    // on DOMContentLoaded while this function is still awaiting settingsReady.
    window.insightsReady = true;
    window.setInsightsRange(168);

    const startInput = document.getElementById('insightsRangeStart');
    const endInput = document.getElementById('insightsRangeEnd');
    if (startInput && endInput) {
        startInput.addEventListener('change', applyCustomRange);
        endInput.addEventListener('change', applyCustomRange);
    }
    const storageDays = document.getElementById('storageDays');
    if (storageDays) storageDays.addEventListener('change', loadStorage);
    const silenceK = document.getElementById('silenceK');
    if (silenceK) silenceK.addEventListener('change', loadSilentWorkflows);
    const autosaves = document.getElementById('includeAutosaves');
    if (autosaves) autosaves.addEventListener('change', loadInsightDeploys);
    for (const id of ['folderFilter', 'tagFilter']) {
        document.getElementById(id)?.addEventListener('change', loadAll);
    }
}

window.setInsightsRange = function (hours) {
    const now = new Date();
    currentRange.startDate = new Date(now.getTime() - hours * 3600000).toISOString();
    currentRange.endDate = now.toISOString();

    // The pressed state IS the styling. `.chip[aria-pressed="true"]` paints it,
    // so there is no second record of which range is selected that can drift
    // from the first — which is what adding and removing four Tailwind classes
    // by hand was.
    const mapping = { 24: 'btn24h', 48: 'btn48h', 168: 'btn7d', 336: 'btn14d', 720: 'btn30d' };
    document.querySelectorAll('#presetRangeContainer button').forEach((btn) => {
        btn.setAttribute('aria-pressed', String(btn.id === mapping[hours]));
    });
    loadAll();
};

function applyCustomRange() {
    const startInput = document.getElementById('insightsRangeStart');
    const endInput = document.getElementById('insightsRangeEnd');
    if (!startInput.value || !endInput.value) return;
    currentRange.startDate = new Date(startInput.value + 'T00:00:00').toISOString();
    currentRange.endDate = new Date(endInput.value + 'T23:59:59').toISOString();
    // A custom range is not any of the presets, so none of them is pressed.
    document.querySelectorAll('#presetRangeContainer button').forEach((btn) => {
        btn.setAttribute('aria-pressed', 'false');
    });
    loadAll();
}

/**
 * The window plus the folder/tag filter, as one query string.
 *
 * Every panel builds its request from this, so narrowing to a folder narrows the
 * whole page at once. A per-panel filter would let two answers on the same
 * screen describe different sets of workflows, which is worse than no filter.
 */
function rangeQuery() {
    const params = new URLSearchParams({
        startDate: currentRange.startDate,
        endDate: currentRange.endDate
    });
    const folder = document.getElementById('folderFilter')?.value;
    const tag = document.getElementById('tagFilter')?.value;
    if (folder) params.set('folder', folder);
    if (tag) params.set('tag', tag);
    return params.toString();
}

/**
 * Reloads what is actually being looked at.
 *
 * This used to call all eleven loaders on every range change, and on page load
 * — eleven requests, several of them counting the whole replica, for a page on
 * which a reader looks at one panel (F-24 §7). insights_nav.js owns which
 * panels are visible and which have ever been loaded; this asks it to refresh
 * those, and leaves the rest to load the first time anyone opens them.
 *
 * The per-panel independence the previous version had is kept, and matters for
 * the same reason: one failing endpoint should cost its own panel and nothing
 * else — the storage forecast being unavailable is no reason to leave the queue
 * lag chart empty.
 */
function loadAll() {
    if (typeof window.reloadVisibleInsights === 'function') {
        window.reloadVisibleInsights();
        return;
    }
    // The nav failed to load. Falling back to everything is worse for the
    // server and correct for the reader, which is the right way round.
    [loadTriggers, loadQueueLag, loadConcurrency, loadSilentWorkflows, loadReliability,
        loadOrganisation, loadDependencies, loadInsightDeploys, loadMetadata,
        loadNodeProfile, loadStorage].forEach((fn) => {
        try { fn(); } catch (err) { console.error('[INSIGHTS]', err); }
    });
}

// ── Coverage banner ──────────────────────────────────────────

/**
 * Says, in the panel itself, how much of the window the answer could see.
 *
 * The mirrored columns are NULL on every execution n8n had already pruned before
 * the backfill ran, so a window reaching further back than the retention horizon
 * is answered from a shrinking sample. Left unsaid, the chart shows traffic
 * collapsing in the past — and that collapse is this replica's history, not the
 * instance's.
 */
function renderCoverage(el, coverage) {
    if (!el) return;
    if (!coverage || coverage.complete) {
        el.classList.add('hidden');
        el.innerHTML = '';
        return;
    }
    const missing = coverage.total - coverage.covered;
    const from = coverage.covered_from
        ? window.formatTime(coverage.covered_from, { day: '2-digit', month: 'short', year: 'numeric' })
        : null;
    el.classList.remove('hidden');
    el.innerHTML = `
        <i class="fa-solid fa-circle-info mr-2 text-amber-400/80"></i>
        Based on <strong class="text-ink-1">${fmtNum(coverage.covered)}</strong> of
        ${fmtNum(coverage.total)} executions in this window (${coverage.pct}%).
        The other ${fmtNum(missing)} were pruned from n8n before this data was mirrored${
    from ? `, so the split only goes back to ${escapeHtml(from)}` : ''}.`;
}

// ── F-02 · Trigger types ─────────────────────────────────────

async function loadTriggers() {
    const cards = document.getElementById('modeCards');
    try {
        const res = await fetchWithAuth(`/api/analytics/triggers?${rangeQuery()}`);
        if (!res.ok) throw new Error('triggers');
        const data = await res.json();

        renderCoverage(document.getElementById('triggerCoverage'), data.coverage);

        if (!data.modes.length) {
            cards.innerHTML = emptyPanel('fa-bolt', 'No execution modes in this window');
            volumeChart.data.labels = [];
            volumeChart.data.datasets = [];
            volumeChart.update();
            return;
        }

        // The comparison the item is about: how far each mode's error rate sits
        // from the blended one the dashboard used to show on its own.
        const blendedTotal = data.modes.reduce((a, m) => a + m.total, 0);
        const blendedErrors = data.modes.reduce((a, m) => a + m.errors, 0);
        const blended = blendedTotal ? (blendedErrors / blendedTotal) * 100 : 0;

        cards.innerHTML = data.modes.map((m) => {
            const ratio = blended > 0 ? m.error_rate / blended : 1;
            const versus = Math.abs(ratio - 1) < 0.15
                ? '<span class="text-ink-3">in line with the average</span>'
                : ratio > 1
                    ? `<span class="text-red-400/90">${ratio.toFixed(1)}× the overall rate</span>`
                    : `<span class="text-green-400/90">${(1 / ratio).toFixed(1)}× better than average</span>`;
            return `
            <div class="card kpi relative overflow-hidden">
                <span class="absolute left-0 top-0 bottom-0 w-1"
                      style="background:${modeColor(m.mode)}"></span>
                <p class="text-[10px] uppercase font-bold tracking-widest text-ink-3 mb-2">
                    ${escapeHtml(modeLabel(m.mode))}</p>
                <div class="flex items-baseline gap-2 mb-3">
                    <span class="text-2xl font-bold text-white">${fmtNum(m.total)}</span>
                    <span class="text-[10px] text-ink-3 uppercase tracking-widest">runs</span>
                </div>
                <div class="flex items-baseline gap-2">
                    <span class="text-lg font-bold ${rateClass(m.error_rate)}">${fmtPct(m.error_rate)}</span>
                    <span class="text-[10px] text-ink-3">${fmtNum(m.errors)} failed</span>
                </div>
                <p class="text-[10px] mt-1">${versus}</p>
                <div class="mt-3 pt-3 border-t border-line/70 grid grid-cols-2 gap-2">
                    <div>
                        <p class="text-[9px] uppercase tracking-widest text-ink-3">Avg lag</p>
                        <p class="text-xs text-ink-2 font-mono">${fmtMs(m.avg_lag_ms)}</p>
                    </div>
                    <div>
                        <p class="text-[9px] uppercase tracking-widest text-ink-3">Workflows</p>
                        <p class="text-xs text-ink-2 font-mono">${fmtNum(m.workflows)}</p>
                    </div>
                </div>
            </div>`;
        }).join('');

        // Stacked volume per mode. Stacked rather than overlaid: the useful
        // reading is composition — which trigger type the traffic is made of —
        // and overlaid lines at these ratios would flatten every mode but one.
        const first = Object.values(data.series)[0] || [];
        volumeChart.data.labels = first.map((p) => p.time_val);
        volumeChart.data.datasets = data.modes.map((m) => ({
            label: modeLabel(m.mode),
            data: (data.series[m.mode] || []).map((p) => p.total),
            borderColor: modeColor(m.mode),
            backgroundColor: window.Viz.alpha(modeColor(m.mode), 0.45),
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 1.5
        }));
        volumeChart.update();
    } catch (err) {
        console.error('[INSIGHTS] triggers:', err);
        cards.innerHTML = emptyPanel('fa-triangle-exclamation', 'Could not load the trigger breakdown');
    }
}

// ── F-03 · Queue lag ─────────────────────────────────────────

async function loadQueueLag() {
    const tbody = document.getElementById('lagModeBody');
    try {
        const res = await fetchWithAuth(`/api/analytics/queue-lag?${rangeQuery()}`);
        if (!res.ok) throw new Error('queue-lag');
        const data = await res.json();

        renderCoverage(document.getElementById('lagCoverage'), data.coverage);

        const s = data.summary || {};
        setText('lagP50', fmtMs(s.p50));
        setText('lagP95', fmtMs(s.p95));
        setText('lagP99', fmtMs(s.p99));
        setText('lagMax', fmtMs(s.max_ms));
        setText('lagSamples', `${fmtNum(s.n)} measured`);

        // Clock skew, if any. Silently clamping it would turn an infrastructure
        // fault into a clean chart, so it gets said out loud instead.
        const skew = document.getElementById('lagSkew');
        if (skew) {
            if (s.negative > 0) {
                skew.classList.remove('hidden');
                skew.innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-1"></i> ` +
                    `${fmtNum(s.negative)} executions report starting before they were created — ` +
                    `that is clock skew between n8n and its database, not queue behaviour.`;
            } else {
                skew.classList.add('hidden');
            }
        }

        const bp = data.backpressure || {};
        const bpEl = document.getElementById('backpressure');
        if (bpEl) {
            if (bp.detected) {
                bpEl.className = 'text-xs rounded-lg px-3 py-2 bg-red-900/20 border border-red-500/30 text-red-300';
                bpEl.innerHTML = `<i class="fa-solid fa-arrow-trend-up mr-1"></i> <strong>Backpressure.</strong> ` +
                    `p95 lag is ${bp.lag_ratio}× the earlier baseline while volume is ` +
                    `${bp.volume_ratio}× — the queue is draining slower than it fills.`;
            } else if (bp.reason) {
                bpEl.className = 'text-xs rounded-lg px-3 py-2 bg-black/20 border border-line text-ink-3';
                bpEl.innerHTML = `<i class="fa-solid fa-circle-minus mr-1"></i> ${escapeHtml(bp.reason)}.`;
            } else {
                bpEl.className = 'text-xs rounded-lg px-3 py-2 bg-green-900/10 border border-green-500/20 text-green-300/90';
                bpEl.innerHTML = `<i class="fa-solid fa-check mr-1"></i> No backpressure. ` +
                    `p95 lag is ${bp.lag_ratio}× the baseline against ${bp.volume_ratio}× the volume.`;
            }
        }

        tbody.innerHTML = data.byMode.length
            ? data.byMode.map((m) => `
                <tr class="hover:bg-gray-800/30 transition-colors">
                    <td class="p-3">
                        <span class="inline-block w-2 h-2 rounded-full mr-2"
                              style="background:${modeColor(m.mode)}"></span>
                        <span class="text-sm text-ink-1">${escapeHtml(modeLabel(m.mode))}</span>
                    </td>
                    <td class="p-3 text-right text-ink-2 font-mono text-xs">${fmtNum(m.n)}</td>
                    <td class="p-3 text-right text-ink-2 font-mono text-xs">${fmtMs(m.p50)}</td>
                    <td class="p-3 text-right text-white font-mono text-xs font-bold">${fmtMs(m.p95)}</td>
                    <td class="p-3 text-right text-ink-2 font-mono text-xs">${fmtMs(m.p99)}</td>
                    <td class="p-3 text-right text-ink-3 font-mono text-xs">${fmtMs(m.max_ms)}</td>
                </tr>`).join('')
            : `<tr><td colspan="6" class="p-8 text-center text-ink-3 text-sm italic">
                   No lag samples in this window</td></tr>`;

        lagChart.data.labels = data.series.map((p) => p.time_val);
        lagChart.data.datasets[0].data = data.series.map((p) => p.p50);
        lagChart.data.datasets[1].data = data.series.map((p) => p.p95);
        lagChart.data.datasets[2].data = data.series.map((p) => p.p99);
        lagChart.update();
    } catch (err) {
        console.error('[INSIGHTS] queue lag:', err);
        tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-red-400/80 text-sm italic">
            Could not load queue lag</td></tr>`;
    }
}

// ── F-06 · Real concurrency ──────────────────────────────────

async function loadConcurrency() {
    try {
        const res = await fetchWithAuth(`/api/analytics/concurrency?${rangeQuery()}`);
        if (!res.ok) throw new Error('concurrency');
        const data = await res.json();
        const s = data.summary;

        setText('concPeak', fmtNum(s.peak));
        setText('concPeakAt', s.peak_at
            ? window.formatTime(s.peak_at, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
            : 'never above zero');
        setText('concAvg', s.avg.toFixed(3));
        setText('concBusy', `${s.busy_pct}%`);
        setText('concBusyDetail',
            `${fmtMs(s.busy_ms)} of work in ${fmtNum(s.executions)} executions`);

        if (data.limit) {
            setText('concHeadroom', `${fmtNum(Math.max(0, data.limit - s.peak))}`);
            setText('concLimitNote', `slots free at peak, of ${fmtNum(data.limit)}`);
        } else {
            setText('concHeadroom', '—');
            setText('concLimitNote', 'set a concurrency limit in Settings to see this');
        }

        // The sentence the panel exists for. Starts and simultaneity are
        // different numbers, and only saying both makes the gap visible.
        const verdict = document.getElementById('concVerdict');
        if (verdict) {
            const perBucket = data.series.length
                ? Math.max(...data.series.map((p) => p.started)) : 0;
            const near = data.limit && s.peak >= data.limit * 0.8;
            verdict.className = near
                ? 'text-xs rounded-lg px-3 py-2 bg-red-900/20 border border-red-500/30 text-red-300 mb-2'
                : 'text-xs rounded-lg px-3 py-2 bg-black/20 border border-line text-ink-2 mb-2';
            verdict.innerHTML = near
                ? `<i class="fa-solid fa-triangle-exclamation mr-1"></i> <strong>Peak of ${s.peak} against a ` +
                  `limit of ${data.limit}.</strong> Executions are queueing behind the ceiling rather than ` +
                  `starting when they are triggered — check the queue lag above.`
                : `<i class="fa-solid fa-circle-info mr-1"></i> The busiest bucket <em>started</em> ` +
                  `${fmtNum(perBucket)} executions but never had more than <strong>${s.peak}</strong> running ` +
                  `at once, because the median one finishes in a fraction of a second. ` +
                  `Volume is not load: this instance is busy ${s.busy_pct}% of the time.`;
        }

        // Executions that ended at an unknown moment are left out entirely
        // rather than treated as still running, which would add a permanent
        // extra slot to every bucket after them.
        const unresolved = document.getElementById('concUnresolved');
        if (unresolved) {
            if (s.unresolved > 0) {
                unresolved.classList.remove('hidden');
                unresolved.innerHTML = `<i class="fa-solid fa-circle-question mr-1"></i> ` +
                    `${fmtNum(s.unresolved)} execution(s) in this window finished at an unrecorded time and are ` +
                    `excluded — counting them as still running would add a slot to every bucket since.`;
            } else {
                unresolved.classList.add('hidden');
            }
        }

        const labels = data.series.map((p) => p.time_val);

        concurrencyChart.data.labels = labels;
        concurrencyChart.data.datasets[0].data = data.series.map((p) => p.peak);
        concurrencyChart.data.datasets[1].data = data.series.map((p) => p.avg);

        // The arrivals moved to their own plot below, sharing this x axis. See
        // the note in initCharts: two measures on two scales are two charts,
        // never two axes on one.
        if (startedChart) {
            startedChart.data.labels = labels;
            startedChart.data.datasets[0].data = data.series.map((p) => p.started);
            window.Viz.setEmpty(startedChart, labels.length > 0, 'No executions started',
                'Nothing began in this window.');
            startedChart.update();
        }
        // The ceiling as a flat dataset rather than an annotation plugin: one
        // fewer vendored library for a horizontal line, and it disappears
        // cleanly when no limit has been configured.
        const limitSet = concurrencyChart.data.datasets[2];
        limitSet.data = data.limit ? data.series.map(() => data.limit) : [];
        limitSet.hidden = !data.limit;
        concurrencyChart.update();
    } catch (err) {
        console.error('[INSIGHTS] concurrency:', err);
    }
}

// ── F-09 · Silent death ──────────────────────────────────────

/** A duration in seconds, at whatever unit keeps it readable. */
function fmtDuration(seconds) {
    const v = Number(seconds) || 0;
    if (v < 90) return `${Math.round(v)}s`;
    if (v < 5400) return `${Math.round(v / 60)}m`;
    if (v < 172800) return `${(v / 3600).toFixed(1)}h`;
    return `${(v / 86400).toFixed(1)}d`;
}

const SILENCE_STATE = {
    silent: { label: 'Silent', cls: 'bg-rose-900/30 text-rose-300' },
    'stopped-after-change': { label: 'Stopped after an edit', cls: 'bg-amber-900/30 text-amber-300' },
    dormant: { label: 'Dormant', cls: 'bg-amber-900/20 text-amber-400/90' },
    never: { label: 'Never observed', cls: 'bg-gray-800 text-ink-2' }
};

async function loadSilentWorkflows() {
    const tbody = document.getElementById('silenceBody');
    try {
        const k = document.getElementById('silenceK')?.value || 3;
        const res = await fetchWithAuth(`/api/analytics/silent-workflows?k=${encodeURIComponent(k)}`);
        if (!res.ok) throw new Error('silent-workflows');
        const data = await res.json();

        setText('silentCount', fmtNum(data.silent.length));
        setText('dormantCount', fmtNum(data.dormant.length));
        setText('neverCount', fmtNum(data.never_observed.length));
        setText('runningCount', fmtNum(data.running.length));
        setText('silenceAsOf', data.data_as_of
            ? `as of ${window.formatTime(data.data_as_of, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
            : '');

        // The guard that makes this panel trustworthy, said out loud.
        //
        // Silence is measured against the newest execution the replica holds, not
        // against the clock. When the ETL falls behind, every scheduled workflow
        // would otherwise look dead at once — the first version of this flagged
        // five simultaneously during a three-hour sync outage, and all five were
        // running perfectly.
        const stale = document.getElementById('silenceStale');
        if (stale) {
            const lagMin = data.replica_lag_ms ? data.replica_lag_ms / 60000 : 0;
            if (lagMin > 15) {
                stale.classList.remove('hidden');
                stale.innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-1"></i> ` +
                    `The replica is <strong>${fmtDuration(data.replica_lag_ms / 1000)}</strong> behind. ` +
                    `Silence below is measured against the newest execution actually synced, not against ` +
                    `now — otherwise a stalled sync would report every scheduled workflow as dead.`;
            } else {
                stale.classList.add('hidden');
            }
        }

        const rows = [
            ...data.silent,
            ...data.dormant,
            ...data.never_observed.map((w) => ({ ...w, verdict: 'never' }))
        ];

        tbody.innerHTML = rows.length ? rows.map((w) => {
            const state = SILENCE_STATE[w.verdict] || SILENCE_STATE.dormant;
            // Which source last saw it run. "n8n counter" means the replica has
            // no execution row for it — the row was pruned — so the absence of
            // executions here is not evidence that it stopped.
            const evidence = w.verdict === 'never'
                ? `<span class="text-ink-3">no execution ever recorded</span>`
                : `<span class="text-ink-3">last seen via ${escapeHtml(w.last_run_source || 'execution')}</span>` +
                  (w.changed_since_last_run
                      ? ' <span class="text-amber-400/90">· edited since</span>' : '');
            return `
                <tr class="hover:bg-gray-800/30 transition-colors">
                    <td class="p-3 text-sm text-ink-1 max-w-[240px] truncate">${escapeHtml(w.name)}</td>
                    <td class="p-3"><span class="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded ${state.cls}">${state.label}</span></td>
                    <td class="p-3 text-right font-mono text-xs text-ink-2">${
    w.median_gap_s ? fmtDuration(w.median_gap_s) : '—'}</td>
                    <td class="p-3 text-right font-mono text-xs text-white">${
    w.silent_for_s === undefined ? '—' : fmtDuration(w.silent_for_s)}</td>
                    <td class="p-3 text-right font-mono text-xs ${
    w.overdue_ratio > 10 ? 'text-rose-400 font-bold' : 'text-ink-2'}">${
    w.overdue_ratio === undefined ? '—' : w.overdue_ratio + '×'}</td>
                    <td class="p-3 text-[11px]">${evidence}</td>
                </tr>`;
        }).join('')
            : `<tr><td colspan="6" class="p-8 text-center text-green-400/70 text-sm italic">
                   Every active workflow is running on schedule.</td></tr>`;
    } catch (err) {
        console.error('[INSIGHTS] silent workflows:', err);
        tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-red-400/80 text-sm italic">
            Could not check for silent workflows</td></tr>`;
    }
}

// ── F-05 · Reliability ───────────────────────────────────────

async function loadReliability() {
    try {
        const res = await fetchWithAuth(`/api/analytics/reliability?${rangeQuery()}`);
        if (!res.ok) throw new Error('reliability');
        const data = await res.json();

        renderCoverage(document.getElementById('reliabilityCoverage'), data.coverage);

        setText('relRawRate', fmtPct(data.raw.rate));
        setText('relRawCount', `${fmtNum(data.raw.failures)} of ${fmtNum(data.first_attempts)} first attempts`);
        setText('relEffRate', fmtPct(data.effective.rate));
        setText('relRetries', fmtNum(data.retry_attempts));
        setText('relHealed', fmtNum(data.self_healed));
        setText('relWaiting', fmtNum(data.waiting));

        const rawEl = document.getElementById('relRawRate');
        const effEl = document.getElementById('relEffRate');
        if (rawEl) rawEl.className = `text-3xl font-bold ${rateClass(data.raw.rate)}`;
        if (effEl) effEl.className = `text-3xl font-bold ${rateClass(data.effective.rate)}`;

        // The two rates are identical while retries are switched off. Saying so
        // is more useful than showing the same number twice without comment —
        // and it names the condition under which they will start to diverge.
        const note = document.getElementById('relNote');
        if (note) {
            note.innerHTML = data.retry_attempts === 0
                ? `<i class="fa-solid fa-circle-info mr-1 text-ink-3"></i> No retries ran in this window, ` +
                  `so the raw and effective rates are the same number. They separate as soon as ` +
                  `retries are enabled on a workflow — at which point a failure that succeeded on ` +
                  `the second attempt stops being counted as an outage.`
                : `<i class="fa-solid fa-rotate mr-1 text-indigo-400"></i> ` +
                  `${fmtNum(data.self_healed)} of ${fmtNum(data.raw.failures)} failures recovered on a retry ` +
                  `(${data.recovery_rate}%). The effective rate is what a caller actually experienced.`;
        }

        // `finished` is currently a restatement of `status` on this instance.
        // The panel says so rather than presenting it as a discovery, and will
        // start reporting a real number the day the two disagree.
        const fin = data.finished || {};
        const finEl = document.getElementById('relFinished');
        if (finEl) {
            const odd = (fin.unfinished_success || 0) + (fin.finished_failure || 0);
            finEl.innerHTML = odd === 0
                ? `<span class="text-ink-3">${fmtNum(fin.unfinished)} executions stopped without finishing — ` +
                  `exactly the set that failed or was canceled, so nothing here contradicts the status column.</span>`
                : `<span class="text-amber-400">${fmtNum(odd)} executions disagree with their own status: ` +
                  `${fmtNum(fin.unfinished_success)} succeeded without finishing, ` +
                  `${fmtNum(fin.finished_failure)} finished while failing.</span>`;
        }

        const storms = document.getElementById('stormsPanel');
        if (storms) {
            if (!data.storms.length) {
                storms.classList.add('hidden');
            } else {
                storms.classList.remove('hidden');
                document.getElementById('stormsBody').innerHTML = data.storms.map((s) => `
                    <tr class="hover:bg-gray-800/30">
                        <td class="p-3 text-sm text-ink-1">${escapeHtml(s.name)}
                            ${archivedBadge(s.is_archived)}</td>
                        <td class="p-3 text-right font-mono text-xs text-amber-400">${fmtNum(s.retries)}</td>
                        <td class="p-3 text-right font-mono text-xs text-green-400">${fmtNum(s.recovered)}</td>
                        <td class="p-3 text-right text-xs text-ink-3">
                            ${escapeHtml(window.formatTime(s.last_retry, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}</td>
                    </tr>`).join('');
            }
        }
    } catch (err) {
        console.error('[INSIGHTS] reliability:', err);
    }
}

// ── F-16 · Organisation ──────────────────────────────────────

// Filled once from the first organisation response, so the pickers know what
// exists without a second request.
let filtersPopulated = false;

async function loadOrganisation() {
    const folderBody = document.getElementById('folderBody');
    const tagBody = document.getElementById('tagBody');
    try {
        const res = await fetchWithAuth(`/api/analytics/organisation?${rangeQuery()}`);
        if (!res.ok) throw new Error('organisation');
        const data = await res.json();

        // Populated from the unfiltered first load. Rebuilding them from a
        // filtered response would remove the very option the user just picked.
        if (!filtersPopulated) {
            fillFilter('folderFilter', data.folders.filter((f) => f.id), (f) => [f.id, f.name]);
            fillFilter('tagFilter', data.tags, (t) => [t.id, t.name]);
            filtersPopulated = true;
        }

        folderBody.innerHTML = data.folders.length ? data.folders.map((f) => `
            <tr class="hover:bg-gray-800/30 transition-colors">
                <td class="p-3 text-sm text-ink-1">
                    ${f.parent_folder_id ? '<span class="text-ink-3 mr-1">└</span>' : ''}${escapeHtml(f.name)}
                </td>
                <td class="p-3 text-right font-mono text-xs text-ink-2">${fmtNum(f.total_workflows)}</td>
                <td class="p-3 text-right font-mono text-xs text-white">${fmtNum(f.total_executions)}</td>
                <td class="p-3 text-right font-mono text-xs ${rateClass(f.error_rate)}">${fmtPct(f.error_rate)}</td>
            </tr>`).join('')
            : emptyRow(4, 'No folders');

        tagBody.innerHTML = data.tags.length ? data.tags.map((t) => `
            <tr class="hover:bg-gray-800/30 transition-colors">
                <td class="p-3 text-sm text-ink-1">${escapeHtml(t.name)}</td>
                <td class="p-3 text-right font-mono text-xs text-ink-2">${fmtNum(t.workflows)}</td>
                <td class="p-3 text-right font-mono text-xs text-white">${fmtNum(t.executions)}</td>
                <td class="p-3 text-right font-mono text-xs ${rateClass(t.error_rate)}">${fmtPct(t.error_rate)}</td>
            </tr>`).join('')
            : emptyRow(4, 'No tags');
    } catch (err) {
        console.error('[INSIGHTS] organisation:', err);
        folderBody.innerHTML = emptyRow(4, 'Could not load folders');
    }
}

function fillFilter(id, items, pick) {
    const el = document.getElementById(id);
    if (!el) return;
    const current = el.value;
    while (el.options.length > 1) el.remove(1);
    for (const item of items) {
        const [value, label] = pick(item);
        const opt = document.createElement('option');
        opt.value = value;
        opt.innerText = label;
        el.appendChild(opt);
    }
    if (current) el.value = current;
}

const emptyRow = (cols, message) =>
    `<tr><td colspan="${cols}" class="p-8 text-center text-ink-3 text-sm italic">${message}</td></tr>`;

// ── F-10 · Blast radius ──────────────────────────────────────

async function loadDependencies() {
    const tbody = document.getElementById('credentialBody');
    try {
        const res = await fetchWithAuth(`/api/analytics/dependencies?${rangeQuery()}`);
        if (!res.ok) throw new Error('dependencies');
        const data = await res.json();

        tbody.innerHTML = data.credentials.length ? data.credentials.map((c) => `
            <tr class="hover:bg-gray-800/30 transition-colors" title="${escapeHtml(c.workflow_names.join(', '))}">
                <td class="p-3 text-sm text-ink-1">${escapeHtml(c.name)}</td>
                <td class="p-3 text-[11px] text-ink-3 font-mono">${escapeHtml(c.type || '—')}</td>
                <td class="p-3 text-right font-mono text-xs ${
    c.workflows >= 10 ? 'text-amber-400 font-bold' : 'text-ink-2'}">${fmtNum(c.workflows)}</td>
                <td class="p-3 text-right font-mono text-xs text-ink-2">${fmtNum(c.executions)}</td>
                <td class="p-3 text-right font-mono text-xs ${rateClass(c.error_rate)}">${fmtPct(c.error_rate)}</td>
            </tr>`).join('')
            : emptyRow(5, 'No credential dependencies recorded');

        // Sub-workflow and error-workflow edges. Only shown when there are any —
        // an empty box titled "workflows that depend on other workflows" tells
        // the reader nothing they did not already know.
        const panel = document.getElementById('callGraph');
        const body = document.getElementById('callGraphBody');
        if (panel && body) {
            panel.classList.toggle('hidden', data.calls.length === 0);
            body.innerHTML = data.calls.map((c) => `
                <div class="flex items-center gap-2 text-ink-2">
                    <span class="text-ink-1">${escapeHtml(c.parent_name || c.parent_id)}</span>
                    <span class="text-ink-3">${c.kind === 'errorWorkflow' ? 'reports failures to' : 'calls'}</span>
                    <span class="text-indigo-300">${escapeHtml(c.child_name || c.child_id)}</span>
                </div>`).join('');
        }
    } catch (err) {
        console.error('[INSIGHTS] dependencies:', err);
        tbody.innerHTML = emptyRow(5, 'Could not load dependencies');
    }
}

// ── F-12 · Node level ────────────────────────────────────────

/**
 * Where a workflow's time goes, node by node.
 *
 * Every figure here is per execution and comes from a small sample, so the
 * panel leads with the sample rather than burying it: a "slowest nodes" list
 * drawn from a third of the instance looks exactly like one drawn from all of
 * it, and only one of those is worth acting on.
 */
async function loadNodeProfile() {
    const wfBody = document.getElementById('profileWorkflowBody');
    const nodeBody = document.getElementById('profileNodeBody');
    const flowPanel = document.getElementById('profileFlow');
    const flowBody = document.getElementById('profileFlowBody');
    const note = document.getElementById('profileNote');

    try {
        const res = await fetchWithAuth('/api/analytics/node-profile');
        if (!res.ok) throw new Error('node-profile');
        const data = await res.json();

        if (note) {
            const c = data.coverage;
            const age = c.oldest_sample
                ? window.formatTime(c.oldest_sample, {
                    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
                }) : null;
            note.innerHTML =
                `<i class="fa-solid fa-flask mr-2 text-cyan-400/80"></i>` +
                `${escapeHtml(c.note)}` +
                (age ? ` Oldest sample taken ${escapeHtml(age)}.` : '') +
                (c.unreadable_executions
                    ? ` ${fmtNum(c.unreadable_executions)} execution(s) had no readable trace.` : '');
        }

        wfBody.innerHTML = data.workflows.length ? data.workflows.map((w) => `
            <tr class="hover:bg-gray-800/30 transition-colors">
                <td class="p-3 text-sm text-ink-1">${escapeHtml(w.workflow_name)}${
    archivedBadge(w.is_archived)}
                    <span class="block text-[10px] text-ink-3">${w.nodes} nodes ·
                    sample of ${w.executions_sampled}</span></td>
                <td class="p-3 text-right font-mono text-xs text-ink-1">${fmtMs(w.ms_per_execution)}</td>
                <td class="p-3 text-[11px] text-cyan-300">${escapeHtml(w.top_node || '—')}</td>
                <td class="p-3 text-right font-mono text-xs ${
    w.top_share >= 75 ? 'text-amber-400 font-bold' : 'text-ink-2'}">${
    w.top_share === null ? '—' : w.top_share + '%'}</td>
            </tr>`).join('')
            : emptyRow(4, 'No workflow has been profiled yet');

        nodeBody.innerHTML = data.nodes.length ? data.nodes.map((n) => `
            <tr class="hover:bg-gray-800/30 transition-colors">
                <td class="p-3 text-sm text-ink-1">${escapeHtml(n.node_name)}${
    // A chat model or a memory never writes to the main output, so it has no
    // item count. Saying which kind of node it is beats an unexplained dash.
    n.is_sub_node ? '<span class="ml-2 text-[9px] uppercase tracking-widest px-1.5 py-0.5 ' +
        'rounded bg-purple-900/40 text-purple-300">sub-node</span>' : ''}${
    n.failed_runs ? '<span class="ml-2 text-[9px] uppercase tracking-widest px-1.5 py-0.5 ' +
        `rounded bg-rose-900/40 text-rose-300">${n.failed_runs} failed</span>` : ''}
                    <span class="block text-[10px] text-ink-3">${escapeHtml(n.workflow_name)}</span></td>
                <td class="p-3 text-right font-mono text-xs text-ink-1">${fmtMs(n.ms_per_execution)}</td>
                <td class="p-3 text-right font-mono text-xs ${
    n.runs_per_execution > 1 ? 'text-amber-300' : 'text-ink-3'}">${n.runs_per_execution}&times;</td>
                <td class="p-3 text-right font-mono text-xs text-ink-3">${
    n.items_per_execution === null ? '—' : fmtNum(n.items_per_execution)}</td>
            </tr>`).join('')
            : emptyRow(4, 'No node timings yet');

        if (flowPanel && flowBody) {
            flowPanel.classList.toggle('hidden', data.flow.length === 0);
            flowBody.innerHTML = data.flow.map((e) => {
                const grew = e.ratio > 1;
                return `
                <tr class="hover:bg-gray-800/30 transition-colors">
                    <td class="p-3 text-[11px] text-ink-2">${escapeHtml(e.workflow_name)}</td>
                    <td class="p-3 text-sm text-ink-1">${escapeHtml(e.from_node)}
                        <i class="fa-solid fa-arrow-right-long mx-2 text-ink-3"></i>${
    escapeHtml(e.to_node)}</td>
                    <td class="p-3 text-right font-mono text-xs text-ink-2">${fmtNum(e.items_in)}</td>
                    <td class="p-3 text-right font-mono text-xs text-ink-2">${fmtNum(e.items_out)}</td>
                    <td class="p-3 text-right font-mono text-xs ${
    grew ? 'text-sky-300' : 'text-amber-300'}">${grew ? '×' + e.ratio : '×' + e.ratio}</td>
                </tr>`;
            }).join('');
        }
    } catch (err) {
        console.error('[INSIGHTS] node profile:', err);
        wfBody.innerHTML = emptyRow(4, 'Could not load the node profile');
        nodeBody.innerHTML = emptyRow(4, 'Could not load the node profile');
    }
}

// ── F-11 · Deploys ───────────────────────────────────────────

async function loadInsightDeploys() {
    const tbody = document.getElementById('deployBody');
    try {
        const autosaves = document.getElementById('includeAutosaves')?.checked ? '&autosaves=true' : '';
        const res = await fetchWithAuth(`/api/analytics/deploys?${rangeQuery()}${autosaves}`);
        if (!res.ok) throw new Error('deploys');
        const data = await res.json();

        renderCoverage(document.getElementById('deployCoverage'), data.coverage);

        const ran = data.deploys.filter((d) => d.executions > 0);
        const rows = ran.length ? ran : data.deploys;

        tbody.innerHTML = rows.length ? rows.slice(0, 40).map((d) => {
            // Only meaningful against another version of the SAME workflow. The
            // endpoint pairs them per workflow; a global "previous row" would
            // compare two unrelated automations and read as a regression that
            // never happened.
            const delta = d.error_rate_delta === undefined || d.error_rate_delta === null
                ? '<span class="text-ink-3">first measured</span>'
                : d.error_rate_delta > 0
                    ? `<span class="text-red-400">+${d.error_rate_delta}pp</span>`
                    : d.error_rate_delta < 0
                        ? `<span class="text-green-400">${d.error_rate_delta}pp</span>`
                        : '<span class="text-ink-3">no change</span>';
            return `
                <tr class="hover:bg-gray-800/30 transition-colors">
                    <td class="p-3 text-[11px] text-ink-2">${escapeHtml(window.formatTime(d.created_at,
        { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}</td>
                    <td class="p-3 text-sm text-ink-1 max-w-[200px] truncate">${escapeHtml(d.workflow_name || '—')}${
    d.autosaved ? ' <span class="text-[9px] text-ink-3 uppercase">autosave</span>' : ''}</td>
                    <td class="p-3 text-[11px] text-ink-2">${escapeHtml(d.authors || '—')}</td>
                    <td class="p-3 text-right font-mono text-xs text-ink-2">${fmtNum(d.executions)}</td>
                    <td class="p-3 text-right font-mono text-xs ${
    d.error_rate === null ? 'text-ink-3' : rateClass(d.error_rate)}">${
    d.error_rate === null ? '—' : fmtPct(d.error_rate)}</td>
                    <td class="p-3 text-right text-[11px]">${delta}</td>
                </tr>`;
        }).join('')
            : emptyRow(6, 'No saved versions in this window');
    } catch (err) {
        console.error('[INSIGHTS] deploys:', err);
        tbody.innerHTML = emptyRow(6, 'Could not load deploys');
    }
}

// ── F-18 · Business metadata ─────────────────────────────────

async function loadMetadata() {
    const section = document.getElementById('metadataSection');
    const tbody = document.getElementById('metadataBody');
    try {
        const res = await fetchWithAuth('/api/analytics/metadata');
        if (!res.ok) throw new Error('metadata');
        const data = await res.json();

        // Hidden entirely when nothing writes metadata. An empty table here is
        // not information; it is an invitation to wonder what is broken.
        if (!data.keys.length) {
            section?.classList.add('hidden');
            return;
        }
        section?.classList.remove('hidden');

        tbody.innerHTML = data.keys.map((k) => {
            const usable = k.distinct_values <= data.max_values_per_key;
            return `
            <tr class="hover:bg-gray-800/30 transition-colors">
                <td class="p-3 text-sm text-ink-1 font-mono">${escapeHtml(k.key)}</td>
                <td class="p-3 text-right font-mono text-xs text-ink-2">${fmtNum(k.occurrences)}</td>
                <td class="p-3 text-right font-mono text-xs text-ink-2">${fmtNum(k.distinct_values)}</td>
                <td class="p-3 text-[11px] ${usable ? 'text-green-400/80' : 'text-ink-3'}">${
    usable ? 'yes' : `too many distinct values (over ${data.max_values_per_key}) — this is a payload field, not a facet`
}</td>
            </tr>`;
        }).join('');
    } catch (err) {
        console.error('[INSIGHTS] metadata:', err);
    }
}

// ── F-04 · Storage growth ────────────────────────────────────

async function loadStorage() {
    const tbody = document.getElementById('storageBody');
    try {
        const days = document.getElementById('storageDays')?.value || 30;
        const res = await fetchWithAuth(`/api/analytics/storage?days=${encodeURIComponent(days)}`);
        if (!res.ok) throw new Error('storage');
        const data = await res.json();

        const t = data.totals;
        const f = data.forecast || {};

        setText('storeRetained', fmtBytes(t.retained_bytes));
        setText('storeExecutions', data.source_bounded
            ? `${fmtNum(t.executions)} executions retained by n8n`
            : `${fmtNum(t.executions)} executions with a recorded size`);

        // Until an ETL cycle has reported where n8n's pruning stands, this panel
        // is measuring the replica's own history instead of the source's — which
        // is a larger number, and would read as unchecked growth.
        const bound = document.getElementById('storeUnbounded');
        if (bound) bound.classList.toggle('hidden', !!data.source_bounded);
        setText('storeDaily', f.known ? fmtBytes(f.daily_bytes) : '—');
        setText('storeRetention', f.known ? `${f.retention_days.toFixed(1)} days` : '—');
        setText('storeEquilibrium', f.known ? fmtBytes(f.equilibrium_bytes) : '—');

        // The headline sentence. It is the whole value of this panel: a bytes
        // figure with no reading attached invites the wrong one, which here is
        // "180 MB a day, therefore 5 GB by autumn" — and n8n is pruning, so that
        // is false.
        const verdict = document.getElementById('storeVerdict');
        if (verdict) {
            if (!f.known) {
                verdict.className = 'text-xs rounded-lg px-3 py-2 bg-black/20 border border-line text-ink-3';
                verdict.textContent = f.reason ? `Not enough history yet — ${f.reason}.` : 'Not enough history yet.';
            } else if (!f.pruning) {
                const p = f.projection || {};
                verdict.className = 'text-xs rounded-lg px-3 py-2 bg-amber-900/20 border border-amber-500/30 text-amber-200';
                verdict.innerHTML = `<i class="fa-solid fa-arrow-trend-up mr-1"></i> ` +
                    `<strong>Nothing is being pruned.</strong> At ${fmtBytes(f.daily_bytes)} a day this reaches ` +
                    `${fmtBytes(p.in_30_days)} in a month and ${fmtBytes(p.in_90_days)} in three` +
                    (p.days_to_5gb ? `, crossing 5 GB in about ${p.days_to_5gb} days` : '') + '.';
            } else {
                const filling = f.headroom_bytes > f.daily_bytes;
                const shrinking = f.headroom_bytes < -f.daily_bytes;
                verdict.className = filling
                    ? 'text-xs rounded-lg px-3 py-2 bg-amber-900/20 border border-amber-500/30 text-amber-200'
                    : 'text-xs rounded-lg px-3 py-2 bg-green-900/10 border border-green-500/20 text-green-200/90';
                const state = filling
                    ? `still filling — about ${fmtBytes(f.headroom_bytes)} of growth left before it levels off`
                    : shrinking
                        ? `shrinking — recent days are lighter than what is being pruned`
                        : `at equilibrium: as much is pruned each day as is written`;
                verdict.innerHTML = `<i class="fa-solid fa-scale-balanced mr-1"></i> ` +
                    `<strong>n8n is pruning at about ${f.retention_days.toFixed(0)} days.</strong> ` +
                    `${fmtBytes(f.daily_bytes)} a day over ${f.days_measured} measured days puts the store ` +
                    `${state}. Settling point ≈ ${fmtBytes(f.equilibrium_bytes)}.`;
            }
        }

        // A trend worth naming only when it would move the equilibrium
        // measurably over the retention window it applies to.
        const trend = document.getElementById('storeTrend');
        if (trend) {
            if (f.known && f.retention_days &&
                Math.abs(f.trend_bytes_per_day * f.retention_days) > f.daily_bytes * 0.5) {
                const up = f.trend_bytes_per_day > 0;
                trend.classList.remove('hidden');
                trend.innerHTML = `<i class="fa-solid fa-${up ? 'arrow-up' : 'arrow-down'} mr-1"></i> ` +
                    `Daily volume is ${up ? 'rising' : 'falling'} by ${fmtBytes(Math.abs(f.trend_bytes_per_day))} ` +
                    `per day, which moves the settling point by about ` +
                    `${fmtBytes(Math.abs(f.trend_bytes_per_day * f.retention_days))} over one retention window.`;
            } else {
                trend.classList.add('hidden');
            }
        }

        tbody.innerHTML = data.byWorkflow.length
            ? data.byWorkflow.map((w) => `
                <tr class="hover:bg-gray-800/30 transition-colors">
                    <td class="p-3 text-sm text-ink-1 max-w-[240px] truncate">
                        ${escapeHtml(w.name)}${archivedBadge(w.is_archived)}</td>
                    <td class="p-3 text-right font-mono text-xs text-ink-2">${fmtNum(w.runs)}</td>
                    <td class="p-3 text-right font-mono text-xs text-white">${fmtBytes(w.bytes)}</td>
                    <td class="p-3 text-right font-mono text-xs ${
    w.avg_json_bytes > 1048576 ? 'text-amber-400 font-bold' : 'text-ink-2'
}">${fmtBytes(w.avg_json_bytes)}</td>
                    <td class="p-3 w-40">
                        <div class="flex items-center gap-2">
                            <div class="flex-1 h-1.5 bg-black/40 rounded overflow-hidden">
                                <div class="h-full bg-indigo-500/70" style="width:${Math.min(100, w.pct)}%"></div>
                            </div>
                            <span class="text-[10px] text-ink-3 font-mono w-10 text-right">${w.pct}%</span>
                        </div>
                    </td>
                </tr>`).join('')
            : `<tr><td colspan="5" class="p-8 text-center text-ink-3 text-sm italic">
                   No payload sizes recorded yet</td></tr>`;

        storageChart.data.labels = data.daily.map((d) => d.day);
        storageChart.data.datasets[0].data = data.daily.map((d) => (d.json_bytes || 0) / 1048576);
        storageChart.data.datasets[1].data = data.daily.map((d) => (d.binary_bytes || 0) / 1048576);
        storageChart.update();
    } catch (err) {
        console.error('[INSIGHTS] storage:', err);
        tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-red-400/80 text-sm italic">
            Could not load storage figures</td></tr>`;
    }
}

// ── Shared bits ──────────────────────────────────────────────

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function archivedBadge(isArchived) {
    return isArchived
        ? ' <span class="text-[9px] uppercase tracking-widest text-ink-3 border border-line-2 ' +
          'rounded px-1 py-0.5 ml-1">archived</span>'
        : '';
}

function emptyPanel(icon, message) {
    return `<div class="col-span-full p-10 text-center text-ink-3 text-sm italic">
        <i class="fa-solid ${icon} text-3xl mb-3 opacity-20 block"></i>${escapeHtml(message)}</div>`;
}

// ── Charts ───────────────────────────────────────────────────

function initCharts() {
    if (typeof Chart === 'undefined') return;
    const V = window.Viz;

    // Colours, fonts, grid, tooltip styling, legend placement and interaction
    // all come from ui/viz.js. This function is down to what each chart plots.
    // The eleven-panel page had four charts and four private copies of that
    // chrome, one of which set `Chart.defaults.color` globally and therefore
    // reached into every other chart on the page (F-24 §1).

    const volumeEl = document.getElementById('volumeByModeChart');
    if (volumeEl) {
        volumeChart = new Chart(volumeEl.getContext('2d'), {
            type: 'line',
            data: { labels: [], datasets: [] },
            options: {
                plugins: {
                    legend: { position: 'bottom' },
                    tooltip: {
                        callbacks: {
                            title: (items) => (items.length
                                ? window.formatTime(items[0].label,
                                    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                : ''),
                            label: (ctx) => ` ${ctx.dataset.label}: ${V.unit('count').fmt(ctx.parsed.y)}`
                        }
                    }
                },
                scales: {
                    y: V.yAxis({ unit: 'count', stacked: true, title: 'Executions' }),
                    x: V.xTimeAxis({ format: { month: 'short', day: 'numeric' }, maxTicks: 10 })
                }
            }
        });
        V.enableBrush(volumeChart, volumeEl.parentElement);
    }

    const lagEl = document.getElementById('lagChart');
    if (lagEl) {
        const t = V.tokens();
        lagChart = new Chart(lagEl.getContext('2d'), {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    // An ordered set — p50 < p95 < p99 — so it takes the ordinal
                    // reading of the status ramp rather than three unrelated
                    // categorical hues: as the percentile gets worse the colour
                    // gets more alarming, which is information the old
                    // green/amber/red already carried by accident.
                    { label: 'p50 (typical)', data: [], borderColor: t.good, borderWidth: 1.5, fill: false },
                    { label: 'p95', data: [], borderColor: t.warning, borderWidth: 2, fill: false },
                    { label: 'p99 (worst)', data: [], borderColor: t.critical, borderWidth: 1.5, fill: false }
                ]
            },
            options: {
                // Gaps are real: a bucket with no executions has no percentile,
                // and joining across it would invent a measurement.
                spanGaps: false,
                plugins: {
                    legend: { position: 'bottom' },
                    tooltip: {
                        callbacks: {
                            title: (items) => (items.length
                                ? window.formatTime(items[0].label,
                                    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                : ''),
                            label: (ctx) => ` ${ctx.dataset.label}: ${V.unit('ms').fmt(ctx.parsed.y)}`
                        }
                    }
                },
                scales: {
                    y: V.yAxis({ unit: 'ms', title: 'Wait before starting' }),
                    x: V.xTimeAxis({ format: { month: 'short', day: 'numeric' }, maxTicks: 10 })
                }
            }
        });
        V.enableBrush(lagChart, lagEl.parentElement);
    }

    // ── Concurrency: two charts, not two axes ────────────────────────────
    //
    // This was one chart with `y` on the left for simultaneous executions and
    // `y1` on the right for executions started, and a comment defending it:
    // "the whole point of the panel is that these two series live on different
    // scales."
    //
    // That is the argument for two axes and it is the reason not to have them.
    // Where the two scales line up is arbitrary — it falls out of the two
    // maxima — so the chart draws a relationship between occupancy and arrivals
    // that is an artefact of the axis choice and not a fact about the
    // instance. Nudge either range and the "correlation" moves.
    //
    // The prescribed alternative is small multiples: two plots, one x axis,
    // read by looking down instead of across. The comparison the panel exists
    // for survives — a spike in arrivals still sits directly above the
    // occupancy at that moment — and nothing is implied about their ratio.
    const concEl = document.getElementById('concurrencyInsightChart');
    if (concEl) {
        const t = V.tokens();
        concurrencyChart = new Chart(concEl.getContext('2d'), {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Peak simultaneous', data: [],
                        borderColor: V.series(6), borderWidth: 2,
                        // Stepped, because concurrency is an integer count that
                        // changes at instants. A smoothed curve through 1, 3, 1
                        // draws values like 2.4 that never existed.
                        stepped: true, fill: false
                    },
                    {
                        label: 'Average occupancy', data: [],
                        borderColor: V.series(2), borderWidth: 1.5,
                        borderDash: [4, 3], fill: false
                    },
                    {
                        label: 'Configured limit', data: [], hidden: true,
                        borderColor: t.critical, borderWidth: 1.5, borderDash: [8, 4], fill: false
                    }
                ]
            },
            options: {
                plugins: {
                    legend: { position: 'bottom' },
                    tooltip: {
                        callbacks: {
                            title: (items) => (items.length
                                ? window.formatTime(items[0].label,
                                    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                : '')
                        }
                    }
                },
                scales: {
                    y: V.yAxis({ unit: 'count', title: 'Running at once', maxTicks: 5 }),
                    // The top chart hides its tick labels: the axis underneath
                    // is the same axis, and printing it twice is noise between
                    // two plots that are meant to be read as one.
                    x: { ...V.xTimeAxis({ format: { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } }),
                        ticks: { display: false } }
                }
            }
        });
    }

    const startedEl = document.getElementById('concurrencyStartedChart');
    if (startedEl) {
        startedChart = new Chart(startedEl.getContext('2d'), {
            type: 'bar',
            data: {
                labels: [],
                datasets: [{ label: 'Executions started', data: [], backgroundColor: V.series(0) }]
            },
            options: {
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: (items) => (items.length
                                ? window.formatTime(items[0].label,
                                    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                : ''),
                            label: (ctx) => ` ${V.unit('count').fmt(ctx.parsed.y)} started`
                        }
                    }
                },
                scales: {
                    y: V.yAxis({ unit: 'count', title: 'Started', maxTicks: 4 }),
                    x: V.xTimeAxis({ format: { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } })
                }
            }
        });
    }

    const storageEl = document.getElementById('storageChart');
    if (storageEl) {
        storageChart = new Chart(storageEl.getContext('2d'), {
            type: 'bar',
            data: {
                labels: [],
                datasets: [
                    { label: 'JSON', data: [], backgroundColor: V.series(0) },
                    { label: 'Binary', data: [], backgroundColor: V.series(2) }
                ]
            },
            options: {
                plugins: {
                    legend: { position: 'bottom' },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} MB`
                        }
                    }
                },
                scales: {
                    // Day keys are plain YYYY-MM-DD, already the calendar day the
                    // bytes belong to — no timezone conversion, which would shift
                    // a day's payload into its neighbour.
                    x: { ...V.xTimeAxis({ format: { month: 'short', day: 'numeric' }, maxTicks: 12 }), stacked: true },
                    y: V.yAxis({ stacked: true, title: 'MB per day' })
                }
            }
        });
    }
}

// ── Exposed for insights_nav.js ──────────────────────────────
//
// The nav decides WHEN a panel loads; this file still decides HOW. Assigned
// rather than declared global so the boundary between the two is one visible
// list rather than eleven implicit ones.
Object.assign(window, {
    loadTriggers, loadQueueLag, loadConcurrency, loadSilentWorkflows, loadReliability,
    loadOrganisation, loadDependencies, loadInsightDeploys, loadMetadata,
    loadNodeProfile, loadStorage
});
