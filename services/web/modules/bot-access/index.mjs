import logger from '@overleaf/logger'
import BotAccessRouter from './app/src/BotAccessRouter.mjs'

let BotAccessModule = {}

// Opt-in: project-scoped bot tokens and the MCP endpoint at /api/v1/bot/mcp.
if (process.env.OVERLEAF_BOT_ACCESS_ENABLED === 'true') {
  logger.debug({}, 'Enabling bot-access module')
  BotAccessModule = {
    router: BotAccessRouter,
  }
}

export default BotAccessModule
