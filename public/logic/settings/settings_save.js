/**
 * Saving the General tab.
 *
 * ── Two things that changed here ─────────────────────────────────────────
 *
 * The ROI save left with the ROI tab; it lives in logic/roi/roi_config.js now,
 * next to the inputs it writes.
 *
 * And the failure path stopped being `alert()`. This endpoint is owner/admin
 * only, so the most likely failure is a permission one with a sentence attached
 * — and a modal dialog is the wrong shape for it: it interrupts, it cannot be
 * re-read after it is dismissed, and it is the one piece of UI on the page that
 * does not look like the page. The message goes in the form's own status line,
 * beside the button that produced it, where it stays until the next attempt.
 */
;(() => {
    const btn = document.getElementById('savePrefsBtn');
    if (!btn) return;

    const msg = document.getElementById('prefsMsg');
    const say = (text, tone) => {
        if (!msg) return;
        msg.textContent = text;
        msg.style.color = tone === 'bad' ? 'var(--critical-ink)'
            : tone === 'good' ? 'var(--good-ink)' : 'var(--ink-3)';
    };

    const LABEL = '<i class="fa-solid fa-check"></i> Save preferences';

    btn.addEventListener('click', async () => {
        const value = (id) => {
            const el = document.getElementById(id);
            return el ? String(el.value).trim() : null;
        };

        // One request per key, because the endpoint validates one key per call —
        // an allowlist that took a whole object would have to decide what to do
        // with a payload that is half valid, and every answer to that is worse
        // than not accepting it.
        const prefs = [
            { key: 'timezone', value: value('timezoneSelect') },
            { key: 'currency', value: value('currencySelect') },
            { key: 'concurrency_limit', value: value('concurrencyLimitInput') }
        ].filter((p) => p.value !== null);

        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
        say('');

        try {
            for (const pref of prefs) {
                const res = await window.fetchWithAuth('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(pref)
                });
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.error || `Could not save ${pref.key}.`);
                }
                // Kept in step so anything rendering money or a timestamp after
                // this uses what was just saved rather than what was loaded.
                if (window.userSettings) window.userSettings[pref.key] = pref.value;
            }

            btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved';
            say('Applies to how figures are displayed from here on.', 'good');
            setTimeout(() => { btn.innerHTML = LABEL; }, 2000);
        } catch (err) {
            console.error(err);
            say(err.message, 'bad');
            btn.innerHTML = LABEL;
        } finally {
            btn.disabled = false;
        }
    });
})();
