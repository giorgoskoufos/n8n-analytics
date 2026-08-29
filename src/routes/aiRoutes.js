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

module.exports = router;
