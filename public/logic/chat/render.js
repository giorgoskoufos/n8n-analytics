/**
 * Turning an answer into something readable, without turning it into a hole.
 *
 * ── What was wrong with the old renderer ─────────────────────────────────
 *
 * `renderMarkdownSafely` in global_functions.js sanitized with
 * `ALLOWED_ATTR: []` and forbade `a` and `img`. That is the right default for
 * untrusted markdown, and it makes three things impossible here:
 *
 *   · No attribute survives, so no `class` survives, so a highlighter's output —
 *     which is nothing BUT `<span class="hljs-keyword">` — collapses back to
 *     plain text. Syntax colouring is not a styling choice on top of that
 *     sanitizer; it is unreachable through it.
 *   · No links, and the documentation tool answers with links to docs.n8n.io.
 *     They were being deleted silently, taking the reference with them.
 *   · No images, same.
 *
 * So this widens the policy — deliberately, and only where it has to.
 *
 * ── The three loosenings, and what keeps each honest ─────────────────────
 *
 * `class` is allowed, but only values on a PREFIX allow-list. This is the one
 * that would be dangerous to wave through: Tailwind is loaded on every page, so
 * an unrestricted `class` lets an answer write `class="fixed inset-0 z-50"` and
 * cover the application with a surface of its own making. Which classes an
 * answer may use is therefore a closed set — the highlighter's, and this file's.
 *
 * `href` is allowed for `https:` only. Not `http:`, not `mailto:`, and above all
 * not `javascript:` — DOMPurify blocks that anyway, but the allow-list is what
 * this file states rather than what a dependency happens to do. Every link is
 * given `rel="noopener noreferrer nofollow"` and opened in a new tab, because
 * the alternative is navigating away from an unfinished conversation.
 *
 * `src` is allowed for one origin, docs.n8n.io, matching the CSP. An image from
 * an arbitrary host is a beacon that reports the reader's address to whoever
 * wrote the markdown — and the markdown is written by a model that has just read
 * pages we do not control. An image that fails the check leaves its alt text
 * behind rather than vanishing, so a missing figure is visible as a missing
 * figure.
 *
 * ── Highlighting is deferred, twice ──────────────────────────────────────
 *
 * The highlighter is 127 kB and most sessions never see a code block, so it is
 * fetched on the first one rather than on page load. And it does not run during
 * streaming: half-written code lexes as different code, so a block would recolour
 * itself several times a second while it arrived. It runs once, when the answer
 * is complete.
 */

(function () {
    'use strict';

    // The only classes an answer is allowed to carry. `hljs-*` is the
    // highlighter's own namespace, `md-*` is this file's, and `language-*` is
    // what marked puts on a fenced block to say what it is.
    //
    // That third one is not decoration and leaving it out is not a safe default:
    // it is how the fence's own label survives sanitising, and without it every
    // block arrives here indistinguishable from plain text — labelled TEXT,
    // highlighted as nothing. It carries no capability; the value is read, never
    // executed, and only ever matched against grammars the highlighter has.
    const CLASS_ALLOWED = /^(hljs|md|language)(-[a-z0-9_+#]+)*$/i;
    const IMAGE_ORIGIN = 'https://docs.n8n.io';

    const HLJS_SRC = '/vendor/highlight.js';
    let hljsPromise = null;

    /**
     * Fetches the highlighter once, on demand.
     *
     * Resolves to null rather than rejecting when it cannot be had: an answer
     * with unhighlighted code is a fine answer, and a chat that refuses to
     * render because a colouring library is missing is not.
     */
    function loadHighlighter() {
        if (window.hljs) return Promise.resolve(window.hljs);
        if (hljsPromise) return hljsPromise;

        hljsPromise = new Promise((resolve) => {
            const el = document.createElement('script');
            el.src = HLJS_SRC;
            el.onload = () => resolve(window.hljs || null);
            el.onerror = () => {
                console.warn('[CHAT] the highlighter could not be loaded; code stays plain.');
                resolve(null);
            };
            document.head.appendChild(el);
        });
        return hljsPromise;
    }

    // ---------------------------------------------------------------- sanitise

    let hooked = false;

    /**
     * Installs the attribute rules DOMPurify cannot express as a config.
     *
     * `afterSanitizeAttributes` runs on every element of every render, including
     * the ones this application renders elsewhere — so each rule checks the node
     * it is looking at rather than assuming it came from here.
     */
    function installHooks() {
        if (hooked || typeof DOMPurify === 'undefined') return;
        hooked = true;

        DOMPurify.addHook('afterSanitizeAttributes', (node) => {
            if (node.hasAttribute && node.hasAttribute('class')) {
                const kept = String(node.getAttribute('class'))
                    .split(/\s+/)
                    .filter((c) => CLASS_ALLOWED.test(c));
                if (kept.length) node.setAttribute('class', kept.join(' '));
                else node.removeAttribute('class');
            }

            if (node.tagName === 'A' && node.hasAttribute('href')) {
                // Opened in a new tab so the conversation is not lost, and
                // `noopener` because the opened page must not get a handle on
                // this one — this page holds an auth token.
                node.setAttribute('target', '_blank');
                node.setAttribute('rel', 'noopener noreferrer nofollow');
            }

            if (node.tagName === 'IMG') {
                const src = node.getAttribute('src') || '';
                if (src.indexOf(IMAGE_ORIGIN + '/') !== 0) {
                    // Replaced rather than removed: a figure that disappears
                    // leaves a sentence referring to something that is not there.
                    const alt = node.getAttribute('alt') || 'image';
                    const note = document.createElement('span');
                    note.setAttribute('class', 'md-dropped-image');
                    note.textContent = alt;
                    if (node.parentNode) node.parentNode.replaceChild(note, node);
                    return;
                }
                node.setAttribute('loading', 'lazy');
                if (!node.getAttribute('alt')) node.setAttribute('alt', '');
            }
        });
    }

    const PURIFY_CONFIG = {
        ALLOWED_TAGS: [
            'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
            'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'span', 'a', 'img'
        ],
        ALLOWED_ATTR: ['class', 'href', 'title', 'alt', 'src', 'target', 'rel'],
        // Stated here rather than left to the default, so the policy is readable
        // in the file that depends on it.
        ALLOWED_URI_REGEXP: /^https:\/\//i,
        FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input', 'object', 'embed'],
        FORBID_ATTR: ['style', 'srcset', 'onerror', 'onload', 'onclick']
    };

    /**
     * Markdown in, safe HTML out.
     *
     * Falls back to escaped plain text when either library is missing, which is
     * the same decision the older renderer made and the right one: an answer
     * shown as source is readable, and an answer shown as unsanitised markup is
     * an XSS in a page holding a token.
     */
    function toSafeHtml(markdown) {
        if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
            console.warn('[CHAT] marked or DOMPurify unavailable — rendering as plain text.');
            return window.escapeHtml(markdown || '');
        }
        installHooks();
        return DOMPurify.sanitize(
            marked.parse(String(markdown || ''), { breaks: true, gfm: true }),
            PURIFY_CONFIG
        );
    }

    // ------------------------------------------------------------ code blocks

    /** The label shown on a block, and the grammar to colour it with. */
    function languageOf(codeEl) {
        const cls = String(codeEl.getAttribute('class') || '');
        const found = cls.match(/(?:language|lang)-([a-z0-9+#]+)/i);
        return found ? found[1].toLowerCase() : null;
    }

    function copyButton(getText) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'code-copy';
        btn.textContent = 'Copy';
        // An accessible name that says WHAT is copied, because a screen reader
        // meeting six buttons called "Copy" learns nothing from any of them.
        btn.setAttribute('aria-label', 'Copy this code block');
        btn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(getText());
                btn.textContent = 'Copied';
                btn.classList.add('is-done');
            } catch (err) {
                btn.textContent = 'Press ⌘C';
                console.warn('[CHAT] clipboard refused:', err);
            }
            setTimeout(() => {
                btn.textContent = 'Copy';
                btn.classList.remove('is-done');
            }, 1600);
        });
        return btn;
    }

    /**
     * Gives every `<pre><code>` a header: what language it is, and a way to take
     * it away with you.
     *
     * Wrapped rather than styled in place, because the label and the button have
     * to sit outside the element that scrolls sideways — a header inside the
     * scroller slides off with the code.
     */
    function decorateCode(container) {
        const blocks = container.querySelectorAll('pre > code');
        const pending = [];

        blocks.forEach((code) => {
            const pre = code.parentElement;
            if (!pre || pre.parentElement.classList.contains('code-block')) return;

            const lang = languageOf(code);
            const wrap = document.createElement('div');
            wrap.className = 'code-block';

            const head = document.createElement('div');
            head.className = 'code-head';
            const label = document.createElement('span');
            label.className = 'code-lang';
            label.textContent = lang || 'text';
            head.appendChild(label);
            head.appendChild(copyButton(() => code.textContent));

            pre.parentElement.insertBefore(wrap, pre);
            wrap.appendChild(head);
            wrap.appendChild(pre);
            pending.push({ code, lang });
        });

        return pending;
    }

    /**
     * Colours the blocks that were just laid out.
     *
     * Only ever called on a finished answer. `highlight()` is used rather than
     * `highlightElement()` because the latter reads and rewrites the element's
     * class list, and this element's class list is governed by the allow-list
     * above — it would put back exactly what the sanitizer was told to remove.
     */
    async function highlight(blocks) {
        if (!blocks.length) return;
        const hljs = await loadHighlighter();
        if (!hljs) return;

        for (const { code, lang } of blocks) {
            const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
            try {
                code.innerHTML = hljs.highlight(code.textContent, { language }).value;
                code.classList.add('hljs');
            } catch (err) {
                // A grammar that throws on odd input leaves the block plain,
                // which is what it already was.
                console.warn('[CHAT] highlight failed:', err);
            }
        }
    }

    // ---------------------------------------------------------------- tables

    // "3,776", "3.1%", "1.4s", "−12", "$40.50", "1 234". What a person reads as
    // a number, rather than what `Number()` happens to parse — `Number('')` is 0
    // and `Number('12 executions')` is NaN, and both of those are wrong here.
    const NUMERIC = /^[−+-]?[$€£]?\d[\d.,\s]*\s*(%|ms|s|m|h|d|kb|mb|gb|tb)?$/i;

    /**
     * Right-aligns the columns that are numbers all the way down.
     *
     * The dashboard's own tables do this, and the reason is that it is what
     * makes a column comparable: aligned digits let an eye run down and find the
     * outlier, ragged ones do not. Decided per COLUMN rather than per cell,
     * because a single stray "n/a" must not un-align the eleven numbers above
     * it — and a column with two numbers and nine words is a text column that
     * happens to contain numbers.
     */
    function alignNumericColumns(table) {
        const rows = [...table.querySelectorAll('tbody tr')];
        if (rows.length === 0) return;
        const headers = [...table.querySelectorAll('thead th')];
        const columns = Math.max(headers.length, ...rows.map((r) => r.cells.length));

        for (let c = 0; c < columns; c++) {
            let numeric = 0;
            let filled = 0;
            for (const row of rows) {
                const cell = row.cells[c];
                if (!cell) continue;
                const text = cell.textContent.trim();
                if (!text || text === '—' || text === '-') continue;
                filled++;
                if (NUMERIC.test(text)) numeric++;
            }
            // Every filled cell, and at least two of them. One number is not a
            // column of numbers.
            if (filled < 2 || numeric !== filled) continue;

            if (headers[c]) headers[c].classList.add('md-num');
            for (const row of rows) {
                if (row.cells[c]) row.cells[c].classList.add('md-num');
            }
        }
    }

    function decorateTables(container) {
        container.querySelectorAll('table').forEach(alignNumericColumns);
    }

    // ------------------------------------------------------------------- API

    /**
     * Writes an answer into an element.
     *
     * @param {HTMLElement} target
     * @param {string}      markdown
     * @param {object}      [opts]
     * @param {boolean}     [opts.final]  true once nothing more is coming, which
     *                                    is the only time it is worth colouring
     */
    function renderInto(target, markdown, opts = {}) {
        target.innerHTML = toSafeHtml(markdown);
        const blocks = decorateCode(target);
        // Alignment is cheap and reads the finished cells, so it runs on every
        // pass — a table that is half-streamed still aligns what it has.
        decorateTables(target);
        if (opts.final) highlight(blocks);
    }

    window.ChatRender = { renderInto, toSafeHtml, loadHighlighter };
})();
