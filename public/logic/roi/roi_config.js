/**
 * The Configure tab: two numbers per workflow, and a way to arrive at one of
 * them.
 *
 * ── What this replaced ───────────────────────────────────────────────────
 *
 * A list in Settings, rendered from a template that set its own colours —
 * `bg-[#171717]`, `text-indigo-400`, `bg-green-900/40`, `bg-gray-700
 * hover:bg-indigo-600` — none of which appear anywhere else in this dashboard.
 * It was the F-24 §7 complaint in one file: a second design system, maintained
 * by nobody, that drifted from the first the moment either changed. Everything
 * here comes from the tokens in input.css.
 *
 * ── The calculator is the point of the tab ───────────────────────────────
 *
 * It was four unlabelled-ish inputs, a reference number in a box, and a button
 * called "Apply Calculated Value" — which is a button that asks you to trust a
 * calculation you have not seen. Press it and a number appears in a different
 * control, several inches away, with no indication of how it got there or
 * whether it is sensible.
 *
 * Three things changed and they are all the same thing:
 *
 *   1. **It is a sentence.** The inputs sit inside a claim about the world —
 *      "a person did this 5 times per week, and each time took 3 hours" —
 *      because that is a thing somebody can check against their memory. Four
 *      fields called Freq / Per / Duration / Unit are not.
 *
 *   2. **The arithmetic is on screen, before the button.** The monthly total,
 *      the execution count it is divided by, and the result all update as you
 *      type. So "Use this figure" confirms something already visible instead of
 *      being the only way to find out what the calculator thinks.
 *
 *   3. **It shows the divisor.** The single most confusing thing about the old
 *      version was that the answer depended on a number it displayed but never
 *      connected to anything. Now the division is written out.
 */

import { perExecutionSeconds } from './roi_math.mjs';

/** Every workflow the caller may configure, with whatever is already stored. */
let workflows = [];

/** Which rows have their calculator open, so a re-render does not close them. */
const opened = new Set();

const el = (id) => document.getElementById(id);

// ==========================================================================
// Reading and writing the list
// ==========================================================================

export async function load() {
    const container = el('settingsContainer');
    if (!container) return;

    container.innerHTML = '<div class="hint py-8 text-center">' +
        '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading workflows…</div>';

    try {
        const res = await window.fetchWithAuth('/api/settings/roi');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        workflows = await res.json();
        render();
        paintCoverage();
    } catch (err) {
        console.error(err);
        container.innerHTML = '<div class="hint py-8 text-center" style="color:var(--critical-ink)">' +
            'Could not load workflows. Run a sync first, or reload the page.</div>';
    }
}

/** What the Overview tab's coverage tile and the tab pill both count. */
export function coverage() {
    const configured = workflows.filter((w) => Number(w.saved_time_seconds) > 0).length;
    return { configured, total: workflows.length };
}

function paintCoverage() {
    const { configured, total } = coverage();
    const pill = el('roiCoveragePill');
    if (pill) {
        pill.textContent = total ? `${configured}/${total}` : '—';
        pill.className = `badge ml-2 ${configured === 0 ? 'badge-warning'
            : configured < total ? 'badge-neutral' : 'badge-good'}`;
    }
    document.dispatchEvent(new CustomEvent('roi:coverage', { detail: coverage() }));
}

// ==========================================================================
// Rendering
// ==========================================================================

const esc = (s) => window.escapeHtml(String(s ?? ''));

function visible() {
    const term = (el('workflowSearch')?.value || '').toLowerCase().trim();
    const filter = el('workflowFilter')?.value || 'all';
    const sort = el('workflowSort')?.value || 'execs_desc';

    let rows = workflows.filter((w) => {
        if (term && !w.name.toLowerCase().includes(term) && !w.id.toLowerCase().includes(term)) {
            return false;
        }
        const set = Number(w.saved_time_seconds) > 0;
        if (filter === 'configured') return set;
        if (filter === 'unconfigured') return !set;
        return true;
    });

    const num = (v) => Number(v) || 0;
    rows = rows.slice().sort((a, b) => {
        switch (sort) {
        case 'name_asc': return a.name.localeCompare(b.name);
        case 'name_desc': return b.name.localeCompare(a.name);
        case 'time_desc': return num(b.saved_time_seconds) - num(a.saved_time_seconds);
        default: return num(b.execution_count) - num(a.execution_count);
        }
    });
    return rows;
}

/**
 * One workflow.
 *
 * `first` is why the column labels are not on every row. There are 164
 * workflows on the instance this was built against, and "SAVES PER RUN /
 * HOURLY RATE" repeated 164 times is 328 lines of chrome competing with the
 * numbers they label — dashboard-design's "the data is the decoration", failed.
 * The label is drawn once, at the top of the list, and every input keeps its
 * `aria-label`, so nothing is lost to a screen reader by removing it from view.
 */
function row(wf, first) {
    const configured = Number(wf.saved_time_seconds) > 0;
    const execs30 = Number(wf.executions_30d) || 0;
    const symbol = window.currencySymbol();

    return `
    <div class="roi-row" data-id="${esc(wf.id)}">
      <div class="roi-row-head">
        <div class="roi-row-id">
          <span class="roi-row-name" title="${esc(wf.name)}">${esc(wf.name)}</span>
          <span class="roi-row-meta">
            <span class="badge ${configured ? 'badge-good' : 'badge-neutral'}">
              ${configured ? 'Configured' : 'Not set'}
            </span>
            <span>${(Number(wf.execution_count) || 0).toLocaleString()} runs all time</span>
            <span>·</span>
            <span>${execs30.toLocaleString()} in the last 30 days</span>
          </span>
        </div>

        <div class="roi-row-inputs">
          <label class="roi-input">
            <span class="roi-input-label" ${first ? '' : 'aria-hidden="true"'}>${first ? 'Saves per run' : ''}</span>
            <span class="input-affix">
              <input type="number" min="0" step="1" class="input js-seconds"
                     value="${Number(wf.saved_time_seconds) || 0}" aria-label="Seconds saved per run">
              <span class="affix">sec</span>
            </span>
          </label>

          <label class="roi-input">
            <span class="roi-input-label" ${first ? '' : 'aria-hidden="true"'}>${first ? 'Hourly rate' : ''}</span>
            <span class="input-affix">
              <span class="affix">${esc(symbol)}</span>
              <input type="number" min="0" step="1" class="input js-rate"
                     value="${Number(wf.hourly_rate) || 0}" aria-label="Hourly rate of the work replaced">
              <span class="affix">/h</span>
            </span>
          </label>

          <button type="button" class="btn btn-sm js-calc-toggle"
                  aria-expanded="${opened.has(wf.id) ? 'true' : 'false'}">
            <i class="fa-solid fa-wand-magic-sparkles"></i> Work it out
          </button>
        </div>
      </div>

      <div class="roi-calc" ${opened.has(wf.id) ? '' : 'hidden'} data-execs="${execs30}">
        <p class="roi-calc-lead">Describe the manual job this replaced.</p>

        <div class="roi-sentence">
          <span>A person did this</span>
          <span class="input-affix roi-calc-field">
            <input type="number" min="1" step="1" value="5" class="input js-freq" aria-label="How many times">
          </span>
          <span>times per</span>
          <span class="input-affix roi-calc-field">
            <select class="input js-per" aria-label="Per period">
              <option value="day">day</option>
              <option value="week" selected>week</option>
              <option value="month">month</option>
            </select>
          </span>
          <span>, and each time took</span>
          <span class="input-affix roi-calc-field">
            <input type="number" min="1" step="1" value="30" class="input js-dur" aria-label="How long">
          </span>
          <span class="input-affix roi-calc-field">
            <select class="input js-unit" aria-label="Time unit">
              <option value="minutes" selected>minutes</option>
              <option value="hours">hours</option>
            </select>
          </span>
          <span>.</span>
        </div>

        <!-- The working, shown before the button rather than behind it. -->
        <div class="roi-working js-working"></div>
      </div>
    </div>`;
}

function render() {
    const container = el('settingsContainer');
    if (!container) return;

    const rows = visible();
    if (!rows.length) {
        container.innerHTML = '<div class="state" style="position:static;min-height:120px">' +
            '<i class="fa-solid fa-magnifying-glass state-icon"></i>' +
            '<p class="state-title">No workflows match</p>' +
            '<p class="state-note">Try a different search, or set the filter back to all workflows.</p>' +
            '</div>';
        return;
    }

    container.innerHTML = rows.map((wf, i) => row(wf, i === 0)).join('');
    rows.forEach((wf) => { if (opened.has(wf.id)) recalc(wf.id); });
}

// ==========================================================================
// The calculator's live working
// ==========================================================================

const rowEl = (id) => document.querySelector(`.roi-row[data-id="${CSS.escape(id)}"]`);

function readCalc(node) {
    return {
        frequency: node.querySelector('.js-freq').value,
        per: node.querySelector('.js-per').value,
        duration: node.querySelector('.js-dur').value,
        unit: node.querySelector('.js-unit').value,
        executions30d: Number(node.dataset.execs) || 0
    };
}

/**
 * Redraws one row's working.
 *
 * Every intermediate is named. If the answer looks wrong, the reader can see
 * WHICH line is wrong — which is the difference between a calculator and an
 * oracle, and the whole reason the old one was distrusted.
 */
function recalc(id) {
    const node = rowEl(id);
    if (!node) return;
    const calc = node.querySelector('.roi-calc');
    const out = node.querySelector('.js-working');
    if (!calc || !out) return;

    const result = perExecutionSeconds(readCalc(calc));

    if (!result.ok) {
        out.innerHTML = `<div class="roi-working-blocked">
            <i class="fa-solid fa-circle-info"></i><span>${esc(result.reason)}</span>
        </div>`;
        return;
    }

    const monthly = window.formatDuration(result.humanSecondsPerMonth);
    const runs = Math.round(result.manualRunsPerMonth).toLocaleString();
    const execs = result.executions30d.toLocaleString();
    const each = window.formatDuration(result.secondsPerExecution);

    out.innerHTML = `
      <dl class="roi-steps">
        <div><dt>That is</dt><dd>${runs} manual runs a month — <strong>${esc(monthly)}</strong> of work</dd></div>
        <div><dt>n8n ran it</dt><dd>${execs} times in the same 30 days</dd></div>
      </dl>
      <div class="roi-result">
        <div>
          <span class="label">Saved per execution</span>
          <span class="roi-result-value">${result.secondsPerExecution.toLocaleString()} sec<span class="roi-result-alt">${
    result.secondsPerExecution >= 60 ? ` · ${esc(each)}` : ''
}</span></span>
        </div>
        <button type="button" class="btn btn-primary btn-sm js-calc-apply">
          <i class="fa-solid fa-arrow-up"></i> Use this figure
        </button>
      </div>`;
}

// ==========================================================================
// Events
// ==========================================================================

/**
 * One delegated listener per event type on the container, rather than a listener
 * per control re-attached on every render.
 *
 * The old version re-queried and re-bound four sets of handlers inside the
 * render function, so every keystroke in the search box rebuilt the whole list
 * and rebound everything on it. Delegation survives a re-render by not caring
 * about it.
 */
export function attach() {
    const container = el('settingsContainer');
    if (!container) return;

    container.addEventListener('input', (event) => {
        const node = event.target.closest('.roi-row');
        if (!node) return;
        const wf = workflows.find((w) => w.id === node.dataset.id);

        if (event.target.classList.contains('js-seconds')) {
            if (wf) wf.saved_time_seconds = Math.max(0, parseInt(event.target.value, 10) || 0);
            markDirty();
            paintCoverage();
        } else if (event.target.classList.contains('js-rate')) {
            if (wf) wf.hourly_rate = Math.max(0, parseFloat(event.target.value) || 0);
            markDirty();
        } else if (event.target.closest('.roi-calc')) {
            recalc(node.dataset.id);
        }
    });

    // `change` as well as `input`, because a <select> in some browsers only
    // fires the second — and the calculator that does not update when you
    // switch week to month is the calculator nobody believes.
    container.addEventListener('change', (event) => {
        const node = event.target.closest('.roi-row');
        if (node && event.target.closest('.roi-calc')) recalc(node.dataset.id);
    });

    container.addEventListener('click', (event) => {
        const node = event.target.closest('.roi-row');
        if (!node) return;
        const id = node.dataset.id;

        const toggle = event.target.closest('.js-calc-toggle');
        if (toggle) {
            const calc = node.querySelector('.roi-calc');
            const open = calc.hidden;
            calc.hidden = !open;
            toggle.setAttribute('aria-expanded', String(open));
            if (open) { opened.add(id); recalc(id); } else { opened.delete(id); }
            return;
        }

        if (event.target.closest('.js-calc-apply')) {
            apply(id);
        }
    });

    ['workflowSearch', 'workflowFilter', 'workflowSort'].forEach((control) => {
        el(control)?.addEventListener(control === 'workflowSearch' ? 'input' : 'change', render);
    });

    el('saveBtn')?.addEventListener('click', save);
}

/**
 * Moves the calculated figure into the field that will actually be saved.
 *
 * The flash is not decoration. The value lands in a control the reader was not
 * looking at — their eyes are on the result panel — so something has to say
 * where it went, and an animation on the destination is the shortest way to
 * point at it.
 */
function apply(id) {
    const node = rowEl(id);
    const calc = node?.querySelector('.roi-calc');
    if (!calc) return;

    const result = perExecutionSeconds(readCalc(calc));
    if (!result.ok) return;

    const input = node.querySelector('.js-seconds');
    input.value = result.secondsPerExecution;

    const wf = workflows.find((w) => w.id === id);
    if (wf) wf.saved_time_seconds = result.secondsPerExecution;

    input.classList.add('is-applied');
    setTimeout(() => input.classList.remove('is-applied'), 900);

    // The badge on the row says "Not set" until this happens, and leaving it
    // stale after the thing it describes has changed is a small lie the reader
    // has no reason to doubt.
    const badge = node.querySelector('.roi-row-meta .badge');
    if (badge && result.secondsPerExecution > 0) {
        badge.className = 'badge badge-good';
        badge.textContent = 'Configured';
    }
    markDirty();
    paintCoverage();
}

// ==========================================================================
// Saving
// ==========================================================================

let dirty = false;

function markDirty() {
    dirty = true;
    say('Unsaved changes.', 'warn');
}

function say(text, tone) {
    const msg = el('roiSaveMsg');
    if (!msg) return;
    msg.textContent = text;
    msg.style.color = tone === 'bad' ? 'var(--critical-ink)'
        : tone === 'good' ? 'var(--good-ink)'
            : tone === 'warn' ? 'var(--warning-ink)' : 'var(--ink-3)';
}

async function save() {
    const btn = el('saveBtn');
    const label = '<i class="fa-solid fa-floppy-disk"></i> Save changes';

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

    try {
        const res = await window.fetchWithAuth('/api/settings/roi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                settings: workflows.map((w) => ({
                    workflow_id: w.id,
                    saved_time_seconds: parseInt(w.saved_time_seconds, 10) || 0,
                    hourly_rate: parseFloat(w.hourly_rate) || 0
                }))
            })
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || 'Could not save.');
        }

        dirty = false;
        btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved';
        say('Saved. The Overview tab will use these figures.', 'good');
        // Refetched rather than assumed: the totals on the other tab are the
        // server's arithmetic, not this page's, and reloading is how the two
        // stay one answer.
        document.dispatchEvent(new CustomEvent('roi:saved'));
        setTimeout(() => { btn.innerHTML = label; }, 2000);
    } catch (err) {
        console.error(err);
        say(err.message, 'bad');
        btn.innerHTML = label;
    } finally {
        btn.disabled = false;
    }
}

/** A tab switch is not a page leave, so this is the only warning there can be. */
export function hasUnsaved() {
    return dirty;
}
