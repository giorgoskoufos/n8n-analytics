// settings_system.js
// F-19 · The dashboard reporting on itself.
//
// Everything else in this app describes n8n. This panel describes the process
// that fills the replica, because every other number on every other page is
// downstream of it and, until now, a stalled ETL looked exactly like a quiet
// week.
//
// Loaded lazily: the full endpoint counts rows and reads several hundred sync
// records, and nobody should pay for that just by opening Settings to change a
// timezone. It fetches on first expand, and again only when asked.

(() => {
    const KB = 1024;
    const MB = 1048576;
    const GB = 1073741824;

    const bytes = (n) => {
        if (n === null || n === undefined) return '—';
        if (n >= GB) return `${(n / GB).toFixed(2)} GB`;
        if (n >= MB) return `${(n / MB).toFixed(1)} MB`;
        if (n >= KB) return `${(n / KB).toFixed(0)} KB`;
        return `${n} B`;
    };

    /** Durations as a person would say them out loud, not as milliseconds. */
    const ago = (ms) => {
        if (ms === null || ms === undefined) return 'never';
        const s = Math.round(ms / 1000);
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.round(s / 60)}m ago`;
        if (s < 86400) return `${(s / 3600).toFixed(1)}h ago`;
        return `${(s / 86400).toFixed(1)}d ago`;
    };

    const took = (ms) => (ms === null || ms === undefined ? '—'
        : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

    const esc = (v) => (window.escapeHtml ? window.escapeHtml(String(v ?? '')) : String(v ?? ''));

    // Tone names, not class strings. The pill is rendered through the shared
    // badge now, so "what colour is 'late'" is answered in input.css and here
    // only in words (F-24 §7).
    const PILL = {
        ok: ['good', 'Running'],
        late: ['warning', 'Late'],
        stalled: ['critical', 'Stalled'],
        unknown: ['neutral', 'No runs yet']
    };

    function tile(label, value, sub, tone = 'text-white') {
        return `<div class="bg-n8n-dark/60 border border-line rounded-lg p-4">
            <p class="text-[10px] uppercase font-bold tracking-widest text-ink-3 mb-1">${esc(label)}</p>
            <p class="text-xl font-bold ${tone}">${value}</p>
            <p class="text-[11px] text-ink-3 mt-1">${sub || ''}</p>
        </div>`;
    }

    function row(label, value, note) {
        return `<div class="flex items-baseline justify-between gap-4 py-2 border-b border-line/60 last:border-0">
            <span class="text-xs text-ink-2">${esc(label)}</span>
            <span class="text-xs text-ink-1 text-right font-mono">${value}${
    note ? `<span class="block text-[10px] text-ink-3 font-sans not-italic">${note}</span>` : ''
}</span>
        </div>`;
    }

    /**
     * One bar per recorded ETL pass, height by duration, red when it failed.
     *
     * A number cannot show a pipeline that is getting slower or one that failed
     * four times overnight and then recovered; the shape can, and this page has
     * no charting library loaded. Scaled against the slowest run in the window
     * rather than a fixed ceiling — the interesting thing is the profile, and a
     * deployment where every pass takes 300 ms would otherwise draw a flat line
     * at the bottom of the box.
     */
    function sparkline(history) {
        if (!history || history.length === 0) {
            return '<p class="text-xs text-ink-3 italic">No runs recorded yet.</p>';
        }
        const recent = history.slice(-120);
        const max = Math.max(...recent.map((r) => r.duration_ms || 0), 1);
        const bars = recent.map((r) => {
            const h = Math.max(2, Math.round(((r.duration_ms || 0) / max) * 40));
            // 'ok' is what recordSyncRun writes. Anything else is a pass that
            // did not finish.
            const ok = r.status === 'ok';
            const title = `${r.started_at} · ${took(r.duration_ms)} · ${r.status}` +
                (r.executions ? ` · ${r.executions} executions` : '');
            return `<span title="${esc(title)}" style="height:${h}px" ` +
                `class="w-[3px] shrink-0 rounded-sm ${ok ? 'bg-indigo-500/70' : 'bg-rose-500'}"></span>`;
        }).join('');
        return `<div class="flex items-end gap-[2px] h-[44px] overflow-x-auto">${bars}</div>
            <p class="text-[10px] text-ink-3 mt-2">${recent.length} most recent passes ·
            tallest bar = ${took(max)}</p>`;
    }

    function render(d) {
        const p = d.pipeline || {};
        const r = d.runs || {};
        const q = d.queue || {};
        const st = d.storage || {};
        const fp = d.fingerprints || {};
        const g = st.growth || {};

        const pillText = (PILL[p.status] || PILL.unknown)[1];

        // The pipeline being healthy and the data being fresh are two different
        // claims, and the case where they disagree — syncing fine, source gone
        // quiet — is the one worth naming out loud.
        const dataStale = d.data && d.data.data_age_ms !== null &&
            d.data.data_age_ms > (p.expected_interval_ms || 300000) * 6;
        const disagreement = p.status === 'ok' && dataStale
            ? `<div class="text-xs rounded-lg px-3 py-2 bg-amber-900/20 border border-amber-500/30 text-amber-200">
                The sync is running normally, but the newest execution in the replica is
                ${esc(ago(d.data.data_age_ms))}. Nothing is broken here — n8n itself has gone quiet.
               </div>` : '';

        const failureNote = p.consecutive_failures > 1
            ? `<div class="text-xs rounded-lg px-3 py-2 bg-rose-900/20 border border-rose-500/30 text-rose-200">
                ${p.consecutive_failures} consecutive failed passes. Last error:
                <span class="font-mono">${esc(p.last_error || 'not recorded')}</span>
               </div>` : '';

        return `
        ${disagreement}${failureNote}
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
            ${tile('Last sync', esc(ago(p.since_last_run_ms)),
        `every ${Math.round((p.expected_interval_ms || 0) / 60000)} min · ${esc(pillText)}`)}
            ${tile('Newest execution', esc(ago(d.data && d.data.data_age_ms)),
        `${(d.data && d.data.executions || 0).toLocaleString()} in the replica`)}
            ${tile('Passes (24h)', `${r.ok || 0}<span class="text-ink-3">/${r.total || 0}</span>`,
        `${r.failed || 0} failed · p95 ${took(r.duration_ms && r.duration_ms.p95)}`,
        (r.failed || 0) > 0 ? 'text-amber-300' : 'text-green-400')}
            ${tile('Replica file', bytes(st.bytes),
        st.reclaimable_bytes ? `${bytes(st.reclaimable_bytes)} reclaimable by VACUUM` : 'no free pages')}
        </div>

        <div>
            <p class="text-[10px] uppercase font-bold tracking-widest text-ink-3 mb-2">Pass duration</p>
            ${sparkline(r.history)}
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-x-8">
            <div>
                <p class="text-[10px] uppercase font-bold tracking-widest text-ink-3 mb-1">Pipeline</p>
                ${row('Last pass finished', esc(p.last_run_at || '—'), esc(p.last_status || ''))}
                ${row('Last success', esc(p.last_success_at || 'none recorded'))}
                ${row('Executions moved (24h)', (r.executions || 0).toLocaleString())}
                ${row('Median pass', took(r.duration_ms && r.duration_ms.p50),
        `slowest ${took(r.duration_ms && r.duration_ms.max)}`)}
            </div>
            <div>
                <p class="text-[10px] uppercase font-bold tracking-widest text-ink-3 mb-1">Error analytics queue</p>
                ${row('Pending', (q.pending || 0).toLocaleString(),
        q.oldest_pending_at ? `oldest queued ${esc(q.oldest_pending_at)}` : '')}
                ${row('Parked after retries', (q.failed || 0).toLocaleString())}
                ${row('Extracted', (q.done || 0).toLocaleString())}
                ${row('Unfingerprinted rows', (fp.unfingerprinted || 0).toLocaleString(),
        (fp.unfingerprinted || 0) > 0 ? 'the backfill is still walking' : 'backfill complete')}
            </div>
            <div>
                <p class="text-[10px] uppercase font-bold tracking-widest text-ink-3 mb-1 mt-4">Storage</p>
                ${row('File size', bytes(st.bytes))}
                ${row('Reclaimable', bytes(st.reclaimable_bytes),
        `${(st.free_pages || 0).toLocaleString()} free pages`)}
                ${row('Growth', g.bytes_per_day === null || g.bytes_per_day === undefined
        ? 'not enough history'
        : `${bytes(Math.abs(g.bytes_per_day))}/day${g.bytes_per_day < 0 ? ' smaller' : ''}`,
    g.span_hours ? `measured over ${g.span_hours}h of run history` : '')}
                ${row('Last VACUUM', esc(st.last_vacuum_at || 'never recorded'),
        st.last_vacuum_at ? '' : 'run scripts/optimizeReplica.js --apply offline')}
            </div>
            <div>
                <p class="text-[10px] uppercase font-bold tracking-widest text-ink-3 mb-1 mt-4">Error intelligence</p>
                ${row('Fingerprint groups', (fp.groups || 0).toLocaleString(),
        `${(fp.triaged || 0).toLocaleString()} triaged`)}
                ${row('Fingerprint rules', `v${esc(fp.version || '?')}`,
        'a bump rewrites every historical group')}
                ${row('Classifier rules', `v${esc(fp.classifier_version || '?')}`)}
                ${row('n8n prune horizon', esc((d.data && d.data.source_oldest_execution_id) || 'unknown'),
        'oldest execution n8n itself still has')}
            </div>
        </div>`;
    }

    let loaded = false;

    async function load() {
        const body = document.getElementById('healthBody');
        const pill = document.getElementById('healthPill');
        if (!body) return;
        body.innerHTML = window.UI.loading('This counts every row in the replica, so it takes a moment.');
        try {
            const res = await window.fetchWithAuth('/api/analytics/system');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            body.innerHTML = render(data);
            if (pill) {
                const [tone, text] = PILL[data.pipeline.status] || PILL.unknown;
                pill.outerHTML = window.UI.badge(text, { tone, cls: 'ml-2' })
                    .replace('<span class="badge', '<span id="healthPill" class="badge');
            }
            loaded = true;
        } catch (err) {
            body.innerHTML = window.UI.failed(`Could not read dashboard health: ${esc(err.message)}`);
        }
    }

    // Loaded when its view is first shown, not on page load.
    //
    // This query counts every row in the replica — around half a million — and
    // it used to be behind a collapsed accordion, which at least meant it did
    // not run until asked. Turning the sections into tabs would have made it
    // run on every visit to Settings if this listened for nothing. It listens
    // for the section becoming visible instead, and only the first time:
    // switching tabs back and forth must not re-run it. That is what Refresh is.
    document.addEventListener('settings:section', (e) => {
        if (e.detail.section === 'health' && !loaded) load();
    });

    const refresh = document.getElementById('healthRefresh');
    if (refresh) refresh.addEventListener('click', load);
})();
