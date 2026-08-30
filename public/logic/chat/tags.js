/**
 * The `@` layer of the composer.
 *
 * ── What a tag is on each side ───────────────────────────────────────────
 *
 * In the textarea a tag is text: `@workflow:281VZtHUACXi9tPH`. Above the
 * textarea the same tag is a chip reading "CallCenterPerMinute". They are the
 * same object at two zoom levels, and which one is canonical matters:
 *
 *   THE TEXT IS CANONICAL. The chip is a rendering of it. Nothing here keeps a
 *   parallel list of "the tags the user has added" that the text could disagree
 *   with — a user who deletes half a tag with the backspace key has deleted the
 *   tag, and there is no second copy left behind to send anyway.
 *
 * ── Why the picker inserts an id and shows a name ────────────────────────
 *
 * Names are not unique on a live instance. "Saved Messages v2" is three
 * workflows here; two error groups are both called `call_center`. The picker
 * showed one specific row, and that knowledge has to survive into the text or
 * the server has nothing to disambiguate with — it would be right to refuse.
 *
 * The id is not trusted for being an id. It is re-resolved server-side through
 * the same scoped catalogue this dropdown reads, and rejected if it is not there
 * — see src/ai/tags.js. What the id buys is precision, not permission.
 *
 * ── Why the dropdown is not a new search ─────────────────────────────────
 *
 * `/api/ai-catalog` is the assistant's own `search_catalog`, scoped the same
 * way. The picker and the model therefore look at exactly one list. A separate
 * index for the UI would be a second thing that can be wrong, and the way it
 * would be wrong is offering a workflow the answer then says does not exist.
 */

(function () {
    'use strict';

    // Kept identical to TAG_RE in src/ai/tags.js. If one changes, both change:
    // the client draws chips for what it thinks are tags and the server acts on
    // what it thinks are tags, and a disagreement is invisible until an answer
    // is about the wrong thing.
    const TAG_RE = /@([a-z_]{2,12}):(?:"([^"\n]{1,120})"|([^\s"@,;]{1,120}))/gi;

    // What a caret sitting inside a half-typed tag looks like.
    const PARTIAL_RE = /@([a-z_]*)(:)?([^\s"@,;]*)$/i;

    const CATEGORY_LABEL = {
        workflow: 'workflow', folder: 'folder', tag: 'tag', project: 'project',
        node: 'node type', error: 'error group', execution: 'execution', tool: 'tool'
    };

    /**
     * An icon per category, and the word demoted to the accessible name.
     *
     * The dropdown used to put the category in a 58px column of uppercase text
     * in front of every row, and the chip spelled it out too — so a panel 420px
     * wide spent most of a line saying "workflow" eight times, in a list where
     * every row was a workflow. The icon carries it; `aria-label` still says it
     * in words for anyone who cannot see the icon.
     */
    const CATEGORY_ICON = {
        workflow: 'fa-diagram-project',
        folder: 'fa-folder',
        tag: 'fa-hashtag',
        project: 'fa-layer-group',
        node: 'fa-cube',
        error: 'fa-triangle-exclamation',
        execution: 'fa-play',
        tool: 'fa-wand-magic-sparkles'
    };

    const TOOL_ICON = {
        docs: 'fa-book',
        sql: 'fa-terminal',
        analytics: 'fa-chart-simple',
        search: 'fa-magnifying-glass',
        drilldown: 'fa-diagram-project',
        instance: 'fa-circle-info'
    };

    const TOOL_LABEL = {
        docs: 'n8n documentation',
        sql: 'a direct query',
        analytics: 'a dashboard metric',
        search: 'the catalogue',
        drilldown: 'one specific thing',
        instance: 'what data exists'
    };

    /** Loaded once per page: which categories and tools this user actually has. */
    let optionsPromise = null;
    function loadOptions() {
        if (optionsPromise) return optionsPromise;
        optionsPromise = window.fetchWithAuth('/api/ai-tag-options')
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
            .then((o) => o || { categories: Object.keys(CATEGORY_LABEL), tools: [] });
        return optionsPromise;
    }

    /** Every complete tag in a string. */
    function parse(text) {
        const out = [];
        const seen = new Set();
        TAG_RE.lastIndex = 0;
        for (const m of String(text || '').matchAll(TAG_RE)) {
            const category = m[1].toLowerCase();
            if (!CATEGORY_LABEL[category]) continue;
            const value = (m[2] === undefined ? m[3] : m[2]).trim();
            if (!value) continue;
            const key = `${category}:${value.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ raw: m[0], category, value, index: m.index });
        }
        return out;
    }

    /** The tag the caret is currently inside, if any. */
    function partialAt(text, caret) {
        const before = String(text).slice(0, caret);
        const m = before.match(PARTIAL_RE);
        if (!m) return null;
        return {
            start: caret - m[0].length,
            end: caret,
            category: (m[1] || '').toLowerCase(),
            typed: Boolean(m[2]),
            query: m[3] || ''
        };
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    /**
     * Draws a set of tags as chips.
     *
     * Used twice: live above the composer, and frozen underneath a sent message
     * once the server has said which of them it could resolve. `onRemove` is what
     * separates the two — a frozen chip has nothing to remove.
     */
    function renderChips(host, items, opts = {}) {
        host.replaceChildren();
        if (!items.length) {
            host.hidden = true;
            return;
        }
        host.hidden = false;

        for (const item of items) {
            const kind = CATEGORY_LABEL[item.category] || item.category;
            const name = item.label || item.value;
            const chip = el('span', 'tag-chip');
            if (item.category === 'tool') chip.classList.add('is-tool');

            // The category is carried by the icon and by the accessible name,
            // never by a word taking up half the chip.
            let icon = CATEGORY_ICON[item.category] || 'fa-at';
            if (item.rejected) {
                chip.classList.add('is-rejected');
                // Colour is never the only signal: the icon changes too, and the
                // reason is readable rather than merely implied.
                icon = 'fa-circle-exclamation';
                chip.title = item.why || 'Could not be resolved';
            }
            chip.appendChild(el('i', `fa-solid ${icon}`));
            chip.setAttribute('aria-label',
                `${kind} ${name}${item.rejected ? ` — ${item.why || 'not found'}` : ''}`);
            chip.appendChild(el('span', 'name', name));

            if (opts.onRemove) {
                const x = el('button');
                x.type = 'button';
                x.setAttribute('aria-label', `Remove ${kind} ${name}`);
                x.appendChild(el('i', 'fa-solid fa-xmark'));
                x.addEventListener('click', () => opts.onRemove(item));
                chip.appendChild(x);
            }
            host.appendChild(chip);
        }
    }

    /**
     * Wires the `@` behaviour onto one composer.
     *
     * @param {object} refs { input, strip, menu, toolsButton, toolHint }
     */
    function attach(refs) {
        const { input, strip, menu, toolsButton, toolHint } = refs;
        // id → what the picker showed for it, so a chip can say "CallCenter"
        // where the text says an id. Lost on reload, which is why a chip falls
        // back to the raw value rather than to nothing.
        const labels = new Map();

        let items = [];          // what the menu is currently offering
        let cursor = -1;         // which of them is selected
        let stage = null;        // the partial being completed
        let inFlight = null;     // AbortController for the catalogue request
        let debounce = null;

        function closeMenu() {
            menu.hidden = true;
            menu.replaceChildren();
            items = [];
            cursor = -1;
            stage = null;
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
        }

        function drawMenu() {
            menu.replaceChildren();
            const head = el('div', 'tag-menu-head');
            head.appendChild(el('span', null, stage && stage.typed
                ? `${CATEGORY_LABEL[stage.category] || stage.category}s`
                : 'Tag something'));
            const hint = el('span');
            hint.textContent = items.length ? '↑↓ · enter' : '';
            head.appendChild(hint);
            menu.appendChild(head);

            if (!items.length) {
                menu.appendChild(el('div', 'tag-menu-empty',
                    stage && stage.typed && stage.query
                        ? `Nothing here is called “${stage.query}”.`
                        : 'Keep typing to search.'));
                menu.hidden = false;
                return;
            }
            items.forEach((item, i) => {
                const opt = el('button', 'tag-option');
                opt.type = 'button';
                opt.id = `tag-option-${i}`;
                opt.setAttribute('role', 'option');
                opt.setAttribute('aria-selected', String(i === cursor));
                opt.setAttribute('aria-label', `${item.kindLabel} ${item.name}`);
                opt.appendChild(el('i', `fa-solid ${item.icon || 'fa-at'}`));
                opt.appendChild(el('span', 'name', item.name));
                if (item.detail) opt.appendChild(el('span', 'detail', item.detail));
                // mousedown, not click: click fires after the textarea has lost
                // focus, and losing focus is what closes this menu.
                opt.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    choose(i);
                });
                menu.appendChild(opt);
            });
            menu.hidden = false;
            input.setAttribute('aria-expanded', 'true');
            if (cursor >= 0) input.setAttribute('aria-activedescendant', `tag-option-${cursor}`);
        }

        function move(delta) {
            if (!items.length) return;
            cursor = (cursor + delta + items.length) % items.length;
            drawMenu();
            // The heading is the menu's first child, so an option's position in
            // the list and its position in the DOM are off by one.
            const active = menu.children[cursor + 1];
            if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
        }

        /** Replaces the half-typed tag with the chosen one. */
        function choose(i) {
            const item = items[i];
            if (!item || !stage) return;

            const text = input.value;
            const replacement = item.insert;
            input.value = text.slice(0, stage.start) + replacement + text.slice(stage.end);
            const caret = stage.start + replacement.length;
            input.setSelectionRange(caret, caret);

            if (item.id && item.name) labels.set(`${item.category}:${item.id}`, item.name);
            closeMenu();
            input.focus();
            // A category is only half a tag, so the menu reopens on the value.
            refresh();
            paintChips();
        }

        // ---- what the menu offers, per stage ----

        async function offerCategories(prefix) {
            const opts = await loadOptions();
            const names = ['tool', ...opts.categories.filter((c) => c !== 'tool')];
            return names
                .filter((c) => c.startsWith(prefix))
                .map((c) => ({
                    kindLabel: c,
                    icon: CATEGORY_ICON[c] || 'fa-at',
                    name: CATEGORY_LABEL[c] || c,
                    detail: c === 'tool' ? 'force one' : '',
                    category: c,
                    // Only half a tag — the value comes next.
                    insert: `@${c}:`
                }));
        }

        async function offerTools(prefix) {
            const opts = await loadOptions();
            return (opts.tools || [])
                .filter((t) => t.alias.startsWith(prefix))
                .map((t) => ({
                    kindLabel: 'tool',
                    icon: TOOL_ICON[t.alias] || 'fa-wand-magic-sparkles',
                    name: t.alias,
                    detail: TOOL_LABEL[t.alias] || '',
                    category: 'tool',
                    insert: `@tool:${t.alias} `
                }));
        }

        async function offerCatalog(category, query) {
            if (query.length < 1) {
                return [{
                    kindLabel: CATEGORY_LABEL[category],
                    name: 'Keep typing to search…',
                    detail: '',
                    insert: null
                }].filter(() => false);          // an empty box is not a search
            }
            if (inFlight) inFlight.abort();
            inFlight = new AbortController();

            const url = `/api/ai-catalog?q=${encodeURIComponent(query)}` +
                (category === 'execution' ? '' : `&kind=${encodeURIComponent(kindFor(category))}`);
            try {
                const res = await window.fetchWithAuth(url, { signal: inFlight.signal });
                if (!res.ok) return [];
                const body = await res.json();
                return (body.results || []).map((r) => ({
                    kindLabel: CATEGORY_LABEL[r.category] || r.category,
                    icon: CATEGORY_ICON[r.category] || 'fa-at',
                    name: r.name,
                    // The disambiguator, and the reason it is on screen: two
                    // error groups here are both called `call_center` and only
                    // the occurrence count tells them apart.
                    detail: r.detail || '',
                    category: r.category,
                    id: r.id,
                    insert: `@${r.category}:${r.id} `
                }));
            } catch (err) {
                if (err.name !== 'AbortError') console.warn('[CHAT] catalog lookup failed:', err);
                return [];
            }
        }

        function kindFor(category) {
            if (category === 'node') return 'node_type';
            if (category === 'error') return 'error_group';
            return category;
        }

        /** Reads the caret and decides what, if anything, to offer. */
        function refresh() {
            const found = partialAt(input.value, input.selectionStart);
            if (!found) {
                closeMenu();
                return;
            }
            stage = found;

            const run = async () => {
                let next;
                if (!found.typed) next = await offerCategories(found.category);
                else if (found.category === 'tool') next = await offerTools(found.query);
                else if (!CATEGORY_LABEL[found.category]) next = [];
                else if (found.category === 'execution') next = [];
                else next = await offerCatalog(found.category, found.query);

                // The caret may have moved on while the request was out.
                const still = partialAt(input.value, input.selectionStart);
                if (!still || still.start !== found.start) return;

                items = next;
                cursor = next.length ? 0 : -1;
                if (!next.length && found.typed && found.query.length < 1) closeMenu();
                else drawMenu();
            };

            // Categories and tools are local, so they appear as fast as the key
            // press. Only the catalogue is debounced, because only it is a
            // request.
            clearTimeout(debounce);
            if (!found.typed || found.category === 'tool') run();
            else debounce = setTimeout(run, 140);
        }

        // ---- the chip strip ----

        function paintChips() {
            const parsed = parse(input.value).map((t) => ({
                ...t,
                label: labels.get(`${t.category}:${t.value}`) || t.value
            }));
            renderChips(strip, parsed, {
                onRemove: (item) => {
                    // Removed from the TEXT, because the text is the tag. The
                    // strip redraws from what is left.
                    input.value = (input.value.slice(0, item.index) +
                        input.value.slice(item.index + item.raw.length)).replace(/ {2,}/g, ' ');
                    paintChips();
                    input.focus();
                }
            });
        }

        // ---- the `+` menu ----

        let toolsMenu = null;

        function closeTools() {
            if (!toolsMenu) return;
            toolsMenu.remove();
            toolsMenu = null;
            toolsButton.setAttribute('aria-expanded', 'false');
        }

        /**
         * The `+` menu: which tools may be chosen without being asked for.
         *
         * It listed one line per tool and nothing else — no heading, no state
         * beyond a tiny glyph — so a popover did open and looked like a grey
         * rectangle, which from the reader's side is the same as nothing
         * happening. Every row now says what the tool is, whether it is on, and
         * what turning it off actually does.
         */
        async function toggleTools() {
            if (toolsMenu) {
                closeTools();
                return;
            }
            const opts = await loadOptions();
            const prefs = window.ChatStore.toolPreferences();

            const menuEl = el('div', 'tag-menu');
            menuEl.setAttribute('role', 'menu');
            menuEl.setAttribute('aria-label', 'Tools');

            const head = el('div', 'tag-menu-head');
            head.appendChild(el('span', null, 'Tools'));
            head.appendChild(el('span', null, 'automatic use'));
            menuEl.appendChild(head);

            // Only `docs` and `sql` are switchable. The others are how the
            // assistant works at all, and a switch that breaks it is not a
            // preference.
            let switchable = 0;
            for (const key of ['docs', 'sql']) {
                if (!(opts.tools || []).some((t) => t.alias === key)) continue;
                switchable++;
                const on = prefs[key] !== false;
                const row = el('button', 'tag-option');
                row.type = 'button';
                row.setAttribute('role', 'menuitemcheckbox');
                row.setAttribute('aria-checked', String(on));
                row.setAttribute('aria-label',
                    `${TOOL_LABEL[key]} — ${on ? 'on' : 'off'}`);
                row.appendChild(el('i', `fa-solid ${on ? 'fa-toggle-on' : 'fa-toggle-off'}`));
                row.appendChild(el('span', 'name', TOOL_LABEL[key]));
                row.appendChild(el('span', 'detail', on ? 'on' : 'off'));
                row.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    const next = window.ChatStore.prefs.tools || {};
                    window.ChatStore.patchPrefs({ tools: { ...next, [key]: !on } });
                    closeTools();
                    paintToolHint();
                });
                menuEl.appendChild(row);
            }

            if (!switchable) {
                menuEl.appendChild(el('div', 'tag-menu-empty',
                    'Everything available is already in use. Connecting the n8n documentation ' +
                    'in Settings adds one you can switch.'));
            } else {
                menuEl.appendChild(el('div', 'tag-menu-note',
                    'Off means it is never chosen on its own. Writing @tool: in the question ' +
                    'still forces it.'));
            }

            toolsButton.closest('.assistant-composer').appendChild(menuEl);
            toolsMenu = menuEl;
            toolsButton.setAttribute('aria-expanded', 'true');
        }

        /**
         * The line beside the `+` button.
         *
         * Two jobs, and they never both apply. Normally it teaches the syntax —
         * `@` is not discoverable, and a placeholder that explains it is a
         * placeholder nobody reads twice. When a tool has been switched off it
         * says so instead, because a preference that changes what the assistant
         * may do must be visible from where the question is typed rather than
         * only inside the menu that set it.
         */
        async function paintToolHint() {
            if (!toolHint) return;
            const opts = await loadOptions();
            const prefs = window.ChatStore.toolPreferences();
            const off = ['docs', 'sql']
                .filter((k) => (opts.tools || []).some((t) => t.alias === k) && prefs[k] === false);

            toolHint.replaceChildren();
            if (off.length) {
                toolHint.appendChild(el('i', 'fa-solid fa-toggle-off'));
                toolHint.appendChild(el('span', null,
                    `${off.map((k) => TOOL_LABEL[k]).join(', ')} off`));
                return;
            }
            const at = el('kbd', null, '@');
            const enter = el('kbd', null, '↵');
            toolHint.appendChild(at);
            toolHint.appendChild(el('span', null, 'to tag'));
            toolHint.appendChild(el('span', null, '·'));
            toolHint.appendChild(enter);
            toolHint.appendChild(el('span', null, 'to send'));
        }

        // ---- wiring ----

        input.addEventListener('input', () => { refresh(); paintChips(); });
        input.addEventListener('click', refresh);
        input.addEventListener('blur', () => setTimeout(closeMenu, 120));
        input.addEventListener('keydown', (e) => {
            if (menu.hidden) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
            else if ((e.key === 'Enter' || e.key === 'Tab') && cursor >= 0 && items[cursor]) {
                // Enter completes the tag rather than sending the message. A
                // message sent by accident mid-tag is one the user has to
                // retype; this is the one place Enter must not send.
                e.preventDefault();
                e.stopPropagation();
                choose(cursor);
            }
        }, true);

        if (toolsButton) toolsButton.addEventListener('click', toggleTools);
        document.addEventListener('click', (e) => {
            // `contains`, not `!==`. The button holds an <i>, so the click that
            // opened this menu reports the icon as its target and an identity
            // check would close the menu on the very click that opened it.
            if (toolsMenu && !toolsMenu.contains(e.target) && !toolsButton.contains(e.target)) {
                closeTools();
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && toolsMenu) {
                closeTools();
                toolsButton.focus();
            }
        });

        paintToolHint();
        paintChips();

        return {
            /** True while the dropdown owns the keyboard. */
            get isOpen() { return !menu.hidden; },
            refresh,
            paintChips,
            close: closeMenu,
            labelFor: (category, value) => labels.get(`${category}:${value}`) || value
        };
    }

    window.ChatTags = { attach, parse, renderChips, CATEGORY_LABEL };
})();
