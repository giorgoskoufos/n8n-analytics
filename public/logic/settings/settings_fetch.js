// settings_fetch.js
;(async () => {
    // Fetch Global Settings
    try {
        const res = await window.fetchWithAuth('/api/settings');
        if (res.ok) {
            window.globalSettings = await res.json();
            if (window.globalSettings.timezone) {
                document.getElementById('timezoneSelect').value = window.globalSettings.timezone;
            }
            const limitEl = document.getElementById('concurrencyLimitInput');
            if (limitEl) limitEl.value = window.globalSettings.concurrency_limit || '';
        }
    } catch (err) { console.error("Failed to load global settings", err); }

    // Fetch Settings
    const container = document.getElementById('settingsContainer');
    try {
        const response = await window.fetchWithAuth('/api/settings/roi');
        if (!response.ok) throw new Error("Failed to fetch settings");
        
        window.allWorkflows = await response.json();
        
        if (window.allWorkflows.length === 0) {
            container.innerHTML = '<div class="text-center py-8 text-ink-3 text-sm">No workflows found. Run a sync first.</div>';
            return;
        }

        window.renderWorkflows();
    } catch (err) {
        console.error(err);
        container.innerHTML = '<div class="text-center py-8 text-red-500 text-sm">Failed to load workflows.</div>';
    }
})();
