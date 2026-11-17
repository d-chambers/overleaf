// Review (comments and tracked changes) logic shared by the token-api HTTP
// routes and the bot-access MCP tools. Callers authenticate and authorise;
// these functions only take ids they have already checked.
import { fetchNothing, RequestFailedError } from '@overleaf/fetch-utils'
import logger from '@overleaf/logger'
import settings from '@overleaf/settings'
import { ObjectId } from 'mongodb'
import ChatApiHandler from '../../../../app/src/Features/Chat/ChatApiHandler.mjs'
import DocstoreManager from '../../../../app/src/Features/Docstore/DocstoreManager.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorRealTimeController from '../../../../app/src/Features/Editor/EditorRealTimeController.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import UserInfoController from '../../../../app/src/Features/User/UserInfoController.mjs'
import UserInfoManager from '../../../../app/src/Features/User/UserInfoManager.mjs'

export const ID_REGEX = /^[0-9a-f]{24}$/
export const MAX_MESSAGE_LENGTH = 10 * 1024 // chat's limit
export const MAX_QUOTE_LENGTH = 10 * 1024

// A comment could not be anchored: quote missing, ambiguous, or rejected by
// document-updater (text or version changed). `reason` is a short machine
// string, as returned by the token-api in its 409 body.
export class ReviewConflictError extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'ReviewConflictError'
    this.reason = reason
  }
}

// Unknown file in the project, or document-updater answered 404.
export class ReviewNotFoundError extends Error {
  constructor(message = 'not found') {
    super(message)
    this.name = 'ReviewNotFoundError'
  }
}

// The request cannot be applied as given (e.g. it splits a surrogate pair).
export class ReviewBadRequestError extends Error {
  constructor(message = 'bad request') {
    super(message)
    this.name = 'ReviewBadRequestError'
  }
}

function iso(value) {
  if (value == null) return null
  const date = new Date(value)
  return isNaN(date) ? null : date.toISOString()
}
export { iso }

// '2026-10-10T12:34:56.789Z' -> '2026-10-10 12:34'
function shortTime(isoString) {
  return isoString ? isoString.slice(0, 16).replace('T', ' ') : '?'
}

// op.p counts UTF-16 code units of lines.join('\n'), as does String.slice.
export function lineAt(text, offset) {
  return text.slice(0, offset).split('\n').length
}

// First two occurrences of quote in text: enough to tell unique from ambiguous.
export function findOffsets(text, quote) {
  const first = text.indexOf(quote)
  if (first === -1) return []
  const second = text.indexOf(quote, first + 1)
  return second === -1 ? [first] : [first, second]
}

// UTF-16 offsets (what ShareJS counts): true if i falls between the halves of a surrogate pair.
export function splitsSurrogatePair(text, i) {
  return (
    /[\uD800-\uDBFF]/.test(text[i - 1] ?? '') &&
    /[\uDC00-\uDFFF]/.test(text[i] ?? '')
  )
}

function byFileLine(a, b) {
  if (a.file !== b.file) {
    if (a.file == null) return 1
    if (b.file == null) return -1
    return a.file < b.file ? -1 : 1
  }
  if (a.line !== b.line) {
    if (a.line == null) return 1
    if (b.line == null) return -1
    return a.line - b.line
  }
  return 0
}

async function getAuthors(userIds) {
  const ids = [...new Set(userIds.filter(id => id && ID_REGEX.test(id)))]
  const users = await UserGetter.promises.getUsers(ids, {
    first_name: 1,
    last_name: 1,
  })
  const names = new Map()
  for (const user of users) {
    const name = `${user.first_name || ''} ${user.last_name || ''}`.trim()
    names.set(user._id.toString(), name || null)
  }
  return id => (id ? { id, name: names.get(id) ?? null } : null)
}

export function toMarkdown(view) {
  const out = [
    `# ${view.project.name}: review comments (${shortTime(view.generated_at)} UTC)`,
  ]
  let currentFile
  for (const thread of view.threads) {
    if (thread.file !== currentFile) {
      currentFile = thread.file
      out.push('', `## ${thread.file ?? '(no file)'}`)
    }
    const state = thread.resolved ? 'resolved' : 'open'
    const where = thread.line != null ? `Line ${thread.line}` : 'Thread'
    out.push('', `### ${where} (${state}) [thread ${thread.id}]`)
    if (thread.quote != null) {
      out.push(...thread.quote.split('\n').map(line => `> ${line}`))
    }
    if (thread.messages.length > 0) out.push('')
    for (const message of thread.messages) {
      const name = message.author?.name ?? message.author?.id ?? 'unknown'
      out.push(
        `- **${name}**, ${shortTime(message.time)}: ${message.content.replaceAll('\n', '\n  ')}`
      )
    }
  }
  if (view.changes.length > 0) {
    out.push('', '## Tracked changes')
    for (const change of view.changes) {
      const name = change.author?.name ?? change.author?.id ?? 'unknown'
      const where = `${change.file ?? '(no file)'}:${change.line ?? '?'}`
      // JSON string literal: newlines and backticks cannot break the list item
      out.push(
        `- ${where} ${change.type} by ${name}, ${shortTime(change.time)}: ${JSON.stringify(change.text)}`
      )
    }
  }
  return out.join('\n') + '\n'
}

// All comment threads and tracked changes of a project, with file and line.
export async function getReviewView(projectId) {
  await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
  // lines and ranges from one docstore read, so offsets match the text
  const [project, paths, docs, chatThreads] = await Promise.all([
    ProjectGetter.promises.getProject(projectId, { name: 1 }),
    ProjectEntityHandler.promises.getAllDocPathsFromProjectById(projectId),
    DocstoreManager.promises.getAllDocsWithRanges(projectId),
    ChatApiHandler.promises.getThreads(projectId),
  ])

  const anchors = new Map()
  const rawChanges = []
  for (const doc of docs) {
    const docId = doc._id.toString()
    const file = paths[docId]?.replace(/^\//, '') ?? null
    const text = (doc.lines ?? []).join('\n')
    const locate = p => ({
      file,
      line: file != null ? lineAt(text, p) : null,
    })
    for (const comment of doc.ranges?.comments ?? []) {
      anchors.set(String(comment.op.t), {
        doc_id: docId,
        ...locate(comment.op.p),
        quote: comment.op.c,
      })
    }
    for (const change of doc.ranges?.changes ?? []) {
      rawChanges.push({ change, ...locate(change.op.p) })
    }
  }

  const userIds = []
  for (const thread of Object.values(chatThreads)) {
    userIds.push(thread.resolved_by_user_id)
    for (const message of thread.messages ?? []) userIds.push(message.user_id)
  }
  for (const { change } of rawChanges) userIds.push(change.metadata?.user_id)
  const author = await getAuthors(userIds.map(id => (id ? String(id) : null)))

  const threadIds = new Set([...Object.keys(chatThreads), ...anchors.keys()])
  const threads = [...threadIds].map(id => {
    const chat = chatThreads[id] ?? {}
    const anchor = anchors.get(id) ?? {
      doc_id: null,
      file: null,
      line: null,
      quote: null,
    }
    return {
      id,
      doc_id: anchor.doc_id,
      file: anchor.file,
      line: anchor.line,
      quote: anchor.quote,
      resolved: !!chat.resolved,
      resolved_at: iso(chat.resolved_at),
      resolved_by: chat.resolved_by_user_id
        ? author(String(chat.resolved_by_user_id))
        : null,
      messages: (chat.messages ?? []).map(m => ({
        id: m.id,
        author: m.user_id ? author(String(m.user_id)) : null,
        time: iso(m.timestamp),
        edited_at: iso(m.edited_at),
        content: m.content,
      })),
    }
  })
  const firstTime = t => t.messages[0]?.time ?? ''
  threads.sort(
    (a, b) => byFileLine(a, b) || firstTime(a).localeCompare(firstTime(b))
  )

  const changes = rawChanges.map(({ change, file, line }) => ({
    id: change.id,
    file,
    line,
    type: change.op.i != null ? 'insert' : 'delete',
    text: change.op.i ?? change.op.d,
    author: change.metadata?.user_id
      ? author(String(change.metadata.user_id))
      : null,
    time: iso(change.metadata?.ts),
  }))
  changes.sort(byFileLine)

  return {
    project: { id: projectId, name: project?.name ?? null },
    generated_at: new Date().toISOString(),
    threads,
    changes,
  }
}

// Reply to an existing thread as userId. Chat errors (RequestFailedError)
// propagate to the caller.
export async function sendMessage({ projectId, threadId, userId, content }) {
  // Reading a thread does not create it; sending to one does. Reject
  // unknown IDs instead of creating an orphan thread without an anchor.
  await ChatApiHandler.promises.getThread(projectId, threadId)
  const user = await UserInfoManager.promises.getPersonalInfo(userId)
  const message = await ChatApiHandler.promises.sendComment(
    projectId,
    threadId,
    userId,
    content
  )
  message.user = UserInfoController.formatPersonalInfo(user)
  EditorRealTimeController.emitToRoom(
    projectId,
    'new-comment',
    threadId,
    message
  )
  return {
    id: message.id,
    time: iso(message.timestamp),
    content: message.content,
  }
}

// New comment thread anchored to `quote` in `file` (project-relative path),
// as userId. With `offset`, the quote must be at that offset; without, it
// must occur exactly once. Throws ReviewNotFoundError, ReviewConflictError or
// ReviewBadRequestError; other errors propagate.
export async function createComment({
  projectId,
  userId,
  file,
  quote,
  content,
  offset,
}) {
  const wanted = file.replace(/^\//, '')
  const paths =
    await ProjectEntityHandler.promises.getAllDocPathsFromProjectById(projectId)
  const docId = Object.keys(paths).find(
    id => paths[id].replace(/^\//, '') === wanted
  )
  if (!docId) throw new ReviewNotFoundError('file not found')

  const { lines, version } = await DocumentUpdaterHandler.promises.getDocument(
    projectId,
    docId,
    -1
  )
  const text = lines.join('\n')
  let at = offset
  if (at !== undefined) {
    if (text.slice(at, at + quote.length) !== quote) {
      throw new ReviewConflictError('quote not at offset')
    }
  } else {
    const offsets = findOffsets(text, quote)
    if (offsets.length === 0) throw new ReviewConflictError('quote not found')
    if (offsets.length > 1) throw new ReviewConflictError('quote ambiguous')
    at = offsets[0]
  }
  if (
    splitsSurrogatePair(text, at) ||
    splitsSurrogatePair(text, at + quote.length)
  ) {
    throw new ReviewBadRequestError()
  }
  const line = lineAt(text, at)

  const threadId = new ObjectId().toString()
  const user = await UserInfoManager.promises.getPersonalInfo(userId)
  // Creates the thread; the anchor below makes it visible in the doc.
  const message = await ChatApiHandler.promises.sendComment(
    projectId,
    threadId,
    userId,
    content
  )
  // Editors learn the thread before the op arrives, as with the editor's own flow.
  message.user = UserInfoController.formatPersonalInfo(user)
  EditorRealTimeController.emitToRoom(
    projectId,
    'new-comment',
    threadId,
    message
  )
  try {
    // All three IDs are 24-hex: projectId checked by the caller, docId from
    // the project, threadId generated above.
    await fetchNothing(
      `${settings.apis.documentupdater.url}/project/${projectId}/doc/${docId}/comment`,
      {
        method: 'POST',
        json: {
          thread_id: threadId,
          user_id: userId,
          text: quote,
          offset: at,
          version,
        },
        signal: AbortSignal.timeout(30 * 1000),
      }
    )
  } catch (err) {
    // Roll back both sides. After a timeout the outcome is unknown, so the
    // range is removed too (a no-op if it was never applied).
    const warn = (e, what) =>
      logger.warn(
        { err: e, projectId, docId, threadId },
        `review: ${what} after failed anchor`
      )
    await DocumentUpdaterHandler.promises
      .deleteThread(projectId, docId, threadId, userId)
      .catch(e => warn(e, 'could not remove range'))
    await ChatApiHandler.promises
      .deleteThread(projectId, threadId)
      .catch(e => warn(e, 'could not delete thread'))
    EditorRealTimeController.emitToRoom(projectId, 'delete-thread', threadId)
    if (err instanceof RequestFailedError) {
      // 422: text or version changed, too many comments, or not a ShareJS doc
      if (err.response.status === 422) {
        throw new ReviewConflictError('anchor rejected')
      }
      if (err.response.status === 404) throw new ReviewNotFoundError()
    }
    throw err
  }

  return {
    thread_id: threadId,
    doc_id: docId,
    file: paths[docId].replace(/^\//, ''),
    line,
    quote,
    message: {
      id: message.id,
      time: iso(message.timestamp),
      content: message.content,
    },
  }
}

export default {
  getReviewView,
  toMarkdown,
  sendMessage,
  createComment,
}
