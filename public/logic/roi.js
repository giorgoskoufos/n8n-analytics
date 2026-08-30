/**
 * The ROI page.
 *
 * Two tabs, one subject. The figures were here and the inputs that produce them
 * were in Settings, which put the answer to this page's most common question —
 * "why is that workflow zero?" — on a different page under a different name.
 *
 * The tab lives in the URL hash for the same reason the settings tabs do: a
 * setting that cannot be linked to cannot be pointed at. `roi.html#configure` is
 * where `settings.html#roi` now redirects.
 */

import * as overview from './roi/roi_overview.js';
import * as config from './roi/roi_config.js';

const SECTIONS = ['overview', 'configure'];
const DEFAULT = 'overview';

function show(name, { fromHash = false } = {}) {
    const target = SECTIONS.includes(name) ? name : DEFAULT;

    for (const section of SECTIONS) {
        const panel = document.getElementById(`section-${section}`);
        if (panel) panel.hidden = section !== target;
    }

    document.querySelectorAll('[data-action="showRoiSection"]').forEach((btn) => {
        // The coverage KPI is also a `showRoiSection` control, and it is a card
        // rather than a tab — so only the things in the tab strip take the
        // selected state, or a KPI tile starts looking like the active tab.
        if (!btn.classList.contains('tab-btn')) return;
        const active = btn.getAttribute('data-arg') === target;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', String(active));
        if (active) window.UI?.revealTab(btn);
    });

    if (!fromHash) {
        window.history.replaceState(null, '', `${window.location.pathname}#${target}`);
    }
    window.dispatchEvent(new Event('resize'));
}

window.showRoiSection = (name) => show(String(name));

/** Kept on `window` because the retry button in an error row dispatches to it. */
window.loadRoiMetrics = () => overview.load();

window.addEventListener('hashchange', () => {
    show(window.location.hash.replace('#', '') || DEFAULT, { fromHash: true });
});

// Coverage is counted by the Configure tab and displayed by Overview. The event
// is what keeps them from importing each other — and it means the tile updates
// the moment somebody types a figure, before anything is saved.
document.addEventListener('roi:coverage', (event) => overview.setCoverage(event.detail));
document.addEventListener('roi:saved', () => overview.load());

document.addEventListener('DOMContentLoaded', async () => {
    show(window.location.hash.replace('#', '') || DEFAULT, { fromHash: true });

    // Both tabs are loaded up front, not lazily. The list is one request that
    // the coverage tile on the OTHER tab depends on, so deferring it would mean
    // the Overview tab showing "—" for coverage until somebody happened to open
    // Configure — which is the tab they open because coverage told them to.
    //
    // Awaited: `formatMoney` reads the configured currency, and rendering the
    // money column before the setting arrives paints it in the wrong one and
    // never repaints.
    await window.settingsReady;
    config.attach();
    await Promise.all([overview.load(), config.load()]);

    document.getElementById('roiTimeRangeFilter')
        ?.addEventListener('change', () => overview.load());
});

// Leaving the page with unsaved figures is worth one interruption. Switching
// TABS is not — nothing is lost, both tabs are the same page, and a confirm on
// a tab click is the kind of dialog people learn to dismiss without reading.
window.addEventListener('beforeunload', (event) => {
    if (!config.hasUnsaved()) return;
    event.preventDefault();
    event.returnValue = '';
});
