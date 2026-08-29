// --- SECTION 2: CHART INITIALIZATION ---
//
// F-24 §1. Everything that used to be declared here — colours, font, grid,
// tooltip styling, legend, interaction — now comes from `ui/viz.js`, which
// reads it from the CSS tokens. What is left in this file is what is actually
// specific to these three charts: what they plot, what a tooltip says, and what
// happens when one is clicked.
//
// The two bugs the item names by file and line were both consequences of that
// not being true:
//
//   · `Execution Timeline` hovered differently from `Execution Volume` beside
//     it, because this file gave the first no `interaction` block and the
//     second `{ mode: 'index', intersect: false }`. Neither line exists now;
//     both charts take the shared default.
//
//   · `Execution Volume` had `y: { min: 0, ticks: { stepSize: 1 } }` and no
//     max. `stepSize: 1` was right when this chart plotted concurrency at 0–4
//     (F-06); it now plots starts per bucket, which reaches 18+. See
//     `updateConcurrencyChart` for the replacement — the axis is clamped to a
//     percentile and the clipped columns are marked, rather than either
//     stretched by the outlier or cropped without saying so.

window.initCharts = function () {
    const V = window.Viz;

    // ── Execution Timeline ────────────────────────────────────────────────
    //
    // Success and errors are a STATUS pair, not two categorical series: the
    // colours mean good and bad rather than "series 1 and series 2", so they
    // come from the status tokens and never from the eight-slot ramp.

    const elLine = document.getElementById('lineChart');
    if (elLine) {
        const t = V.tokens();
        window.lineChart = new Chart(elLine.getContext('2d'), {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Successful runs',
                        data: [],
                        borderColor: t.good,
                        backgroundColor: V.areaFill(t.good, 0.16),
                        fill: true
                    },
                    {
                        label: 'Failed runs',
                        data: [],
                        borderColor: t.critical,
                        backgroundColor: V.areaFill(t.critical, 0.16),
                        fill: true
                    }
                ]
            },
            options: {
                // Two series, so a legend is present — identity is never
                // carried by colour alone. It was `display: false` before,
                // which left two unlabelled lines and a tooltip.
                plugins: {
                    legend: { display: true, position: 'top', align: 'end' },
                    tooltip: {
                        callbacks: {
                            title: (items) => items.length
                                ? window.formatTime(items[0].label,
                                    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                : '',
                            label: (ctx) => ` ${ctx.dataset.label}: ${V.unit('count').fmt(ctx.parsed.y)}`
                        }
                    }
                },
                scales: {
                    y: V.yAxis({ unit: 'count' }),
                    x: V.xTimeAxis({ format: { hour: '2-digit', minute: '2-digit' } })
                }
            }
        });
    }

    // ── Top Workflows ─────────────────────────────────────────────────────

    const elDoughnut = document.getElementById('doughnutChart');
    if (elDoughnut) {
        window.doughnutChart = new Chart(elDoughnut.getContext('2d'), {
            type: 'doughnut',
            data: { labels: [], datasets: [{ data: [], cutout: '72%', hoverOffset: 12 }] },
            options: {
                plugins: {
                    legend: { position: 'bottom' },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                const total = ctx.dataset.data.reduce((a, b) => a + b, 0) || 1;
                                const pct = ((ctx.parsed / total) * 100).toFixed(1);
                                return ` ${ctx.label}: ${ctx.parsed.toLocaleString()} runs (${pct}%)`;
                            }
                        }
                    }
                }
            }
        });
    }

    // ── Execution Volume ──────────────────────────────────────────────────

    const elConcurrency = document.getElementById('concurrencyChart');
    if (elConcurrency) {
        window.concurrencyChart = new Chart(elConcurrency.getContext('2d'), {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Executions started',
                    data: [],
                    borderColor: V.series(0),
                    backgroundColor: V.areaFill(V.series(0)),
                    fill: true
                }]
            },
            options: {
                // One series, so no legend box — the card title names it. The
                // axis title carries the unit instead.
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: (items) => {
                                if (!items.length) return '';
                                const intervalMins = parseInt(document.getElementById('concurrencyInterval')?.value) || 5;
                                const start = new Date(items[0].label);
                                const end = new Date(start.getTime() + intervalMins * 60000);
                                const f = (d) => window.formatTime(d.toISOString(), { hour: '2-digit', minute: '2-digit' });
                                return `${f(start)} – ${f(end)}`;
                            },
                            label: (ctx) => ` ${V.unit('count').fmt(ctx.parsed.y)} started`,
                            // The clamp is explained where the reader meets it,
                            // not only in the corner note.
                            afterBody: (items) => {
                                const clamp = window.concurrencyChart?.options?.plugins?.outlierMarks;
                                if (!clamp?.max || !items.length) return '';
                                return items[0].parsed.y > clamp.max
                                    ? `Above the axis clamp of ${clamp.max} — drawn clipped.`
                                    : '';
                            }
                        }
                    }
                },
                onClick: async (_e, activeEls) => {
                    if (!activeEls.length) return;
                    const dataIndex = activeEls[0].index;
                    const timestamp = window.concurrencyChart.data.labels[dataIndex];
                    const interval = document.getElementById('concurrencyInterval')?.value || 5;
                    // The reader is about to leave this list for a modal, and
                    // they expect to come back to the row they left from.
                    window.UI?.scroll.save('index', document.getElementById('appMain'));
                    await fetchConcurrencyDetails(timestamp, interval);
                },
                scales: {
                    // No stepSize. Chart.js derives the step from the range,
                    // which is the only thing that stays correct when the
                    // question the chart answers changes.
                    y: V.yAxis({ unit: 'count', title: 'Executions started' }),
                    x: V.xTimeAxis({ format: { hour: '2-digit', minute: '2-digit' }, maxTicks: 12 })
                }
            }
        });

        // 60 days at one screen width does not read. Drag to narrow, button to
        // restore — and it narrows the view only, never the fetch, so the KPI
        // row above still describes the range the filter bar claims.
        V.enableBrush(window.concurrencyChart, elConcurrency.parentElement);
    }
};

/**
 * Main dashboard initialization - only runs if we are on the index/dashboard page.
 */
window.initDashboard = function () {
    return !!document.getElementById('lineChart');
};
