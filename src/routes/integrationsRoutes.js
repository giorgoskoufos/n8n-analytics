const express = require('express');
const integrationsController = require('../controllers/integrationsController');
const { authenticateToken, requireElevatedRole, resolveScope } = require('../middlewares/auth');
const { globalApiLimiter } = require('../middlewares/rateLimiter');

/**
 * Two routers, because one of these routes cannot be authenticated.
 *
 * The OAuth callback is reached by the browser navigating back from the
 * documentation service, not by a fetch from the page — so there is no
 * Authorization header to send. The token lives in localStorage and a top-level
 * navigation cannot carry it.
 *
 * What protects it instead is the `state` parameter, which the controller
 * stores against the user who began the flow and checks against the flow it
 * completes. That is the whole defence, which is why it is written out at
 * length in integrationsController rather than assumed.
 *
 * It has to be a SEPARATE router, mounted before the others. Every router in
 * this application calls `router.use(authenticateToken)` with no path, and that
 * runs for any request reaching the router — including one that will fall
 * through to a later router. Declaring the callback after such a `use` in the
 * same file is not enough, and declaring it in a router mounted after them is
 * not enough either: the first blanket `use` on /api answers 401 first.
 */
const publicRouter = express.Router();
publicRouter.get('/integrations/docs/callback', integrationsController.callback);

const router = express.Router();
router.use(authenticateToken, globalApiLimiter, resolveScope);

router.get('/integrations/docs', integrationsController.status);
router.post('/integrations/docs/connect', integrationsController.connect);
router.post('/integrations/docs/disconnect', integrationsController.disconnect);

// The assistant's own provider credentials.
//
// Reading is open to anyone signed in and writing is not, and the asymmetry is
// deliberate. "Is the assistant configured?" is the answer to "why is the chat
// refusing to talk to me", and a member who cannot see it does not know whether
// to ask an admin or to report a bug. Setting the key spends somebody's billing
// account, which is an owner's decision — the same gate `POST /api/settings`
// already puts on the instance-wide settings.
router.get('/integrations/openai', integrationsController.aiStatus);
router.post('/integrations/openai', requireElevatedRole, integrationsController.saveAiKey);
router.post('/integrations/openai/clear', requireElevatedRole, integrationsController.clearAiKey);

module.exports = { router, publicRouter };
