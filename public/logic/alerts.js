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

async function loadStatus() {
    try {
        const res = await fetchWithAuth('/api/alerts/status');
        if (!res.ok) return;
        const s = await res.json();
        setText('statRules', s.active_rules);
        setText('statChannels', s.active_channels);
        setText('statFired', s.fired_24h);
        setText('statUndelivered', s.undelivered);

        // Alerting goes deliberately quiet when the replica is too far behind to
        // judge. Saying so is essential: silence that looks like "nothing is
        // wrong" while the pipeline is stalled is the worst possible failure for
        // a feature like this.
        const paused = document.getElementById('alertPaused');
        if (paused) {
            if (s.paused_by_staleness) {
                paused.classList.remove('hidden');
                paused.innerHTML = `<i class="fa-solid fa-pause mr-1"></i> ` +
                    `<strong>Alerting is paused.</strong> The replica is ` +
                    `${Math.round(s.replica_lag_ms / 60000)} minutes behind, and every scheduled ` +
                    `workflow would look dead. Rules resume automatically once the sync catches up.`;
            } else {
                paused.classList.add('hidden');
            }
        }
    } catch (err) {
        console.error('[ALERTS] status:', err);
    }
}

// ── Rules ────────────────────────────────────────────────────

const ruleSpec = (type) => schema.ruleTypes.find((t) => t.type === type);

/** The rule's condition as a sentence, in the units the type actually uses. */
function describeCondition(rule) {
    const spec = ruleSpec(rule.type);
    if (!spec) return escapeHtml(rule.type);
    const threshold = spec.threshold
        ? `<strong class="text-gray-200">${rule.threshold}${escapeHtml(spec.threshold.unit)}</strong> `
        : '';
    return `${escapeHtml(spec.label)}<br>` +
        `<span class="text-[10px] text-gray-500">${threshold}over ${formatMinutes(rule.window_minutes)}` +
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
    return '<span class="text-gray-500">the whole instance</span>';
}

async function loadRules() {
    const tbody = document.getElementById('rulesBody');
    try {
        const res = await fetchWithAuth('/api/alerts/rules');
        rules = await res.json();

        tbody.innerHTML = rules.length ? rules.map((r) => `
            <tr class="hover:bg-gray-800/30 transition-colors ${r.enabled ? '' : 'opacity-50'}">
                <td class="p-3">
                    <button data-action="toggleAlertRule" data-arg="${r.id}"
                            title="${r.enabled ? 'Disable' : 'Enable'}"
                            class="w-8 h-5 rounded-full transition-colors relative ${
    r.enabled ? 'bg-indigo-600' : 'bg-gray-700'}">
                        <span class="absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${
    r.enabled ? 'left-3.5' : 'left-0.5'}"></span>
                    </button>
                </td>
                <td class="p-3 text-sm text-gray-200">${escapeHtml(r.name)}</td>
                <td class="p-3 text-xs text-gray-400">${describeCondition(r)}</td>
                <td class="p-3 text-xs text-gray-300">${describeScope(r)}</td>
                <td class="p-3 text-xs">${
    r.channel_name
        ? `<span class="text-gray-300">${escapeHtml(r.channel_name)}</span>`
        : '<span class="text-amber-400/80">nowhere — recorded only</span>'}</td>
                <td class="p-3 text-right text-[11px] text-gray-500">${
    r.last_fired
        ? escapeHtml(window.formatTime(r.last_fired, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))
        : 'never'}${r.times_fired ? `<br><span class="text-gray-600">${r.times_fired}×</span>` : ''}</td>
                <td class="p-3 text-right whitespace-nowrap">
                    <button data-action="editAlertRule" data-arg="${r.id}" title="Edit"
                        class="text-gray-500 hover:text-indigo-300 transition-colors px-2"><i class="fa-solid fa-pen text-xs"></i></button>
                    <button data-action="deleteAlertRule" data-arg="${r.id}" title="Delete"
                        class="text-gray-600 hover:text-rose-400 transition-colors px-2"><i class="fa-solid fa-trash text-xs"></i></button>
                </td>
            </tr>`).join('')
            : `<tr><td colspan="7" class="p-10 text-center text-gray-500 text-sm italic">
                   No rules yet. Nothing will tell you when something breaks until there is one.</td></tr>`;
    } catch (err) {
        console.error('[ALERTS] rules:', err);
        tbody.innerHTML = row(7, 'Could not load rules');
    }
}

// ── Channels ─────────────────────────────────────────────────

async function loadChannels() {
    const tbody = document.getElementById('channelsBody');
    try {
        const res = await fetchWithAuth('/api/alerts/channels');
        channels = await res.json();

        tbody.innerHTML = channels.length ? channels.map((c) => {
            const spec = schema.channelTypes.find((t) => t.type === c.type);
            const result = c.last_error
                ? `<span class="text-rose-400" title="${escapeHtml(c.last_error)}">failed ${
    escapeHtml(window.formatTime(c.last_error_at, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>`
                : c.last_ok_at
                    ? `<span class="text-green-400/80">delivered ${
    escapeHtml(window.formatTime(c.last_ok_at, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>`
                    : '<span class="text-gray-600">never used — send a test</span>';
            return `
            <tr class="hover:bg-gray-800/30 transition-colors ${c.enabled ? '' : 'opacity-50'}">
                <td class="p-3">
                    <button data-action="toggleAlertChannel" data-arg="${c.id}"
                            class="w-8 h-5 rounded-full transition-colors relative ${
    c.enabled ? 'bg-green-600' : 'bg-gray-700'}">
                        <span class="absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${
    c.enabled ? 'left-3.5' : 'left-0.5'}"></span>
                    </button>
                </td>
                <td class="p-3 text-sm text-gray-200">${escapeHtml(c.name)}</td>
                <td class="p-3 text-xs text-gray-400">${escapeHtml(spec ? spec.label : c.type)}</td>
                <td class="p-3 text-xs text-gray-500">${c.rules} rule${c.rules === 1 ? '' : 's'}</td>
                <td class="p-3 text-[11px]">${result}</td>
                <td class="p-3 text-right whitespace-nowrap">
                    <button data-action="testAlertChannel" data-arg="${c.id}" title="Send a test message"
                        class="text-gray-500 hover:text-green-300 transition-colors px-2"><i class="fa-solid fa-vial text-xs"></i></button>
                    <button data-action="editAlertChannel" data-arg="${c.id}" title="Edit"
                        class="text-gray-500 hover:text-indigo-300 transition-colors px-2"><i class="fa-solid fa-pen text-xs"></i></button>
                    <button data-action="deleteAlertChannel" data-arg="${c.id}" title="Delete"
                        class="text-gray-600 hover:text-rose-400 transition-colors px-2"><i class="fa-solid fa-trash text-xs"></i></button>
                </td>
            </tr>`;
        }).join('')
            : `<tr><td colspan="6" class="p-10 text-center text-gray-500 text-sm italic">
                   No channels. Rules still fire and are recorded below, but nobody is told.</td></tr>`;
    } catch (err) {
        console.error('[ALERTS] channels:', err);
        tbody.innerHTML = row(6, 'Could not load channels');
    }
}

// ── Events ───────────────────────────────────────────────────

const DELIVERY_LABEL = {
    sent: '<span class="text-green-400">delivered</span>',
    failed: '<span class="text-rose-400">failed</span>',
    suppressed: '<span class="text-gray-500">held by cooldown</span>',
    no_channel: '<span class="text-amber-400/80">no channel</span>',
    pending: '<span class="text-gray-400">pending</span>'
};

async function loadEvents() {
    const tbody = document.getElementById('eventsBody');
    try {
        const res = await fetchWithAuth('/api/alerts/events?limit=50');
        const events = await res.json();
        tbody.innerHTML = events.length ? events.map((e) => `
            <tr class="hover:bg-gray-800/30 transition-colors align-top">
                <td class="p-3 text-[11px] text-gray-500 whitespace-nowrap">${
    escapeHtml(window.formatTime(e.fired_at, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}</td>
                <td class="p-3 text-xs text-gray-400">${escapeHtml(e.rule_name || '—')}</td>
                <td class="p-3 text-xs text-gray-200">${escapeHtml(e.title)}
                    <div class="text-[11px] text-gray-500 mt-0.5">${escapeHtml(e.body || '')}</div></td>
                <td class="p-3 text-right text-[11px]">${DELIVERY_LABEL[e.delivery_status] || escapeHtml(e.delivery_status)}${
    e.delivery_error ? `<div class="text-[10px] text-rose-400/70 mt-0.5">${escapeHtml(e.delivery_error)}</div>` : ''}</td>
            </tr>`).join('')
            : row(4, 'Nothing has fired yet.');
    } catch (err) {
        console.error('[ALERTS] events:', err);
        tbody.innerHTML = row(4, 'Could not load the alert log');
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

function openEditor(kind, id) {
    editing = { kind, id };
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
            renderEditor();
        });
    }
}

function field(label, inner, hint) {
    return `<label class="flex flex-col gap-1">
        <span class="text-[10px] uppercase font-bold tracking-widest text-gray-500">${label}</span>
        ${inner}
        ${hint ? `<span class="text-[10px] text-gray-600">${hint}</span>` : ''}
    </label>`;
}

const input = (id, value, attrs = '') =>
    `<input id="${id}" value="${escapeHtml(value ?? '')}" ${attrs}
        class="bg-n8n-dark border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors">`;

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
        ${field('Fire when', `<select id="formType"
            class="bg-n8n-dark border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">${typeOptions}</select>`,
    escapeHtml(spec.description || ''))}
        ${thresholdField}
        <div class="grid grid-cols-2 gap-4">
            ${field('Measured over (minutes)',
        input('formWindow', existing.window_minutes ?? defaults.window_minutes, 'type="number" min="1"'))}
            ${field('At most one alert per (minutes)',
        input('formCooldown', existing.cooldown_minutes ?? defaults.cooldown_minutes, 'type="number" min="0"'),
        'Stops a workflow failing every minute from alerting every minute.')}
        </div>
        ${field('Ignore below this many executions',
        input('formMin', existing.min_executions ?? defaults.min_executions, 'type="number" min="1"'),
        'One failure out of two is a 50% error rate and is not news.')}
        ${field('Watching', `<select id="formWorkflow"
            class="bg-n8n-dark border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">${workflowOptions}</select>`)}
        ${field('Send it to', `<select id="formChannel"
            class="bg-n8n-dark border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">${channelOptions}</select>`,
    channels.length ? '' : 'No channels yet — the alert will be recorded on this page only.')}
        <label class="flex items-center gap-2 text-xs text-gray-300 mt-1">
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

    const fields = spec.fields.map((f) => field(
        escapeHtml(f.label) + (f.required ? '' : ' <span class="text-gray-600">(optional)</span>'),
        input(`formCfg_${f.key}`,
            // A secret is never sent to the browser, so the box starts empty and
            // a blank one means "leave it as it was". Wiping a token by editing
            // a channel's name would be a nasty surprise.
            f.secret ? '' : ((existing.config || {})[f.key] || ''),
            `placeholder="${f.secret && (existing.config || {})[f.key] ? 'unchanged' : ''}"`),
        f.secret ? 'Stored on the server and never sent back to this page.' : ''
    )).join('');

    return `
        ${field('Name', input('formName', existing.name || '', 'maxlength="80"'))}
        ${field('Type', `<select id="formType"
            class="bg-n8n-dark border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">${typeOptions}</select>`,
    escapeHtml(spec.description || ''))}
        ${fields}
        <label class="flex items-center gap-2 text-xs text-gray-300 mt-1">
            <input type="checkbox" id="formEnabled" class="accent-green-500" ${
    existing.enabled === 0 ? '' : 'checked'}> Enabled
        </label>`;
}

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

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = (Number(value) || 0).toLocaleString();
}

const row = (cols, message) =>
    `<tr><td colspan="${cols}" class="p-8 text-center text-gray-500 text-sm italic">${message}</td></tr>`;

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
