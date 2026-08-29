/**
 * Error Intelligence — F-24 §3.
 *
 * Four items land here, and they are all versions of the same complaint: the
 * page reported numbers and did not let anyone act on them.
 *
 *  1. The groups table was flat, with the Category column repeated on every
 *     row. A value repeated on every row is a heading that has not been
 *     promoted yet. It is sectioned now, with a per-category total, collapsible.
 *
 *  2. There was no trigger-type filter — and that was not a UI omission but the
 *     gap F-02 left: `?mode=` went onto four endpoints and not onto
 *     getErrorIntelligence. So we knew webhooks fail at 4.03% and schedules at
 *     0.82%, and could not see which errors belonged to which. Backend and
 *     control both exist now.
 *
 *  3. "Needs Attention" said 3,324 and "2 groups behave against their category"
 *     and stopped there — it never said what the number counted, never said
 *     what "against their category" meant, and did not lead anywhere, even
 *     though the `↯ relabelled` badges it was describing were right there in
 *     the rows below. It is a button now, it says what it counts, and it
 *     filters to the rows it is talking about.
 *
 *  4. An HTML error response rendered as `<!DOCTYPE html>…`. F-07 collapses
 *     these to `<HTML: {title}>` for the fingerprint; what is *shown* now goes
 *     through `UI.errorMessage`, which pulls out the title and the body text
 *     and keeps the markup behind "show raw".
 *
 * Everything visual — colours, badges, tables, empty states — comes from the
 * shared layer. This file has no hex codes in it.
 */

document.addEventListener('DOMContentLoaded', initErrorIntelligence);

// ── Category config ──────────────────────────────────────────
//
// Colour is no longer written here. Eight categories are pinned to the eight
// validated series slots in fixed order, so a category missing from today's
// data cannot shift the colour of every category after it the moment it comes
// back — and so the donut, the trend chart and the table headings agree without
// three copies of a palette.
const CATEGORY_CONFIG = {
    auth:       { label: 'Auth & Credentials', icon: 'fa-key',             nature: 'structural' },
    rate_limit: { label: 'Rate Limited',       icon: 'fa-gauge-high',      nature: 'transient'  },
    network:    { label: 'Network & Timeout',  icon: 'fa-wifi',            nature: 'transient'  },
    upstream:   { label: 'Upstream Error',     icon: 'fa-server',          nature: 'transient'  },
    config:     { label: 'Configuration',      icon: 'fa-gear',            nature: 'structural' },
    data:       { label: 'Data & Validation',  icon: 'fa-database',        nature: 'structural' },
    logic:      { label: 'Logic & Code',       icon: 'fa-code',            nature: 'structural' },
    unknown:    { label: 'Uncategorized',      icon: 'fa-circle-question', nature: 'unknown'    }
};

const ALL_CATEGORIES = Object.keys(CATEGORY_CONFIG);
window.Viz.pin('category', ALL_CATEGORIES);
const catColor = (key) => (key === 'unknown'
    // Uncategorized is an absence of classification, not a ninth kind of error.
    // Giving it a hue would put it in the same visual class as the seven real
    // categories and make "we do not know" look like a finding.
    ? window.Viz.tokens().ink3
    : window.Viz.colorFor('category', key));

// F-08. What the fingerprint has been observed to do, rather than what its
// category implies. 'unknown' is a real answer and says so: five occurrences is
// the floor below which a recovery rate means nothing.
const BEHAVIOUR = {
    transient:    { label: 'Self-healing', tone: 'good',     icon: 'fa-bolt',           title: 'Almost always passes on the next run' },
    intermittent: { label: 'Intermittent', tone: 'warning',  icon: 'fa-adjust',         title: 'Passes sometimes — worth watching' },
    structural:   { label: 'Needs a fix',  tone: 'critical', icon: 'fa-screwdriver-wrench', title: 'Has essentially never passed on its own' },
    unknown:      { label: 'Unproven',     tone: 'neutral',  icon: 'fa-circle-question', title: 'Too few occurrences to tell' }
};

// F-15. What someone decided about a fingerprint, as opposed to what it is
// doing. An error page that only ever grows is a page nobody reads; a decision
// is what takes a row off the list without pretending it did not happen.
const LIFECYCLE = {
    open:         { label: 'Open',         tone: 'neutral' },
    acknowledged: { label: 'Acknowledged', tone: 'brand' },
    resolved:     { label: 'Resolved',     tone: 'good' },
    ignored:      { label: 'Ignored',      tone: 'neutral' }
};

let trendChart = null;
let categoryChart = null;
let currentRange = { startDate: null, endDate: null };
let currentMode = '';
// Set by the Needs Attention tile. Not a server-side filter: it selects among
// rows already fetched, so toggling it costs no request and cannot disagree
// with the totals above it.
let showOnlyRelabelled = false;
let lastGroups = [];
let lastDeploys = [];

// ── Initialization ───────────────────────────────────────────
async function initErrorIntelligence() {
    // Every value this page renders is a timestamp, so the timezone has to be
    // known before the first one is drawn — otherwise the page paints in the
    // browser's zone and silently re-paints in the configured one.
    await window.settingsReady;
    initCharts();

    // F-24 §7 asks for deep-linkable views. This page had none: every visit
    // started at 7 days with no filter, so "look at the last 30 days of webhook
    // errors" could only ever be an instruction, never a link. The state that
    // decides what the page shows now lives in the URL.
    const state = readHash();
    currentMode = state.mode || '';
    const initialModeSel = document.getElementById('errorModeFilter');
    if (initialModeSel) initialModeSel.value = currentMode;
    setErrorRange(state.range || 168);

    // Delegated so rows carry a data attribute instead of an inline onclick.
    document.addEventListener('click', (event) => {
        const row = event.target.closest('[data-group-toggle]');
        // Ignore clicks on the nested "Inspect" buttons — those open the snapshot.
        if (!row || event.target.closest('[data-error-exec-id]') || event.target.closest('[data-action]')) return;
        toggleGroupDetail(row);
    });

    window.UI.bindGroupCollapse(document.getElementById('errorGroupsWrap'));

    const startInput = document.getElementById('errorRangeStart');
    const endInput = document.getElementById('errorRangeEnd');
    if (startInput && endInput) {
        startInput.addEventListener('change', applyCustomRange);
        endInput.addEventListener('change', applyCustomRange);
    }

    const modeSel = document.getElementById('errorModeFilter');
    if (modeSel) {
        modeSel.addEventListener('change', () => {
            currentMode = modeSel.value;
            writeHash(readHash().range);
            fetchErrorData();
        });
    }
}

/**
 * The page's state, in the URL.
 *
 * `#range=720&mode=webhook`. Deliberately the hash rather than the query
 * string: it costs no request when it changes, and it keeps this page's own
 * state visibly separate from the parameters the API takes.
 */
function readHash() {
    const raw = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(raw);
    const range = Number(params.get('range'));
    return {
        range: [24, 48, 168, 336, 720].includes(range) ? range : null,
        mode: params.get('mode') || ''
    };
}

function writeHash(range) {
    const params = new URLSearchParams();
    if (range) params.set('range', String(range));
    if (currentMode) params.set('mode', currentMode);
    const next = params.toString();
    // replaceState, not a hash assignment: setting location.hash pushes a
    // history entry, and a reader who changed the range twice would need three
    // presses of Back to leave the page.
    window.history.replaceState(null, '', next ? `#${next}` : window.location.pathname);
}

function markPresets(activeId) {
    document.querySelectorAll('#presetRangeContainer button').forEach(btn => {
        btn.setAttribute('aria-pressed', String(btn.id === activeId));
    });
}

function setErrorRange(hours) {
    const now = new Date();
    currentRange.startDate = new Date(now.getTime() - hours * 3600000).toISOString();
    currentRange.endDate = now.toISOString();
    markPresets({ 24: 'btn24h', 48: 'btn48h', 168: 'btn7d', 336: 'btn14d', 720: 'btn30d' }[hours]);
    writeHash(hours);
    fetchErrorData();
}
window.setErrorRange = setErrorRange;

function applyCustomRange() {
    const startInput = document.getElementById('errorRangeStart');
    const endInput = document.getElementById('errorRangeEnd');
    if (!startInput.value || !endInput.value) return;

    currentRange.startDate = new Date(startInput.value + 'T00:00:00').toISOString();
    currentRange.endDate = new Date(endInput.value + 'T23:59:59').toISOString();
    markPresets(null);
    fetchErrorData();
}

/**
 * The Needs Attention tile's destination.
 *
 * The tile described the `↯ relabelled` rows and had no way to reach them.
 * Toggling rather than navigating, because the tile is the thing that explained
 * what these rows are and pushing the reader elsewhere loses that explanation.
 */
window.filterRelabelled = function () {
    showOnlyRelabelled = !showOnlyRelabelled;
    renderErrorGroups(lastGroups);
    updateScopeNote();
    document.getElementById('errorGroupsCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.clearErrorFilters = function () {
    showOnlyRelabelled = false;
    currentMode = '';
    const sel = document.getElementById('errorModeFilter');
    if (sel) sel.value = '';
    fetchErrorData();
};

function updateScopeNote() {
    const note = document.getElementById('errorScopeNote');
    const clearBtn = document.getElementById('clearErrorFilters');
    if (!note) return;

    const parts = [];
    if (currentMode) {
        const label = document.querySelector(`#errorModeFilter option[value="${currentMode}"]`)?.textContent || currentMode;
        parts.push(`trigger type “${label}”`);
    }
    if (showOnlyRelabelled) {
        parts.push('groups whose measured behaviour contradicts their category');
    }

    const on = parts.length > 0;
    note.hidden = !on;
    if (clearBtn) clearBtn.hidden = !on;
    if (on) {
        note.innerHTML = `<i class="fa-solid fa-filter mr-1.5"></i>Showing only ${parts.join(' · ')}`;
    }
}

// ── Data ─────────────────────────────────────────────────────
async function fetchErrorData() {
    const params = new URLSearchParams({
        startDate: currentRange.startDate,
        endDate: currentRange.endDate
    });
    if (currentMode) params.set('mode', currentMode);

    try {
        const res = await fetchWithAuth(`/api/analytics/error-intelligence?${params}`);
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data = await res.json();

        lastGroups = data.errorGroups || [];
        // Fetched in parallel and never awaited before the page renders: the
        // deploy overlay is context on a chart, and a slow or missing
        // workflow_history table must not hold back the errors themselves.
        loadDeploys();
        renderKPIs(data.summary);
        renderTrendChart(data.trend);
        renderCategoryChart(data.categories);
        renderWorkflowHealth(data.workflows);
        renderErrorGroups(lastGroups);
        updateScopeNote();
    } catch (e) {
        console.error('[ERROR PAGE]', e);
        // A page that fails silently leaves the previous range's numbers on
        // screen under the new range's filter chips, which is worse than an
        // error: it is a wrong answer wearing a right label.
        document.getElementById('kpiSection').innerHTML =
            `<div class="card md:col-span-2 lg:col-span-4" style="position:relative;min-height:140px">${window.UI.failed(e.message)}</div>`;
        document.getElementById('errorGroupsBody').innerHTML =
            window.UI.rowState(6, window.UI.failed(e.message));
    }
}

/**
 * F-11's last open piece · vertical deploy rules on the error charts.
 *
 * "Did we cause this" is the first question asked of every error spike, and
 * until now this chart could not answer it. n8n keeps every saved version with
 * its author and every execution records the version it ran; `GET
 * /api/analytics/deploys` already joins the two. All that was missing was the
 * line on the chart.
 *
 * Autosaves are excluded — n8n writes one on nearly every keystroke pause, so
 * on this instance 5 of 204 versions are real saves and a chart marking all of
 * them would be a solid grey block instead of a signal.
 *
 * Several deploys on one day collapse into one rule, because the trend is
 * bucketed by day and two rules a pixel apart say nothing two rules cannot.
 * The count and the names go into the caption underneath, which is also the
 * accessible form of the overlay: a canvas rule is invisible to a screen
 * reader, and "three deploys, here is what they were" is the actual content.
 */
async function loadDeploys() {
    try {
        const params = new URLSearchParams({
            startDate: currentRange.startDate,
            endDate: currentRange.endDate
        });
        const res = await fetchWithAuth(`/api/analytics/deploys?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        lastDeploys = data.deploys || [];
    } catch (err) {
        // Context, not content. A missing overlay is quieter than a red box
        // over a chart that is otherwise perfectly correct.
        console.warn('[ERRORS] deploy overlay unavailable:', err);
        lastDeploys = [];
    }
    applyDeployMarks();
}

/** The day bucket a timestamp belongs to, in the trend chart's own label form. */
const dayBucket = (iso) => `${String(iso).slice(0, 10)}T00:00:00Z`;

function applyDeployMarks() {
    if (!trendChart) return;

    const labels = new Set(trendChart.data.labels || []);
    const byDay = new Map();
    for (const d of lastDeploys) {
        const key = dayBucket(d.created_at);
        // A deploy outside the plotted range has no column to sit above.
        if (!labels.has(key)) continue;
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(d);
    }

    trendChart.options.plugins.deployMarks = {
        marks: [...byDay.keys()].map((at) => ({ at }))
    };
    trendChart.update('none');

    const caption = document.getElementById('deployCaption');
    if (!caption) return;

    if (!byDay.size) {
        caption.innerHTML = lastDeploys.length
            ? '<span class="label">No workflow was saved inside this range.</span>'
            : '';
        return;
    }

    const total = [...byDay.values()].reduce((a, list) => a + list.length, 0);
    const items = [...byDay.entries()].map(([day, list]) => {
        const names = [...new Set(list.map((d) => d.workflow_name))];
        const shown = names.slice(0, 3).map((n) => escapeHtml(n)).join(', ');
        const more = names.length > 3 ? ` +${names.length - 3} more` : '';
        return `<li><strong style="color:var(--ink-2)">${escapeHtml(window.formatTime(day, { month: 'short', day: 'numeric' }))}</strong> — ${shown}${more}</li>`;
    });

    caption.innerHTML = `
        <details class="mt-2">
            <summary class="label cursor-pointer select-none">
                <i class="fa-solid fa-code-commit mr-1.5"></i>${total} deploy${total === 1 ? '' : 's'} marked on this chart
            </summary>
            <ul class="mt-1.5 text-[11px] leading-relaxed" style="color:var(--ink-3);list-style:disc;margin-left:1.25rem">
                ${items.join('')}
            </ul>
        </details>`;
}

// ── KPIs ─────────────────────────────────────────────────────
function renderKPIs(summary) {
    const host = document.getElementById('kpiSection');
    if (!host) return;

    const relabelled = summary.mislabelled_groups || 0;

    host.innerHTML = [
        window.UI.kpi({
            label: 'Total failures',
            value: (summary.total_errors || 0).toLocaleString(),
            tone: 'critical',
            trend: window.UI.trend(summary.trend_pct, { goodWhenDown: true }),
            note: 'Executions recorded with status "error" in this range'
        }),
        window.UI.kpi({
            label: 'Error rate',
            value: `${summary.error_rate || 0}%`,
            note: `${(summary.total_errors || 0).toLocaleString()} of ${(summary.total_executions || 0).toLocaleString()} runs`
        }),
        window.UI.kpi({
            label: 'Self-healing',
            value: (summary.transient_observed || 0).toLocaleString(),
            tone: 'good',
            // The old tile said "(measured)" and left the reader to guess what
            // had been measured, and against what.
            note: 'Failures in groups that were followed by a successful run almost every time'
        }),
        // ── The Needs Attention tile, rebuilt. ──
        //
        // Three complaints, three fixes:
        //   ① it never said what "against their category" means — it is F-08's
        //      finding: the label says transient, the measured recovery says
        //      otherwise (`<HTML: service suspended>`, 0 recoveries in 47);
        //   ② it led nowhere, though the `↯ relabelled` badges were in the rows
        //      below — it is a button now and filters to exactly those rows;
        //   ③ "3,324" did not say what it counted — it counts failures in
        //      groups that have essentially never recovered on their own.
        window.UI.kpi({
            label: 'Needs attention',
            value: (summary.structural_observed || 0).toLocaleString(),
            tone: 'brand',
            note: 'Failures in groups that have essentially never recovered on their own',
            hint: relabelled
                ? (relabelled === 1
                    ? '1 group is labelled one way and behaves the other — click to see it'
                    : `${relabelled} groups are labelled one way and behave the other — click to see them`)
                : 'Every group here behaves the way its category predicts',
            action: relabelled ? 'filterRelabelled' : undefined
        })
    ].join('');
}

// ── Trend ────────────────────────────────────────────────────
function renderTrendChart(trendData) {
    const has = Array.isArray(trendData) && trendData.length > 0;
    window.Viz.setEmpty(trendChart, has, 'No failures in this range',
        'Nothing failed between these dates. An empty grid would read as a measured zero; this is the absence of any error at all.');

    if (!has) {
        trendChart.data.labels = [];
        trendChart.data.datasets = [];
        trendChart.update();
        return;
    }

    // The API returns date(timestamp), a bare YYYY-MM-DD in UTC. Appending only
    // 'T00:00:00' made the browser read it as LOCAL midnight, so west of UTC every
    // bar was labelled with the previous day.
    trendChart.data.labels = trendData.map(d => d.day + 'T00:00:00Z');

    trendChart.data.datasets = ALL_CATEGORIES
        .filter(cat => trendData.some(d => d[cat]))
        .map(cat => ({
            label: CATEGORY_CONFIG[cat].label,
            data: trendData.map(d => d[cat] || 0),
            backgroundColor: window.Viz.alpha(catColor(cat), 0.55),
            borderColor: catColor(cat),
            fill: true
        }));

    trendChart.update();

    // The labels only exist after this update, and a deploy is placed by label.
    applyDeployMarks();

    const tableHost = document.getElementById('trendTable');
    if (tableHost) {
        tableHost.innerHTML = window.Viz.tableFor(trendChart, {
            unit: 'count', axisLabel: 'Day', labelFormat: { month: 'short', day: 'numeric' }
        });
    }
}

// ── Category donut ───────────────────────────────────────────
function renderCategoryChart(categories) {
    const has = Array.isArray(categories) && categories.length > 0;
    window.Viz.setEmpty(categoryChart, has, 'No categories to break down',
        'There were no failures in this range to classify.');

    if (!has) {
        categoryChart.data.labels = [];
        categoryChart.data.datasets[0].data = [];
        categoryChart.update();
        return;
    }

    categoryChart.data.labels = categories.map(c => CATEGORY_CONFIG[c.error_category]?.label || c.error_category);
    categoryChart.data.datasets[0].data = categories.map(c => c.count);
    categoryChart.data.datasets[0].backgroundColor = categories.map(c => catColor(c.error_category));
    categoryChart.update();
}

// ── Workflow health ──────────────────────────────────────────
function renderWorkflowHealth(workflows) {
    const body = document.getElementById('healthTableBody');
    if (!body) return;

    if (!workflows || !workflows.length) {
        body.innerHTML = window.UI.rowState(4, window.UI.empty(
            'No failing workflows',
            'Every workflow that ran in this range completed without an error.', 'fa-circle-check'));
        return;
    }

    body.innerHTML = workflows.map(wf => {
        const score = wf.health_score || 0;
        // A health score is a status, so it takes a status token. The three
        // thresholds are the only place they are decided.
        const tone = score < 80 ? 'critical' : score < 95 ? 'warning' : 'good';
        return `
            <tr>
                <td class="truncate max-w-[220px]" style="color:var(--ink-1);font-weight:600">${escapeHtml(wf.name)}</td>
                <td class="num" style="color:var(--critical-ink)">${wf.error_count}</td>
                <td class="num">${wf.total_runs}</td>
                <td>
                    <div class="flex items-center gap-3">
                        <div class="flex-1 rounded-full h-1.5 overflow-hidden" style="background:var(--surface-3)">
                            <div class="h-full rounded-full" style="width:${score}%;background:var(--${tone}-mark)"></div>
                        </div>
                        <span class="num text-[11px]" style="color:var(--${tone}-ink);min-width:3rem">${score}%</span>
                    </div>
                </td>
            </tr>`;
    }).join('');
}

// ── Error groups ─────────────────────────────────────────────
function renderErrorGroups(groups) {
    const body = document.getElementById('errorGroupsBody');
    const countEl = document.getElementById('groupCount');
    if (!body) return;

    const visible = showOnlyRelabelled ? groups.filter(g => g.label_disagrees) : groups;

    if (!visible.length) {
        countEl.textContent = '0 groups';
        body.innerHTML = window.UI.rowState(6, showOnlyRelabelled
            ? window.UI.empty('Nothing is mislabelled',
                'Every group in this range behaves the way its category predicts. Clear the filter to see them all.', 'fa-circle-check')
            : window.UI.empty('No errors in this range',
                'Nothing failed between these dates.', 'fa-circle-check'));
        return;
    }

    countEl.textContent = `${visible.length} group${visible.length === 1 ? '' : 's'}` +
        (visible.length !== groups.length ? ` of ${groups.length}` : '');

    // The sections, in the category order the palette is pinned to, so the
    // headings and the donut walk the colours in the same order.
    const order = ALL_CATEGORIES.filter(cat => visible.some(g => g.error_category === cat));

    body.innerHTML = order.map(cat => {
        const rows = visible.filter(g => g.error_category === cat);
        const total = rows.reduce((a, g) => a + g.count, 0);
        const cfg = CATEGORY_CONFIG[cat] || CATEGORY_CONFIG.unknown;

        const head = `
            <tr class="group-head">
                <td colspan="6">
                    <button type="button" class="flex items-center gap-2.5 w-full text-left"
                            data-group-collapse="${escapeHtml(cat)}" aria-expanded="true">
                        <i class="fa-solid fa-chevron-down text-[10px]" style="color:var(--ink-3)"></i>
                        <i class="fa-solid ${cfg.icon}" style="color:${catColor(cat)}"></i>
                        <span class="text-[12px] font-bold" style="color:var(--ink-1)">${escapeHtml(cfg.label)}</span>
                        <span class="label">${rows.length} group${rows.length === 1 ? '' : 's'}</span>
                        <span class="label" style="margin-left:auto">${total.toLocaleString()} occurrences</span>
                    </button>
                </td>
            </tr>`;

        return head + rows.map((g, i) => groupRow(g, cat, i)).join('');
    }).join('');
}

function groupRow(g, cat, idx) {
    const activity = g.activity === 'active'
        ? window.UI.badge('Active', { tone: 'critical', dot: true, title: 'Seen within the last 24 hours' })
        : window.UI.badge('Recurring', { tone: 'neutral', title: 'Not seen in the last 24 hours, but has happened repeatedly' });

    // A fingerprint nobody had ever seen before this window. The single most
    // actionable label on the page: everything else here has been happening for
    // a while.
    const isNew = g.is_new ? ' ' + window.UI.badge('new', { tone: 'warning', title: 'First ever occurrence falls inside this range' }) : '';

    // One fingerprint can span categories when the same message arrives with
    // different HTTP codes. Saying so is better than picking one silently.
    const spans = g.category_count > 1
        ? ' ' + window.UI.badge(`+${g.category_count - 1} more`, { tone: 'neutral', title: 'This fingerprint has also been classified under other categories' })
        : '';

    // F-08: measured, not inferred from the wording of the message.
    const b = BEHAVIOUR[g.behaviour] || BEHAVIOUR.unknown;
    const behaviour = window.UI.badge(b.label, { tone: b.tone, icon: b.icon, title: b.title });

    // Where the measurement contradicts the label every other tool shows. This
    // is what the Needs Attention tile is counting and now filters to.
    const disagrees = g.label_disagrees
        ? ' ' + window.UI.badge('relabelled', {
            tone: 'warning', icon: 'fa-arrows-rotate',
            title: `Its category implies the opposite of what it does: it recovered ${g.recovered} time(s) in ${g.observed} observed occurrences.`
        })
        : '';

    const life = LIFECYCLE[g.status] || LIFECYCLE.open;
    // Only shown once it is not simply 'open': a badge saying "Open" on every
    // row is noise, and its absence already means the same thing.
    const lifecycle = g.status && g.status !== 'open'
        ? ' ' + window.UI.badge(life.label, { tone: life.tone })
        : '';

    const workflows = (g.workflow_names || []).map(n => escapeHtml(n)).join(', ');

    // The displayed message, not the raw document. An HTML error body shows its
    // title and text, with the markup behind "show raw".
    const summary = window.UI.readHtmlError(g.error_summary);
    const shortMsg = summary.isHtml
        ? (summary.title || summary.text || 'HTML error response').slice(0, 140)
        : String(g.error_summary || '').slice(0, 140);

    return `
        <tr class="row-link" data-group-toggle data-group-member="${escapeHtml(cat)}">
            <td style="color:var(--ink-3)"><i class="fa-solid fa-chevron-right text-[10px]"></i></td>
            <td><code class="mono px-2 py-1 rounded whitespace-nowrap"
                      style="background:var(--surface-0);border:1px solid var(--line);color:var(--ink-2)">${escapeHtml(g.node_name)}</code></td>
            <td class="max-w-md">
                <span class="truncate block" style="color:var(--critical-ink)">${escapeHtml(shortMsg)}</span>
                <span class="inline-flex flex-wrap gap-1 mt-1.5">${behaviour}${disagrees}${isNew}${spans}</span>
            </td>
            <td class="num">${g.count.toLocaleString()}</td>
            <td class="num">${g.affected_workflows}</td>
            <td class="num">${activity}${lifecycle}</td>
        </tr>
        <tr class="hidden" data-detail-row data-loaded="false" data-group-member="${escapeHtml(cat)}"
            data-fingerprint="${escapeHtml(g.fingerprint)}" style="background:var(--surface-0)">
            <td colspan="6" class="pl-10">
                <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 text-[11px]" style="color:var(--ink-2)">
                    <div><span class="label block mb-1">First seen (range)</span>${formatTimeNice(g.first_seen)}</div>
                    <div><span class="label block mb-1">Last seen</span>${formatTimeNice(g.last_seen)}</div>
                    <div><span class="label block mb-1">First seen ever</span>${formatTimeNice(g.ever_first_seen)}</div>
                    <div><span class="label block mb-1">Node type</span><code class="mono">${escapeHtml(g.node_type || 'Unknown')}</code></div>
                    <div class="col-span-2"><span class="label block mb-1">Affected workflows</span>${workflows || 'Unknown'}</div>
                    <div><span class="label block mb-1">Fingerprint</span><code class="mono">${escapeHtml(g.fingerprint)}</code></div>
                    <div><span class="label block mb-1">Recovers</span>${
    g.recovery_rate === null
        ? `<span style="color:var(--ink-3)">too few to judge (${g.observed})</span>`
        : `${g.recovery_rate}% <span style="color:var(--ink-3)">(${g.recovered} of ${g.observed} followed by a success)</span>`
}</div>
                </div>

                <div class="mt-3 text-[10px]" style="color:var(--ink-3)">
                    <span class="label">Grouped as</span>
                    <code class="mono ml-2" style="color:var(--ink-2)">${escapeHtml(g.normalized_message || '')}</code>
                </div>

                <div class="mt-3 p-3 rounded-lg" style="background:var(--surface-1);border:1px solid var(--line)">
                    ${window.UI.errorMessage(g.error_summary, idx)}
                </div>

                <!-- Triage (F-15) -->
                <div class="mt-4 flex items-center gap-2 flex-wrap">
                    <span class="label mr-1">Triage</span>
                    ${['acknowledge', 'resolve', 'ignore', 'reopen'].map(action => `
                        <button data-action="setFingerprintStatus"
                                data-arg="${escapeHtml(g.fingerprint)}:${action}"
                                class="btn btn-sm">${action}</button>`).join('')}
                    <span class="text-[10px] ml-2" style="color:var(--ink-3)">${
    g.status && g.status !== 'open'
        ? `${escapeHtml(life.label.toLowerCase())}${g.notes ? ` — ${escapeHtml(g.notes)}` : ''}`
        : 'not triaged yet'}</span>
                </div>

                <div class="mt-4">
                    <p class="label mb-2">Recent occurrences</p>
                    <div class="executions-container card card-clip">
                        ${window.UI.loading()}
                    </div>
                </div>
            </td>
        </tr>`;
}

async function toggleGroupDetail(row) {
    const detailRow = row.nextElementSibling;
    if (!detailRow || !detailRow.hasAttribute('data-detail-row')) return;

    const icon = row.querySelector('.fa-chevron-right');
    if (detailRow.classList.contains('hidden')) {
        detailRow.classList.remove('hidden');
        if (icon) icon.style.transform = 'rotate(90deg)';
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
    container.style.position = 'relative';
    container.style.minHeight = '120px';

    try {
        const res = await fetchWithAuth('/api/analytics/error-group-executions', {
            method: 'POST',
            body: JSON.stringify({
                fingerprint,
                startDate: currentRange.startDate,
                endDate: currentRange.endDate,
                // The same filter as the row above. Without it, a group counted
                // as 12 under ?mode=webhook opens onto 30 occurrences of every
                // mode and the page contradicts itself in one click — which is
                // precisely what L-30 was.
                mode: currentMode || undefined
            })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        detailRow.setAttribute('data-loaded', 'true');

        if (!data.executions || !data.executions.length) {
            container.innerHTML = window.UI.empty('No occurrences kept',
                'n8n has pruned the executions behind this group, or they fall outside your project scope.', 'fa-box-archive');
            return;
        }

        container.style.minHeight = '';
        container.innerHTML = `
            <div class="tbl-wrap custom-scrollbar" style="max-height:260px">
                <table class="tbl">
                    <thead><tr><th>Time</th><th>Workflow</th><th class="num">Action</th></tr></thead>
                    <tbody>
                        ${data.executions.map(ex => `
                            <tr>
                                <td>${formatTimeNice(ex.timestamp)}</td>
                                <td style="color:var(--ink-1);font-weight:600">${escapeHtml(ex.workflow_name)}</td>
                                <td class="num">
                                    <button data-error-exec-id="${escapeHtml(ex.exec_id)}" class="btn btn-sm">
                                        <i class="fa-solid fa-magnifying-glass"></i> Inspect
                                    </button>
                                </td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>`;
    } catch (err) {
        console.error(err);
        container.innerHTML = window.UI.failed('Could not load the occurrences behind this group.');
    }
}

// ── Charts ───────────────────────────────────────────────────
//
// Everything that used to be declared here — colours, fonts, grid, tooltip
// styling, legend placement, interaction mode — is in ui/viz.js now. What
// remains is what is specific to these two charts.
function initCharts() {
    const V = window.Viz;

    const trendCanvas = document.getElementById('trendChart');
    if (trendCanvas) {
        trendChart = new Chart(trendCanvas.getContext('2d'), {
            type: 'line',
            data: { labels: [], datasets: [] },
            options: {
                plugins: {
                    legend: { position: 'top', align: 'end' },
                    tooltip: {
                        callbacks: {
                            title: (items) => items.length
                                ? window.formatTime(items[0].label, { month: 'short', day: 'numeric', year: 'numeric' })
                                : '',
                            label: (ctx) => ` ${ctx.dataset.label}: ${V.unit('count').fmt(ctx.parsed.y)}`
                        }
                    }
                },
                scales: {
                    x: V.xTimeAxis({ format: { month: 'short', day: 'numeric' }, maxTicks: 10 }),
                    y: V.yAxis({ unit: 'count', stacked: true, title: 'Failures' })
                }
            }
        });
        V.enableBrush(trendChart, trendCanvas.parentElement);
    }

    const catCanvas = document.getElementById('categoryChart');
    if (catCanvas) {
        categoryChart = new Chart(catCanvas.getContext('2d'), {
            type: 'doughnut',
            data: { labels: [], datasets: [{ data: [], cutout: '62%', hoverOffset: 12 }] },
            options: {
                plugins: {
                    legend: { position: 'bottom' },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                const total = ctx.dataset.data.reduce((a, b) => a + b, 0) || 1;
                                return ` ${ctx.label}: ${ctx.parsed.toLocaleString()} (${((ctx.parsed / total) * 100).toFixed(1)}%)`;
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
// the rest of the dashboard.
function formatTimeNice(isoStr) {
    if (!isoStr) return '—';
    return window.formatTime(isoStr, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

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
        // Refetch rather than patch the row: resolving changes what the alert
        // rules will do next, and a stale page that still offers "resolve" on
        // something already resolved invites a second, contradictory decision.
        await fetchErrorData();
    } catch (err) {
        console.error('[TRIAGE]', err);
    }
};
