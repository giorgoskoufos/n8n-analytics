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
//   · The section is in the URL. `settings.html#roi` opens on ROI, which means
//     a setting can be linked to — from a note, a ticket, or another part of
//     this dashboard. An accordion has no address.
//
//   · Only the visible section does work. The ROI panel renders a row per
//     workflow, and it was doing that on every page load whether or not anyone
//     opened it.

(() => {
    const SECTIONS = ['general', 'roi', 'health'];
    const DEFAULT = 'general';

    /**
     * Shows one section and hides the rest.
     *
     * `hidden` rather than a class: it removes the panel from the accessibility
     * tree as well as from view, which `display:none` via a utility class did
     * not reliably do here — a screen reader was reading all three sections in
     * sequence as one very long page.
     */
    function show(name, { fromHash = false } = {}) {
        const target = SECTIONS.includes(name) ? name : DEFAULT;

        for (const s of SECTIONS) {
            const panel = document.getElementById(`section-${s}`);
            if (panel) panel.hidden = s !== target;
        }

        document.querySelectorAll('[data-action="showSettingsSection"]').forEach((btn) => {
            const isActive = btn.getAttribute('data-arg') === target;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', String(isActive));
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
