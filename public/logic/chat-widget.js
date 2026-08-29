// ==========================================
// n8n AI Chat Widget — the floating shell
// ==========================================
//
// F-24 §6. This file and chat.js used to be two implementations of the same
// chat against the same endpoint, and a fix to one never reached the other —
// most visibly, this one rendered markdown and the full page did not.
//
// Everything about MESSAGES now lives in chat-core.js. What remains here is
// what is genuinely specific to a floating panel on a phone: the open/close
// transition, the iOS scroll lock, the gesture isolation and the resize handle.
// None of that has an equivalent on a full page, which is why it stayed.

// Global state
let isChatOpen = false;

// --- SECTION 1: TOGGLE LOGIC ---

function toggleChat() {
    console.log("🤖 Toggling AI Chat. Current state:", isChatOpen);
    const widget = document.getElementById('chatWidget');
    const toggleBtn = document.getElementById('chatToggle');
    const input = document.getElementById('userInput');

    if (!widget || !toggleBtn || !input) {
        console.error("🤖 Chat widget elements not found!");
        return;
    }

    isChatOpen = !isChatOpen;

    if (isChatOpen) {
        // Show Widget
        widget.classList.remove('translate-y-10', 'translate-y-full', 'opacity-0', 'pointer-events-none');
        widget.classList.add('translate-y-0', 'opacity-100', 'pointer-events-auto');

        // Update FAB icons
        const robotIcon = toggleBtn.querySelector('.fa-robot');
        const xIcon = toggleBtn.querySelector('.fa-xmark');
        if (robotIcon) robotIcon.classList.add('hidden');
        if (xIcon) xIcon.classList.remove('hidden');

        input.focus();

        // Robust iOS body scroll lock
        if (window.innerWidth < 1024) {
            // Reset any custom resized dimensions for mobile
            widget.style.width = '100%';
            widget.style.height = '';

            const scrollY = window.scrollY;
            document.body.style.position = 'fixed';
            document.body.style.top = `-${scrollY}px`;
            document.body.style.width = '100%';
            document.body.style.overflow = 'hidden';
            document.body.dataset.scrollY = scrollY;

            // Sync initial viewport for iOS
            if (window.visualViewport) {
                widget.style.height = `${window.visualViewport.height}px`;
                widget.style.top = `${window.visualViewport.offsetTop}px`;
            }
        }
    } else {
        // Hide Widget
        if (window.innerWidth < 1024) {
            widget.classList.add('translate-y-full', 'opacity-0', 'pointer-events-none');
            resetViewportStyles(); // Clear iOS-specific overrides

            // Restore scroll and release lock
            const scrollY = document.body.dataset.scrollY;
            document.body.style.position = '';
            document.body.style.top = '';
            document.body.style.width = '';
            document.body.style.overflow = '';
            window.scrollTo(0, parseInt(scrollY || '0'));
        } else {
            widget.classList.add('translate-y-10', 'opacity-0', 'pointer-events-none');
        }
        widget.classList.remove('translate-y-0', 'opacity-100', 'pointer-events-auto');

        const robotIcon = toggleBtn.querySelector('.fa-robot');
        const xIcon = toggleBtn.querySelector('.fa-xmark');
        if (robotIcon) robotIcon.classList.remove('hidden');
        if (xIcon) xIcon.classList.add('hidden');
    }
}

// Ensure toggle function is global
window.toggleChat = toggleChat;

// --- SECTION 2: EVENT LISTENERS ---

let chat = null;

function initChatWidget() {
    const widget = document.getElementById('chatWidget');
    const chatBox = document.getElementById('chatBox');

    // Sending, rendering, streaming, the SQL disclosure and the history are all
    // the core's. `compact` is the only thing this shell asks for, and it only
    // affects type size — a 400px panel and a full page want different reading
    // sizes and nothing else.
    chat = window.ChatCore.mount({
        box: chatBox,
        input: document.getElementById('userInput'),
        send: document.getElementById('sendBtn')
    }, { compact: true });

    // iOS gesture isolation: prevent the page behind from panning.
    if (widget && chatBox) {
        widget.addEventListener('touchmove', (e) => {
            if (!chatBox.contains(e.target) && isChatOpen) e.preventDefault();
        }, { passive: false });
    }

    if (chat) chat.loadHistory();

    initResizer();
}

function initResizer() {
    const handle = document.getElementById('chatResizeHandle');
    const widget = document.getElementById('chatWidget');
    if (!handle || !widget) return;

    let startX, startY, startWidth, startHeight;

    function startResize(e) {
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        startX = clientX;
        startY = clientY;
        startWidth = widget.offsetWidth;
        startHeight = widget.offsetHeight;

        function onMove(moveEvent) {
            const currentX = moveEvent.touches ? moveEvent.touches[0].clientX : moveEvent.clientX;
            const currentY = moveEvent.touches ? moveEvent.touches[0].clientY : moveEvent.clientY;

            const deltaX = startX - currentX;
            const deltaY = startY - currentY;

            const newWidth = Math.max(300, Math.min(window.innerWidth - 10, startWidth + deltaX));
            const newHeight = Math.max(400, Math.min(window.innerHeight - 10, startHeight + deltaY));

            widget.style.width = `${newWidth}px`;
            widget.style.height = `${newHeight}px`;
            // Resizing shortens the scroll region; without this the newest
            // message slides out of view while the handle is still held.
            chat?.scrollToBottom();
        }

        function onEnd() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
    }

    handle.addEventListener('mousedown', startResize);
    handle.addEventListener('touchstart', startResize, { passive: false });
}

// Run init. This script is loaded at the end of <body>, so on a fast page the
// document may already be interactive by the time it executes and the event
// would never fire.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatWidget);
} else {
    initChatWidget();
}

// loadChatHistory, sendMessage, appendMessage, showTypingIndicator,
// removeMessage and scrollToBottom lived here — about 160 lines, duplicated
// almost line for line in chat.js. They are chat-core.js now, once.

// escapeHtml lives in global_functions.js, loaded before this file.


// --- SECTION 5: VIEWPORT HANDLING (iOS Fix) ---

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        const widget = document.getElementById('chatWidget');
        if (widget && isChatOpen && window.innerWidth < 1024) {
            widget.style.height = `${window.visualViewport.height}px`;
            setTimeout(() => chat?.scrollToBottom(), 50);
        }
    });

    window.visualViewport.addEventListener('scroll', () => {
        const widget = document.getElementById('chatWidget');
        if (widget && isChatOpen && window.innerWidth < 1024) {
            widget.style.top = `${window.visualViewport.offsetTop}px`;
        }
    });
}

function resetViewportStyles() {
    const widget = document.getElementById('chatWidget');
    if (widget) {
        widget.style.height = '';
        widget.style.top = '';
    }
}
