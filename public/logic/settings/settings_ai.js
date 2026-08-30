/**
 * The assistant's model and API key, from the page.
 *
 * The same argument the documentation integration makes, applied to the thing
 * the assistant cannot work without at all: the alternative was editing a file
 * on the host and restarting the process, which is not a flow anybody who
 * installed this next to their n8n is going to want to repeat to try a different
 * model.
 *
 * ── Two fields, two endpoints, one button ────────────────────────────────
 *
 * The model is an ordinary instance setting and goes through `POST /api/settings`
 * with the timezone and the concurrency limit. The key is a secret and goes
 * through `POST /api/integrations/openai`, which is the only surface it has —
 * see the note in integrationsController for why it is not in the settings table
 * at all.
 *
 * They share a button because they are one decision to a reader, and splitting
 * them into two saves would produce the state where the model is saved and the
 * key is not. The model is written FIRST for that reason: if the key write then
 * fails, what is left is a configured model and a missing key, which the status
 * line already describes correctly. The other order leaves a working key next to
 * a model nobody chose.
 */

(function () {
    'use strict';

    const dot = () => document.getElementById('aiStatusDot');
    const detail = () => document.getElementById('aiStatusDetail');
    const keyInput = () => document.getElementById('aiApiKeyInput');
    const modelInput = () => document.getElementById('aiModelInput');
    const saveBtn = () => document.getElementById('aiSaveBtn');
    const clearBtn = () => document.getElementById('aiClearKeyBtn');
    const note = () => document.getElementById('aiSaveNote');

    /** Where a value came from, in the words an operator would use. */
    const SOURCE = {
        settings: 'set here',
        environment: 'from the server environment',
        default: 'the built-in default'
    };

    function paint(state) {
        const badge = dot();
        if (!badge) return;

        if (state.checking) {
            badge.className = 'badge badge-neutral';
            badge.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin badge-dot"></i>Checking';
            detail().textContent = '';
            return;
        }

        if (state.error) {
            badge.className = 'badge badge-critical';
            badge.innerHTML = '<i class="fa-solid fa-triangle-exclamation badge-dot"></i>Unknown';
            detail().textContent = state.error;
            return;
        }

        if (state.configured) {
            badge.className = 'badge badge-good';
            badge.innerHTML = '<i class="fa-solid fa-circle-check badge-dot"></i>Key configured';
            // The source is on the line whenever it is not the obvious one. An
            // operator who saves a key here while an old one sits in the
            // server's environment has to be able to see which is answering
            // their questions, or the first surprising bill is unexplainable.
            const where = SOURCE[state.keySource] || '';
            detail().textContent = [state.keyHint, where].filter(Boolean).join(' · ');
        } else {
            badge.className = 'badge badge-neutral';
            badge.innerHTML = '<i class="fa-solid fa-circle badge-dot"></i>No key';
            detail().textContent = 'The chat panel cannot answer until a key is saved.';
        }

        // Only offers to remove what it can remove. The environment's key is not
        // this page's to delete, and a button that silently does nothing is
        // worse than one that is not there.
        if (clearBtn()) clearBtn().hidden = state.keySource !== 'settings';

        // Never refilled with a value — there is no value to refill it with, and
        // a masked field showing eight dots that are not the key is a field
        // people try to edit.
        if (keyInput()) keyInput().value = '';
        if (modelInput() && document.activeElement !== modelInput()) {
            modelInput().value = state.model || '';
        }
        if (note()) {
            note().textContent = state.model
                ? `Answering with ${state.model} (${SOURCE[state.modelSource] || ''}).`
                : '';
        }
    }

    async function refresh() {
        if (!document.getElementById('aiStatusDot')) return;
        paint({ checking: true });
        try {
            const res = await window.fetchWithAuth('/api/integrations/openai');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            paint(await res.json());
        } catch (err) {
            paint({ error: `Could not check: ${err.message}` });
        }
    }

    window.saveAiConfig = async function () {
        const btn = saveBtn();
        const key = keyInput() ? keyInput().value.trim() : '';
        const model = modelInput() ? modelInput().value.trim() : '';

        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
        }

        try {
            // Model first — see the header. An empty string is a real value here:
            // it clears the setting and falls back to the default.
            const modelRes = await window.fetchWithAuth('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'ai_model', value: model })
            });
            if (!modelRes.ok) {
                const body = await modelRes.json().catch(() => ({}));
                // The server's own message, not a generic one: this endpoint is
                // owner/admin only, and "Could not save" leaves a member
                // guessing at a permission problem.
                throw new Error(body.error || 'Could not save the model.');
            }

            // An empty key field means "leave the key alone", not "clear it".
            // Clearing is the button next to this one, because a destructive
            // action that happens by leaving a field blank is one people do by
            // accident.
            if (key) {
                const keyRes = await window.fetchWithAuth('/api/integrations/openai', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apiKey: key })
                });
                const body = await keyRes.json().catch(() => ({}));
                if (!keyRes.ok) throw new Error(body.error || 'Could not save the API key.');
            }

            if (btn) btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved';
            setTimeout(() => {
                if (btn) btn.innerHTML = '<i class="fa-solid fa-check"></i> Save';
            }, 2000);
        } catch (err) {
            if (note()) note().textContent = err.message;
            if (btn) btn.innerHTML = '<i class="fa-solid fa-check"></i> Save';
        } finally {
            if (btn) btn.disabled = false;
            refresh();
        }
    };

    window.clearAiKey = async function () {
        const btn = clearBtn();
        if (btn) btn.disabled = true;
        try {
            await window.fetchWithAuth('/api/integrations/openai/clear', { method: 'POST' });
        } finally {
            if (btn) btn.disabled = false;
            refresh();
        }
    };

    document.addEventListener('settings:section', (event) => {
        if (event.detail && event.detail.section === 'assistant') refresh();
    });

    document.addEventListener('DOMContentLoaded', () => {
        if (window.location.hash.includes('assistant')) refresh();
    });
})();
