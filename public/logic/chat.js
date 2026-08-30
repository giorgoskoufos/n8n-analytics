// ==========================================
// The full-page conversation
// ==========================================
//
// F-24 §6 reduced this file from 159 lines to a mounting call, because it was a
// second implementation of what the floating panel already did and the two had
// drifted: this one rendered answers with `escapeHtml`, so every markdown table
// the server prompt asks for arrived here as a screen of literal pipes.
//
// It stayed reduced. What is left is the two things a full page genuinely
// decides differently from a 420px panel:
//
//   · reading size — `compact` is off, so the type is a size larger;
//   · that there is room to replay the whole history, and a reason to. Arriving
//     at a blank page having asked ten questions this morning is the thing that
//     made people distrust it.
//
// The panel's own shell logic — opening, focus return, the mobile sheet, the
// resize grip — has no equivalent here, which is why none of it is in this file.

document.addEventListener('DOMContentLoaded', async () => {
    const chat = window.ChatCore.mount({
        log: document.getElementById('assistantLog'),
        input: document.getElementById('assistantInput'),
        send: document.getElementById('assistantSend'),
        stop: document.getElementById('assistantStop'),
        status: document.getElementById('assistantStatus'),
        jump: document.getElementById('assistantJump'),
        strip: document.getElementById('assistantTagStrip'),
        menu: document.getElementById('assistantTagMenu'),
        toolsButton: document.querySelector('[data-assistant="tools"]'),
        toolHint: document.getElementById('assistantToolHint'),
        threadButton: document.querySelector('[data-assistant="threads"]'),
        threadTitle: document.getElementById('assistantThreadTitle'),
        threadMenu: document.getElementById('assistantThreads'),
        newButton: document.querySelector('[data-assistant="new"]')
    });

    if (!chat) {
        console.warn('[CHAT] the page is missing one of #assistantLog, #assistantInput, #assistantSend.');
        return;
    }

    await chat.loadHistory();
    // An answer that was still being written when the reader clicked through to
    // this page. Same registry, same turn — see src/ai/turns.js.
    await chat.resumeInFlight();

    document.getElementById('assistantInput')?.focus();
});
