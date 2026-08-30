const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const { authenticateToken, resolveScope } = require('../middlewares/auth');
const { aiLimiter, globalApiLimiter } = require('../middlewares/rateLimiter');

router.use(authenticateToken, globalApiLimiter, resolveScope);

router.post('/ai-chat', aiLimiter, aiController.chat);

// F-24 §6 · the same pipeline, streamed.
//
// Behind the same rate limiter as the non-streaming call: it costs the same two
// model calls, and a limiter that only guards one of two doors is not a limiter.
router.post('/ai-chat/stream', aiLimiter, aiController.chatStream);
router.get('/chat-history', aiController.getHistory);

// Picking an answer back up after a page load.
//
// Not behind aiLimiter: reattaching costs nothing but a socket, and a reader who
// navigates through three pages while one answer is written would otherwise
// spend three of their chat requests on watching the same one.
router.get('/ai-chat/turns', aiController.openTurns);
router.get('/ai-chat/turn/:id', aiController.attachTurn);
router.post('/ai-chat/turn/:id/cancel', aiController.cancelTurn);

// The `@` picker and the `+` menu.
//
// Under the global limiter rather than the AI one: these fire on keystrokes and
// cost a scoped read of a ~350-row index, not a model call. Putting them behind
// aiLimiter would spend a user's chat budget on typing.
router.get('/ai-catalog', aiController.searchCatalog);
router.get('/ai-tag-options', aiController.getTagOptions);

// Conversations.
//
// The chat was one endless thread per user, so `/chat-history` meant "all of
// it" and the model's context meant "your last ten messages, whatever they were
// about". It now takes a conversation, and these are how one is chosen.
router.get('/ai-conversations', aiController.listConversations);
router.post('/ai-conversations', aiController.createConversation);
router.patch('/ai-conversations/:id', aiController.updateConversation);
router.delete('/ai-conversations/:id', aiController.deleteConversation);

// What the assistant remembers about the caller. Listed and deleted by the
// person it is about — that is the condition on the feature existing, not a
// nicety. Writing is not here on purpose: a memory is only ever created through
// the `remember` tool, inside a turn, where it appears in the steps.
router.get('/ai-memories', aiController.listMemories);
router.delete('/ai-memories/:id', aiController.deleteMemory);

module.exports = router;
