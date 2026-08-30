/**
 * The Overview tab: what the automation is worth, and how much of it is guessed.
 *
 * ── The coverage tile ────────────────────────────────────────────────────
 *
 * Every figure here is a sum over the workflows somebody has configured. On an
 * instance where most are not, the total is not a measurement of what the
 * automation saved — it is a floor, and a reader has no way to tell which of
 * the two they are looking at.
 *
 * That caveat existed, in prose, in the documentation. This puts it on the page
 * as a number beside the numbers it qualifies, and makes it the one tile that
 * is a link, because the tile is useless unless the fix is one click from it.
 */

const el = (id) => document.getElementById(id);

let lastCoverage = null;

export async function load() {
    const range = el('roiTimeRangeFilter')?.value || 'all';
    const body = el('roiWorkflowsTable');

    if (body) {
        body.innerHTML = '<tr><td colspan="5" class="hint" style="text-align:center;padding:2rem">' +
            '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading…</td></tr>';
    }

    try {
        const res = await window.fetchWithAuth(`/api/analytics/roi?timeRange=${range}`);
        if (!res.ok) throw new Error('Failed to fetch ROI metrics');
        paint(await res.json());
    } catch (err) {
        console.error(err);
        ['kpiTotalTime', 'kpiTotalMoney', 'kpiExecutions', 'kpiCoverage']
            .forEach((id) => { if (el(id)) el(id).textContent = '—'; });
        if (body) {
            body.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:2rem;' +
                'color:var(--critical-ink);font-size:12px">Could not load ROI data. ' +
                '<button class="btn btn-sm ml-2" data-action="loadRoiMetrics">Retry</button></td></tr>';
        }
    }
}

function paint(data) {
    const seconds = parseInt(data.summary?.total_time_saved_seconds, 10) || 0;
    const money = parseFloat(data.summary?.total_money_saved) || 0;
    const executions = parseInt(data.summary?.total_executions, 10) || 0;

    el('kpiTotalTime').textContent = window.formatDuration(seconds);
    el('kpiTotalMoney').textContent = window.formatMoney(money, { narrow: true, decimals: 0 });
    el('kpiExecutions').textContent = executions.toLocaleString();

    // The hours behind the headline, because "3d 4h" is easy to read and hard
    // to compare against anything, and somebody checking this against a
    // spreadsheet wants the raw figure.
    const sub = el('kpiTotalTimeSub');
    if (sub) {
        sub.textContent = seconds > 0
            ? `${Math.round(seconds / 3600).toLocaleString()} hours across configured workflows`
            : 'nothing configured yet';
    }

    const rows = data.topWorkflows || [];
    const count = el('roiTableCount');
    if (count) count.textContent = rows.length ? `${rows.length} workflows` : '';

    const body = el('roiWorkflowsTable');
    if (!body) return;

    if (!rows.length) {
        body.innerHTML = `<tr><td colspan="5" style="padding:0">
            <div class="state" style="position:static;min-height:220px">
              <i class="fa-solid fa-clock-rotate-left state-icon"></i>
              <p class="state-title">Nothing to report yet</p>
              <p class="state-note">This page adds up time saved per execution — a figure that has
                 to be set per workflow before there is anything to add up.</p>
              <button class="btn btn-primary btn-sm mt-2" data-action="showRoiSection" data-arg="configure">
                <i class="fa-solid fa-sliders"></i> Configure workflows
              </button>
            </div></td></tr>`;
        return;
    }

    body.innerHTML = rows.map((wf) => {
        const execs = parseInt(wf.executions, 10) || 0;
        const saved = parseInt(wf.time_saved_seconds, 10) || 0;
        // Derived rather than sent: it is what was configured, and showing it
        // beside the total is what lets somebody spot the row whose per-run
        // figure is a typo. A total of "41d" looks plausible; "2h saved per
        // execution" does not.
        const perRun = execs > 0 ? Math.round(saved / execs) : 0;
        return `<tr>
            <td style="color:var(--ink-1);font-weight:600">${window.escapeHtml(wf.name)}</td>
            <td class="num">${execs.toLocaleString()}</td>
            <td class="num" style="color:var(--ink-3);font-weight:500">${perRun.toLocaleString()}s</td>
            <td class="num">${window.formatDuration(saved)}</td>
            <td class="num">${window.formatMoney(wf.money_saved, { narrow: true, decimals: 0 })}</td>
        </tr>`;
    }).join('');
}

/** Coverage comes from the Configure tab's list, which is the only place it is known. */
export function setCoverage({ configured, total }) {
    lastCoverage = { configured, total };

    const value = el('kpiCoverage');
    const sub = el('kpiCoverageSub');
    const note = el('roiCoverageNote');
    if (!value) return;

    value.textContent = total ? `${configured} / ${total}` : '—';
    if (sub) {
        sub.textContent = total
            ? `workflows with a value set — ${Math.round((configured / total) * 100)}%`
            : 'workflows with a value set';
    }

    if (!note) return;
    const missing = total - configured;
    // Said once, above the table, and only when it changes what the numbers
    // mean. A banner that is always there is a banner nobody reads.
    if (total > 0 && missing > 0) {
        note.innerHTML = `<div class="note ${configured === 0 ? 'note-brand' : ''} mb-6">
            <i class="fa-solid fa-circle-info"></i>
            <p>${configured === 0
        ? 'No workflow has a time saving set yet, so every figure above is zero — that is a missing input, not a measured result.'
        : `${missing} of ${total} workflows have no time saving set and contribute nothing to these totals. Treat the figures above as a floor rather than the full picture.`}
               <button class="btn btn-sm ml-2" data-action="showRoiSection" data-arg="configure">
                 <i class="fa-solid fa-sliders"></i> Configure
               </button></p>
        </div>`;
    } else {
        note.innerHTML = '';
    }
}

export function currentCoverage() {
    return lastCoverage;
}
