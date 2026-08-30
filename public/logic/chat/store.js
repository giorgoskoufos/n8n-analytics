/**
 * The little that has to survive a page load.
 *
 * This is a multi-page application: every link is a full document, so the panel
 * is destroyed and rebuilt six times in a normal session. Three different things
 * have to come back, and they come back from three different places — which is
 * the point of this file, because putting them all in one place is how a draft
 * ends up on the server or a conversation ends up trapped in one browser.
 *
 *   the conversation   from the SERVER, `GET /api/chat-history`. It is the
 *                      authoritative copy, it is per user rather than per
 *                      browser, and it already existed.
 *   an answer in flight from the SERVER too, `GET /api/ai-chat/turns` — see
 *                      src/ai/turns.js. The id is kept here only to know which
 *                      one to reattach to first.
 *   how the panel sat  from HERE. Open or shut, how big, what was half-typed.
 *                      None of it belongs to anyone but this browser, and none
 *                      of it is worth a request.
 *
 * `sessionStorage` rather than `localStorage` for the open/closed state: a panel
 * that reopens itself in a tab you opened tomorrow morning is a panel that has
 * decided something on your behalf. Size and tool preferences are `localStorage`
 * — those are settings, and settings should stick.
 */

(function () {
    'use strict';

    const SESSION_KEY = 'assistant:session';
    const PREFS_KEY = 'assistant:prefs';

    /**
     * Storage that cannot throw.
     *
     * Private windows, storage-blocked browsers and a full quota all raise on
     * access rather than returning null, and none of them is a reason for the
     * assistant not to work — it just forgets things between pages.
     */
    function read(area, key, fallback) {
        try {
            const raw = window[area].getItem(key);
            return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
        } catch (ignored) {
            return { ...fallback };
        }
    }

    function write(area, key, value) {
        try {
            window[area].setItem(key, JSON.stringify(value));
        } catch (ignored) { /* nothing here is worth an error */ }
    }

    const SESSION_DEFAULTS = { open: false, draft: '', turnId: null, unread: false };
    const PREFS_DEFAULTS = { width: null, height: null, tools: { docs: true, sql: true } };

    let session = read('sessionStorage', SESSION_KEY, SESSION_DEFAULTS);
    let prefs = read('localStorage', PREFS_KEY, PREFS_DEFAULTS);

    const store = {
        get session() { return session; },
        get prefs() { return prefs; },

        patchSession(patch) {
            session = { ...session, ...patch };
            write('sessionStorage', SESSION_KEY, session);
            return session;
        },

        patchPrefs(patch) {
            prefs = { ...prefs, ...patch };
            write('localStorage', PREFS_KEY, prefs);
            return prefs;
        },

        /**
         * Which tools the `+` menu has switched off.
         *
         * Sent as a preference, never as an authorisation: the server decides
         * what exists — `docs` needs this user to have connected it — and this
         * can only ever narrow that. See the note in aiController.prepare.
         */
        toolPreferences() {
            return { docs: prefs.tools.docs !== false, sql: prefs.tools.sql !== false };
        }
    };

    window.ChatStore = store;
})();
