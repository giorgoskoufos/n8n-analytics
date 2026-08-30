// settings_nav.js — F-24 §2.
//
// Replaces settings_accordions.js and settings_ui.js.
//
// The page was three accordions in one column plus a floating "jump to
// top/bottom" button. The item calls that button a symptom rather than a
// solution, and it is right: a page only needs one once it has grown too tall
// to navigate, and adding it accepts the height as given. The categories are
// views now, one at a time, so there is nothing to jump past.
//
// Two things this buys beyond the scroll:
//
//   · The section is in the URL. `settings.html#general` opens on General, which means
//     a setting can be linked to — from a note, a ticket, or another part of
//     this dashboard. An accordion has no address.
//
//   · Only the visible section does work. The ROI panel renders a row per
//     workflow, and it was doing that on every page load whether or not anyone
//     opened it.

(() => {
    // The allowlist and the tab row have to agree, and this is the half that is
    // easy to forget: a tab whose name is missing here silently falls back to
    // `general`, so the button appears, does nothing visible, and looks broken
    // rather than unregistered.
    const SECTIONS = ['general', 'assistant', 'memory', 'health'];
    const DEFAULT = 'general';

    /**
     * Names this page used to answer to.
     *
     * The whole argument for putting the section in the URL was that a setting
     * can then be linked to — from a note, a ticket, or another part of this
     * dashboard. That promise is only worth anything if the links keep working
     * when a tab is renamed or moved, so the old names resolve rather than
     * silently falling back to `general` and looking like a broken link.
     *
     * `roi` is the interesting one: it is not renamed, it is GONE from this
     * page. Time savings live on the ROI page now, beside the figures they
     * explain, so the old hash redirects there instead of resolving here.
     */
    const RENAMED = { integrations: 'assistant' };
    const MOVED = { roi: '../pages/roi.html#configure' };

    /**
     * Shows one section and hides the rest.
     *
     * `hidden` rather than a class: it removes the panel from the accessibility
     * tree as well as from view, which `display:none` via a utility class did
     * not reliably do here — a screen reader was reading all three sections in
     * sequence as one very long page.
     */
    function show(name, { fromHash = false } = {}) {
        if (MOVED[name]) {
            // replace, not assign: the hash that sent them here should not be a
            // stop on the way back.
            window.location.replace(MOVED[name]);
            return;
        }
        const asked = RENAMED[name] || name;
        const target = SECTIONS.includes(asked) ? asked : DEFAULT;

        for (const s of SECTIONS) {
            const panel = document.getElementById(`section-${s}`);
            if (panel) panel.hidden = s !== target;
        }

        document.querySelectorAll('[data-action="showSettingsSection"]').forEach((btn) => {
            const isActive = btn.getAttribute('data-arg') === target;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', String(isActive));
            // The strip scrolls sideways on a narrow viewport, so the selected
            // tab is not necessarily one of the tabs on screen.
            if (isActive) window.UI?.revealTab(btn);
        });

        // replaceState, not pushState: switching a settings tab is not a
        // navigation anyone wants to walk back through with the browser's back
        // button, and filling the history with it would make back-out-of-
        // settings take three presses.
        if (!fromHash) {
            const url = `${window.location.pathname}#${target}`;
            window.history.replaceState(null, '', url);
        }

        // The panel that was hidden had no width to lay out against; anything
        // measuring itself inside it needs to be told the layout changed.
        window.dispatchEvent(new Event('resize'));

        document.dispatchEvent(new CustomEvent('settings:section', { detail: { section: target } }));
    }

    window.showSettingsSection = (name) => show(String(name));

    // The hash is read on load and honoured on change, so a link into a section
    // works and the back button still moves between sections a person typed.
    window.addEventListener('hashchange', () => {
        show(window.location.hash.replace('#', '') || DEFAULT, { fromHash: true });
    });

    document.addEventListener('DOMContentLoaded', () => {
        show(window.location.hash.replace('#', '') || DEFAULT, { fromHash: true });
    });
})();
