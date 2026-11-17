import logger from '@overleaf/logger'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import botTokenAuth, { checkOrigin, creatorCanEdit } from './BotAuthMiddleware.mjs'
import BotAccessController from './BotAccessController.mjs'
import BotMcpController from './BotMcpController.mjs'

const ID_REGEX = /^[0-9a-f]{24}$/

// Unauthenticated attempts, per IP (stops token guessing from hammering Mongo).
const mcpIpLimiter = new RateLimiter('bot-access-mcp-ip', { points: 600, duration: 60 })
// Authenticated calls, per bot.
const mcpBotLimiter = new RateLimiter('bot-access-mcp-bot', { points: 120, duration: 60 })
const manageLimiter = new RateLimiter('bot-access-manage', { points: 30, duration: 60 })

// Owners and editors of the project (invited or via an edit link); never
// site admins by virtue of being admins.
async function ensureCanManageBots(req, res, next) {
  try {
    const projectId = req.params.Project_id
    if (!ID_REGEX.test(projectId)) return res.sendStatus(404)
    const userId = SessionManager.getLoggedInUserId(req.session)
    if (!userId || !(await creatorCanEdit(userId, projectId))) {
      return res.status(403).json({
        message: 'Only the project owner and editors can connect bots.',
      })
    }
    next()
  } catch (err) {
    next(err)
  }
}

export default {
  apply(webRouter, privateApiRouter, publicApiRouter) {
    logger.debug({}, 'Init bot-access router')

    const manage = [
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(manageLimiter),
      ensureCanManageBots,
    ]
    webRouter.get('/project/:Project_id/bot-access', ...manage, BotAccessController.list)
    webRouter.post('/project/:Project_id/bot-access', ...manage, BotAccessController.create)
    webRouter.delete(
      '/project/:Project_id/bot-access/:bot_id',
      ...manage,
      BotAccessController.revoke
    )

    publicApiRouter.post(
      '/api/v1/bot/mcp',
      RateLimiterMiddleware.rateLimit(mcpIpLimiter, { ipOnly: true }),
      checkOrigin,
      botTokenAuth,
      RateLimiterMiddleware.rateLimit(mcpBotLimiter, { getUserId: req => req.bot.botId }),
      BotMcpController.post
    )
    publicApiRouter.all('/api/v1/bot/mcp', BotMcpController.methodNotAllowed)
  },
}
