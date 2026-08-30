/**
 * Filling the General tab from what is stored.
 *
 * It used to fetch the workflow list here too, on every settings page load,
 * whether or not the ROI tab was ever opened — a row per workflow, rendered
 * into a panel nobody was looking at. That list moved to the ROI page with the
 * settings it belongs to, so this fetches one small object and stops.
 */
;(async () => {
    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    };

    try {
        const res = await window.fetchWithAuth('/api/settings');
        if (!res.ok) return;

        window.globalSettings = await res.json();

        if (window.globalSettings.timezone) set('timezoneSelect', window.globalSettings.timezone);
        // Defaulted in the markup rather than here would put the default in two
        // places; this is the one that knows what is stored.
        set('currencySelect', window.globalSettings.currency || 'EUR');
        set('concurrencyLimitInput', window.globalSettings.concurrency_limit || '');
    } catch (err) {
        console.error('Failed to load global settings', err);
    }
})();
