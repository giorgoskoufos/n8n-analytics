// settings_render.js
window.renderWorkflows = function() {
    const container = document.getElementById('settingsContainer');
    const searchInput = document.getElementById('workflowSearch');
    const sortSelect = document.getElementById('workflowSort');
    
    if (!container) return;
    const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
    const sortMode = sortSelect ? sortSelect.value : 'name_asc';
    
    // Filter
    let filtered = window.allWorkflows.filter(wf => 
        wf.name.toLowerCase().includes(searchTerm) || 
        wf.id.toLowerCase().includes(searchTerm)
    );

    // Sort
    filtered.sort((a, b) => {
        if (sortMode === 'name_asc') {
            return a.name.localeCompare(b.name);
        } else if (sortMode === 'name_desc') {
            return b.name.localeCompare(a.name);
        } else if (sortMode === 'execs_desc') {
            const countA = parseInt(a.execution_count) || 0;
            const countB = parseInt(b.execution_count) || 0;
            return countB - countA;
        } else if (sortMode === 'time_desc') {
            const timeA = parseInt(a.saved_time_seconds) || 0;
            const timeB = parseInt(b.saved_time_seconds) || 0;
            return timeB - timeA;
        }
        return 0;
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div class="text-center py-8 text-ink-3 text-sm border border-dashed border-line-2 rounded-lg">No workflows match your search.</div>';
        return;
    }

    container.innerHTML = filtered.map(wf => `
        <div class="flex flex-col p-3 border border-line rounded-lg hover:bg-gray-800/50 transition-colors settings-row bg-n8n-card/30" data-id="${wf.id}">
            <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div class="truncate pr-4 flex-1 w-full">
                    <h3 class="text-sm font-semibold text-ink-1 truncate" title="${window.escapeHtml(wf.name)}">${window.escapeHtml(wf.name)}</h3>
                    <div class="flex gap-4 mt-1">
                        <p class="text-xs text-ink-3 font-mono">ID: ${window.escapeHtml(wf.id)}</p>
                        ${wf.execution_count ? `<p class="text-xs text-indigo-400/80"><i class="fa-solid fa-bolt mr-1"></i>${parseInt(wf.execution_count).toLocaleString()} execs</p>` : ''}
                    </div>
                </div>
                
                <div class="flex flex-wrap sm:flex-nowrap items-center gap-3 sm:gap-4 flex-shrink-0 w-full sm:w-auto mt-2 sm:mt-0 justify-between sm:justify-end">
                    <button class="text-xs text-ink-2 hover:text-indigo-400 underline wizard-toggle bg-transparent border-none cursor-pointer text-left focus:outline-none">
                        Wizard Calculator
                    </button>
                    
                    <div class="flex items-center gap-1 bg-black/20 p-1.5 rounded border border-line">
                        <span class="text-xs text-ink-3 ml-1">Wage/hr: $</span>
                        <input type="number" min="0" value="${wf.hourly_rate || 0}" class="w-16 bg-[#171717] border border-line-2 rounded p-1 text-sm text-white focus:border-indigo-500 focus:outline-none text-right hourly-rate-input shadow-inner transition-colors">
                    </div>

                    <div class="flex items-center gap-1 bg-black/20 p-1.5 rounded border border-line">
                        <span class="text-xs text-ink-3 ml-1">Time Saved/Exec:</span>
                        <input type="number" min="0" value="${wf.saved_time_seconds}" class="w-20 bg-[#171717] border border-line-2 rounded p-1 text-sm text-white focus:border-indigo-500 focus:outline-none text-right saved-time-input shadow-inner transition-colors">
                        <span class="text-xs text-ink-3 mr-1">s</span>
                    </div>
                </div>
            </div>

            <!-- Expandable Wizard -->
            <div class="wizard-container hidden mt-4 pt-3 border-t border-line/60 bg-black/20 rounded-md p-4 shadow-inner">
                <p class="text-xs text-ink-2 mb-3"><i class="fa-solid fa-wand-magic-sparkles mr-1 text-indigo-400"></i> Calculate exact machine seconds based on your human labor baseline.</p>
                <div class="flex flex-wrap items-end gap-3 text-sm">
                    <!-- Frequency -->
                    <div>
                        <label class="block text-[10px] text-ink-3 mb-1 uppercase tracking-wider">Manual Freq</label>
                        <input type="number" min="1" value="5" class="w-20 bg-[#171717] border border-line-2 rounded p-2 text-white focus:outline-none focus:border-indigo-500 wiz-freq">
                    </div>
                    <div>
                        <label class="block text-[10px] text-ink-3 mb-1 uppercase tracking-wider">Per</label>
                        <select class="bg-[#171717] border border-line-2 rounded p-2 text-white focus:outline-none cursor-pointer wiz-per">
                            <option value="day">Day</option>
                            <option value="week" selected>Week</option>
                            <option value="month">Month</option>
                        </select>
                    </div>
                    
                    <!-- Duration -->
                    <div class="ml-0 sm:ml-2">
                        <label class="block text-[10px] text-ink-3 mb-1 uppercase tracking-wider">Manual Duration</label>
                        <input type="number" min="1" value="3" class="w-20 bg-[#171717] border border-line-2 rounded p-2 text-white focus:outline-none focus:border-indigo-500 wiz-dur">
                    </div>
                    <div>
                        <label class="block text-[10px] text-ink-3 mb-1 uppercase tracking-wider">Unit</label>
                        <select class="bg-[#171717] border border-line-2 rounded p-2 text-white focus:outline-none cursor-pointer wiz-unit">
                            <option value="minutes">Minutes</option>
                            <option value="hours" selected>Hours</option>
                        </select>
                    </div>
                    
                    <!-- Referene -->
                    <div class="ml-0 sm:ml-4 flex flex-col justify-center bg-indigo-900/20 px-4 py-1.5 rounded border border-indigo-500/20 h-[38px]">
                        <span class="text-[10px] text-indigo-400 uppercase tracking-widest leading-none">n8n Executions (30d)</span>
                        <span class="text-white font-bold leading-tight wiz-execs">${wf.executions_30d || 1}</span>
                    </div>
                    
                    <button class="ml-auto w-full sm:w-auto bg-gray-700 hover:bg-indigo-600 text-white font-semibold py-2 px-4 rounded transition-colors text-xs wiz-apply mt-2 sm:mt-0 shadow-md">
                        Apply Calculated Value
                    </button>
                </div>
            </div>
        </div>
    `).join('');

    // Re-attach listeners
    document.querySelectorAll('.saved-time-input').forEach(input => {
        input.addEventListener('input', (e) => {
            const id = e.target.closest('.settings-row').getAttribute('data-id');
            const wf = window.allWorkflows.find(w => w.id === id);
            if (wf) wf.saved_time_seconds = parseInt(e.target.value) || 0;
        });
    });

    document.querySelectorAll('.hourly-rate-input').forEach(input => {
        input.addEventListener('input', (e) => {
            const id = e.target.closest('.settings-row').getAttribute('data-id');
            const wf = window.allWorkflows.find(w => w.id === id);
            if (wf) wf.hourly_rate = parseFloat(e.target.value) || 0;
        });
    });

    document.querySelectorAll('.wizard-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const rowContainer = e.target.closest('.settings-row').querySelector('.wizard-container');
            rowContainer.classList.toggle('hidden');
        });
    });

    document.querySelectorAll('.wiz-apply').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const row = e.target.closest('.settings-row');
            const freq = parseInt(row.querySelector('.wiz-freq').value) || 0;
            const per = row.querySelector('.wiz-per').value;
            const dur = parseInt(row.querySelector('.wiz-dur').value) || 0;
            const unit = row.querySelector('.wiz-unit').value;
            const execs = parseInt(row.querySelector('.wiz-execs').innerText.replace(/,/g, '')) || 1;
            
            let multiplier = 1;
            if (per === 'day') multiplier = 30;
            if (per === 'week') multiplier = 30 / 7;
            
            const monthlyFreq = freq * multiplier;
            const unitSeconds = unit === 'hours' ? 3600 : 60;
            const totalHumanSeconds30d = monthlyFreq * dur * unitSeconds;
            
            const calculatedSeconds = Math.round(totalHumanSeconds30d / Math.max(1, execs));
            
            const timeInput = row.querySelector('.saved-time-input');
            timeInput.value = calculatedSeconds;
            
            const id = row.getAttribute('data-id');
            const wf = window.allWorkflows.find(w => w.id === id);
            if (wf) wf.saved_time_seconds = calculatedSeconds;
            
            timeInput.classList.add('bg-green-900/40', 'border-green-500');
            setTimeout(() => {
                timeInput.classList.remove('bg-green-900/40', 'border-green-500');
            }, 800);
        });
    });

};
;
(() => {
    const searchInput = document.getElementById('workflowSearch');
    const sortSelect = document.getElementById('workflowSort');
    searchInput?.addEventListener('input', window.renderWorkflows);
    sortSelect?.addEventListener('change', window.renderWorkflows);
})();
