/**
 * header.js — assembles the app shell.
 *
 * F-24 §2 asked for a persistent sidebar with expand/collapse instead of a
 * burger dropdown, and for the sync-lag indicator to move into it alongside the
 * n8n status. The obvious way to build that is to restructure the <body> of
 * every page. This does not do that, for the reason F-24 §7 is a section at
 * all: six copies of a layout is six places for it to drift, and this codebase
 * already has five files whose diffs are unreadable because of it.
 *
 * Instead the shell is built around whatever the page already had. On load this
 * lifts the existing body content into `.shell-main`, puts the rail beside it,
 * and drops the page header into the `#header-target` the page already
 * declares. Element identity is preserved by the move — `getElementById` in a
 * page script that runs afterwards resolves exactly as before — so no page
 * script had to change for this.
 *
 * Everything the rail displays comes from this file. There is one navigation.
 */

(function () {
    'use strict';

    const COLLAPSE_KEY = 'nav:collapsed';

    // ─────────────────────────────────────────────────────────────────────

    async function initGlobalHeader() {
        const isPages = window.location.pathname.includes('/pages/');
        const basePath = isPages ? '../' : '';

        let tpl;
        try {
            const response = await fetch(basePath + 'global-header.html');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            tpl = document.createElement('div');
            tpl.innerHTML = await response.text();
        } catch (err) {
            // The rail failing to load must not take the page with it. Without
            // it the content is still readable; the page simply has no
            // navigation, which is survivable, and the console says why.
            console.error('[SHELL] Could not load the shell template:', err);
            return;
        }

        const navTpl = tpl.querySelector('#tpl-shell-nav');
        const headTpl = tpl.querySelector('#tpl-page-head');
        if (!navTpl || !headTpl) {
            console.error('[SHELL] Template markup is missing its parts.');
            return;
        }

        buildShell(navTpl);
        placePageHeader(headTpl);
        fixNavPaths(isPages);
        wireShell();

        checkN8nHealth();
        checkSyncLag();

        // Last, and not awaited by anything above it: the assistant is the one
        // part of the shell whose absence costs the page nothing.
        mountAssistant(tpl.querySelector('#tpl-assistant'), basePath);
    }

    /**
     * Puts the assistant on this page.
     *
     * ── Why the scripts are injected rather than listed in seven files ───
     *
     * The same argument as the rail itself. Before this the widget was in
     * index.html and nowhere else, and its five dependencies were `<script>`
     * tags in that one file — so "add the assistant to the Errors page" meant
     * copying six lines into six documents and keeping them in step forever.
     * This is the file that already knows every page has a shell.
     *
     * `async = false` on a dynamically created script is what makes the browser
     * run them in insertion order instead of in whatever order they arrive.
     * chat-core reads `window.ChatStore` and `window.ChatRender` at mount time,
     * so the order is load-bearing.
     *
     * Matching on the file NAME rather than the full URL: index.html already
     * loads marked and DOMPurify with relative paths, and an exact-URL check
     * would load a second copy of each.
     */
    const ASSISTANT_SCRIPTS = [
        '/vendor/marked.umd.js',
        '/vendor/purify.min.js',
        '/logic/chat/store.js',
        '/logic/chat/render.js',
        '/logic/chat/tags.js',
        '/logic/chat-core.js',
        '/logic/chat/panel.js'
    ];

    function loadScripts(sources) {
        const loaded = [...document.scripts].map((s) => s.src.split('/').pop());
        const wanted = sources.filter((src) => !loaded.includes(src.split('/').pop()));
        if (!wanted.length) return Promise.resolve();

        return new Promise((resolve) => {
            let left = wanted.length;
            const done = () => { if (--left === 0) resolve(); };
            for (const src of wanted) {
                const el = document.createElement('script');
                el.src = src;
                el.async = false;
                el.onload = done;
                el.onerror = () => {
                    console.error(`[SHELL] Could not load ${src}; the assistant is unavailable.`);
                    done();
                };
                document.head.appendChild(el);
            }
        });
    }

    async function mountAssistant(template, basePath) {
        if (!template) return;
        // The page that IS the conversation does not also float one over itself.
        if (document.body.dataset.assistant === 'off') return;

        try {
            await loadScripts(ASSISTANT_SCRIPTS);
            if (!window.AssistantPanel) return;
            window.AssistantPanel.mount(template.content.cloneNode(true), basePath);
        } catch (err) {
            console.error('[SHELL] The assistant failed to mount:', err);
        }
    }

    /**
     * Wraps the existing document body in the two-column grid.
     *
     * The page's own padding classes (`p-4 md:p-8`) are lifted off the body and
     * onto the content column — left on the body they would indent the rail
     * away from the viewport edge, which is the one place a persistent rail
     * must not be.
     */
    function buildShell(navTpl) {
        const body = document.body;
        if (document.querySelector('.shell')) return;

        const shell = document.createElement('div');
        shell.className = 'shell';
        shell.id = 'appShell';

        // Restored per viewer, not per page — a rail that re-expands on every
        // navigation is a preference the app keeps forgetting.
        try {
            if (localStorage.getItem(COLLAPSE_KEY) === '1') shell.dataset.collapsed = 'true';
        } catch (ignored) { /* private mode */ }

        const main = document.createElement('main');
        main.className = 'shell-main';
        main.id = 'appMain';

        // The page's own padding moves onto the content column. Left on the
        // body it would indent the rail away from the viewport edge, which is
        // the one place a persistent rail must not be.
        ['p-4', 'md:p-8', 'p-8', 'p-6'].forEach((c) => body.classList.remove(c));

        // Move, don't clone. Cloning would drop every listener the page had
        // already attached and silently detach the nodes that page scripts hold
        // references to.
        while (body.firstChild) main.appendChild(body.firstChild);

        const scrim = document.createElement('div');
        scrim.className = 'nav-scrim';
        scrim.setAttribute('data-action', 'closeNavDrawer');
        scrim.setAttribute('aria-hidden', 'true');

        // The whole fragment, not `.firstElementChild` — the template holds two
        // top-level elements now. The collapse handle straddles the rail's
        // border, and the rail clips its overflow, so the handle has to be a
        // sibling of it rather than a child. The CSS reveals it with
        // `.shell-nav:hover ~ .nav-handle`, which is why the order here matters.
        shell.appendChild(navTpl.content.cloneNode(true));
        shell.appendChild(scrim);
        shell.appendChild(main);
        body.appendChild(shell);

        // The rail may have come back collapsed from localStorage above; the
        // handle has to say so before anyone looks at it.
        paintCollapse(shell);

        // The rail comes before the content in the DOM, so keyboard users would
        // otherwise tab through six links on every page load.
        const skip = document.createElement('a');
        skip.href = '#appMain';
        skip.className = 'sr-only focus:not-sr-only';
        skip.textContent = 'Skip to content';
        skip.style.cssText = 'position:absolute;top:8px;left:8px;z-index:80;background:var(--surface-1);border:1px solid var(--line-2);border-radius:8px';
        body.prepend(skip);
    }

    /**
     * Puts the page header into the slot the page declares, reading the title,
     * subtitle and breadcrumb trail off that slot's data attributes.
     */
    function placePageHeader(headTpl) {
        const target = document.getElementById('header-target');
        if (!target) return;

        target.appendChild(headTpl.content.cloneNode(true));

        const title = target.getAttribute('data-title');
        const subtitle = target.getAttribute('data-subtitle');
        if (title) document.getElementById('headerTitle').textContent = title;
        if (subtitle) document.getElementById('headerSubtitle').textContent = subtitle;

        // F-16's last open piece. Declared as `data-crumbs="Label|href, Label"`
        // — the trailing entry is the current page and carries no href.
        const raw = target.getAttribute('data-crumbs');
        const holder = document.getElementById('headerCrumbs');
        if (raw && holder && window.UI) {
            const trail = raw.split(',').map((part) => {
                const [label, href] = part.split('|').map((s) => s.trim());
                return { label, href: href || null };
            }).filter((c) => c.label);
            holder.innerHTML = window.UI.crumbs(trail);
            holder.style.marginBottom = '4px';
        }
    }

    /**
     * Rewrites the rail's hrefs for the current directory and marks the current
     * page.
     *
     * `aria-current="page"` is the whole mechanism — the CSS keys off it, so
     * the highlight and the accessibility tree cannot disagree. The old version
     * added `text-white bg-gray-800` and told assistive tech nothing.
     */
    function fixNavPaths(isPages) {
        const basePath = isPages ? '../' : '';
        const pagesPath = isPages ? '' : 'pages/';

        const links = {
            'nav-home': basePath + 'index.html',
            'nav-insights': pagesPath + 'insights.html',
            'nav-errors': pagesPath + 'errors.html',
            'nav-alerts': pagesPath + 'alerts.html',
            'nav-roi': pagesPath + 'roi.html',
            'nav-settings': pagesPath + 'settings.html'
        };

        // The current file, defaulting to index.html at a bare directory root.
        const here = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();

        for (const [id, path] of Object.entries(links)) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.setAttribute('href', path);
            if (path.split('/').pop().toLowerCase() === here) {
                el.setAttribute('aria-current', 'page');
            }
        }
    }

    function wireShell() {
        const shell = document.getElementById('appShell');
        if (!shell) return;

        // Escape closes the drawer. On mobile the scrim covers the content, so
        // without this the only way out is to find the strip of scrim that is
        // not under a thumb.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && shell.dataset.drawer === 'open') closeDrawer();
        });

        // A resize past the breakpoint leaves `data-drawer` set, and the rail
        // then reads as "open" in a layout where open means nothing.
        window.addEventListener('resize', () => {
            // Rotating into landscape past the breakpoint leaves `data-drawer`
            // set on a layout where "open" means nothing — and, before this,
            // left the page pinned by a scroll lock with no drawer on screen to
            // explain why it would not scroll.
            if (window.innerWidth >= 1024 && shell.dataset.drawer === 'open') closeDrawer();
        });

        wireNavHandleTracking(shell);
    }

    /**
     * Slides the collapse handle to the cursor's height while it is over the
     * nav band — the scrolling list of links, not the brand row or the status
     * foot above and below it — instead of leaving it pinned to the vertical
     * centre.
     *
     * The nav element's own bounding rect is cached on `pointerenter` rather
     * than re-measured on every move: it is `flex-1` inside a rail whose only
     * size change is width (the collapse animation), so its top/bottom do not
     * move while a pointer is crossing it, and calling `getBoundingClientRect`
     * on every `pointermove` would force a layout read on every one of them
     * for a number that has not changed.
     */
    function wireNavHandleTracking(shell) {
        const track = shell.querySelector('#appNav nav[aria-label="Main"]');
        const handle = shell.querySelector('.nav-handle');
        if (!track || !handle) return;

        const RADIUS = 11; // half the handle's 22px — keeps the circle from riding past the nav's own top/bottom edge
        let rect = null;

        track.addEventListener('pointerenter', () => { rect = track.getBoundingClientRect(); });
        track.addEventListener('pointermove', (e) => {
            if (!rect) rect = track.getBoundingClientRect();
            const y = Math.min(Math.max(e.clientY, rect.top + RADIUS), rect.bottom - RADIUS);
            handle.style.top = `${y}px`;
        });

        // The cached rect goes stale on anything that could move the nav band
        // vertically — a viewport resize, or the browser zoom level changing.
        window.addEventListener('resize', () => { rect = null; });
    }

    /**
     * The page does not scroll behind the drawer.
     *
     * Without this, a drag that starts anywhere on the scrim — which is most of
     * the screen, and is where a thumb naturally lands — scrolls the page
     * underneath instead of the list of links. The reader closes the drawer and
     * finds themselves somewhere else on a page they had not moved.
     *
     * `position: fixed` with a negative `top` rather than `overflow: hidden`,
     * because iOS Safari scrolls the document regardless of `overflow` on the
     * body; the offset is what stops the page jumping to the top the moment it
     * is pinned, and it is restored on the way out.
     */
    let drawerScrollY = 0;

    function lockPage() {
        drawerScrollY = window.scrollY;
        document.body.style.position = 'fixed';
        document.body.style.top = `-${drawerScrollY}px`;
        document.body.style.width = '100%';
    }

    function unlockPage() {
        if (!document.body.style.position) return;
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.width = '';
        window.scrollTo(0, drawerScrollY);
    }

    function closeDrawer() {
        const shell = document.getElementById('appShell');
        if (!shell || shell.dataset.drawer !== 'open') return;
        delete shell.dataset.drawer;
        unlockPage();
        // Back to the button that opened it, which is where a keyboard user was
        // standing and where a screen reader has to be put back.
        document.querySelector('[data-action="openNavDrawer"]')?.focus();
    }

    window.openNavDrawer = function () {
        const shell = document.getElementById('appShell');
        if (!shell) return;
        shell.dataset.drawer = 'open';
        lockPage();
        // Focus follows the drawer, or a screen reader stays parked on the
        // trigger behind a scrim it cannot see.
        document.querySelector('#appNav .nav-item')?.focus();
    };

    window.closeNavDrawer = closeDrawer;

    /**
     * Brings the handle into line with the rail.
     *
     * `data-collapsed` on the shell is the one record of the state: the CSS
     * rotates the chevron off it, so the arrow cannot point the wrong way, and
     * this only has to restate it for assistive tech and the tooltip. The
     * previous version flipped the icon class on click and nowhere else, which
     * is why a rail restored from localStorage came back collapsed with an
     * arrow still offering to collapse it.
     */
    function paintCollapse(shell) {
        const btn = shell.querySelector('[data-action="toggleNavCollapse"]');
        if (!btn) return;
        const collapsed = shell.dataset.collapsed === 'true';
        btn.setAttribute('aria-expanded', String(!collapsed));
        btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    }

    window.toggleNavCollapse = function () {
        const shell = document.getElementById('appShell');
        if (!shell) return;
        const next = shell.dataset.collapsed === 'true' ? null : 'true';
        if (next) shell.dataset.collapsed = 'true'; else delete shell.dataset.collapsed;
        try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch (ignored) { /* private mode */ }

        paintCollapse(shell);

        // Chart.js sizes to its container, and the container just changed width
        // by 172px. Without this every canvas on the page stays the old width
        // until something else forces a resize.
        window.dispatchEvent(new Event('resize'));
    };

    // ─────────────────────────────────────────────────────────────────────
    // Status foot
    // ─────────────────────────────────────────────────────────────────────

    // `tone` is a token name, not a colour. Passing the raw hex here is how the
    // two-places problem starts again.
    const TONE_INK = {
        good: 'var(--good-ink)',
        warning: 'var(--warning-ink)',
        critical: 'var(--critical-ink)',
        muted: 'var(--ink-3)'
    };

    function paintStatus(el, tone, icon, label, title) {
        if (!el) return;
        const color = TONE_INK[tone] || TONE_INK.muted;
        el.title = title;
        el.innerHTML =
            `<i class="fa-solid ${icon} nav-icon" style="font-size:11px;color:${color}"></i>` +
            `<span class="nav-label label" style="letter-spacing:.06em;color:${color}">${window.escapeHtml(label)}</span>`;
    }

    async function checkN8nHealth() {
        const el = document.getElementById('n8nHealthIndicator');
        if (!el) return;
        try {
            if (typeof window.fetchWithAuth !== 'function') return;
            const res = await window.fetchWithAuth('/api/n8n-health');
            if (res.ok) {
                const data = await res.json();
                if (data.status === 'ok') {
                    paintStatus(el, 'good', 'fa-circle-check', 'n8n online',
                        'The n8n instance answered its health check.');
                    return;
                }
            }
            throw new Error('unhealthy');
        } catch (ignored) {
            paintStatus(el, 'critical', 'fa-circle-xmark', 'n8n offline',
                'The n8n instance did not answer. The dashboard still reads the local replica, so these numbers are the last synced ones.');
        }
    }

    /**
     * F-19 · How old is what you are looking at.
     *
     * Two ages, answering different questions: how long since the ETL last
     * finished a pass, and how old the newest execution in the replica is. The
     * line shows the first, because that is the one that means "this page may
     * be wrong"; the tooltip carries both, because a healthy pipeline over a
     * quiet n8n looks identical from the outside and is not a problem to fix.
     *
     * Uses ?brief=1 — the full health payload counts half a million rows, and
     * this runs on every page load of every page.
     */
    /** The stage names, in the reader's vocabulary rather than the ETL's. */
    const STAGE_WORDS = {
        executions: 'reading executions',
        details: 'filling in execution details',
        errors: 'extracting error detail',
        grouping: 'grouping errors'
    };

    async function checkSyncLag() {
        const el = document.getElementById('syncLagIndicator');
        if (!el) return;

        const ago = (ms) => {
            if (ms === null || ms === undefined) return 'unknown';
            const s = Math.round(ms / 1000);
            if (s < 60) return `${s}s`;
            if (s < 3600) return `${Math.round(s / 60)}m`;
            if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
            return `${(s / 86400).toFixed(1)}d`;
        };

        try {
            if (typeof window.fetchWithAuth !== 'function') return;
            const res = await window.fetchWithAuth('/api/analytics/system?brief=1');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const d = await res.json();
            const since = ago(d.pipeline.since_last_run_ms);
            const dataAge = ago(d.data.data_age_ms);
            const detail = `Last ETL pass ${since} ago (${d.pipeline.last_status || 'unknown'}). ` +
                `Newest execution in the replica is ${dataAge} old.`;

            // Catching up outranks everything below it, and that ordering is the
            // point. A replica mid-catch-up has a pipeline running perfectly on
            // schedule — `pipeline.status` is 'ok' — while every total on every
            // page is a floor. "Synced 12s ago" is true and is the single most
            // misleading thing the interface could say at that moment.
            const catching = d.catching_up;
            if (catching && catching.active) {
                window.SyncProgress?.show(catching);
                paintStatus(el, 'warning', 'fa-arrows-rotate',
                    `Catching up · ${catching.pct}%`,
                    `${catching.remaining.toLocaleString()} rows still to process ` +
                    `(${STAGE_WORDS[catching.stage] || catching.stage}). The pages work, but ` +
                    'totals are incomplete until this finishes.');
                return;
            }
            window.SyncProgress?.hide(catching);

            if (d.pipeline.status === 'stalled') {
                paintStatus(el, 'critical', 'fa-triangle-exclamation', `Sync stalled · ${since}`, detail);
            } else if (d.pipeline.status === 'late') {
                paintStatus(el, 'warning', 'fa-hourglass-half', `Sync late · ${since}`, detail);
            } else if (d.pipeline.status === 'unknown') {
                paintStatus(el, 'muted', 'fa-circle-question', 'Never synced',
                    'No ETL pass has been recorded yet.');
            } else {
                paintStatus(el, 'muted', 'fa-rotate', `Synced ${since} ago`, detail);
            }
        } catch (ignored) {
            // A status widget must not be the loudest thing on a page it failed
            // to describe. It says it does not know, and says nothing else.
            paintStatus(el, 'muted', 'fa-circle-question', 'Sync unknown',
                'Could not read the dashboard health endpoint.');
        }
    }

    document.addEventListener('DOMContentLoaded', initGlobalHeader);

    // A tab can sit open for hours. "Synced 2m ago", true when the tab was
    // opened this morning, is worse than no indicator at all.
    //
    // Faster while catching up. Sixty seconds is right for a status line that
    // changes twice an hour and useless for a percentage somebody is watching
    // to decide whether to wait — and it is the same call either way, so the
    // interval follows what the last answer said rather than being two timers.
    let lagTimer = null;
    function scheduleLagCheck(ms) {
        clearInterval(lagTimer);
        lagTimer = setInterval(checkSyncLag, ms);
    }
    document.addEventListener('sync:progress', (event) => {
        scheduleLagCheck(event.detail && event.detail.active ? 5000 : 60000);
    });
    scheduleLagCheck(60000);
})();
