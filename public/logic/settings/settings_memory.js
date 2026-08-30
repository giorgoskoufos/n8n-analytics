/**
 * What the assistant remembers about you, and how to make it stop.
 *
 * This page is not a convenience on top of the memory feature — it is the
 * condition on the feature existing. A note kept about somebody that they cannot
 * read or delete is not memory, it is a file, and the difference is entirely
 * whether this list is here.
 *
 * So it shows every memory verbatim, in the words that go into the prompt rather
 * than a paraphrase, with the date it was learned. Nothing is summarised and
 * nothing is hidden behind a count.
 *
 * Writing is deliberately absent. A memory only ever comes from the `remember`
 * tool, inside a conversation, where it appears in that answer's steps — so
 * every one of these has a moment the reader was present for. A text box here
 * would create memories with no such moment, and the honest thing to do with
 * something you want the assistant to know is to tell it.
 */

(function () {
    'use strict';

    const esc = (v) => window.escapeHtml(v);

    function when(iso) {
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) return '';
        const days = Math.round((Date.now() - t) / 86400000);
        if (days < 1) return 'today';
        if (days === 1) return 'yesterday';
        if (days < 30) return `${days} days ago`;
        return new Date(t).toISOString().slice(0, 10);
    }

    async function render() {
        const list = document.getElementById('memoryList');
        const count = document.getElementById('memoryCount');
        const forgetAll = document.getElementById('memoryForgetAll');
        const pill = document.getElementById('memoryPill');
        if (!list) return;

        let body;
        try {
            const res = await window.fetchWithAuth('/api/ai-memories');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            body = await res.json();
        } catch (err) {
            console.warn('[SETTINGS] could not read memories:', err);
            list.innerHTML = '<p class="text-xs" style="color:var(--critical-ink)">' +
                'Could not read your memories.</p>';
            return;
        }

        const memories = body.memories || [];
        if (pill) {
            pill.textContent = String(memories.length);
            pill.className = `badge ml-2 ${memories.length ? 'badge-neutral' : 'badge-neutral'}`;
        }
        if (count) {
            count.textContent = memories.length
                ? `${memories.length} of ${body.limit} remembered`
                : '';
        }
        if (forgetAll) forgetAll.hidden = memories.length === 0;

        if (!memories.length) {
            // An empty state that says what would fill it, because "nothing yet"
            // on its own reads like something is broken.
            list.innerHTML =
                '<div class="p-4 rounded text-xs" ' +
                'style="background:var(--surface-2);border:1px solid var(--line);color:var(--ink-2)">' +
                'Nothing yet. The assistant writes one when you tell it something about how you ' +
                'work &mdash; which part of the instance is yours, or how you want numbers ' +
                'presented. You will see it happen in that answer&rsquo;s steps.</div>';
            return;
        }

        list.innerHTML = memories.map((m) => `
            <div class="flex items-start gap-3 py-2.5" style="border-bottom:1px solid var(--line)">
                <i class="fa-solid fa-bookmark mt-1" style="color:var(--ink-3);font-size:11px"></i>
                <div class="min-w-0 flex-1">
                    <p class="text-sm" style="color:var(--ink-1)">${esc(m.content)}</p>
                    <p class="label mt-0.5">learned ${esc(when(m.created_at))}</p>
                </div>
                <button class="btn btn-sm" type="button" data-forget="${esc(String(m.id))}"
                        aria-label="Forget: ${esc(m.content)}">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>`).join('');

        list.querySelectorAll('[data-forget]').forEach((btn) => {
            btn.addEventListener('click', () => forget(btn.dataset.forget));
        });
    }

    async function forget(id) {
        try {
            const res = await window.fetchWithAuth(`/api/ai-memories/${encodeURIComponent(id)}`,
                { method: 'DELETE' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
            console.warn('[SETTINGS] could not forget:', err);
        }
        render();
    }

    document.addEventListener('DOMContentLoaded', () => {
        const forgetAll = document.getElementById('memoryForgetAll');
        if (forgetAll) {
            forgetAll.addEventListener('click', async () => {
                // Confirmed, because it is not undoable and the thing it destroys
                // took real conversations to accumulate.
                if (!window.confirm('Forget everything the assistant knows about you?')) return;
                await forget('all');
            });
        }
        render();
    });
})();
