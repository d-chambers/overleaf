// PUT /api/v1/bot/upload/:ticket: receives the raw bytes of a file a bot
// prepared with prepare_upload. The ticket is the only credential: single
// use, bound to one bot/project/path, short-lived. Everything checked when the
// ticket was issued is checked again here, since the project may have changed.
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import { db } from '../../../../app/src/infrastructure/mongodb.mjs'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'
import { creatorCanEdit } from './BotAuthMiddleware.mjs'
import BotUploadManager from './BotUploadManager.mjs'
import { BINARY_EXTENSIONS, ToolError, checkNewFilePath, pathOccupant } from './BotTools.mjs'

const SOURCE = 'bot-access'

class TooLargeError extends Error {}

function fail(res, status, error) {
  res.status(status).json({ ok: false, error })
}

// First bytes each type must start with, to catch uploading the wrong file.
function looksLike(ext, head) {
  const startsWith = sig => head.subarray(0, sig.length).equals(Buffer.from(sig))
  switch (ext) {
    case 'png':
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'jpg':
    case 'jpeg':
      return startsWith([0xff, 0xd8, 0xff])
    case 'gif':
      return startsWith([0x47, 0x49, 0x46, 0x38])
    case 'pdf':
      return startsWith([0x25, 0x50, 0x44, 0x46]) // %PDF
    case 'svg':
      return /<svg[\s>]/i.test(head.toString('utf8'))
    case 'eps':
    case 'ps':
      return startsWith([0x25, 0x21]) || startsWith([0xc5, 0xd0, 0xd3, 0xc6])
    default:
      return true
  }
}

async function upload(req, res, next) {
  let tmpDir = null
  try {
    // Must be sent as a raw body; a form/JSON body has already been consumed.
    if (req._body || !req.is('application/octet-stream')) {
      return fail(
        res,
        415,
        "Send the raw file: curl -X PUT -H 'Content-Type: application/octet-stream' --data-binary @FILE <url>"
      )
    }
    const ticket = await BotUploadManager.redeem(req.params.ticket)
    if (!ticket) {
      return fail(res, 404, 'Unknown, expired or already used upload link. Call prepare_upload again.')
    }
    const projectId = ticket.projectId.toString()
    const bot = await db.botTokens.findOne({ _id: ticket.botId }, { projection: { createdBy: 1 } })
    if (!bot) return fail(res, 401, 'This bot has been revoked.')
    if (!(await creatorCanEdit(bot.createdBy, projectId))) {
      return fail(res, 403, 'The person who connected this bot no longer has edit access to the project.')
    }

    const { path, ext } = checkNewFilePath(ticket.path, BINARY_EXTENSIONS)
    const occupant = await pathOccupant(projectId, path)
    if (occupant === 'doc' || occupant === 'folder' || (occupant === 'file' && !ticket.overwrite)) {
      return fail(res, 409, `"${path}" is now taken in the project. Call prepare_upload again.`)
    }

    tmpDir = await fs.promises.mkdtemp(Path.join(os.tmpdir(), 'bot-upload-'))
    const fsPath = Path.join(tmpDir, 'upload')
    const max = Settings.maxUploadSize
    let bytes = 0
    let head = Buffer.alloc(0)
    await pipeline(
      req,
      new Transform({
        transform(chunk, _enc, cb) {
          bytes += chunk.length
          if (bytes > max) return cb(new TooLargeError())
          if (head.length < 512) head = Buffer.concat([head, chunk]).subarray(0, 512)
          cb(null, chunk)
        },
      }),
      fs.createWriteStream(fsPath, { mode: 0o600 })
    )
    if (bytes === 0) return fail(res, 400, 'The upload was empty.')
    if (!looksLike(ext, head)) {
      return fail(res, 400, `The file does not look like a .${ext} file. Check LOCAL_FILE.`)
    }

    await EditorController.promises.upsertFileWithPath(
      projectId,
      '/' + path,
      fsPath,
      null,
      SOURCE,
      ticket.botUserId.toString()
    )
    logger.info({ projectId, botId: ticket.botId.toString(), path, bytes }, 'bot-access: file uploaded')
    res.json({ ok: true, path, bytes, replaced: occupant === 'file' })
  } catch (err) {
    if (err instanceof TooLargeError) {
      return fail(res, 413, `File too large (limit ${Math.round(Settings.maxUploadSize / 1024 / 1024)} MB).`)
    }
    if (err instanceof ToolError) return fail(res, 400, err.message)
    next(err)
  } finally {
    if (tmpDir) fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

export default { upload }
