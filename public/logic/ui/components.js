/**
 * components.js — F-24 §7. The shared component layer.
 *
 * "There is no common component layer. The card, the table, the badge and the
 * modal are re-written in errors.js, insights.js, alerts.js and
 * settings_system.js separately. No bundler is needed to fix this."
 *
 * That last sentence is the design constraint. This is a plain script that
 * defines `window.UI`, loaded before the page scripts, holding the handful of
 * things that were being re-typed. The measurable goal is the one in the item:
 * a change to a badge happens here, once.
 *
 * Two rules inherited from B-05 that nothing in this file may break:
 *   · every interpolated value passes through escapeHtml;
 *   · no inline `onclick` — behaviour attaches through `data-action` and the
 *     dispatcher in global_functions.js, or through a delegated listener.
 */

(function () {
    'use strict';

    const esc = (v) => (window.escapeHtml ? window.escapeHtml(v) : String(v ?? ''));

    // ─────────────────────────────────────────────────────────────────────
    // Badge
    // ─────────────────────────────────────────────────────────────────────
    //
    // One badge, six tones. Tone is semantic, never decorative: `critical` means
    // a thing is broken, not "this one is red". A tone always ships with its
    // word, because colour alone is not an encoding anyone can rely on.

    const TONES = ['neutral', 'good', 'warning', 'serious', 'critical', 'brand'];

    /**
     * @param {string} label  text — escaped here, pass it raw
     * @param {object} o      { tone, icon, dot, title, cls }
     */
    function badge(label, o = {}) {
        const tone = TONES.includes(o.tone) ? o.tone : 'neutral';
        const dot = o.dot ? '<span class="badge-dot"></span>' : '';
        const icon = o.icon ? `<i class="fa-solid ${esc(o.icon)}"></i>` : '';
        const title = o.title ? ` title="${esc(o.title)}"` : '';
        return `<span class="badge badge-${tone} ${esc(o.cls || '')}"${title}>${dot}${icon}${esc(label)}</span>`;
    }

    // ─────────────────────────────────────────────────────────────────────
    // States
    // ─────────────────────────────────────────────────────────────────────
    //
    // Empty, loading and failed are three different claims and used to render
    // as one grey "Loading..." that never went away when a fetch threw. A
    // panel stuck on "Loading..." forever is the worst of the three, because it
    // is the only one that gives the reader nothing to do.

    function empty(title, note, icon) {
        return `<div class="state">
            <i class="fa-solid ${esc(icon || 'fa-inbox')} state-icon"></i>
            <p class="state-title">${esc(title || 'Nothing here')}</p>
            ${note ? `<p class="state-note">${esc(note)}</p>` : ''}
        </div>`;
    }

    function loading(note) {
        return `<div class="state" aria-busy="true">
            <i class="fa-solid fa-circle-notch fa-spin state-icon"></i>
            <p class="state-title">Loading…</p>
            ${note ? `<p class="state-note">${esc(note)}</p>` : ''}
        </div>`;
    }

    function failed(note) {
        return `<div class="state" role="alert">
            <i class="fa-solid fa-triangle-exclamation state-icon" style="color:var(--critical-ink)"></i>
            <p class="state-title">Could not load this</p>
            <p class="state-note">${esc(note || 'The request failed. The rest of the page is unaffected.')}</p>
        </div>`;
    }

    // The same three, as a table row, so a table can say them inside its own
    // body instead of collapsing to a blank <tbody>.
    function rowState(colspan, html) {
        return `<tr><td colspan="${Number(colspan) || 1}" style="position:relative;height:180px;padding:0">${html}</td></tr>`;
    }

    // ─────────────────────────────────────────────────────────────────────
    // KPI tile
    // ─────────────────────────────────────────────────────────────────────

    /**
     * A KPI that explains itself.
     *
     * The `Needs Attention` tile on the errors page is why this takes a `note`
     * and an `href`/`action` rather than just a number: it showed "3,324" and a
     * sentence about groups behaving against their category, said neither what
     * the number counted nor what the sentence meant, and led nowhere. A number
     * on a dashboard that cannot say what it counts is decoration.
     */
    function kpi(o = {}) {
        const tone = TONES.includes(o.tone) ? o.tone : null;
        const valueColor = tone && tone !== 'neutral' ? ` style="color:var(--${tone === 'brand' ? 'brand' : tone + '-ink'})"` : '';
        const inner = `
            <p class="label">${esc(o.label || '')}</p>
            <div class="flex items-baseline gap-3 mt-1.5">
                <span class="kpi-value"${valueColor}>${esc(o.value ?? '—')}</span>
                ${o.trend || ''}
            </div>
            ${o.note ? `<p class="kpi-sub">${esc(o.note)}</p>` : ''}
            ${o.hint ? `<p class="kpi-sub" style="opacity:.85">${esc(o.hint)}</p>` : ''}`;

        // Interactive tiles are real buttons. A clickable <div> is unreachable
        // by keyboard and invisible to assistive tech, and this one is the
        // entry point to the rows it counts.
        if (o.action) {
            return `<button type="button" class="card kpi kpi-link" data-action="${esc(o.action)}"
                        ${o.arg !== undefined ? `data-arg="${esc(o.arg)}"` : ''}>${inner}</button>`;
        }
        return `<div class="card kpi">${inner}</div>`;
    }

    /**
     * A period-over-period delta.
     *
     * `goodWhenDown` exists because the same arrow means opposite things on
     * different tiles — errors falling is good, executions falling is usually
     * not — and hard-coding red-for-up was producing green "improvements" on
     * the throughput card every time traffic dropped.
     */
    function trend(pct, o = {}) {
        const n = Number(pct) || 0;
        if (!n) return '';
        const up = n > 0;
        const good = o.goodWhenDown ? !up : up;
        const tone = good ? 'good' : 'critical';
        return badge(`${up ? '↑' : '↓'} ${Math.abs(n)}%`, {
            tone,
            title: o.title || `${Math.abs(n)}% ${up ? 'higher' : 'lower'} than the preceding period of the same length`
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // Table
    // ─────────────────────────────────────────────────────────────────────
    //
    // F-24 §7: "one table implementation. Infinite scroll exists only on the
    // index page; alerts, errors and insights dump whatever the endpoint
    // returned into the DOM." Sticky headers, horizontal scroll inside the
    // table and nowhere else, optional grouping, optional paging.

    /**
     * @param {object} spec
     *   columns : [{ key, label, align, cls, render(row) }]
     *   rows    : any[]
     *   groupBy : (row) => ({ key, label, icon, color }) | null
     *   rowAttrs: (row, i) => string           extra attributes, e.g. data-*
     *   empty   : { title, note, icon }
     *   maxHeight: css length for the scroll region
     */
    function table(spec) {
        const cols = spec.columns || [];
        const head = cols.map((c) =>
            `<th class="${c.align === 'right' ? 'num' : ''} ${esc(c.cls || '')}">${esc(c.label || '')}</th>`
        ).join('');

        let body;
        if (!spec.rows || !spec.rows.length) {
            const e = spec.empty || {};
            body = rowState(cols.length, empty(e.title, e.note, e.icon));
        } else if (typeof spec.groupBy === 'function') {
            body = groupedBody(spec, cols);
        } else {
            body = spec.rows.map((r, i) => rowHtml(r, i, cols, spec)).join('');
        }

        const style = spec.maxHeight ? ` style="max-height:${esc(spec.maxHeight)}"` : '';
        return `<div class="tbl-wrap custom-scrollbar"${style}>
            <table class="tbl">
                <thead><tr>${head}</tr></thead>
                <tbody>${body}</tbody>
            </table>
        </div>`;
    }

    function rowHtml(r, i, cols, spec) {
        const attrs = spec.rowAttrs ? spec.rowAttrs(r, i) : '';
        const cls = spec.rowClass ? spec.rowClass(r, i) : '';
        const tds = cols.map((c) => {
            const v = c.render ? c.render(r, i) : esc(r[c.key]);
            return `<td class="${c.align === 'right' ? 'num' : ''} ${esc(c.cls || '')}">${v}</td>`;
        }).join('');
        return `<tr class="${esc(cls)}" ${attrs}>${tds}</tr>`;
    }

    /**
     * Sectioned rendering — F-24 §3's first item.
     *
     * "It is a flat table with the Category column repeated row by row. What is
     * wanted: sections per category with the groups inside, a total per
     * category, collapsible." Repeating a value on every row is the clearest
     * signal that the value is really a heading.
     */
    function groupedBody(spec, cols) {
        const order = [];
        const buckets = new Map();
        for (const r of spec.rows) {
            const g = spec.groupBy(r);
            if (!g) continue;
            if (!buckets.has(g.key)) { buckets.set(g.key, { meta: g, rows: [] }); order.push(g.key); }
            buckets.get(g.key).rows.push(r);
        }

        return order.map((key) => {
            const { meta, rows } = buckets.get(key);
            const total = spec.groupTotal
                ? spec.groupTotal(rows)
                : rows.length;
            const swatch = meta.color
                ? `<span class="badge-dot" style="background:${esc(meta.color)};width:8px;height:8px"></span>`
                : '';
            const icon = meta.icon ? `<i class="fa-solid ${esc(meta.icon)}" style="color:${esc(meta.color || 'currentColor')}"></i>` : '';

            const header = `<tr class="group-head" data-group-section="${esc(key)}">
                <td colspan="${cols.length}">
                    <button type="button" class="flex items-center gap-2.5 w-full text-left"
                            data-group-collapse="${esc(key)}" aria-expanded="true">
                        <i class="fa-solid fa-chevron-down text-[10px]" style="color:var(--ink-3)"></i>
                        ${swatch}${icon}
                        <span class="text-[12px] font-bold" style="color:var(--ink-1)">${esc(meta.label)}</span>
                        <span class="label" style="margin-left:auto">${esc(total)}</span>
                    </button>
                </td>
            </tr>`;

            const body = rows.map((r, i) =>
                rowHtml(r, i, cols, { ...spec, rowAttrs: (row, idx) => `data-group-member="${esc(key)}" ${spec.rowAttrs ? spec.rowAttrs(row, idx) : ''}` })
            ).join('');

            return header + body;
        }).join('');
    }

    /**
     * Wires the collapse buttons a grouped table renders.
     *
     * Delegated on a container rather than bound per button, so re-rendering
     * the table body does not leak a listener per row per refresh — which the
     * per-page implementations were doing, one of them on a 60-second timer.
     */
    function bindGroupCollapse(container) {
        if (!container || container.__groupBound) return;
        container.__groupBound = true;
        container.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-group-collapse]');
            if (!btn) return;
            const key = btn.getAttribute('data-group-collapse');
            const open = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', String(!open));
            const chev = btn.querySelector('i.fa-chevron-down, i.fa-chevron-right');
            if (chev) {
                chev.classList.toggle('fa-chevron-down', !open);
                chev.classList.toggle('fa-chevron-right', open);
            }
            container.querySelectorAll(`[data-group-member="${CSS.escape(key)}"]`).forEach((row) => {
                row.hidden = open;
                // A detail row belonging to a collapsed member goes with it.
                const next = row.nextElementSibling;
                if (next && next.hasAttribute('data-detail-row')) next.hidden = open || next.classList.contains('hidden');
            });
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // Breadcrumbs — F-16's last open piece
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @param {Array} trail  [{ label, href }] — the last entry is the current
     *                       page and takes no href.
     */
    function crumbs(trail) {
        if (!Array.isArray(trail) || !trail.length) return '';
        const items = trail.map((c, i) => {
            const last = i === trail.length - 1;
            if (last || !c.href) return `<span aria-current="page">${esc(c.label)}</span>`;
            return `<a href="${esc(c.href)}">${esc(c.label)}</a>`;
        });
        return `<nav class="crumbs" aria-label="Breadcrumb">${items.join('<span class="sep">/</span>')}</nav>`;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Scroll restoration — F-24 §7
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Puts the reader back where they were after a drill-down.
     *
     * Opening an execution and closing it again used to return to the top of a
     * list that could be hundreds of rows long, which on the errors page means
     * losing the row you were working on. Held in sessionStorage rather than in
     * a variable so it also survives the drill-downs that open in a new tab.
     */
    const scroll = {
        save(key, el) {
            const target = el || document.scrollingElement;
            if (!target) return;
            try { sessionStorage.setItem(`scroll:${key}`, String(target.scrollTop)); } catch (ignored) { /* private mode */ }
        },
        restore(key, el) {
            const target = el || document.scrollingElement;
            if (!target) return;
            try {
                const v = sessionStorage.getItem(`scroll:${key}`);
                if (v !== null) target.scrollTop = Number(v) || 0;
            } catch (ignored) { /* private mode */ }
        },
        clear(key) {
            try { sessionStorage.removeItem(`scroll:${key}`); } catch (ignored) { /* private mode */ }
        }
    };

    // ─────────────────────────────────────────────────────────────────────
    // Tab strips
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Brings the selected tab into view inside a `.tabs` strip.
     *
     * Below `sm` the strip scrolls sideways rather than wrapping onto three
     * lines, and a strip that scrolls has an off-screen half. Selecting a tab
     * from a keyboard, or landing on `settings.html#health` from a link, would
     * otherwise mark a tab that is not on screen — so the page shows a strip
     * with nothing selected on it and the panel below belonging to none of the
     * tabs you can see.
     *
     * `inline: 'nearest'` and `block: 'nearest'` — 'nearest' is the value that
     * does nothing when the element is already visible, which is the common
     * case and the one where any scrolling at all is the page moving under
     * somebody. It is also what keeps a horizontal strip from dragging the
     * whole page vertically to reach itself.
     */
    function revealTab(btn) {
        if (!btn || !btn.closest('.tabs')) return;
        try {
            btn.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        } catch (ignored) {
            // Older engines only take the boolean form, and the fallback is a
            // scroll that is slightly ruder rather than no scroll at all.
            btn.scrollIntoView(false);
        }
    }

    /**
     * Focus, unless focusing would summon the on-screen keyboard uninvited.
     *
     * ── The problem, which only exists on touch ──────────────────────────
     *
     * On a desktop, focusing a text field is free: the caret lands somewhere
     * useful and nothing moves. On a phone it is not free — it raises the
     * keyboard, which takes half the viewport, pushes the layout up, and covers
     * the thing the person opened. Opening the assistant to READ an answer and
     * being handed a keyboard is the common case, and it makes the panel feel
     * like it is demanding to be typed into.
     *
     * So autofocus becomes a desktop-only affordance. Anywhere a person's action
     * was explicitly about the text field — tapping it, tapping a suggestion
     * that fills it — the browser focuses it anyway and this helper is not
     * involved.
     *
     * `pointer: coarse` rather than a width breakpoint: what decides this is
     * whether there is a physical keyboard, not how wide the window is. A narrow
     * desktop window has a keyboard and should still autofocus; a tablet in
     * landscape is wide and should not.
     */
    function focusUnlessTouch(el) {
        if (!el) return false;
        try {
            if (window.matchMedia('(pointer: coarse)').matches) return false;
        } catch (ignored) {
            // An engine without matchMedia is not a phone.
        }
        el.focus();
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────
    // HTML error bodies — F-24 §3
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Collapses an HTML error document to the part that is the error.
     *
     * F-07 already does this for the *fingerprint* — it groups on
     * `<HTML: {title}>` so that ten thousand bytes of Cloudflare markup do not
     * become ten thousand distinct errors. What it never did was change what
     * gets *shown*: the reader still got `<!DOCTYPE html>…` and had to find the
     * sentence in it. For an HTML error response the `<title>` and the visible
     * body text ARE the error; the markup is packaging.
     *
     * Parsed with DOMParser into an inert document — never assigned to innerHTML
     * and never executed. The result is escaped by the caller like any other
     * string, and the raw text stays available behind "show raw", because
     * occasionally the packaging is the evidence.
     *
     * @returns {{isHtml: boolean, title: string|null, text: string|null, raw: string}}
     */
    function readHtmlError(raw) {
        const s = String(raw || '');
        const looksHtml = /^\s*(<!doctype html|<html[\s>])/i.test(s) ||
            (/<html[\s>]/i.test(s) && /<\/html>/i.test(s));
        if (!looksHtml || typeof DOMParser === 'undefined') {
            return { isHtml: false, title: null, text: null, raw: s };
        }

        try {
            const doc = new DOMParser().parseFromString(s, 'text/html');
            doc.querySelectorAll('script, style, noscript, svg, head link').forEach((n) => n.remove());

            const title = (doc.querySelector('title')?.textContent || '').trim() || null;
            let text = (doc.body?.textContent || '')
                .replace(/\s+/g, ' ')
                .trim();
            // Long enough to carry the sentence that matters, short enough that
            // it cannot become the wall of text it is replacing.
            if (text.length > 600) text = text.slice(0, 600) + '…';

            // A title that merely repeats the first words of the body adds a
            // line and no information.
            const redundant = title && text.toLowerCase().startsWith(title.toLowerCase());
            return { isHtml: true, title: redundant ? null : title, text: text || null, raw: s };
        } catch (ignored) {
            return { isHtml: false, title: null, text: null, raw: s };
        }
    }

    /**
     * Renders an error message for display, HTML documents included.
     *
     * `idx` namespaces the toggle so several of these can sit on one page —
     * the executions feed under an expanded error group renders one per row.
     */
    function errorMessage(raw, idx = 0) {
        const parsed = readHtmlError(raw);
        if (!parsed.isHtml) {
            return `<pre class="mono whitespace-pre-wrap leading-relaxed" style="color:var(--critical-ink)">${esc(parsed.raw)}</pre>`;
        }

        return `<div>
            ${parsed.title ? `<p class="text-[12px] font-semibold" style="color:var(--critical-ink)">${esc(parsed.title)}</p>` : ''}
            ${parsed.text ? `<p class="text-[11px] mt-1 leading-relaxed" style="color:var(--ink-2)">${esc(parsed.text)}</p>` : ''}
            <details class="mt-2" data-raw-html="${Number(idx)}">
                <summary class="label cursor-pointer select-none">Show raw response (${esc(parsed.raw.length.toLocaleString())} bytes)</summary>
                <pre class="mono whitespace-pre-wrap leading-relaxed mt-2 p-3" style="color:var(--ink-3);background:var(--surface-0);border-radius:var(--r-md);max-height:320px;overflow:auto">${esc(parsed.raw)}</pre>
            </details>
        </div>`;
    }

    // ─────────────────────────────────────────────────────────────────────

    window.UI = {
        esc,
        badge,
        empty,
        loading,
        failed,
        rowState,
        kpi,
        trend,
        table,
        rowHtml,
        bindGroupCollapse,
        crumbs,
        scroll,
        revealTab,
        focusUnlessTouch,
        readHtmlError,
        errorMessage
    };
})();
