/**
 * insights_nav.js — F-24 §7.
 *
 * "insights.js: 1,128+ lines / 57 KB, insights.html: 598+ lines, with 11 panels
 * that all load together and none of them deep-linkable."
 *
 * Two separate costs in one sentence, and they need different fixes.
 *
 * The loading one is the expensive half: every visit fired eleven requests,
 * several of which count the whole replica, to render a page on which a person
 * looks at one thing. Panels are grouped into four views here and a panel's
 * loader runs the first time its view is shown — once, not on every switch.
 * `loadAll()` in insights.js is now what a *range change* means: reload
 * whatever has already been looked at, and leave the rest for when it is.
 *
 * The addressing one is smaller but sharper: "the queue lag chart" could only
 * ever be an instruction to scroll. `#panel=queue-lag` opens the right view and
 * scrolls to the right panel.
 *
 * This file is deliberately separate from insights.js rather than another
 * hundred lines inside it — the item's complaint is that the file is too big to
 * work in, and answering it by making the file bigger would be a poor joke.
 */

(function () {
    'use strict';

    const GROUPS = {
        traffic: ['triggers', 'queue-lag', 'concurrency'],
        reliability: ['silent', 'reliability', 'deploys'],
        structure: ['organisation', 'blast-radius', 'metadata'],
        cost: ['storage', 'node-time']
    };

    const DEFAULT = 'traffic';

    // Which panel each loader belongs to. insights.js still owns the loaders;
    // this only decides when they run. Registered by name so that a loader
    // missing from the page (a panel gated behind a feature) is a no-op rather
    // than a crash.
    const LOADERS = {
        triggers: 'loadTriggers',
        'queue-lag': 'loadQueueLag',
        concurrency: 'loadConcurrency',
        silent: 'loadSilentWorkflows',
        reliability: 'loadReliability',
        organisation: 'loadOrganisation',
        'blast-radius': 'loadDependencies',
        deploys: 'loadInsightDeploys',
        metadata: 'loadMetadata',
        'node-time': 'loadNodeProfile',
        storage: 'loadStorage'
    };

    const loaded = new Set();
    const visible = new Set();
    let current = null;

    /**
     * Nothing may load before insights.js has resolved the time range.
     *
     * `initInsights` awaits `window.settingsReady` — the timezone has to be
     * known before a single timestamp is drawn — and only then sets the range.
     * This file's own DOMContentLoaded handler runs while that await is still
     * pending, so firing the loaders here sent `startDate=null&endDate=null`
     * and every panel came back a 400. Visibility is decided immediately;
     * loading waits for the signal.
     */
    const ready = () => window.insightsReady === true;

    const groupOf = (panel) =>
        Object.keys(GROUPS).find((g) => GROUPS[g].includes(panel)) || DEFAULT;

    /**
     * Runs a panel's loader if it has not run yet.
     *
     * `data-conditional` marks a panel the page itself decides to reveal —
     * Business metadata is hidden unless the instance has any. Its loader still
     * runs (that is how the page finds out); the `hidden` class it manages
     * stays its own business.
     */
    function ensureLoaded(panel) {
        if (loaded.has(panel) || !ready()) return;
        const fnName = LOADERS[panel];
        const fn = fnName && window[fnName];
        if (typeof fn !== 'function') return;
        loaded.add(panel);
        try {
            fn();
        } catch (err) {
            // One panel's loader throwing must not stop the others in the same
            // group — the whole point of the original per-panel loading.
            console.error(`[INSIGHTS] ${fnName} failed:`, err);
        }
    }

    function show(group, opts = {}) {
        const target = GROUPS[group] ? group : DEFAULT;
        current = target;

        visible.clear();
        document.querySelectorAll('.panel').forEach((section) => {
            const panel = section.getAttribute('data-panel');
            const inGroup = GROUPS[target].includes(panel);
            if (inGroup) visible.add(panel);
            // `hidden` and not a class, so a hidden panel leaves the
            // accessibility tree as well as the viewport. Eleven panels read
            // out in sequence is what a screen reader had to sit through.
            section.hidden = !inGroup;
            if (inGroup) ensureLoaded(panel);
        });

        document.querySelectorAll('[data-action="showInsightsGroup"]').forEach((btn) => {
            const active = btn.getAttribute('data-arg') === target;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', String(active));
        });

        if (!opts.fromHash) writeHash(target, opts.panel);

        // Charts inside a panel that was hidden had no width to lay out against.
        window.dispatchEvent(new Event('resize'));

        if (opts.panel) {
            document.getElementById(`panel-${opts.panel}`)
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function writeHash(group, panel) {
        const params = new URLSearchParams();
        if (panel) params.set('panel', panel);
        else if (group && group !== DEFAULT) params.set('group', group);
        const next = params.toString();
        window.history.replaceState(null, '', next ? `#${next}` : window.location.pathname);
    }

    function readHash() {
        const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
        const panel = params.get('panel');
        if (panel && LOADERS[panel]) return { group: groupOf(panel), panel };
        const group = params.get('group');
        return { group: GROUPS[group] ? group : DEFAULT, panel: null };
    }

    window.showInsightsGroup = (group) => show(String(group));

    /**
     * Reloads only what has already been looked at.
     *
     * Called by insights.js when the range or a filter changes. A panel nobody
     * has opened has nothing on screen to go stale, so re-querying it would be
     * work done for a view that does not exist.
     */
    window.reloadVisibleInsights = function () {
        // Everything on screen, plus anything that has been on screen before —
        // switching back to a group whose numbers were fetched under a
        // different range must not show the old ones.
        const stale = new Set([...visible, ...loaded]);
        for (const panel of stale) {
            const fn = window[LOADERS[panel]];
            if (typeof fn !== 'function') continue;
            loaded.add(panel);
            try { fn(); } catch (err) { console.error(`[INSIGHTS] ${panel}:`, err); }
        }
    };

    window.addEventListener('hashchange', () => {
        const { group, panel } = readHash();
        if (group !== current || panel) show(group, { fromHash: true, panel });
    });

    document.addEventListener('DOMContentLoaded', () => {
        const { group, panel } = readHash();
        show(group, { fromHash: true, panel });
    });
})();
