/**
 * viz.js — F-24 §1. One theme for every chart on the dashboard.
 *
 * `new Chart(` appears nine times across three files, and each one declared its
 * own colours, font, grid, tooltip, legend and interaction. That is not a
 * tidiness complaint; it produced two shipped bugs that this file exists to make
 * unrepeatable:
 *
 *   · `Execution Timeline` and `Execution Volume` sit side by side on the index
 *     page and hover differently, because the first never declared an
 *     `interaction` block and silently inherited Chart.js's `nearest/intersect`
 *     default while the second declared `index/false` (old
 *     app_chart_initialization.js:6 vs :87). Two charts, two behaviours, one
 *     page — and nothing in either file that would tell you why.
 *
 *   · `Execution Volume` carried `min: 0, ticks: { stepSize: 1 }` and no max
 *     (:117). `stepSize: 1` was correct when that chart showed *concurrency*,
 *     which ran 0–4 (F-06). It now shows starts per bucket, which reaches 18+,
 *     so a single spike stretched the axis and flattened every other bar toward
 *     the baseline.
 *
 * The fix for both is the same fix: there is one place to declare this now.
 *
 * Colour comes from the CSS custom properties in `input.css` and from nowhere
 * else, so a palette change is a change to one `:root` block rather than to
 * nine object literals. The eight series slots are the validated `dataviz` dark
 * ramp — see the note at the top of input.css for the gates they clear.
 *
 * Load order: after Chart.js, before any page script that constructs a chart.
 */

(function () {
    'use strict';

    // Loaded on pages that have no charts too — the unit formatters and the
    // token reader are useful on their own — so a missing Chart.js is a fact,
    // not a fault. `boot()` below is the part that needs it and returns early.

    // ─────────────────────────────────────────────────────────────────────
    // Tokens
    // ─────────────────────────────────────────────────────────────────────
    //
    // Read once at boot and cached. These are design tokens, not state: they do
    // not change while the page is open, and re-reading them per tick would put
    // a layout-flushing getComputedStyle inside Chart.js's render loop.

    const css = (name, fallback) => {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
    };

    let T = null;
    function tokens() {
        if (T) return T;
        T = {
            surface0: css('--surface-0', '#171717'),
            surface1: css('--surface-1', '#222222'),
            surface2: css('--surface-2', '#2a2a2a'),
            surface3: css('--surface-3', '#333333'),
            ink1: css('--ink-1', '#eeeeee'),
            ink2: css('--ink-2', '#b9b7b0'),
            ink3: css('--ink-3', '#9a978f'),
            grid: css('--grid', 'rgba(255,255,255,0.06)'),
            axis: css('--axis', 'rgba(255,255,255,0.14)'),
            brand: css('--brand', '#ff6f5c'),
            good: css('--good-mark', '#0ca30c'),
            warning: css('--warning-mark', '#fab219'),
            serious: css('--serious-mark', '#ec835a'),
            critical: css('--critical-mark', '#d03b3b'),
            goodInk: css('--good-ink', '#4ade80'),
            criticalInk: css('--critical-ink', '#f87171'),
            series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => css(`--series-${i}`, '#3987e5'))
        };
        return T;
    }

    /**
     * A series colour by slot.
     *
     * Slots are assigned in fixed order and never cycled. A ninth series is not
     * a generated hue — past eight the caller folds the tail into "Other" or
     * facets, because a ninth colour is indistinguishable from one of the first
     * eight under colour-vision deficiency and there is no ordering that fixes
     * that.
     */
    function series(i) {
        const s = tokens().series;
        return i < s.length ? s[i] : tokens().ink3;
    }

    /**
     * A stable colour for a named entity.
     *
     * The rule this enforces: colour follows the entity, never its rank. A
     * filter that removes one workflow must not repaint the survivors — a
     * reader who learned "Invoice Sync is blue" is misled the moment blue moves.
     * Keyed per `space` so the workflow palette and the category palette can
     * both start at slot 1 without colliding.
     */
    const registries = new Map();
    function colorFor(space, key) {
        if (!registries.has(space)) registries.set(space, new Map());
        const reg = registries.get(space);
        if (!reg.has(key)) reg.set(key, reg.size);
        return series(reg.get(key));
    }

    /**
     * Pins entities to specific slots up front.
     *
     * For a fixed vocabulary — the eight error categories, the six execution
     * modes — the mapping should be declared rather than discovered, so that a
     * category absent from today's data does not shift every colour after it
     * the moment it reappears.
     */
    function pin(space, keys) {
        const reg = new Map();
        keys.forEach((k, i) => reg.set(k, i));
        registries.set(space, reg);
    }

    // With alpha, for fills under a line.
    function alpha(hex, a) {
        const h = String(hex).replace('#', '');
        if (h.length !== 6) return hex;
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
        return `rgba(${r}, ${g}, ${b}, ${a})`;
    }

    // A top-down gradient under an area line. Falls back to a flat wash before
    // the chart area exists, which it does not on the very first layout pass.
    function areaFill(color, peak = 0.28) {
        return (ctx) => {
            const { ctx: c, chartArea } = ctx.chart;
            if (!chartArea) return alpha(color, 0.08);
            const g = c.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
            g.addColorStop(0, alpha(color, 0));
            g.addColorStop(1, alpha(color, peak));
            return g;
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Units
    // ─────────────────────────────────────────────────────────────────────
    //
    // F-24 §1: "units in the legend — ms, %, MB, ×. Insights has four units on
    // one page." A number with no unit beside three other numbers with
    // different units is a number nobody can read. Every formatter here is used
    // by the axis, the tooltip and the legend from the same definition, so the
    // three cannot disagree about what a value means.

    const UNITS = {
        count: {
            suffix: '',
            fmt: (v) => Number(v).toLocaleString(),
            axis: (v) => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k' : String(v))
        },
        ms: {
            suffix: 'ms',
            fmt: (v) => {
                const n = Number(v);
                if (!isFinite(n)) return '—';
                if (n < 1000) return `${Math.round(n)} ms`;
                if (n < 60000) return `${(n / 1000).toFixed(1)} s`;
                return `${(n / 60000).toFixed(1)} min`;
            },
            axis: (v) => (v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}s`)
        },
        percent: {
            suffix: '%',
            fmt: (v) => `${Number(v).toFixed(2)}%`,
            axis: (v) => `${v}%`
        },
        bytes: {
            suffix: 'MB',
            fmt: (v) => {
                const n = Number(v);
                if (n < 1024) return `${n.toFixed(0)} KB`;
                if (n < 1048576) return `${(n / 1024).toFixed(1)} MB`;
                return `${(n / 1048576).toFixed(2)} GB`;
            },
            axis: (v) => (v < 1024 ? `${v}KB` : `${(v / 1024).toFixed(0)}MB`)
        },
        ratio: {
            suffix: '×',
            fmt: (v) => `${Number(v).toFixed(2)}×`,
            axis: (v) => `${v}×`
        }
    };

    const unit = (name) => UNITS[name] || UNITS.count;

    // ─────────────────────────────────────────────────────────────────────
    // Percentile clamp — the Execution Volume bug, generalised
    // ─────────────────────────────────────────────────────────────────────

    function percentile(sorted, p) {
        if (!sorted.length) return 0;
        const idx = (sorted.length - 1) * p;
        const lo = Math.floor(idx), hi = Math.ceil(idx);
        return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
    }

    // A round number at or above v, so the top gridline is readable.
    function niceCeil(v) {
        if (v <= 0) return 1;
        const mag = Math.pow(10, Math.floor(Math.log10(v)));
        const n = v / mag;
        const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
        return step * mag;
    }

    /**
     * Decides the y maximum for a series with outliers.
     *
     * The naive reading of the bug ("the axis is too tall, cap it lower") is
     * wrong — that just crops the peak and lies in the other direction. What is
     * needed is for the *rule* not to be hidden by the *exception*: clamp to a
     * high percentile so the body of the distribution uses the full height, and
     * then say out loud that points sit above the clamp, and how high they go.
     * Chart.js clips the drawn value; `outlierMarks` below draws a caret at the
     * top of every clipped column so a clipped point is never mistaken for a
     * point that merely reached the top.
     *
     * Returns `{ max: null }` when the data has no outliers at all, in which
     * case the axis is simply left to fit — clamping a well-behaved series adds
     * a caveat to a chart that does not need one.
     */
    function clampMax(values, opts = {}) {
        const p = opts.percentile ?? 0.98;
        const trigger = opts.trigger ?? 1.5;   // peak must exceed the clamp by this much
        const nums = values.filter((v) => typeof v === 'number' && isFinite(v));
        if (nums.length < 8) return { max: null, clipped: 0, peak: 0 };

        const sorted = [...nums].sort((a, b) => a - b);
        const peak = sorted[sorted.length - 1];
        const pv = percentile(sorted, p);
        if (pv <= 0 || peak < pv * trigger) return { max: null, clipped: 0, peak };

        const max = niceCeil(pv);
        const clipped = nums.filter((v) => v > max).length;
        if (!clipped) return { max: null, clipped: 0, peak };
        return { max, clipped, peak };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Plugins
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Draws a caret above every column whose value was clipped by the clamp,
     * and a one-line note naming how many and how high.
     *
     * Without this the clamp would be the more dishonest of the two options: a
     * bar that stops exactly at the top of the axis and a bar that runs off the
     * top of the chart look identical.
     */
    const outlierMarks = {
        id: 'outlierMarks',
        afterDatasetsDraw(chart, _args, opts) {
            if (!opts || !opts.max) return;
            const t = tokens();
            const { ctx, chartArea, scales } = chart;
            if (!chartArea || !scales.y) return;

            ctx.save();
            ctx.fillStyle = t.brand;

            chart.data.datasets.forEach((ds, di) => {
                const meta = chart.getDatasetMeta(di);
                if (meta.hidden) return;
                ds.data.forEach((v, i) => {
                    if (typeof v !== 'number' || v <= opts.max) return;
                    const el = meta.data[i];
                    if (!el) return;
                    const x = el.x;
                    const y = chartArea.top + 5;
                    ctx.beginPath();
                    ctx.moveTo(x, y - 4);
                    ctx.lineTo(x + 4, y + 3);
                    ctx.lineTo(x - 4, y + 3);
                    ctx.closePath();
                    ctx.fill();
                });
            });

            const label = `${opts.clipped} above ${unit(opts.unit || 'count').axis(opts.max)}` +
                ` · peak ${unit(opts.unit || 'count').fmt(opts.peak)}`;
            ctx.font = '600 10px "Open Sans", sans-serif';
            ctx.fillStyle = t.ink3;
            ctx.textAlign = 'right';
            ctx.fillText(label, chartArea.right, chartArea.top - 4);
            ctx.restore();
        }
    };

    /**
     * "Empty is not zero."
     *
     * A chart with no rows behind it used to draw its grid and stop, which
     * reads as a measured zero — the single most expensive kind of wrong a
     * dashboard can be, because it looks like an answer. This paints over the
     * plot instead and says which of the two it is.
     */
    const emptyState = {
        id: 'emptyState',
        afterDraw(chart, _args, opts) {
            if (!opts || !opts.show) return;
            const t = tokens();
            const { ctx, chartArea } = chart;
            if (!chartArea) return;
            const cx = (chartArea.left + chartArea.right) / 2;
            const cy = (chartArea.top + chartArea.bottom) / 2;

            ctx.save();
            ctx.fillStyle = t.surface1;
            ctx.fillRect(chartArea.left, chartArea.top,
                chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);

            ctx.textAlign = 'center';
            ctx.fillStyle = t.ink2;
            ctx.font = '600 12px "Open Sans", sans-serif';
            ctx.fillText(opts.title || 'No data in this range', cx, cy - 4);

            if (opts.note) {
                ctx.fillStyle = t.ink3;
                ctx.font = '11px "Open Sans", sans-serif';
                ctx.fillText(opts.note, cx, cy + 14);
            }
            ctx.restore();
        }
    };

    /**
     * Deploy markers — F-11's one remaining open piece.
     *
     * A vertical rule on an error chart at the moment a workflow version
     * changed. The question "did we cause this" is the first one asked of every
     * error spike, and until now the chart could not answer it.
     */
    const deployMarks = {
        id: 'deployMarks',
        afterDatasetsDraw(chart, _args, opts) {
            if (!opts || !Array.isArray(opts.marks) || !opts.marks.length) return;
            const t = tokens();
            const { ctx, chartArea, scales } = chart;
            if (!chartArea || !scales.x) return;

            ctx.save();
            for (const m of opts.marks) {
                const x = scales.x.getPixelForValue(m.at);
                if (!isFinite(x) || x < chartArea.left || x > chartArea.right) continue;

                ctx.strokeStyle = alpha(t.ink3, 0.55);
                ctx.lineWidth = 1;
                // Solid, not dashed. A dashed rule reads as "projected" or
                // "threshold"; this is a thing that definitely happened.
                ctx.beginPath();
                ctx.moveTo(x, chartArea.top);
                ctx.lineTo(x, chartArea.bottom);
                ctx.stroke();

                ctx.fillStyle = t.ink3;
                ctx.beginPath();
                ctx.arc(x, chartArea.top + 3, 3, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }
    };

    // ─────────────────────────────────────────────────────────────────────
    // Global defaults
    // ─────────────────────────────────────────────────────────────────────

    function boot() {
        if (typeof window.Chart === 'undefined') return;
        const t = tokens();
        const C = window.Chart;

        C.register(outlierMarks, emptyState, deployMarks);

        C.defaults.font.family = '"Open Sans", sans-serif';
        C.defaults.font.size = 11;
        C.defaults.color = t.ink3;
        C.defaults.borderColor = t.grid;
        C.defaults.maintainAspectRatio = false;
        C.defaults.responsive = true;

        // The one-line fix for the hover inconsistency, in the one place that
        // now exists to make it. Every chart hovers by index with no
        // intersection requirement: you get the whole column by being anywhere
        // above it, rather than having to land on a 2px line.
        C.defaults.interaction = { mode: 'index', intersect: false, axis: 'x' };
        C.defaults.hover = { mode: 'index', intersect: false };

        // Marks: thin lines, no dots until hover, generous hit radius. A dot on
        // every point of a 60-day series is noise; a 12px hit radius is what
        // makes the invisible point still reachable.
        C.defaults.elements.line.borderWidth = 2;
        C.defaults.elements.line.tension = 0.35;
        C.defaults.elements.point.radius = 0;
        C.defaults.elements.point.hoverRadius = 4;
        C.defaults.elements.point.hitRadius = 12;
        C.defaults.elements.point.borderWidth = 2;
        // The 2px surface ring that separates overlapping markers, instead of a
        // border drawn around every mark.
        C.defaults.elements.point.hoverBorderWidth = 2;
        C.defaults.elements.point.hoverBorderColor = t.surface1;
        C.defaults.elements.bar.borderRadius = 4;
        C.defaults.elements.bar.borderSkipped = 'bottom';
        C.defaults.elements.arc.borderWidth = 2;
        C.defaults.elements.arc.borderColor = t.surface1;

        C.defaults.plugins.legend.labels.color = t.ink2;
        C.defaults.plugins.legend.labels.boxWidth = 8;
        C.defaults.plugins.legend.labels.boxHeight = 8;
        C.defaults.plugins.legend.labels.usePointStyle = true;
        C.defaults.plugins.legend.labels.pointStyle = 'circle';
        C.defaults.plugins.legend.labels.padding = 14;

        C.defaults.plugins.tooltip.backgroundColor = t.surface0;
        C.defaults.plugins.tooltip.borderColor = t.axis;
        C.defaults.plugins.tooltip.borderWidth = 1;
        C.defaults.plugins.tooltip.titleColor = t.ink1;
        C.defaults.plugins.tooltip.bodyColor = t.ink2;
        C.defaults.plugins.tooltip.padding = 10;
        C.defaults.plugins.tooltip.cornerRadius = 8;
        C.defaults.plugins.tooltip.displayColors = true;
        C.defaults.plugins.tooltip.boxWidth = 8;
        C.defaults.plugins.tooltip.boxHeight = 8;
        C.defaults.plugins.tooltip.usePointStyle = true;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Scale builders
    // ─────────────────────────────────────────────────────────────────────

    /**
     * A y axis that knows its unit.
     *
     * Note what is NOT here: `stepSize`. The old volume chart pinned it to 1,
     * which was right for a 0–4 concurrency count and wrong for everything
     * since. Chart.js picks a sensible step from the range on its own; pinning
     * it is how an axis outlives the question it was drawn for.
     */
    function yAxis(opts = {}) {
        const t = tokens();
        const u = unit(opts.unit);
        return {
            beginAtZero: opts.beginAtZero !== false,
            stacked: !!opts.stacked,
            max: opts.max ?? undefined,
            grid: { color: t.grid, drawTicks: false },
            border: { display: false },
            ticks: {
                color: t.ink3,
                padding: 8,
                maxTicksLimit: opts.maxTicks || 6,
                callback: (v) => u.axis(v)
            },
            title: opts.title
                ? { display: true, text: opts.title, color: t.ink3, font: { size: 10, weight: '700' } }
                : undefined
        };
    }

    /**
     * A time-ish x axis. The labels are ISO strings on a category scale — the
     * backend guarantees UTC ISO-8601, and `window.formatTime` is the only
     * thing on the dashboard allowed to turn one into a local-looking string.
     */
    function xTimeAxis(opts = {}) {
        const t = tokens();
        const fmt = opts.format || { hour: '2-digit', minute: '2-digit' };
        return {
            grid: { display: false },
            border: { color: t.axis },
            ticks: {
                color: t.ink3,
                maxRotation: 0,
                autoSkipPadding: 12,
                maxTicksLimit: opts.maxTicks || 8,
                callback: function (val) {
                    const label = this.getLabelForValue(val);
                    if (!label) return '';
                    return window.formatTime ? window.formatTime(label, fmt) : label;
                }
            }
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    // States
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Marks a chart empty, or not.
     *
     * `hasData` is deliberately the caller's judgement rather than
     * `datasets.length` — a series of genuine zeroes is data and must draw as a
     * flat line at zero, while no series at all is an absence and must say so.
     */
    function setEmpty(chart, hasData, title, note) {
        if (!chart) return;
        // NOT `chart.options.plugins = chart.options.plugins || {}`.
        //
        // Reading `chart.options.plugins` in Chart.js v4 does not hand back a
        // plain object — it hands back a resolver proxy. Assigning that proxy
        // back onto the same key makes it a link in its own resolution chain,
        // and the very next option lookup dies with
        // "Recursion detected: _scriptable->_scriptable". Every chart on the
        // page then fails to draw, which is exactly how this was found: the
        // dashboard rendered its KPIs and its table and left three skeleton
        // placeholders where the charts should have been.
        //
        // Chart.js creates `options.plugins` itself during construction, so
        // there is nothing to guard against — the key is always there, and
        // writing one property into it is all this needs to do.
        chart.options.plugins.emptyState = {
            show: !hasData,
            title: title || 'No data in this range',
            note: note || 'Nothing was recorded here — this is not a measurement of zero.'
        };
    }

    /**
     * The loading state, which is a different claim from the empty state.
     *
     * A refetch holds the previous render at reduced opacity rather than
     * flashing a skeleton over it — the numbers on screen were true a moment
     * ago, and replacing them with a shimmer costs the reader their place for
     * no gain. A first load has nothing to hold, so it gets the skeleton.
     */
    function setLoading(el, on) {
        if (!el) return;
        el.classList.toggle('is-refetching', !!on);
        el.setAttribute('aria-busy', on ? 'true' : 'false');
    }

    // ─────────────────────────────────────────────────────────────────────
    // Table-view twin
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Builds the WCAG-clean equivalent of a chart.
     *
     * Every chart needs a path to its values that is not "hover the right
     * pixel" — that is the accessibility requirement, and it doubles as the
     * answer to "what exactly was that spike". Rendered into a `<details>` so
     * it costs no space until asked for, and it is real markup, so it is in the
     * accessibility tree whether or not anyone opens it.
     */
    function tableFor(chart, opts = {}) {
        if (!chart) return '';
        const esc = window.escapeHtml || ((s) => String(s));
        const u = unit(opts.unit);
        const labels = chart.data.labels || [];
        const sets = chart.data.datasets || [];
        const labelFmt = opts.labelFormat || null;

        const head = sets.map((d) => `<th class="num">${esc(d.label || '')}</th>`).join('');
        const rows = labels.map((l, i) => {
            const shown = labelFmt && window.formatTime ? window.formatTime(l, labelFmt) : l;
            const cells = sets.map((d) => {
                const v = d.data[i];
                return `<td class="num">${typeof v === 'number' ? esc(u.fmt(v)) : '—'}</td>`;
            }).join('');
            return `<tr><td>${esc(shown)}</td>${cells}</tr>`;
        }).join('');

        return `
            <details class="mt-3">
                <summary class="label cursor-pointer select-none">Table view</summary>
                <div class="tbl-wrap custom-scrollbar mt-2" style="max-height:260px">
                    <table class="tbl">
                        <thead><tr><th>${esc(opts.axisLabel || 'Bucket')}</th>${head}</tr></thead>
                        <tbody>${rows || '<tr><td colspan="99">No rows.</td></tr>'}</tbody>
                    </table>
                </div>
            </details>`;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Brush / zoom on a time series
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Drag across a chart to narrow it to that span; a button restores it.
     *
     * F-24 §1: "60 days across one screen width does not read." No library —
     * the F-24 constraints forbid a CDN dependency and this is thirty lines
     * against a category scale.
     *
     * Deliberately additive: the brush narrows the *view*, never the fetch. The
     * numbers in the KPI row above still describe the range the filter bar
     * says they describe, which they would not if a drag silently re-queried.
     */
    function enableBrush(chart, host) {
        if (!chart || !host) return;
        const canvas = chart.canvas;
        let startX = null;
        let overlay = null;

        const full = () => ({ min: undefined, max: undefined });

        const reset = () => {
            Object.assign(chart.options.scales.x, full());
            chart.update('none');
            if (badge) badge.hidden = true;
        };

        // The affordance. Hidden until a brush is active — a permanent "reset
        // zoom" button on an un-zoomed chart is a control that does nothing.
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'btn btn-sm';
        badge.style.cssText = 'position:absolute;top:8px;right:8px;z-index:6';
        badge.innerHTML = '<i class="fa-solid fa-arrows-left-right-to-line"></i> Reset zoom';
        badge.hidden = true;
        badge.addEventListener('click', reset);
        host.style.position = host.style.position || 'relative';
        host.appendChild(badge);

        const idxAt = (evt) => {
            const rect = canvas.getBoundingClientRect();
            const x = evt.clientX - rect.left;
            const scale = chart.scales.x;
            if (!scale) return null;
            const v = scale.getValueForPixel(x);
            return v === undefined ? null : Math.round(v);
        };

        canvas.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            startX = idxAt(e);
            if (startX === null) return;
            overlay = document.createElement('div');
            overlay.style.cssText =
                'position:absolute;top:0;bottom:0;background:rgba(255,111,92,0.14);' +
                'border-inline:1px solid var(--brand);pointer-events:none;z-index:4';
            host.appendChild(overlay);
            canvas.setPointerCapture(e.pointerId);
        });

        canvas.addEventListener('pointermove', (e) => {
            if (startX === null || !overlay) return;
            const rect = canvas.getBoundingClientRect();
            const scale = chart.scales.x;
            const a = scale.getPixelForValue(startX);
            const b = e.clientX - rect.left;
            overlay.style.left = `${Math.min(a, b)}px`;
            overlay.style.width = `${Math.abs(b - a)}px`;
        });

        const finish = (e) => {
            if (startX === null) return;
            const endX = idxAt(e);
            if (overlay) { overlay.remove(); overlay = null; }
            const a = startX;
            startX = null;
            if (endX === null) return;
            const lo = Math.min(a, endX), hi = Math.max(a, endX);
            // Two buckets is the floor. A stray click reads as a zero-width
            // drag, and zooming to a single column on a mis-click is the kind
            // of thing that makes people stop trusting a chart.
            if (hi - lo < 2) return;
            chart.options.scales.x.min = lo;
            chart.options.scales.x.max = hi;
            chart.update('none');
            badge.hidden = false;
        };

        canvas.addEventListener('pointerup', finish);
        canvas.addEventListener('pointercancel', () => {
            if (overlay) { overlay.remove(); overlay = null; }
            startX = null;
        });

        return { reset };
    }

    // ─────────────────────────────────────────────────────────────────────

    window.Viz = {
        boot,
        tokens,
        series,
        colorFor,
        pin,
        alpha,
        areaFill,
        unit,
        UNITS,
        yAxis,
        xTimeAxis,
        clampMax,
        niceCeil,
        percentile,
        setEmpty,
        setLoading,
        tableFor,
        enableBrush
    };

    boot();
})();
