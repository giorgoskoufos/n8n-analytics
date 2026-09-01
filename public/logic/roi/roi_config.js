/**
 * The Configure tab: two ways of saying the same thing, and you pick one.
 *
 * ── Why two views instead of one with a drawer ───────────────────────────
 *
 * There is exactly one number the database wants — seconds saved per run — and
 * two completely different ways a person arrives at it. Somebody who has
 * already measured their process types the figure. Somebody who has not knows
 * the job it replaced: "a person did this five times a week and it took half an
 * hour."
 *
 * The previous version showed the first and hid the second behind a per-row
 * "Work it out" button. That makes the harder, rarer path the default and the
 * easier, commoner one a thing you have to discover — and it put both on screen
 * at once for any row you opened, so the same figure had two controls competing
 * to own it. Which one is the truth? The one you touched last, which is not
 * something an interface should make you remember.
 *
 * So: one choice, made once, at the top of the tab.
 *
 *   Business case    the sentence. Default, because it is the one that needs
 *                    no prior measurement, and the one that keeps working when
 *                    the workflow's traffic changes.
 *   Per-run figures  the number, typed.
 *
 * Both carry the hourly rate, because a view you cannot finish in is not a
 * view, it is half of one.
 *
 * ── Why the baseline is stored and not just its result ───────────────────
 *
 * The division is one-way: 1 sec/run could have come from a thousand different
 * jobs. If only the result were saved, the default view would reopen on its own
 * placeholder text over a workflow configured as something else — a sentence
 * nobody wrote, sitting under a "Configured" badge. So migration 026 keeps the
 * four inputs, and their absence is meaningful: it means the figure was typed
 * directly, and this file says so rather than inventing a baseline.
 *
 * ── Why an untouched row saves nothing ───────────────────────────────────
 *
 * The sentence has placeholder values, and they compute to a real-looking
 * number. Writing that number on save would configure every workflow in the
 * list from a claim nobody made — 164 confident figures out of one page load.
 * A row goes live when somebody touches its sentence, and until then the
 * arithmetic is shown as a preview and stored nowhere.
 */

import { perExecutionSeconds } from './roi_math.mjs';

/** Every workflow the caller may configure, with whatever is already stored. */
let workflows = [];

/**
 * Rows whose sentence the person has edited this session.
 *
 * A row with a stored baseline is already live; this is what promotes one that
 * is not, at the moment of the first keystroke. Kept out of `workflows` because
 * it is interaction state, not data to be saved.
 */
const touched = new Set();

const MODE_KEY = 'roi.configure.mode';
const MODES = ['baseline', 'direct'];

/**
 * Which view is showing. A preference of the person, not of the workflow — so
 * it is one value for the whole list, and it is remembered, because being
 * returned to a view you did not choose on every reload is the kind of small
 * insult that makes people stop using a page.
 */
let mode = 'baseline';

const DEFAULTS = { frequency: 5, per: 'week', duration: 30, unit: 'minutes' };

const el = (id) => document.getElementById(id);
const esc = (s) => window.escapeHtml(String(s ?? ''));

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
// The baseline, and whether a row has one
// ==========================================================================

/** True when this row's sentence is the source of its figure. */
function isLive(wf) {
    return touched.has(wf.id) || wf.baseline_frequency !== null;
}

/** What to put in the sentence's controls — the stored claim, or the placeholder. */
function baselineOf(wf) {
    if (wf.baseline_frequency === null) return { ...DEFAULTS };
    return {
        frequency: Number(wf.baseline_frequency),
        per: wf.baseline_per,
        duration: Number(wf.baseline_duration),
        unit: wf.baseline_unit
    };
}

// ==========================================================================
// Rendering
// ==========================================================================

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

/** The name, the badge and the run counts — identical in both views. */
function head(wf) {
    const configured = Number(wf.saved_time_seconds) > 0;
    return `
        <div class="roi-row-id">
          <span class="roi-row-name" title="${esc(wf.name)}">${esc(wf.name)}</span>
          <span class="roi-row-meta">
            <span class="badge ${configured ? 'badge-good' : 'badge-neutral'}">
              ${configured ? 'Configured' : 'Not set'}
            </span>
            <span>${(Number(wf.execution_count) || 0).toLocaleString()} runs all time</span>
            <span>·</span>
            <span>${(Number(wf.executions_30d) || 0).toLocaleString()} in the last 30 days</span>
          </span>
        </div>`;
}

/**
 * The rate control, in both views.
 *
 * `first` is why the column label is not on every row. There are 164 workflows
 * on the instance this was built against, and the same caption repeated 164
 * times is chrome competing with the numbers it labels. It is drawn once, at
 * the top, and the `aria-label` stays on every input so nothing is lost to a
 * screen reader.
 */
function rateField(wf, first) {
    return `
          <label class="roi-input">
            <span class="roi-input-label" ${first ? '' : 'aria-hidden="true"'}>${first ? 'Hourly rate' : ''}</span>
            <span class="input-affix">
              <span class="affix">${esc(window.currencySymbol())}</span>
              <input type="number" min="0" step="1" class="input js-rate"
                     value="${Number(wf.hourly_rate) || 0}" aria-label="Hourly rate of the work replaced">
              <span class="affix">/h</span>
            </span>
          </label>`;
}

const option = (value, label, selected) =>
    `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`;

function baselineRow(wf, first) {
    const b = baselineOf(wf);
    return `
    <div class="roi-row" data-id="${esc(wf.id)}">
      <div class="roi-row-head">
        ${head(wf)}
        <div class="roi-row-inputs">${rateField(wf, first)}</div>
      </div>

      <div class="roi-calc" data-execs="${Number(wf.executions_30d) || 0}">
        <div class="roi-sentence">
          <span>A person did this</span>
          <span class="input-affix roi-calc-field">
            <input type="number" min="1" step="1" value="${esc(b.frequency)}"
                   class="input js-freq" aria-label="How many times">
          </span>
          <span>times per</span>
          <span class="input-affix roi-calc-field">
            <select class="input js-per" aria-label="Per period">
              ${option('day', 'day', b.per)}${option('week', 'week', b.per)}${option('month', 'month', b.per)}
            </select>
          </span>
          <span>, and each time took</span>
          <span class="input-affix roi-calc-field">
            <input type="number" min="1" step="1" value="${esc(b.duration)}"
                   class="input js-dur" aria-label="How long">
          </span>
          <span class="input-affix roi-calc-field">
            <select class="input js-unit" aria-label="Time unit">
              ${option('minutes', 'minutes', b.unit)}${option('hours', 'hours', b.unit)}
            </select>
          </span>
          <span>.</span>
        </div>

        <div class="roi-working js-working"></div>
      </div>
    </div>`;
}

function directRow(wf, first) {
    return `
    <div class="roi-row" data-id="${esc(wf.id)}">
      <div class="roi-row-head">
        ${head(wf)}
        <div class="roi-row-inputs">
          <label class="roi-input">
            <span class="roi-input-label" ${first ? '' : 'aria-hidden="true"'}>${first ? 'Saves per run' : ''}</span>
            <span class="input-affix">
              <input type="number" min="0" step="1" class="input js-seconds"
                     value="${Number(wf.saved_time_seconds) || 0}" aria-label="Seconds saved per run">
              <span class="affix">sec</span>
            </span>
          </label>
          ${rateField(wf, first)}
        </div>
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

    const draw = mode === 'direct' ? directRow : baselineRow;
    container.innerHTML = rows.map((wf, i) => draw(wf, i === 0)).join('');
    if (mode === 'baseline') rows.forEach((wf) => recalc(wf.id));
}

// ==========================================================================
// The live working
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
 * Redraws one row's working, and — when the row is live — commits the figure.
 *
 * Every intermediate is named. If the answer looks wrong, the reader can see
 * WHICH line is wrong, which is the difference between a calculator and an
 * oracle, and the whole reason the old one was distrusted.
 */
function recalc(id, { commit = false } = {}) {
    const node = rowEl(id);
    if (!node) return;
    const calc = node.querySelector('.roi-calc');
    const out = node.querySelector('.js-working');
    if (!calc || !out) return;

    const wf = workflows.find((w) => w.id === id);
    if (!wf) return;

    const result = perExecutionSeconds(readCalc(calc));
    const live = isLive(wf);

    if (!result.ok) {
        // The refusal names the other view, because on a workflow n8n has not
        // run there is no divisor and no amount of rewording the sentence will
        // produce one. Telling somebody to try harder at an impossible form is
        // worse than telling them where the possible one is.
        out.innerHTML = `<div class="roi-working-blocked">
            <i class="fa-solid fa-circle-info"></i><span>${esc(result.reason)}</span>
        </div>`;
        return;
    }

    if (commit && live) {
        wf.saved_time_seconds = result.secondsPerExecution;
        wf.baseline_frequency = Number(calc.querySelector('.js-freq').value);
        wf.baseline_per = calc.querySelector('.js-per').value;
        wf.baseline_duration = Number(calc.querySelector('.js-dur').value);
        wf.baseline_unit = calc.querySelector('.js-unit').value;
        paintBadge(node, wf);
    }

    const monthly = window.formatDuration(result.humanSecondsPerMonth);
    const runs = Math.round(result.manualRunsPerMonth).toLocaleString();
    const execs = result.executions30d.toLocaleString();
    const each = result.secondsPerExecution >= 60
        ? ` · ${esc(window.formatDuration(result.secondsPerExecution))}` : '';

    // The stored figure is shown beside the preview only when the two are not
    // the same thing — a row whose number was typed directly still has one, and
    // an untouched sentence must not look like it replaced it.
    const stored = Number(wf.saved_time_seconds) || 0;
    const pending = !live && stored > 0
        ? `<p class="roi-preview-note">Currently <strong>${stored.toLocaleString()} sec</strong>
             per run, entered directly. Edit the sentence to replace it.</p>`
        : !live
            ? '<p class="roi-preview-note">A preview. Edit the sentence to use it.</p>'
            : '';

    out.innerHTML = `
      <dl class="roi-steps">
        <div><dt>That is</dt><dd>${runs} manual runs a month — <strong>${esc(monthly)}</strong> of work</dd></div>
        <div><dt>n8n ran it</dt><dd>${execs} times in the same 30 days</dd></div>
      </dl>
      <div class="roi-result${live ? '' : ' is-preview'}">
        <div>
          <span class="label">Saved per execution</span>
          <span class="roi-result-value">${result.secondsPerExecution.toLocaleString()} sec<span
            class="roi-result-alt">${each}</span></span>
        </div>
        ${pending}
      </div>`;
}

/** Keeps the badge honest the moment the thing it describes changes. */
function paintBadge(node, wf) {
    const badge = node.querySelector('.roi-row-meta .badge');
    if (!badge) return;
    const configured = Number(wf.saved_time_seconds) > 0;
    badge.className = `badge ${configured ? 'badge-good' : 'badge-neutral'}`;
    badge.textContent = configured ? 'Configured' : 'Not set';
}

// ==========================================================================
// The view switch
// ==========================================================================

function paintMode() {
    document.querySelectorAll('.roi-mode-btn').forEach((btn) => {
        const on = btn.dataset.mode === mode;
        btn.setAttribute('aria-checked', String(on));
        btn.classList.toggle('is-on', on);
        // Only the selected control is in the tab order, which is what a
        // radiogroup is supposed to do — otherwise every switch costs two tabs
        // to get past.
        btn.tabIndex = on ? 0 : -1;
    });
}

function setMode(next) {
    if (!MODES.includes(next) || next === mode) return;
    mode = next;
    try {
        window.localStorage.setItem(MODE_KEY, mode);
    } catch {
        // A browser refusing storage is not a reason to refuse the switch.
    }
    paintMode();
    render();
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

    try {
        const saved = window.localStorage.getItem(MODE_KEY);
        if (MODES.includes(saved)) mode = saved;
    } catch {
        // Same as above: the default is a perfectly good answer.
    }
    paintMode();

    document.querySelectorAll('.roi-mode-btn').forEach((btn) => {
        btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    container.addEventListener('input', (event) => {
        const node = event.target.closest('.roi-row');
        if (!node) return;
        const wf = workflows.find((w) => w.id === node.dataset.id);
        if (!wf) return;

        if (event.target.classList.contains('js-seconds')) {
            wf.saved_time_seconds = Math.max(0, parseInt(event.target.value, 10) || 0);
            // Typing the figure directly retires whatever sentence used to
            // produce it. Keeping both would leave the other view redisplaying a
            // claim that no longer computes to the saved number — the one thing
            // storing the baseline was meant to prevent.
            clearBaseline(wf);
            paintBadge(node, wf);
            markDirty();
            paintCoverage();
        } else if (event.target.classList.contains('js-rate')) {
            wf.hourly_rate = Math.max(0, parseFloat(event.target.value) || 0);
            markDirty();
        } else if (event.target.closest('.roi-calc')) {
            touched.add(wf.id);
            recalc(wf.id, { commit: true });
            markDirty();
            paintCoverage();
        }
    });

    // `change` as well as `input`, because a <select> in some browsers only
    // fires the second — and the calculator that does not update when you
    // switch week to month is the calculator nobody believes.
    container.addEventListener('change', (event) => {
        const node = event.target.closest('.roi-row');
        if (!node || !event.target.closest('.roi-calc')) return;
        touched.add(node.dataset.id);
        recalc(node.dataset.id, { commit: true });
        markDirty();
        paintCoverage();
    });

    ['workflowSearch', 'workflowFilter', 'workflowSort'].forEach((control) => {
        el(control)?.addEventListener(control === 'workflowSearch' ? 'input' : 'change', render);
    });

    el('saveBtn')?.addEventListener('click', save);
}

function clearBaseline(wf) {
    touched.delete(wf.id);
    wf.baseline_frequency = null;
    wf.baseline_per = null;
    wf.baseline_duration = null;
    wf.baseline_unit = null;
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
                    hourly_rate: parseFloat(w.hourly_rate) || 0,
                    // All four or none — the server rejects three, because a
                    // sentence with a hole in it can be neither recomputed nor
                    // redisplayed.
                    baseline_frequency: w.baseline_frequency,
                    baseline_per: w.baseline_per,
                    baseline_duration: w.baseline_duration,
                    baseline_unit: w.baseline_unit
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
