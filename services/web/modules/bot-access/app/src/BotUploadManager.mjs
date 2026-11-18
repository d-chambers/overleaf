// One-time upload tickets for binary files (images, PDFs). A bot asks for a
// ticket with the prepare_upload tool and then PUTs the raw file to the
// ticket URL, so file bytes never travel through the model or the MCP call.
// A ticket is bound to one bot, one project and one path; it expires after
// TICKET_TTL_MS and can be redeemed once. Only its SHA-256 is stored.
import crypto from 'node:crypto'
import logger from '@overleaf/logger'
import { ObjectId } from 'mongodb'
import { db } from '../../../../app/src/infrastructure/mongodb.mjs'

export const TICKET_PREFIX = 'olu_'
const TICKET_LENGTH = 40
const TICKET_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
export const TICKET_REGEX = new RegExp(`^${TICKET_PREFIX}[A-Za-z0-9]{${TICKET_LENGTH}}$`)
export const TICKET_TTL_MS = 10 * 60 * 1000

function collection() {
  return db.botUploads
}

let indexesEnsured = null
function ensureIndexes() {
  if (!indexesEnsured) {
    indexesEnsured = Promise.all([
      collection().createIndex({ ticketHash: 1 }, { unique: true }),
      // Mongo deletes expired tickets on its own.
      collection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]).catch(err => {
      indexesEnsured = null
      logger.err({ err }, 'bot-access: could not create upload indexes')
      throw err
    })
  }
  return indexesEnsured
}

function hashTicket(ticket) {
  return crypto.createHash('sha256').update(ticket).digest('hex')
}

export default {
  async create({ botId, projectId, botUserId, path, overwrite }) {
    await ensureIndexes()
    let ticket = TICKET_PREFIX
    for (let i = 0; i < TICKET_LENGTH; i++) {
      ticket += TICKET_CHARS[crypto.randomInt(TICKET_CHARS.length)]
    }
    const expiresAt = new Date(Date.now() + TICKET_TTL_MS)
    await collection().insertOne({
      ticketHash: hashTicket(ticket),
      botId: new ObjectId(botId),
      projectId: new ObjectId(projectId),
      botUserId: new ObjectId(botUserId),
      path,
      overwrite: Boolean(overwrite),
      createdAt: new Date(),
      expiresAt,
      usedAt: null,
    })
    return { ticket, expiresAt }
  },

  // Atomically marks the ticket used and returns it, or null if it is
  // unknown, expired or already used.
  async redeem(ticket) {
    if (!TICKET_REGEX.test(ticket)) return null
    const result = await collection().findOneAndUpdate(
      { ticketHash: hashTicket(ticket), usedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { usedAt: new Date() } },
      { returnDocument: 'after' }
    )
    // mongodb driver >= 6 returns the document; older drivers wrap it in .value
    return result && Object.hasOwn(result, 'value') && Object.hasOwn(result, 'ok')
      ? result.value
      : result
  },
}
