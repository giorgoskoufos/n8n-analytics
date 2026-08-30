/**
 * The floating shell.
 *
 * Everything about MESSAGES is chat-core's. What lives here is what is genuinely
 * specific to a panel that floats over a page it does not own: opening and
 * closing, where the focus goes, the difference between a desktop dock and a
 * mobile sheet, and the grip in the corner.
 *
 * ── Modality, honestly ───────────────────────────────────────────────────
 *
 * On a desktop this panel does not block the page. You can read a chart while it
 * writes, which is the entire reason it is a panel and not a page — so it
 * declares `aria-modal="false"` and leaves the rest of the document reachable.
 * Marking it modal because it happens to float would make a screen reader hide
 * content that is still there and still usable.
 *
 * Below 640px it covers the viewport completely. There it really is modal, so it
 * says so, and it takes the scroll lock and the focus trap that claim implies.
 * The same component tells the truth in both cases rather than picking one
 * answer and being wrong half the time.
 *
 * ── It is mounted, not pasted ────────────────────────────────────────────
 *
 * The markup lives once, in global-header.html, and header.js puts it on every
 * page that has a shell. Before this it existed in index.html and nowhere else:
 * Insights, Errors, ROI, Alerts and Settings had no assistant at all.
 */

(function () {
    'use strict';

    // Kept identical to the media query in input.css that turns the dock into a
    // sheet. Everything below — the scroll lock, the focus trap, `aria-modal` —
    // is a claim about whether this thing covers the page, so it has to be the
    // same condition that decides whether it does. A phone held sideways is the
    // case that needs the second half: 844x390 is not narrow, and has nothing
    // like the height the dock wants.
    const MOBILE = '(max-width: 640px), (max-height: 480px)';

    let panel = null;
    let launcher = null;
    let chat = null;
    let isOpen = false;
    let lastFocus = null;

    const isMobile = () => window.matchMedia(MOBILE).matches;

    // ------------------------------------------------------------ scroll lock

    let lockedAt = 0;

    function lockPage() {
        lockedAt = window.scrollY;
        document.body.style.position = 'fixed';
        document.body.style.top = `-${lockedAt}px`;
        document.body.style.width = '100%';
        document.body.style.overflow = 'hidden';
    }

    function unlockPage() {
        if (!document.body.style.position) return;
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.width = '';
        document.body.style.overflow = '';
        window.scrollTo(0, lockedAt);
    }

    // ------------------------------------------------------------- open/close

    function open() {
        if (isOpen) return;
        isOpen = true;
        lastFocus = document.activeElement;

        panel.hidden = false;
        panel.classList.add('is-open', 'is-entering');
        setTimeout(() => panel.classList.remove('is-entering'), 200);
        launcher.setAttribute('aria-expanded', 'true');
        launcher.setAttribute('aria-label', 'Close the assistant');
        setLauncherIcon('fa-xmark');

        setModality();
        if (isMobile()) lockPage();

        markUnread(false);
        window.ChatStore.patchSession({ open: true });

        const input = document.getElementById('assistantInput');
        if (input) input.focus();
        if (chat) chat.scrollToBottom();
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        panel.classList.remove('is-open');
        panel.hidden = true;
        launcher.setAttribute('aria-expanded', 'false');
        launcher.setAttribute('aria-label', 'Open the assistant');
        setLauncherIcon('fa-robot');
        unlockPage();
        window.ChatStore.patchSession({ open: false });

        // Focus goes back where it came from. A dialog that closes and leaves
        // focus on the document body drops a keyboard user at the top of the
        // page they were halfway down.
        if (lastFocus && lastFocus.isConnected) lastFocus.focus();
        else launcher.focus();
    }

    function toggle() {
        if (isOpen) close();
        else open();
    }

    /**
     * The launcher is also the close button, so it has to look like one.
     *
     * The old widget swapped these on `:hover` in CSS, which meant the icon told
     * you what would happen only while the pointer was over it — and told a
     * touch user nothing at all.
     */
    function setLauncherIcon(name) {
        const icon = launcher.querySelector('i');
        if (icon) icon.className = `fa-solid ${name}`;
    }

    /** Modal on a sheet that covers everything, non-modal on a dock that does not. */
    function setModality() {
        panel.setAttribute('aria-modal', String(isMobile()));
    }

    function markUnread(on) {
        const dot = document.getElementById('assistantUnread');
        if (dot) dot.hidden = !on;
        window.ChatStore.patchSession({ unread: Boolean(on) });
        launcher.setAttribute('aria-label',
            on ? 'Open the assistant — a new answer is waiting'
                : (isOpen ? 'Close the assistant' : 'Open the assistant'));
    }

    // ------------------------------------------------------------- focus trap

    /**
     * Only while the sheet covers the page.
     *
     * A trap in the desktop dock would be a bug: the page behind it is still
     * meant to be reachable, and Tab is how a keyboard user reaches it.
     */
    function onKeydown(e) {
        if (!isOpen) return;

        if (e.key === 'Escape') {
            e.preventDefault();
            close();
            return;
        }
        if (e.key !== 'Tab' || !isMobile()) return;

        const focusable = panel.querySelectorAll(
            'a[href], button:not([disabled]), textarea, input, [tabindex]:not([tabindex="-1"])'
        );
        const visible = [...focusable].filter((el) => el.offsetParent !== null);
        if (!visible.length) return;

        const first = visible[0];
        const last = visible[visible.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }

    // ----------------------------------------------------------------- resize

    /**
     * The grip.
     *
     * Size is a preference, so it persists — and it is clamped to the viewport
     * on restore, because a panel sized on a wide monitor and reopened on a
     * laptop would otherwise come back larger than the screen.
     */
    function initResize() {
        const handle = document.getElementById('assistantResize');
        if (!handle) return;

        const prefs = window.ChatStore.prefs;
        if (prefs.width && prefs.height && !isMobile()) {
            panel.style.width = `${Math.min(prefs.width, window.innerWidth - 24)}px`;
            panel.style.height = `${Math.min(prefs.height, window.innerHeight - 24)}px`;
        }

        const start = (e) => {
            if (isMobile()) return;
            const point = e.touches ? e.touches[0] : e;
            const from = { x: point.clientX, y: point.clientY };
            const size = { w: panel.offsetWidth, h: panel.offsetHeight };

            const move = (ev) => {
                const p = ev.touches ? ev.touches[0] : ev;
                const w = Math.max(320, Math.min(window.innerWidth - 24, size.w + (from.x - p.clientX)));
                const h = Math.max(380, Math.min(window.innerHeight - 24, size.h + (from.y - p.clientY)));
                panel.style.width = `${w}px`;
                panel.style.height = `${h}px`;
                // Resizing shortens the scroll region; without this the newest
                // message slides out of view while the grip is still held.
                if (chat) chat.scrollToBottom();
            };

            const end = () => {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', end);
                document.removeEventListener('touchmove', move);
                document.removeEventListener('touchend', end);
                window.ChatStore.patchPrefs({ width: panel.offsetWidth, height: panel.offsetHeight });
            };

            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', end);
            document.addEventListener('touchmove', move, { passive: false });
            document.addEventListener('touchend', end);
            e.preventDefault();
        };

        handle.addEventListener('mousedown', start);
        handle.addEventListener('touchstart', start, { passive: false });
    }

    // ------------------------------------------------------------------ mount

    /**
     * Builds the panel into the current document.
     *
     * @param {DocumentFragment} fragment  the #tpl-assistant contents
     * @param {string} basePath            '' or '../', because pages/ is one
     *                                     level down and the expand link is a
     *                                     real href rather than a router call
     */
    function mount(fragment, basePath) {
        if (document.getElementById('assistantPanel')) return;
        document.body.appendChild(fragment);

        panel = document.getElementById('assistantPanel');
        launcher = document.getElementById('assistantLauncher');
        if (!panel || !launcher) return;

        const expand = document.getElementById('assistantExpand');
        if (expand) expand.href = `${basePath}pages/chat.html`;

        launcher.addEventListener('click', toggle);
        panel.querySelectorAll('[data-assistant="close"]').forEach((b) =>
            b.addEventListener('click', close));
        document.addEventListener('keydown', onKeydown);
        window.matchMedia(MOBILE).addEventListener('change', () => {
            setModality();
            if (!isMobile()) unlockPage();
        });

        chat = window.ChatCore.mount({
            log: document.getElementById('assistantLog'),
            input: document.getElementById('assistantInput'),
            send: document.getElementById('assistantSend'),
            stop: document.getElementById('assistantStop'),
            status: document.getElementById('assistantStatus'),
            jump: document.getElementById('assistantJump'),
            strip: document.getElementById('assistantTagStrip'),
            menu: document.getElementById('assistantTagMenu'),
            toolsButton: panel.querySelector('[data-assistant="tools"]'),
            toolHint: document.getElementById('assistantToolHint'),
            threadButton: panel.querySelector('[data-assistant="threads"]'),
            threadTitle: document.getElementById('assistantThreadTitle'),
            threadMenu: document.getElementById('assistantThreads'),
            newButton: panel.querySelector('[data-assistant="new"]')
        }, {
            compact: true,
            // An answer that finishes while the panel is shut is the whole point
            // of a turn that outlives the request — so the launcher has to say
            // that it happened.
            onAnswer: () => { if (!isOpen) markUnread(true); }
        });

        if (!chat) return;
        initResize();
        setModality();

        boot();
    }

    /**
     * What happens on every page load.
     *
     * The order matters. History first, so the conversation is there; then the
     * check for an answer still being written, because that one appends to the
     * end of it. Reopening comes last so the panel does not flash empty.
     */
    async function boot() {
        await chat.loadHistory();
        const resumed = await chat.resumeInFlight();

        if (window.ChatStore.session.open) open();
        else if (resumed || window.ChatStore.session.unread) markUnread(true);
    }

    window.AssistantPanel = { mount, open, close, toggle };

    // The old global. `data-action="toggleChat"` may still be in a page
    // somewhere, and a dispatcher that finds nothing logs an error rather than
    // doing nothing quietly.
    window.toggleChat = toggle;
})();
