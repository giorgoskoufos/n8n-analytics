/**
 * global-header.js
 * Injects the global header across all dashboard pages.
 */

async function initGlobalHeader() {
    const isPages = window.location.pathname.includes('/pages/');
    const basePath = isPages ? '../' : '';
    
    try {
        const response = await fetch(basePath + 'global-header.html');
        if (!response.ok) throw new Error('Failed to load header template');
        const html = await response.text();
        
        const headerTarget = document.getElementById('header-target');
        if (!headerTarget) {
            console.warn("[HEADER] No #header-target element found.");
            return;
        }

        // 1. Create temporary container to parse HTML
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        
        // 2. Extract and inject Overlay at the start of body
        const overlay = tempDiv.querySelector('#burgerOverlay');
        if (overlay) {
            document.body.prepend(overlay);
        }
        
        // 3. Inject the rest of the header into the target
        headerTarget.innerHTML = tempDiv.innerHTML;

        // 4. Update Dynamic Content
        const pageTitle = headerTarget.getAttribute('data-title');
        const pageSubtitle = headerTarget.getAttribute('data-subtitle');
        
        if (pageTitle) document.getElementById('headerTitle').textContent = pageTitle;
        if (pageSubtitle) document.getElementById('headerSubtitle').textContent = pageSubtitle;
        
        // 5. Fix Paths (Logo and Menu)
        const logo = document.getElementById('headerLogo');
        if (logo) {
            logo.src = '/assets/n8n_db.svg';
        }
        
        fixMenuPaths(isPages);
        
        // 6. Attach Listeners and Health Check
        setupMenuLogic();
        checkN8nHealth();
        checkSyncLag();
        
        console.log("[HEADER] Global header initialized successfully");
        
    } catch (err) {
        console.error('[HEADER] Error:', err);
    }
}

function fixMenuPaths(isPages) {
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
    
    for (const [id, path] of Object.entries(links)) {
        const el = document.getElementById(id);
        if (el) {
            el.setAttribute('href', path);
            const currentPath = window.location.pathname;
            if (currentPath.endsWith(path.split('/').pop())) {
                 el.classList.remove('text-gray-300');
                 el.classList.add('text-white', 'bg-gray-800');
            }
        }
    }
}

function setupMenuLogic() {
    const burgerBtn = document.getElementById('burgerBtn');
    const burgerMenu = document.getElementById('burgerMenu');
    const burgerOverlay = document.getElementById('burgerOverlay');
    
    if (!burgerBtn || !burgerMenu || !burgerOverlay) return;

    function toggleMenu(show) {
        if (show) {
            burgerMenu.classList.remove('hidden');
            burgerMenu.classList.add('flex');
            burgerOverlay.classList.remove('hidden');
            setTimeout(() => burgerOverlay.classList.add('opacity-100'), 10);
        } else {
            burgerMenu.classList.add('hidden');
            burgerMenu.classList.remove('flex');
            burgerOverlay.classList.remove('opacity-100');
            setTimeout(() => burgerOverlay.classList.add('hidden'), 300);
        }
    }

    burgerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMenu(burgerMenu.classList.contains('hidden'));
    });

    document.addEventListener('click', (e) => {
        if (!burgerBtn.contains(e.target) && !burgerMenu.contains(e.target)) {
            toggleMenu(false);
        }
    });

    burgerOverlay.addEventListener('click', () => toggleMenu(false));
}

async function checkN8nHealth() {
    const healthContainer = document.getElementById('n8nHealthIndicator');
    if (!healthContainer) return;
    try {
        if (typeof window.fetchWithAuth !== 'function') return;
        const res = await window.fetchWithAuth('/api/n8n-health');
        if (res.ok) {
            const data = await res.json();
            if (data.status === 'ok') {
                healthContainer.innerHTML = `<span class="flex h-2 w-2 relative mr-2">
  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
  <span class="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
</span> <span class="text-[10px] text-green-400 font-bold tracking-widest uppercase">n8n Online</span>`;
                return;
            }
        }
        throw new Error();
    } catch (e) {
        healthContainer.innerHTML = `<span class="flex h-2 w-2 relative mr-2"><span class="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span></span> <span class="text-[10px] text-red-500 font-bold tracking-widest uppercase">n8n Offline</span>`;
    }
}

/**
 * F-19 · How old is what you are looking at.
 *
 * Two separate ages, and they answer different questions: how long since the
 * ETL last finished a pass, and how old the newest execution in the replica is.
 * The pill shows the first, because that is the one that means "this page may be
 * wrong"; the tooltip carries both, because a healthy pipeline over a quiet n8n
 * looks identical from the outside and is not a problem to fix.
 *
 * Uses ?brief=1 — the full health payload counts half a million rows, and this
 * runs on every page load of every page.
 */
async function checkSyncLag() {
    const pill = document.getElementById('syncLagIndicator');
    const text = document.getElementById('syncLagText');
    if (!pill || !text) return;

    const ago = (ms) => {
        if (ms === null || ms === undefined) return 'unknown';
        const s = Math.round(ms / 1000);
        if (s < 60) return `${s}s`;
        if (s < 3600) return `${Math.round(s / 60)}m`;
        if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
        return `${(s / 86400).toFixed(1)}d`;
    };

    const paint = (tone, icon, label, title) => {
        pill.className = 'hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full ' +
            `bg-white/5 border text-[10px] uppercase tracking-widest font-bold ${tone}`;
        pill.title = title;
        pill.innerHTML = `<i class="fa-solid ${icon}"></i><span id="syncLagText">${label}</span>`;
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

        if (d.pipeline.status === 'stalled') {
            paint('border-rose-500/40 text-rose-300', 'fa-triangle-exclamation',
                `Sync stalled · ${since}`, detail);
        } else if (d.pipeline.status === 'late') {
            paint('border-amber-500/40 text-amber-300', 'fa-hourglass-half',
                `Sync late · ${since}`, detail);
        } else if (d.pipeline.status === 'unknown') {
            paint('border-white/10 text-gray-500', 'fa-circle-question', 'Never synced',
                'No ETL pass has been recorded yet.');
        } else {
            paint('border-white/10 text-gray-400', 'fa-rotate', `Synced ${since} ago`, detail);
        }
    } catch (e) {
        // A header widget must not be the loudest thing on a page it failed to
        // describe. It says it does not know, and says nothing else.
        paint('border-white/10 text-gray-600', 'fa-circle-question', 'Sync unknown',
            'Could not read the dashboard health endpoint.');
    }
}

document.addEventListener('DOMContentLoaded', initGlobalHeader);

// The page can sit open for hours. A "synced 2m ago" that was true when the tab
// was opened this morning is worse than no indicator at all.
setInterval(checkSyncLag, 60000);
