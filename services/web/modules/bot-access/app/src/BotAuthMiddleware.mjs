// Bearer-token authentication for the bot MCP endpoint. A token is valid only
// while its project exists and the person who connected the bot still has
// edit access to it.
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import PrivilegeLevels from '../../../../app/src/Features/Authorization/PrivilegeLevels.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import Errors from '../../../../app/src/Features/Errors/Errors.js'
import BotTokenManager from './BotTokenManager.mjs'

const BEARER = /^Bearer\s+(\S+)$/i
export const EDIT_LEVELS = [PrivilegeLevels.OWNER, PrivilegeLevels.READ_AND_WRITE]

function deny(req, res, status, message) {
  logger.info({ ip: req.ip, status, message }, 'bot-access: request denied')
  if (status === 401) res.set('WWW-Authenticate', 'Bearer')
  res.status(status).json({ error: message })
}

// MCP Streamable HTTP: servers must validate Origin to prevent DNS rebinding.
// Non-browser clients send none; browsers must come from this site.
export function checkOrigin(req, res, next) {
  const origin = req.headers.origin
  if (origin) {
    let allowed = false
    try {
      allowed = new URL(origin).origin === new URL(Settings.siteUrl).origin
    } catch {}
    if (!allowed) return deny(req, res, 403, 'origin not allowed')
  }
  next()
}

export async function creatorCanEdit(createdBy, projectId) {
  try {
    const level = await AuthorizationManager.promises.getPrivilegeLevelForProject(
      createdBy,
      projectId,
      null,
      { ignoreSiteAdmin: true, ignorePublicAccess: true }
    )
    return EDIT_LEVELS.includes(level)
  } catch (err) {
    if (err instanceof Errors.NotFoundError) return false
    throw err
  }
}

export default async function botTokenAuth(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store')
    const match = BEARER.exec((req.headers.authorization || '').trim())
    if (!match) return deny(req, res, 401, 'missing bearer token')
    const record = await BotTokenManager.findByToken(match[1])
    if (!record) return deny(req, res, 401, 'invalid or revoked token')

    const projectId = record.projectId.toString()
    const project = await ProjectGetter.promises.getProject(projectId, { _id: 1 })
    if (!project) return deny(req, res, 401, 'the project no longer exists')
    if (!(await creatorCanEdit(record.createdBy, projectId))) {
      return deny(
        req,
        res,
        403,
        'the person who connected this bot no longer has edit access to the project'
      )
    }

    req.bot = {
      botId: record._id.toString(),
      projectId,
      // strings, as session user ids are: chat compares them as strings
      botUserId: record.botUserId.toString(),
      name: record.name,
    }
    next()
  } catch (err) {
    next(err)
  }
}
