// ==========================================
// n8n AI Chat — the full-page shell
// ==========================================
//
// F-24 §6. This file was 159 lines that re-implemented what chat-widget.js
// already did, and the copies had drifted: this one rendered the assistant's
// answers with `escapeHtml`, so every markdown table the server prompt asks
// for — "if the data has 2 or more columns, ALWAYS use a Markdown table" —
// arrived here as a screen of literal pipe characters.
//
// All of the behaviour is in chat-core.js now. What is left is the part that is
// genuinely specific to a full page rather than a floating panel: which
// elements to use, and that a full page has room to replay the history.

document.addEventListener('DOMContentLoaded', () => {
    const chat = window.ChatCore.mount({
        box: document.getElementById('chatBox'),
        input: document.getElementById('userInput'),
        send: document.getElementById('sendBtn')
    });

    if (!chat) {
        console.warn('[CHAT] the page is missing one of #chatBox, #userInput, #sendBtn.');
        return;
    }

    // The widget loads history because it is small and easily lost; the full
    // page does it for the opposite reason — there is room to show it, and
    // arriving at a blank page having asked ten questions this morning is the
    // thing that made people distrust it.
    chat.loadHistory();

    document.getElementById('userInput')?.focus();
});
