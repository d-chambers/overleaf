// Session-authenticated management routes behind the editor's "Connect bot"
// card: list, create and revoke the bots of one project. Owners and editors
// only (BotAccessRouter enforces it).
import Settings from '@overleaf/settings'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import BotTokenManager, { MAX_BOTS_PER_PROJECT, normaliseName } from './BotTokenManager.mjs'

const ID_REGEX = /^[0-9a-f]{24}$/

export function mcpUrl() {
  return `${Settings.siteUrl.replace(/\/+$/, '')}/api/v1/bot/mcp`
}

// "My Thesis (v2)" -> "overleaf-my-thesis-v2"; used as the MCP server name.
function serverName(projectName, projectId) {
  const slug = (projectName || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '')
  return `overleaf-${slug || projectId.slice(-6)}`
}

function instructions({ name, token, projectName, projectId }) {
  const url = mcpUrl()
  const server = serverName(projectName, projectId)
  return {
    serverName: server,
    mcpUrl: url,
    claudeCommand: `claude mcp add --transport http ${server} ${url} --header "Authorization: Bearer ${token}"`,
    jsonConfig: JSON.stringify(
      {
        mcpServers: {
          [server]: {
            type: 'http',
            url,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
      null,
      2
    ),
    note: `This connects "${name}" to the project "${projectName}" only. The token is shown once; revoke it from the Bot card at any time.`,
  }
}

async function withCreatorNames(bots) {
  const ids = [...new Set(bots.map(b => b.createdBy))]
  const users = await UserGetter.promises.getUsers(ids, {
    first_name: 1,
    last_name: 1,
    email: 1,
  })
  const names = new Map(
    users.map(u => [
      u._id.toString(),
      `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
    ])
  )
  return bots.map(b => ({ ...b, createdByName: names.get(b.createdBy) ?? null }))
}

const BotAccessController = {
  async list(req, res, next) {
    try {
      const projectId = req.params.Project_id
      const bots = await BotTokenManager.listForProject(projectId)
      res.json({
        mcpUrl: mcpUrl(),
        maxBots: MAX_BOTS_PER_PROJECT,
        bots: await withCreatorNames(bots),
      })
    } catch (err) {
      next(err)
    }
  },

  async create(req, res, next) {
    try {
      const projectId = req.params.Project_id
      const name = normaliseName(req.body?.name)
      if (!name) {
        return res.status(400).json({ message: 'Give the bot a name of 1 to 40 characters.' })
      }
      const userId = SessionManager.getLoggedInUserId(req.session)
      const project = await ProjectGetter.promises.getProject(projectId, { name: 1 })
      let bot
      try {
        bot = await BotTokenManager.create({ projectId, createdBy: userId, name })
      } catch (err) {
        if (err.code === 'TOO_MANY_BOTS') {
          return res.status(409).json({
            message: `A project can have at most ${MAX_BOTS_PER_PROJECT} bots. Revoke one first.`,
          })
        }
        throw err
      }
      const { token, ...view } = bot
      res.status(201).json({
        bot: view,
        token,
        ...instructions({ name, token, projectName: project?.name, projectId }),
      })
    } catch (err) {
      next(err)
    }
  },

  async revoke(req, res, next) {
    try {
      const projectId = req.params.Project_id
      const botId = req.params.bot_id
      if (!ID_REGEX.test(botId)) return res.sendStatus(404)
      const userId = SessionManager.getLoggedInUserId(req.session)
      const deleted = await BotTokenManager.revoke({ projectId, botId, revokedBy: userId })
      res.sendStatus(deleted ? 204 : 404)
    } catch (err) {
      next(err)
    }
  },
}

export default BotAccessController
