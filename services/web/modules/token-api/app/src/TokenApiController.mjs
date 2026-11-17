import { readFileSync } from 'node:fs'
import { RequestFailedError } from '@overleaf/fetch-utils'
import logger from '@overleaf/logger'
import ChatApiHandler from '../../../../app/src/Features/Chat/ChatApiHandler.mjs'
import DocstoreManager from '../../../../app/src/Features/Docstore/DocstoreManager.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorRealTimeController from '../../../../app/src/Features/Editor/EditorRealTimeController.mjs'
import UserInfoController from '../../../../app/src/Features/User/UserInfoController.mjs'
import UserInfoManager from '../../../../app/src/Features/User/UserInfoManager.mjs'
import {
  InvalidRequestError,
  parseReq,
  z,
} from '../../../../app/src/infrastructure/Validation.mjs'
import { notFound, objectId } from './TokenApiAuthMiddleware.mjs'
import {
  MAX_MESSAGE_LENGTH,
  MAX_QUOTE_LENGTH,
  ReviewBadRequestError,
  ReviewConflictError,
  ReviewNotFoundError,
  createComment,
  getReviewView,
  sendMessage,
  toMarkdown,
} from './ReviewService.mjs'

// The module README doubles as the API documentation, served at GET /api/v1.
let README = null
try {
  README = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
} catch (err) {
  logger.warn(
    { err },
    'token-api: README.md not found, GET /api/v1 answers 404'
  )
}

// A bad request body, or a 404 (unknown thread, comment not in that doc) or
// 400 from chat or document-updater, becomes the API's fixed body; anything
// else is a 500.
function handleWriteError(err, res, next) {
  if (err instanceof InvalidRequestError) {
    return res.status(400).json({ error: 'bad request' })
  }
  if (err instanceof ReviewConflictError) {
    return res.status(409).json({ error: 'conflict', reason: err.reason })
  }
  if (err instanceof ReviewNotFoundError) return notFound(res)
  if (err instanceof ReviewBadRequestError) {
    return res.status(400).json({ error: 'bad request' })
  }
  if (err instanceof RequestFailedError) {
    if (err.response.status === 404) return notFound(res)
    if (err.response.status === 400) {
      return res.status(400).json({ error: 'bad request' })
    }
  }
  next(err)
}

// Ids are already checked by the middleware (malformed -> 404).
const projectSchema = z.object({
  params: z.object({ project_id: objectId }),
})

const getThreadsSchema = z.object({
  params: z.object({ project_id: objectId }),
  // Any other format (or a repeated one) falls back to JSON, never 400.
  query: z.object({ format: z.literal('md').optional().catch(undefined) }),
})

// Content rules as in chat: not blank, at most chat's length limit.
const contentSchema = z
  .string()
  .max(MAX_MESSAGE_LENGTH)
  .refine(s => s.trim() !== '')

const sendMessageSchema = z.object({
  params: z.object({ project_id: objectId, thread_id: objectId }),
  body: z.object({ content: contentSchema }),
})

const createCommentSchema = z.object({
  params: z.object({ project_id: objectId }),
  body: z.object({
    file: z.string().min(1),
    quote: z.string().min(1).max(MAX_QUOTE_LENGTH),
    content: contentSchema,
    // Number.isInteger, not .int(): .int() also caps at MAX_SAFE_INTEGER.
    offset: z.number().min(0).refine(Number.isInteger).optional(),
  }),
})

const docThreadSchema = z.object({
  params: z.object({
    project_id: objectId,
    doc_id: objectId,
    thread_id: objectId,
  }),
})

const TokenApiController = {
  docs(req, res) {
    if (README == null) return notFound(res)
    res.type('text/markdown; charset=utf-8').send(README)
  },

  async getRanges(req, res, next) {
    try {
      const { project_id } = parseReq(req, projectSchema).params
      // Flush unflushed edits to docstore (docs stay loaded), then read all docs from there.
      await DocumentUpdaterHandler.promises.flushProjectToMongo(project_id)
      const docs = await DocstoreManager.promises.getAllRanges(project_id)
      res.json(docs.map(doc => ({ id: doc._id, ranges: doc.ranges ?? {} })))
    } catch (err) {
      next(err)
    }
  },

  async getThreads(req, res, next) {
    try {
      const { params, query } = parseReq(req, getThreadsSchema)
      const view = await getReviewView(params.project_id)
      if (query.format === 'md') {
        res.type('text/markdown; charset=utf-8').send(toMarkdown(view))
      } else {
        res.json(view)
      }
    } catch (err) {
      next(err)
    }
  },

  async sendMessage(req, res, next) {
    try {
      const { params, body } = parseReq(req, sendMessageSchema)
      const result = await sendMessage({
        projectId: params.project_id,
        threadId: params.thread_id,
        userId: req.tokenUserId,
        content: body.content,
      })
      res.status(201).json(result)
    } catch (err) {
      handleWriteError(err, res, next)
    }
  },

  async createComment(req, res, next) {
    try {
      const { params, body } = parseReq(req, createCommentSchema)
      const { file, quote, content, offset } = body
      const result = await createComment({
        projectId: params.project_id,
        userId: req.tokenUserId,
        file,
        quote,
        content,
        offset,
      })
      res.status(201).json(result)
    } catch (err) {
      handleWriteError(err, res, next)
    }
  },

  async resolveThread(req, res, next) {
    try {
      const { params } = parseReq(req, docThreadSchema)
      const { project_id, doc_id, thread_id } = params
      // 404 unless the comment is anchored in this doc of this project; the
      // chat write below must not happen for a wrong doc_id.
      await DocumentUpdaterHandler.promises.getComment(
        project_id,
        doc_id,
        thread_id
      )
      const userId = req.tokenUserId
      const user = await UserInfoManager.promises.getPersonalInfo(userId)
      await ChatApiHandler.promises.resolveThread(project_id, thread_id, userId)
      EditorRealTimeController.emitToRoom(
        project_id,
        'resolve-thread',
        thread_id,
        UserInfoController.formatPersonalInfo(user)
      )
      await DocumentUpdaterHandler.promises.resolveThread(
        project_id,
        doc_id,
        thread_id,
        userId
      )
      res.sendStatus(204)
    } catch (err) {
      handleWriteError(err, res, next)
    }
  },

  async reopenThread(req, res, next) {
    try {
      const { params } = parseReq(req, docThreadSchema)
      const { project_id, doc_id, thread_id } = params
      await DocumentUpdaterHandler.promises.getComment(
        project_id,
        doc_id,
        thread_id
      )
      await ChatApiHandler.promises.reopenThread(project_id, thread_id)
      EditorRealTimeController.emitToRoom(
        project_id,
        'reopen-thread',
        thread_id
      )
      await DocumentUpdaterHandler.promises.reopenThread(
        project_id,
        doc_id,
        thread_id,
        req.tokenUserId
      )
      res.sendStatus(204)
    } catch (err) {
      handleWriteError(err, res, next)
    }
  },
}

export default TokenApiController
