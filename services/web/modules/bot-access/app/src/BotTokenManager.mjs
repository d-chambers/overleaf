// Project-scoped bot tokens. Each token belongs to exactly one project and one
// bot user (created for it). Only the SHA-256 of the token is stored.
import crypto from 'node:crypto'
import logger from '@overleaf/logger'
import { ObjectId } from 'mongodb'
import { db } from '../../../../app/src/infrastructure/mongodb.mjs'
import UserCreator from '../../../../app/src/Features/User/UserCreator.mjs'

export const TOKEN_PREFIX = 'olb_'
const TOKEN_LENGTH = 40 // characters after the prefix (~238 bits)
const TOKEN_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
export const TOKEN_REGEX = new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9]{${TOKEN_LENGTH}}$`)
export const MAX_BOTS_PER_PROJECT = 10
const LAST_USED_RESOLUTION_MS = 60 * 1000

function collection() {
  return db.botTokens
}

let indexesEnsured = null
function ensureIndexes() {
  if (!indexesEnsured) {
    indexesEnsured = Promise.all([
      collection().createIndex({ tokenHash: 1 }, { unique: true }),
      collection().createIndex({ projectId: 1 }),
    ]).catch(err => {
      indexesEnsured = null
      logger.err({ err }, 'bot-access: could not create indexes')
      throw err
    })
  }
  return indexesEnsured
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function generateToken() {
  let token = TOKEN_PREFIX
  for (let i = 0; i < TOKEN_LENGTH; i++) {
    token += TOKEN_CHARS[crypto.randomInt(TOKEN_CHARS.length)]
  }
  return token
}

// Names are shown in the review panel as "<name> (bot)".
export function normaliseName(name) {
  if (typeof name !== 'string') return null
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned.length < 1 || cleaned.length > 40) return null
  return cleaned
}

function publicView(doc) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    createdAt: doc.createdAt,
    lastUsedAt: doc.lastUsedAt ?? null,
    createdBy: doc.createdBy.toString(),
    tokenPartial: doc.tokenPartial,
  }
}

const BotTokenManager = {
  async listForProject(projectId) {
    const docs = await collection()
      .find({ projectId: new ObjectId(projectId) })
      .sort({ createdAt: 1 })
      .toArray()
    return docs.map(publicView)
  },

  // Creates the bot user and the token. Returns the token in clear text; it
  // is never retrievable again.
  async create({ projectId, createdBy, name }) {
    await ensureIndexes()
    const count = await collection().countDocuments({
      projectId: new ObjectId(projectId),
    })
    if (count >= MAX_BOTS_PER_PROJECT) {
      const err = new Error('too many bots for this project')
      err.code = 'TOO_MANY_BOTS'
      throw err
    }
    const botId = new ObjectId()
    // A user with no password and no third-party identity cannot log in to
    // the website; the .invalid TLD (RFC 2606) can never receive mail, so a
    // password reset can never reach anyone.
    const user = await UserCreator.promises.createNewUser({
      email: `bot-${botId.toString()}@bot.invalid`,
      first_name: name,
      last_name: '(bot)',
      holdingAccount: false,
      analyticsId: crypto.randomUUID(),
    })
    const token = generateToken()
    await collection().insertOne({
      _id: botId,
      projectId: new ObjectId(projectId),
      botUserId: user._id,
      name,
      createdBy: new ObjectId(createdBy),
      createdAt: new Date(),
      lastUsedAt: null,
      tokenHash: hashToken(token),
      tokenPartial: token.slice(0, TOKEN_PREFIX.length + 4) + '…',
    })
    logger.info(
      { projectId, createdBy, botId: botId.toString(), botUserId: user._id },
      'bot-access: bot connected'
    )
    return { ...publicView(await collection().findOne({ _id: botId })), token }
  },

  // Deletes the token. The bot user stays, so its past tracked changes and
  // comments keep their author name.
  async revoke({ projectId, botId, revokedBy }) {
    const result = await collection().deleteOne({
      _id: new ObjectId(botId),
      projectId: new ObjectId(projectId),
    })
    if (result.deletedCount > 0) {
      logger.info({ projectId, botId, revokedBy }, 'bot-access: bot revoked')
    }
    return result.deletedCount > 0
  },

  // Token -> its record, or null. Constant work regardless of the input:
  // lookup is by hash, so timing does not reveal valid prefixes.
  async findByToken(token) {
    if (typeof token !== 'string' || !TOKEN_REGEX.test(token)) return null
    const doc = await collection().findOne({ tokenHash: hashToken(token) })
    if (!doc) return null
    if (
      !doc.lastUsedAt ||
      Date.now() - doc.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS
    ) {
      collection()
        .updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } })
        .catch(err =>
          logger.warn({ err, botId: doc._id }, 'bot-access: lastUsedAt update failed')
        )
    }
    return doc
  },
}

export default BotTokenManager
