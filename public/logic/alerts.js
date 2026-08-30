/**
 * Alert configuration (F-13, F-14).
 *
 * The form is generated from a vocabulary the server sends, not from a copy of
 * it kept here. That is the whole reason /api/alerts/schema exists: a rule type
 * added to the engine appears in this form automatically, with its own units and
 * its own explanation, and cannot end up mislabelled. A threshold field that
 * says only "Threshold" is a trap — 5 could be five percent, five milliseconds
 * or five multiples, and the difference is between an alert that never fires and
 * one that fires every minute.
 */

document.addEventListener('DOMContentLoaded', initAlerts);

let schema = { ruleTypes: [], channelTypes: [] };
let rules = [];
let channels = [];
let workflows = [];
let editing = null;   // { kind: 'rule' | 'channel', id: number | null }

async function initAlerts() {
    await window.settingsReady;
    try {
        const res = await fetchWithAuth('/api/alerts/schema');
        schema = await res.json();
    } catch (err) {
        console.error('[ALERTS] schema:', err);
    }
    // Populated once; the rule form offers these as the thing to watch.
    try {
        const res = await fetchWithAuth('/api/workflows');
        if (res.ok) workflows = (await res.json()).filter((w) => !w.is_archived);
    } catch (err) { /* the picker degrades to "everything", which is a valid rule */ }

    await refreshAll();
}

async function refreshAll() {
    await Promise.all([loadStatus(), loadRules(), loadChannels(), loadEvents()]);
}

// ── Status ───────────────────────────────────────────────────

/**
 * The four tiles at the top.
 *
 * They used to be four hand-written cards with four arbitrary colours — indigo,
 * grey, amber, rose — chosen for variety rather than for meaning. Through the
 * shared KPI now, and only two of them assert anything: "fired" is neutral
 * because firing is what the feature is for, and "undelivered" turns red only
 * when it is non-zero. A red 0 is a warning about nothing, and a dashboard that
 * cries wolf at zero teaches people to stop reading it.
 */
async function loadStatus() {
    const host = document.getElementById('alertStats');
    try {
        const res = await fetchWithAuth('/api/alerts/status');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const s = await res.json();

        if (host) {
            host.innerHTML = [
                window.UI.kpi({
                    label: 'Active rules', value: (s.active_rules ?? 0).toLocaleString(),
                    note: s.active_rules ? 'being evaluated every pass' : 'nothing is being watched'
                }),
                window.UI.kpi({
                    label: 'Channels', value: (s.active_channels ?? 0).toLocaleString(),
                    note: s.active_channels ? 'can receive an alert' : 'alerts would be recorded only'
                }),
                window.UI.kpi({
                    label: 'Fired (24h)', value: (s.fired_24h ?? 0).toLocaleString(),
                    note: 'rules that met their condition'
                }),
                window.UI.kpi({
                    label: 'Undelivered', value: (s.undelivered ?? 0).toLocaleString(),
                    tone: s.undelivered ? 'critical' : undefined,
                    note: s.undelivered
                        ? 'these fired and nobody was told — check the channel'
                        : 'everything that fired was delivered'
                })
            ].join('');
        }

        // Alerting goes deliberately quiet when the replica is too far behind to
        // judge. Saying so is essential: silence that looks like "nothing is
        // wrong" while the pipeline is stalled is the worst possible failure for
        // a feature like this.
        const paused = document.getElementById('alertPaused');
        if (paused) {
            if (s.paused_by_staleness) {
                paused.classList.remove('hidden');
                paused.innerHTML = `<i class="fa-solid fa-pause mr-1.5"></i>` +
                    `<strong>Alerting is paused.</strong> The replica is ` +
                    `${Math.round(s.replica_lag_ms / 60000)} minutes behind, and every scheduled ` +
                    `workflow would look dead. Rules resume automatically once the sync catches up.`;
            } else {
                paused.classList.add('hidden');
            }
        }
    } catch (err) {
        console.error('[ALERTS] status:', err);
        if (host) host.innerHTML = `<div class="card md:col-span-2 lg:col-span-4"
            style="position:relative;min-height:120px">${window.UI.failed()}</div>`;
    }
}

/**
 * The enable/disable switch, once instead of twice.
 *
 * Rules and channels each had their own copy of this markup, differing only in
 * the colour of the "on" state — which was itself the bug: the two switches
 * meant the same thing and looked like they meant different things.
 */
function toggleSwitch(action, id, on, label) {
    return `<button data-action="${action}" data-arg="${id}" role="switch"
                    aria-checked="${on ? 'true' : 'false'}"
                    aria-label="${window.UI.esc(label)}"
                    title="${on ? 'Disable' : 'Enable'}"
                    style="width:34px;height:20px;border-radius:999px;position:relative;flex:none;
                           transition:background-color .2s ease;
                           background:${on ? 'var(--good-mark)' : 'var(--surface-3)'}">
                <span style="position:absolute;top:3px;width:14px;height:14px;border-radius:999px;
                             background:var(--ink-1);transition:left .2s ease;
                             left:${on ? '17px' : '3px'}"></span>
            </button>`;
}

// ── Rules ────────────────────────────────────────────────────

const ruleSpec = (type) => schema.ruleTypes.find((t) => t.type === type);

/** The rule's condition as a sentence, in the units the type actually uses. */
function describeCondition(rule) {
    const spec = ruleSpec(rule.type);
    if (!spec) return escapeHtml(rule.type);
    const threshold = spec.threshold
        ? `<strong style="color:var(--ink-1)">${rule.threshold}${escapeHtml(spec.threshold.unit)}</strong> `
        : '';
    return `${escapeHtml(spec.label)}<br>` +
        `<span class="text-[10px]" style="color:var(--ink-3)">${threshold}over ${formatMinutes(rule.window_minutes)}` +
        `${rule.min_executions > 1 ? `, min ${rule.min_executions} runs` : ''}` +
        ` · one alert per ${formatMinutes(rule.cooldown_minutes)}</span>`;
}

function describeScope(rule) {
    if (rule.workflow_id) {
        const wf = workflows.find((w) => w.id === rule.workflow_id);
        return escapeHtml(wf ? wf.name : rule.workflow_id);
    }
    if (rule.folder_id) return 'a folder';
    if (rule.tag_id) return 'a tag';
    return '<span style="color:var(--ink-3)">the whole instance</span>';
}

async function loadRules() {
    const tbody = document.getElementById('rulesBody');
    tbody.innerHTML = window.UI.rowState(7, window.UI.loading());
    try {
        const res = await fetchWithAuth('/api/alerts/rules');
        rules = await res.json();

        if (!rules.length) {
            tbody.innerHTML = window.UI.rowState(7, window.UI.empty(
                'No rules yet',
                'Nothing will tell you when something breaks until there is one. ' +
                'The first one most instances want is "a failure nobody has seen before".',
                'fa-bell-slash'));
            return;
        }

        tbody.innerHTML = rules.map((r) => `
            <tr${r.enabled ? '' : ' style="opacity:.5"'}>
                <td>${toggleSwitch('toggleAlertRule', r.id, r.enabled, `Enable the rule ${r.name}`)}</td>
                <td style="color:var(--ink-1);font-weight:600">${escapeHtml(r.name)}</td>
                <td>${describeCondition(r)}</td>
                <td>${describeScope(r)}</td>
                <td>${
    r.channel_name
        ? escapeHtml(r.channel_name)
        : window.UI.badge('recorded only', {
            tone: 'warning',
            title: 'This rule has no channel. It will still fire and be logged below, but nobody is told.'
        })}</td>
                <td class="num">${
    r.last_fired
        ? escapeHtml(window.formatTime(r.last_fired, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))
        : '<span style="color:var(--ink-3)">never</span>'}${
    r.times_fired ? `<div class="label">${r.times_fired}\u00d7 in total</div>` : ''}</td>
                <td class="num">
                    <button data-action="editAlertRule" data-arg="${r.id}" class="btn btn-sm"
                            aria-label="Edit ${escapeHtml(r.name)}"><i class="fa-solid fa-pen"></i></button>
                    <button data-action="deleteAlertRule" data-arg="${r.id}" class="btn btn-sm btn-danger"
                            aria-label="Delete ${escapeHtml(r.name)}"><i class="fa-solid fa-trash"></i></button>
                </td>
            </tr>`).join('');
    } catch (err) {
        console.error('[ALERTS] rules:', err);
        tbody.innerHTML = window.UI.rowState(7, window.UI.failed('Could not load the rules.'));
    }
}

// ── Channels ─────────────────────────────────────────────────

async function loadChannels() {
    const tbody = document.getElementById('channelsBody');
    tbody.innerHTML = window.UI.rowState(6, window.UI.loading());
    try {
        const res = await fetchWithAuth('/api/alerts/channels');
        channels = await res.json();

        if (!channels.length) {
            tbody.innerHTML = window.UI.rowState(6, window.UI.empty(
                'No channels',
                'Rules still fire and are recorded below, but nobody is told. ' +
                'A webhook into n8n turns every integration n8n already has into an alert channel.',
                'fa-paper-plane'));
            return;
        }

        const when = (t) => escapeHtml(window.formatTime(t,
            { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }));

        tbody.innerHTML = channels.map((c) => {
            const spec = schema.channelTypes.find((t) => t.type === c.type);

            // Three states, and the third is the one that matters: a channel
            // nobody has ever tested is indistinguishable from a working one
            // until the incident it was built for.
            const result = c.last_error
                ? window.UI.badge(`failed ${when(c.last_error_at)}`, { tone: 'critical', title: c.last_error })
                : c.last_ok_at
                    ? window.UI.badge(`delivered ${when(c.last_ok_at)}`, { tone: 'good' })
                    : window.UI.badge('never used — send a test', { tone: 'warning' });

            const headerCount = Array.isArray((c.config || {}).headers) ? c.config.headers.length : 0;

            return `
            <tr${c.enabled ? '' : ' style="opacity:.5"'}>
                <td>${toggleSwitch('toggleAlertChannel', c.id, c.enabled, `Enable the channel ${c.name}`)}</td>
                <td style="color:var(--ink-1);font-weight:600">${escapeHtml(c.name)}</td>
                <td>${escapeHtml(spec ? spec.label : c.type)}${
    headerCount ? `<div class="label">${headerCount} custom header${headerCount === 1 ? '' : 's'}</div>` : ''}</td>
                <td class="num">${c.rules}</td>
                <td>${result}</td>
                <td class="num">
                    <button data-action="testAlertChannel" data-arg="${c.id}" class="btn btn-sm"
                            title="Send a real message through this channel"
                            aria-label="Test ${escapeHtml(c.name)}"><i class="fa-solid fa-vial"></i></button>
                    <button data-action="editAlertChannel" data-arg="${c.id}" class="btn btn-sm"
                            aria-label="Edit ${escapeHtml(c.name)}"><i class="fa-solid fa-pen"></i></button>
                    <button data-action="deleteAlertChannel" data-arg="${c.id}" class="btn btn-sm btn-danger"
                            aria-label="Delete ${escapeHtml(c.name)}"><i class="fa-solid fa-trash"></i></button>
                </td>
            </tr>`;
        }).join('');
    } catch (err) {
        console.error('[ALERTS] channels:', err);
        tbody.innerHTML = window.UI.rowState(6, window.UI.failed('Could not load the channels.'));
    }
}

// ── Events ───────────────────────────────────────────────────

// Every delivery outcome is a status, so each is a tone and a word — never a
// colour on its own. `suppressed` is neutral on purpose: a cooldown holding a
// repeat is the system working, not a failure.
const DELIVERY = {
    sent: ['good', 'delivered'],
    failed: ['critical', 'failed'],
    suppressed: ['neutral', 'held by cooldown'],
    no_channel: ['warning', 'no channel'],
    pending: ['neutral', 'pending']
};

async function loadEvents() {
    const tbody = document.getElementById('eventsBody');
    tbody.innerHTML = window.UI.rowState(4, window.UI.loading());
    try {
        const res = await fetchWithAuth('/api/alerts/events?limit=50');
        const events = await res.json();

        if (!events.length) {
            tbody.innerHTML = window.UI.rowState(4, window.UI.empty(
                'Nothing has fired yet',
                'This is the log of every time a rule met its condition, including the ones a cooldown held back.',
                'fa-clock-rotate-left'));
            return;
        }

        tbody.innerHTML = events.map((e) => {
            const [tone, label] = DELIVERY[e.delivery_status] || ['neutral', e.delivery_status];
            return `
            <tr style="vertical-align:top">
                <td class="whitespace-nowrap">${
    escapeHtml(window.formatTime(e.fired_at, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}</td>
                <td>${escapeHtml(e.rule_name || '—')}</td>
                <td>
                    <span style="color:var(--ink-1)">${escapeHtml(e.title)}</span>
                    <div class="text-[11px] mt-0.5" style="color:var(--ink-3)">${escapeHtml(e.body || '')}</div>
                </td>
                <td class="num">${window.UI.badge(label, { tone })}${
    e.delivery_error
        ? `<div class="text-[10px] mt-1" style="color:var(--critical-ink)">${escapeHtml(e.delivery_error)}</div>`
        : ''}</td>
            </tr>`;
        }).join('');
    } catch (err) {
        console.error('[ALERTS] events:', err);
        tbody.innerHTML = window.UI.rowState(4, window.UI.failed('Could not load the alert log.'));
    }
}

// ── The editor ───────────────────────────────────────────────

window.newAlertRule = () => openEditor('rule', null);
window.editAlertRule = (id) => openEditor('rule', Number(id));
window.newAlertChannel = () => openEditor('channel', null);
window.editAlertChannel = (id) => openEditor('channel', Number(id));

window.closeAlertEditor = function () {
    editing = null;
    const modal = document.getElementById('editorModal');
    modal.classList.add('hidden');
    modal.style.display = 'none';
    document.body.style.overflow = 'auto';
};

function showEditorError(message) {
    const el = document.getElementById('editorError');
    if (el) el.textContent = message;
}

function openEditor(kind, id) {
    // `headers` is deliberately reset here rather than left to be lazily
    // rebuilt: it is per-channel state, and carrying it from the last channel
    // edited would put one channel's header names into another's form.
    editing = { kind, id, headers: null, draft: null };
    const modal = document.getElementById('editorModal');
    document.getElementById('editorError').textContent = '';
    document.getElementById('editorTitle').textContent =
        `${id ? 'Edit' : 'New'} ${kind}`;
    renderEditor();
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function renderEditor() {
    const body = document.getElementById('editorBody');
    body.innerHTML = editing.kind === 'rule' ? ruleForm() : channelForm();

    // The rule form changes shape with the type, because a threshold means
    // something different for each one and half the fields do not apply.
    const typeSelect = document.getElementById('formType');
    if (typeSelect) {
        typeSelect.addEventListener('change', () => {
            const current = collectForm();
            editing.draft = { ...current, type: typeSelect.value, threshold: '' };
            // Channel types do not share a config shape — telegram has no
            // headers at all — so the rows are re-derived rather than carried
            // across, which would leave orphan rows the new type cannot store.
            if (editing.kind === 'channel') editing.headers = null;
            renderEditor();
        });
    }
}

function field(label, inner, hint) {
    return `<label class="flex flex-col gap-1.5">
        <span class="label">${label}</span>
        ${inner}
        ${hint ? `<span class="text-[10px]" style="color:var(--ink-3)">${hint}</span>` : ''}
    </label>`;
}

// One input style, one select style. They were re-typed as a 200-character
// class attribute at every call site, which is why the form drifted out of step
// with the rest of the dashboard in the first place (F-24 §7).
const CONTROL = 'width:100%;background:var(--surface-0);border:1px solid var(--line);' +
    'border-radius:var(--r-md);padding:.5rem .75rem;font-size:13px;color:var(--ink-1)';

const input = (id, value, attrs = '') =>
    `<input id="${id}" value="${escapeHtml(value ?? '')}" ${attrs} style="${CONTROL}">`;

const select = (id, options) => `<select id="${id}" style="${CONTROL}">${options}</select>`;

function ruleForm() {
    const existing = editing.draft || rules.find((r) => r.id === editing.id) || {};
    const type = existing.type || schema.ruleTypes[0]?.type;
    const spec = ruleSpec(type) || {};
    const defaults = spec.defaults || {};

    const typeOptions = schema.ruleTypes.map((t) =>
        `<option value="${t.type}" ${t.type === type ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
    ).join('');

    const channelOptions = ['<option value="">Record it, but tell nobody</option>']
        .concat(channels.map((c) =>
            `<option value="${c.id}" ${String(existing.channel_id) === String(c.id) ? 'selected' : ''}>${
                escapeHtml(c.name)}</option>`)).join('');

    const workflowOptions = ['<option value="">Every workflow</option>']
        .concat(workflows.map((w) =>
            `<option value="${escapeHtml(w.id)}" ${existing.workflow_id === w.id ? 'selected' : ''}>${
                escapeHtml(w.name)}</option>`)).join('');

    // Only shown when the type has one. Novelty is not a quantity, and a
    // threshold box next to "a failure nobody has seen before" would be a
    // question with no correct answer.
    const thresholdField = spec.threshold
        ? field(`Threshold (${escapeHtml(spec.threshold.unit)})`,
            input('formThreshold', existing.threshold ?? '',
                `type="number" step="any" min="${spec.threshold.min}" max="${spec.threshold.max}"`),
            escapeHtml(spec.threshold.hint))
        : '';

    return `
        ${field('Name', input('formName', existing.name || '', 'maxlength="80" placeholder="e.g. Call Center failing"'))}
        ${field('Fire when', select('formType', typeOptions),
    escapeHtml(spec.description || ''))}
        ${thresholdField}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            ${field('Measured over (minutes)',
        input('formWindow', existing.window_minutes ?? defaults.window_minutes, 'type="number" min="1"'))}
            ${field('At most one alert per (minutes)',
        input('formCooldown', existing.cooldown_minutes ?? defaults.cooldown_minutes, 'type="number" min="0"'),
        'Stops a workflow failing every minute from alerting every minute.')}
        </div>
        ${field('Ignore below this many executions',
        input('formMin', existing.min_executions ?? defaults.min_executions, 'type="number" min="1"'),
        'One failure out of two is a 50% error rate and is not news.')}
        ${field('Watching', select('formWorkflow', workflowOptions))}
        ${field('Send it to', select('formChannel', channelOptions),
    channels.length ? '' : 'No channels yet — the alert will be recorded on this page only.')}
        <label class="flex items-center gap-2 text-xs text-ink-2 mt-1">
            <input type="checkbox" id="formEnabled" class="accent-indigo-500" ${
    existing.enabled === 0 ? '' : 'checked'}> Enabled
        </label>`;
}

function channelForm() {
    const existing = editing.draft || channels.find((c) => c.id === editing.id) || {};
    const type = existing.type || schema.channelTypes[0]?.type;
    const spec = schema.channelTypes.find((t) => t.type === type) || { fields: [] };

    const typeOptions = schema.channelTypes.map((t) =>
        `<option value="${t.type}" ${t.type === type ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
    ).join('');

    const fields = spec.fields.map((f) => {
        // F-24 §4 · the header list.
        if (f.type === 'headers') return headerListField(existing);

        return field(
            escapeHtml(f.label) + (f.required ? '' : ' <span style="color:var(--ink-3)">(optional)</span>'),
            input(`formCfg_${f.key}`,
                // A secret is never sent to the browser, so the box starts empty
                // and a blank one means "leave it as it was". Wiping a token by
                // editing a channel's name would be a nasty surprise.
                f.secret ? '' : ((existing.config || {})[f.key] || ''),
                `placeholder="${f.secret && (existing.config || {})[f.key] ? 'unchanged' : ''}"`),
            f.secret ? 'Stored on the server and never sent back to this page.' : ''
        );
    }).join('');

    // Import lives above the fields it fills in, because that is the order it
    // is used in: paste, then check what it produced, then save.
    const curlBox = spec.fields.some((f) => f.type === 'headers') ? `
        <details class="card card-pad" style="padding:.75rem">
            <summary class="label cursor-pointer select-none">
                <i class="fa-solid fa-terminal mr-1.5"></i>Start from a cURL command
            </summary>
            <p class="text-[11px] mt-2 mb-2" style="color:var(--ink-3)">
                Paste the command your endpoint's docs give you. It is parsed on the server by our own
                reader — never run — and the URL is checked against the same rules as a typed one.
            </p>
            <textarea id="curlPaste" rows="4" placeholder="curl -X POST https://… -H 'Authorization: Bearer …'"
                      style="${CONTROL};font-family:ui-monospace,monospace;font-size:11px;resize:vertical"></textarea>
            <div class="flex items-center gap-2 mt-2">
                <button type="button" class="btn btn-sm" data-action="importAlertCurl">
                    <i class="fa-solid fa-file-import"></i> Fill the form from this
                </button>
                ${editing.id ? `<button type="button" class="btn btn-sm" data-action="exportAlertCurl"
                        data-arg="${editing.id}">
                    <i class="fa-solid fa-file-export"></i> Export this channel
                </button>` : ''}
            </div>
            <p id="curlNote" class="text-[11px] mt-2" hidden></p>
        </details>` : '';

    return `
        ${field('Name', input('formName', existing.name || '', 'maxlength="80"'))}
        ${field('Type', select('formType', typeOptions), escapeHtml(spec.description || ''))}
        ${curlBox}
        ${fields}
        <label class="flex items-center gap-2 text-xs mt-1" style="color:var(--ink-2)">
            <input type="checkbox" id="formEnabled" style="accent-color:var(--good-mark)" ${
    existing.enabled === 0 ? '' : 'checked'}> Enabled
        </label>`;
}

/**
 * The custom-header rows.
 *
 * Held in `editing.headers` rather than read back out of the DOM on every
 * keystroke, so adding or removing a row can re-render without losing what has
 * been typed into the others.
 *
 * Every value arrives masked. A masked value submitted unchanged means "keep
 * the stored one" — resolved server-side BY NAME, which is what makes it safe
 * to reorder or rename rows here.
 */
function headerListField(existing) {
    if (!editing.headers) {
        const stored = (existing.config || {}).headers;
        editing.headers = Array.isArray(stored)
            ? stored.map((h) => ({ name: h.name, value: h.value || '' }))
            : [];
    }

    const rows = editing.headers.map((h, i) => `
        <div class="flex items-center gap-2" data-header-row="${i}">
            <input id="hdrName_${i}" value="${escapeHtml(h.name)}" placeholder="Header name"
                   style="${CONTROL};flex:0 0 38%">
            <input id="hdrValue_${i}" value="${escapeHtml(h.value)}" placeholder="Value"
                   style="${CONTROL};flex:1;font-family:ui-monospace,monospace;font-size:11px">
            <button type="button" class="btn btn-sm btn-danger" data-action="removeAlertHeader" data-arg="${i}"
                    aria-label="Remove ${escapeHtml(h.name) || 'this header'}" style="flex:none">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>`).join('');

    return `
        <div class="flex flex-col gap-1.5">
            <span class="label">Custom headers <span style="color:var(--ink-3)">(optional)</span></span>
            <div class="flex flex-col gap-2">${rows}</div>
            <div class="flex items-center gap-2 mt-1">
                <button type="button" class="btn btn-sm" data-action="addAlertHeader">
                    <i class="fa-solid fa-plus"></i> Add header
                </button>
                <span class="text-[10px]" style="color:var(--ink-3)">
                    ${editing.headers.length
        ? 'Dotted values are stored on the server. Leave one as it is to keep it.'
        : 'For endpoints that need an Authorization, a signature, or both.'}
                </span>
            </div>
        </div>`;
}

/** Reads the header rows out of the DOM, so a re-render keeps what was typed. */
function readHeaderRows() {
    if (!editing.headers) return [];
    return editing.headers.map((_, i) => ({
        name: document.getElementById(`hdrName_${i}`)?.value ?? '',
        value: document.getElementById(`hdrValue_${i}`)?.value ?? ''
    }));
}

window.addAlertHeader = function () {
    editing.headers = readHeaderRows();
    if (editing.headers.length >= 10) {
        showEditorError('Ten custom headers is the limit.');
        return;
    }
    editing.headers.push({ name: '', value: '' });
    editing.draft = collectForm();
    renderEditor();
    document.getElementById(`hdrName_${editing.headers.length - 1}`)?.focus();
};

window.removeAlertHeader = function (index) {
    editing.headers = readHeaderRows();
    editing.headers.splice(Number(index), 1);
    editing.draft = collectForm();
    renderEditor();
};

/**
 * Fills the form from a pasted cURL command.
 *
 * The parse happens on the server: it is the same module the security note in
 * F-24 §4 is about, and a second copy of it in the browser would be a second
 * thing to get right. What comes back has already been through `validateUrl`,
 * so a paste aimed at a private address is refused here, where the person can
 * see why, rather than silently at save time.
 */
window.importAlertCurl = async function () {
    const box = document.getElementById('curlPaste');
    const note = document.getElementById('curlNote');
    if (!box || !box.value.trim()) return;

    try {
        const res = await fetchWithAuth('/api/alerts/channels/parse-curl', {
            method: 'POST',
            body: JSON.stringify({ command: box.value })
        });
        const body = await res.json();
        if (!res.ok) {
            note.hidden = false;
            note.style.color = 'var(--critical-ink)';
            note.textContent = body.error || 'That could not be read as a curl command.';
            return;
        }

        editing.draft = { ...collectForm(), config: { url: body.url } };
        editing.headers = body.headers.map((h) => ({ name: h.name, value: h.value }));
        renderEditor();

        // Re-rendered, so the note has to be written again — and the details
        // element it lives in has to be re-opened, or the confirmation would be
        // invisible behind a collapsed summary.
        const reopened = document.getElementById('curlNote');
        const details = reopened?.closest('details');
        if (details) details.open = true;
        if (reopened) {
            reopened.hidden = false;
            reopened.style.color = 'var(--good-ink)';
            reopened.textContent = `Read the URL and ${body.headers.length} header(s).` +
                (body.notes.length ? ` ${body.notes.join(' ')}` : '');
        }
    } catch (err) {
        console.error('[ALERTS] curl import:', err);
    }
};

/**
 * Renders the saved channel as a cURL command.
 *
 * Values come back masked, and the note says so. That is not an oversight: this
 * API has never read a stored secret back to a browser, and handing them out
 * through an endpoint that happens to return a shell command would undo the
 * reason `redactConfig` exists. For "does this channel actually work", the Test
 * button sends a real message down the real delivery path.
 */
window.exportAlertCurl = async function (id) {
    const note = document.getElementById('curlNote');
    try {
        const res = await fetchWithAuth(`/api/alerts/channels/${encodeURIComponent(id)}/curl`);
        const body = await res.json();
        if (!res.ok) {
            note.hidden = false;
            note.style.color = 'var(--critical-ink)';
            note.textContent = body.error;
            return;
        }
        const box = document.getElementById('curlPaste');
        if (box) box.value = body.command;
        note.hidden = false;
        note.style.color = 'var(--ink-3)';
        note.textContent = body.note;
    } catch (err) {
        console.error('[ALERTS] curl export:', err);
    }
};

function collectForm() {
    const val = (id) => document.getElementById(id)?.value;
    if (editing.kind === 'rule') {
        return {
            name: val('formName'),
            type: val('formType'),
            threshold: val('formThreshold'),
            window_minutes: val('formWindow'),
            cooldown_minutes: val('formCooldown'),
            min_executions: val('formMin'),
            workflow_id: val('formWorkflow') || null,
            channel_id: val('formChannel') || null,
            enabled: document.getElementById('formEnabled')?.checked
        };
    }
    const type = val('formType');
    const spec = schema.channelTypes.find((t) => t.type === type) || { fields: [] };
    const config = {};
    for (const f of spec.fields) {
        if (f.type === 'headers') {
            // Sent even when empty, so removing the last header actually
            // removes it. Omitting the key would read as "not submitted" and
            // the server would keep what it had.
            config[f.key] = readHeaderRows().filter((h) => h.name.trim() || h.value.trim());
            continue;
        }
        const v = val(`formCfg_${f.key}`);
        if (v) config[f.key] = v;
    }
    return {
        name: val('formName'),
        type,
        config,
        enabled: document.getElementById('formEnabled')?.checked
    };
}

window.saveAlertEditor = async function () {
    const payload = collectForm();
    const base = editing.kind === 'rule' ? '/api/alerts/rules' : '/api/alerts/channels';
    const url = editing.id ? `${base}/${editing.id}` : base;
    const errEl = document.getElementById('editorError');
    errEl.textContent = '';

    try {
        const res = await fetchWithAuth(url, {
            method: editing.id ? 'PUT' : 'POST',
            body: JSON.stringify(payload)
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            // The server's own message, not a generic one: it names the field and
            // the units, which is the only useful thing to show here.
            errEl.textContent = body.error ||
                (res.status === 403 ? 'Only an owner or admin can change alerting.' : 'Could not save.');
            return;
        }
        window.closeAlertEditor();
        await refreshAll();
    } catch (err) {
        errEl.textContent = 'Could not save.';
    }
};

// ── Row actions ──────────────────────────────────────────────

async function writeAction(url, options, okMessage) {
    try {
        const res = await fetchWithAuth(url, options);
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            notePermission(res.status, body.error);
            return null;
        }
        if (okMessage) showNote(okMessage, 'ok');
        return res.json().catch(() => ({}));
    } catch (err) {
        console.error('[ALERTS]', err);
        return null;
    }
}

window.toggleAlertRule = async function (id) {
    const rule = rules.find((r) => r.id === Number(id));
    if (!rule) return;
    await writeAction(`/api/alerts/rules/${rule.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...rule, enabled: !rule.enabled })
    });
    await Promise.all([loadRules(), loadStatus()]);
};

window.toggleAlertChannel = async function (id) {
    const channel = channels.find((c) => c.id === Number(id));
    if (!channel) return;
    // config is redacted on the way in, so it is deliberately not resent: the
    // server keeps the stored secrets when the field arrives blank.
    await writeAction(`/api/alerts/channels/${channel.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: channel.name, type: channel.type, config: {}, enabled: !channel.enabled })
    });
    await Promise.all([loadChannels(), loadStatus()]);
};

window.deleteAlertRule = async function (id) {
    const rule = rules.find((r) => r.id === Number(id));
    if (!rule || !window.confirm(`Delete the rule "${rule.name}"? Alerts it already sent are kept.`)) return;
    await writeAction(`/api/alerts/rules/${rule.id}`, { method: 'DELETE' });
    await Promise.all([loadRules(), loadStatus()]);
};

window.deleteAlertChannel = async function (id) {
    const channel = channels.find((c) => c.id === Number(id));
    if (!channel) return;
    const warning = channel.rules
        ? `\n\n${channel.rules} rule(s) use it. They will keep firing, but nobody will be told.`
        : '';
    if (!window.confirm(`Delete the channel "${channel.name}"?${warning}`)) return;
    await writeAction(`/api/alerts/channels/${channel.id}`, { method: 'DELETE' });
    await refreshAll();
};

window.testAlertChannel = async function (id) {
    const result = await writeAction(`/api/alerts/channels/${id}/test`, { method: 'POST' });
    if (result) {
        showNote(result.ok
            ? 'Test message delivered.'
            : `The channel did not accept it: ${result.error}`, result.ok ? 'ok' : 'bad');
    }
    await loadChannels();
};

window.runAlertsNow = async function () {
    const result = await writeAction('/api/alerts/run?force=true', { method: 'POST' });
    if (result) {
        showNote(result.status === 'ok'
            ? `Evaluated ${result.rules} rule(s): ${result.fired} fired, ${result.delivered} delivered, ${result.suppressed} held by cooldown.`
            : `Pass returned "${result.status}".`, 'ok');
    }
    await refreshAll();
};

// ── Small helpers ────────────────────────────────────────────

// `setText` and `row` lived here. Both are gone: the tiles are rendered through
// UI.kpi and the empty rows through UI.rowState, so there is no longer a local
// definition of "how an empty table looks" for this page to disagree with the
// others about.

function formatMinutes(minutes) {
    const m = Number(minutes) || 0;
    if (m === 0) return 'no cooldown';
    if (m < 60) return `${m} min`;
    if (m < 1440) return `${(m / 60).toFixed(m % 60 ? 1 : 0)} h`;
    return `${(m / 1440).toFixed(m % 1440 ? 1 : 0)} d`;
}

function notePermission(status, message) {
    if (status === 403) {
        showNote(message || 'Only an owner or admin can change alerting. You can still see what is configured.', 'bad');
    } else {
        showNote(message || 'That did not work.', 'bad');
    }
}

function showNote(message, kind) {
    const el = document.getElementById('permissionNote');
    if (!el) return;
    el.classList.remove('hidden');
    el.className = kind === 'ok'
        ? 'text-xs rounded-lg px-3 py-2 bg-green-900/15 border border-green-500/25 text-green-200 mb-6'
        : 'text-xs rounded-lg px-3 py-2 bg-rose-900/20 border border-rose-500/30 text-rose-200 mb-6';
    el.textContent = message;
}
