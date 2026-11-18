// The MCP tools a bot can call. Every function receives the authenticated
// context ({ projectId, botUserId, botId, name }) from BotAuthMiddleware and
// only ever touches that one project.
import { RequestFailedError } from '@overleaf/fetch-utils'
import Settings from '@overleaf/settings'
import ChatApiHandler from '../../../../app/src/Features/Chat/ChatApiHandler.mjs'
import ClsiManager from '../../../../app/src/Features/Compile/ClsiManager.mjs'
import CompileManager from '../../../../app/src/Features/Compile/CompileManager.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'
import SafePath from '../../../../app/src/Features/Project/SafePath.mjs'
import BotUploadManager, { TICKET_TTL_MS } from './BotUploadManager.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import LatexParser from '../../../../frontend/js/ide/log-parser/latex-log-parser.ts'
import {
  ID_REGEX,
  MAX_MESSAGE_LENGTH,
  MAX_QUOTE_LENGTH,
  ReviewBadRequestError,
  ReviewConflictError,
  ReviewNotFoundError,
  createComment,
  findOffsets,
  getReviewView,
  lineAt,
  sendMessage,
  splitsSurrogatePair,
  toMarkdown,
} from '../../../token-api/app/src/ReviewService.mjs'

const MAX_READ_LINES = 2000
const MAX_EDIT_TEXT = 100 * 1024
const MAX_NEW_FILE = 512 * 1024
// create_file only makes text files Overleaf can edit; binaries are uploaded by people.
const TEXT_EXTENSIONS = new Set([
  'tex', 'bib', 'bst', 'cls', 'sty', 'clo', 'cfg', 'def', 'dtx', 'ins', 'ist',
  'bbx', 'cbx', 'lbx', 'txt', 'md', 'csv', 'tsv', 'dat', 'json', 'yaml', 'yml', 'tikz',
])
// prepare_upload / the upload endpoint: binary files for figures.
export const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'pdf', 'eps', 'ps', 'svg', 'tif', 'tiff', 'bmp', 'webp',
])
const MAX_REVIEW_CHARS = 100 * 1024
const MAX_LOG_BYTES = 4 * 1024 * 1024
const MAX_LOG_ENTRIES = 20
const SOURCE = 'bot-access'

// A problem the bot can fix by changing its call: returned to it as an MCP
// tool error (isError: true), not a protocol error.
export class ToolError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ToolError'
  }
}

const CONFLICT_HINTS = {
  'quote not found':
    'The quoted text was not found in the file. Re-read the file and copy the text exactly (including whitespace and line breaks).',
  'quote ambiguous':
    'The quoted text occurs more than once in the file. Quote a longer passage so it is unique.',
  'quote not at offset':
    'The file changed while the comment was being added. Re-read the file and try again.',
  'anchor rejected':
    'The file changed while the comment was being added. Re-read the file and try again.',
}

// ReviewService errors -> messages the bot can act on.
function reviewError(err) {
  if (err instanceof ReviewConflictError) {
    return new ToolError(CONFLICT_HINTS[err.reason] ?? `Conflict: ${err.reason}`)
  }
  if (err instanceof ReviewNotFoundError) {
    return new ToolError('Not found. Use list_files to see the project files.')
  }
  if (err instanceof ReviewBadRequestError) {
    return new ToolError(
      'The quoted text starts or ends in the middle of a character. Quote whole characters.'
    )
  }
  if (err instanceof RequestFailedError && err.response?.status === 404) {
    return new ToolError('Not found.')
  }
  return err
}

function normalisePath(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new ToolError('path is required (a project-relative path such as "main.tex").')
  }
  return path.trim().replace(/^\.?\/+/, '')
}

async function getEntities(projectId) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    name: 1,
    rootFolder: 1,
    rootDoc_id: 1,
  })
  if (!project) throw new ToolError('The project no longer exists.')
  const { docs, files } = ProjectEntityHandler.getAllEntitiesFromProject(project)
  const strip = p => p.replace(/^\//, '')
  return {
    project,
    docs: docs.map(d => ({ path: strip(d.path), id: d.doc._id.toString() })),
    files: files.map(f => ({ path: strip(f.path), id: f.file._id.toString() })),
  }
}

async function resolveDoc(projectId, rawPath) {
  const path = normalisePath(rawPath)
  const { docs, files } = await getEntities(projectId)
  const doc = docs.find(d => d.path === path)
  if (doc) return doc
  if (files.some(f => f.path === path)) {
    throw new ToolError(
      `"${path}" is a binary or uploaded file (e.g. an image or PDF). Bots can only read and edit text files.`
    )
  }
  throw new ToolError(`No file "${path}" in this project. Use list_files to see the files.`)
}

// Validates a path for a NEW entity: plain relative path, names Overleaf
// accepts, and an extension from `extensions`. Returns { path, ext }.
export function checkNewFilePath(rawPath, extensions) {
  const path = normalisePath(rawPath)
  const parts = path.split('/')
  if (path.endsWith('/') || parts.some(p => p === '' || p === '.' || p === '..')) {
    throw new ToolError('path must be a plain project-relative file path such as "references.bib" or "figures/plot.png".')
  }
  if (!SafePath.isCleanPath(path) || !parts.every(p => SafePath.isCleanFilename(p))) {
    throw new ToolError('path contains characters Overleaf does not allow in file names.')
  }
  const name = parts.at(-1)
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  if (!extensions.has(ext)) {
    throw new ToolError(`Allowed file types here: ${[...extensions].map(e => '.' + e).join(', ')}.`)
  }
  return { path, ext }
}

// What already occupies `path` in the project: 'doc', 'file', 'folder'
// (a folder, or a file in the way of a parent folder), or null.
export async function pathOccupant(projectId, path) {
  const { docs, files } = await getEntities(projectId)
  if (docs.some(d => d.path === path)) return 'doc'
  if (files.some(f => f.path === path)) return 'file'
  const taken = [...docs, ...files].map(e => e.path)
  if (taken.some(t => t.startsWith(path + '/') || path.startsWith(t + '/'))) return 'folder'
  return null
}

function requireString(value, name, { max, allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new ToolError(`${name} must be a string.`)
  if (!allowEmpty && value === '') throw new ToolError(`${name} must not be empty.`)
  if (max && value.length > max) {
    throw new ToolError(`${name} is too long (at most ${max} characters).`)
  }
  return value
}

function requireMessage(value, name) {
  requireString(value, name, { max: MAX_MESSAGE_LENGTH })
  if (value.trim() === '') throw new ToolError(`${name} must not be blank.`)
  return value
}

async function streamToString(stream, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > maxBytes) {
      chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)))
      stream.destroy?.()
      break
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function formatLogEntry(entry) {
  const where = `${entry.file ?? '?'}${entry.line != null ? `:${entry.line}` : ''}`
  const lines = [`- ${where}: ${entry.message}`]
  const context = (entry.content ?? '').split('\n').filter(l => l.trim() !== '')
  for (const line of context.slice(0, 3)) lines.push(`    ${line}`)
  return lines.join('\n')
}

export const TOOL_DEFINITIONS = [
  {
    name: 'list_files',
    description:
      'List the files of the Overleaf project this bot is connected to. Text files can be read and edited; binary files (images, PDFs) cannot.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_file',
    description:
      'Read a text file of the project as it is right now, with line numbers. Pending tracked insertions are part of the text; pending tracked deletions are not. Always read before suggesting edits.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative path, e.g. "main.tex" or "chapters/intro.tex".' },
        start_line: { type: 'integer', minimum: 1, description: 'First line to return (default 1).' },
        end_line: { type: 'integer', minimum: 1, description: `Last line to return (default: start_line + ${MAX_READ_LINES - 1}).` },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace one passage of a text file. By default (track_changes true) the change is recorded as a tracked change by this bot for a human to accept or reject. Set track_changes to false ONLY when the user has explicitly asked for a direct edit: the change is then applied immediately (still attributed to this bot in the project history). old_text must occur exactly once in the file (copy it exactly from read_file, without the line-number prefixes); include more surrounding text if it is not unique. Use an empty new_text to delete.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative path of a text file.' },
        old_text: { type: 'string', description: 'Exact text to replace; must occur exactly once.' },
        new_text: { type: 'string', description: 'Replacement text (may be empty to delete).' },
        track_changes: {
          type: 'boolean',
          description: 'true (default): record as a tracked change for review. false: apply directly; only when the user explicitly asked for that.',
        },
        comment: { type: 'string', description: 'Optional explanation, added as a review comment on the new text.' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_file',
    description:
      'Create a new text file (e.g. a .bib or a chapter .tex) with the given content. It is added directly, not as a tracked change, and cannot overwrite an existing file (use edit_file for that). Folders in the path are created as needed. Only create files the user asked for or that the requested work clearly needs.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative path of the new file, e.g. "references.bib" or "chapters/methods.tex".' },
        content: { type: 'string', description: 'Full content of the new file.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'prepare_upload',
    description:
      'Get a one-time link to upload a binary file (image or PDF, e.g. a figure) into the project. Then upload the local file with the exact curl command returned; the file content never goes through this tool. The link works once, for this path only, and expires after 10 minutes. Existing files are only replaced when overwrite is true, which you should only use when the user asked to replace that file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative destination, e.g. "figures/borehole-layout.png".' },
        overwrite: { type: 'boolean', description: 'Replace an existing file at this path (default false).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'comment',
    description:
      'Add a review comment anchored to a passage of a text file. The quote must occur exactly once in the file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative path of a text file.' },
        quote: { type: 'string', description: 'Exact passage the comment refers to; must occur exactly once.' },
        text: { type: 'string', description: 'The comment.' },
      },
      required: ['path', 'quote', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'reply',
    description: 'Reply to an existing review comment thread (thread ids come from list_review).',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: '24-character thread id from list_review.' },
        text: { type: 'string', description: 'The reply.' },
      },
      required: ['thread_id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_review',
    description:
      'List the review comment threads (with thread ids) and pending tracked changes of the project, as Markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        include_resolved: { type: 'boolean', description: 'Also include resolved threads (default false).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'compile',
    description:
      'Compile the project with its current settings (including pending tracked changes) and return the LaTeX errors and warnings from the log, with file and line. Cannot change compile settings.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

const handlers = {
  async list_files(ctx) {
    const { project, docs, files } = await getEntities(ctx.projectId)
    const rootDocId = project.rootDoc_id?.toString()
    const main = docs.find(d => d.id === rootDocId)?.path
    const out = [`Project: ${project.name}`]
    if (main) out.push(`Main file: ${main}`)
    out.push('', 'Text files (readable, editable via edit_file):')
    for (const d of [...docs].sort((a, b) => a.path.localeCompare(b.path))) {
      out.push(`- ${d.path}`)
    }
    if (files.length > 0) {
      out.push('', 'Binary files (not readable by bots):')
      for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
        out.push(`- ${f.path}`)
      }
    }
    return out.join('\n')
  },

  async read_file(ctx, args) {
    const doc = await resolveDoc(ctx.projectId, args.path)
    const { lines, version, ranges } =
      await DocumentUpdaterHandler.promises.getDocument(ctx.projectId, doc.id, -1)
    const total = lines.length
    const start = Number.isInteger(args.start_line) && args.start_line > 0 ? args.start_line : 1
    let end = Number.isInteger(args.end_line) && args.end_line >= start
      ? args.end_line
      : start + MAX_READ_LINES - 1
    end = Math.min(end, total, start + MAX_READ_LINES - 1)
    if (start > total) {
      return `${doc.path} has ${total} line(s); start_line ${start} is past the end.`
    }
    const width = String(end).length
    const body = []
    for (let n = start; n <= end; n++) {
      body.push(`${String(n).padStart(width)}| ${lines[n - 1]}`)
    }
    const pending = ranges?.changes?.length ?? 0
    const header = [
      `${doc.path} (version ${version}): lines ${start}-${end} of ${total}.`,
    ]
    if (end < total) header.push(`More lines follow; call read_file with start_line ${end + 1}.`)
    if (pending > 0) {
      header.push(
        `${pending} pending tracked change(s) in this file: pending insertions are included below, pending deletions are not.`
      )
    }
    return `${header.join(' ')}\n\n${body.join('\n')}`
  },

  async edit_file(ctx, args) {
    if (args.track_changes != null && typeof args.track_changes !== 'boolean') {
      throw new ToolError('track_changes must be true or false.')
    }
    const tracked = args.track_changes !== false
    const doc = await resolveDoc(ctx.projectId, args.path)
    const oldText = requireString(args.old_text, 'old_text', { max: MAX_EDIT_TEXT })
    const newText = requireString(args.new_text, 'new_text', {
      max: MAX_EDIT_TEXT,
      allowEmpty: true,
    })
    if (oldText === newText) throw new ToolError('new_text is identical to old_text.')
    const comment = args.comment == null ? null : requireMessage(args.comment, 'comment')

    const { lines, version } = await DocumentUpdaterHandler.promises.getDocument(
      ctx.projectId,
      doc.id,
      -1
    )
    const text = lines.join('\n')
    const offsets = findOffsets(text, oldText)
    if (offsets.length === 0) {
      throw new ToolError(
        'old_text was not found in the file. Re-read the file and copy the text exactly (including whitespace and line breaks, without the line-number prefixes).'
      )
    }
    if (offsets.length > 1) {
      throw new ToolError(
        'old_text occurs more than once in the file. Include more surrounding text so it is unique.'
      )
    }
    const at = offsets[0]
    if (splitsSurrogatePair(text, at) || splitsSurrogatePair(text, at + oldText.length)) {
      throw new ToolError('old_text starts or ends in the middle of a character.')
    }
    const updated = text.slice(0, at) + newText + text.slice(at + oldText.length)

    // Cheap compare-and-set: refuse if someone edited the doc since we read
    // it, so the diff below cannot turn their edit into a tracked deletion.
    const current = await DocumentUpdaterHandler.promises.getDocument(
      ctx.projectId,
      doc.id,
      -1
    )
    if (current.version !== version) {
      throw new ToolError('The file changed while the edit was being prepared. Re-read it and try again.')
    }
    try {
      // document-updater diffs old vs new and applies the difference,
      // as tracked changes when `tracked`, attributed to the bot user.
      await DocumentUpdaterHandler.promises.setDocument(
        ctx.projectId,
        doc.id,
        ctx.botUserId,
        updated.split('\n'),
        SOURCE,
        tracked
      )
    } catch (err) {
      if (err instanceof RequestFailedError && err.response?.status === 406) {
        throw new ToolError('The file would become too large.')
      }
      throw err
    }
    const line = lineAt(text, at)
    const out = [
      tracked
        ? `Suggested a tracked change in ${doc.path} at line ${line}. It is pending: a human must accept or reject it in the review panel.`
        : `Edited ${doc.path} directly at line ${line} (not tracked).`,
    ]

    if (comment) {
      if (newText === '' || newText.length > MAX_QUOTE_LENGTH) {
        out.push('The comment was not added: it can only be anchored to non-empty new text of at most 10 KiB. Use the comment tool on nearby text instead.')
      } else {
        try {
          await createComment({
            projectId: ctx.projectId,
            userId: ctx.botUserId,
            file: doc.path,
            quote: newText,
            content: comment,
            offset: at,
          })
          out.push('Added your comment on the new text.')
        } catch (err) {
          const e = reviewError(err)
          if (!(e instanceof ToolError)) throw e
          out.push(`The edit was made, but the comment could not be added: ${e.message}`)
        }
      }
    }
    return out.join(' ')
  },

  async create_file(ctx, args) {
    const content = requireString(args.content, 'content', { max: MAX_NEW_FILE, allowEmpty: true })
    const { path } = checkNewFilePath(args.path, TEXT_EXTENSIONS)
    const occupant = await pathOccupant(ctx.projectId, path)
    if (occupant === 'doc' || occupant === 'file') {
      throw new ToolError(`"${path}" already exists. Use edit_file to change it.`)
    }
    if (occupant === 'folder') {
      throw new ToolError(`"${path}" conflicts with an existing file or folder.`)
    }
    await EditorController.promises.upsertDocWithPath(
      ctx.projectId,
      '/' + path,
      content.split('\n'),
      SOURCE,
      ctx.botUserId
    )
    return `Created ${path} (${content.split('\n').length} lines).`
  },

  async prepare_upload(ctx, args) {
    if (args.overwrite != null && typeof args.overwrite !== 'boolean') {
      throw new ToolError('overwrite must be true or false.')
    }
    const overwrite = args.overwrite === true
    const { path } = checkNewFilePath(args.path, BINARY_EXTENSIONS)
    const occupant = await pathOccupant(ctx.projectId, path)
    if (occupant === 'doc') {
      throw new ToolError(`"${path}" is a text file; edit it with edit_file instead.`)
    }
    if (occupant === 'folder') {
      throw new ToolError(`"${path}" conflicts with an existing file or folder.`)
    }
    if (occupant === 'file' && !overwrite) {
      throw new ToolError(`"${path}" already exists. Pass overwrite: true only if the user asked to replace it.`)
    }
    const { ticket } = await BotUploadManager.create({
      botId: ctx.botId,
      projectId: ctx.projectId,
      botUserId: ctx.botUserId,
      path,
      overwrite,
    })
    const url = `${Settings.siteUrl.replace(/\/+$/, '')}/api/v1/bot/upload/${ticket}`
    const minutes = Math.round(TICKET_TTL_MS / 60000)
    return [
      `Upload link for ${path} (single use, expires in ${minutes} minutes). Run this, replacing LOCAL_FILE with the path of the file on this machine:`,
      '',
      `curl -sS --fail-with-body -X PUT -H 'Content-Type: application/octet-stream' --data-binary @LOCAL_FILE '${url}'`,
      '',
      `On success it prints {"ok":true,...}. Then reference it in LaTeX, e.g. \\includegraphics{${path}}.`,
    ].join('\n')
  },

  async comment(ctx, args) {
    const path = normalisePath(args.path)
    const quote = requireString(args.quote, 'quote', { max: MAX_QUOTE_LENGTH })
    const content = requireMessage(args.text, 'text')
    await resolveDoc(ctx.projectId, path) // friendly errors for binaries/unknown paths
    try {
      const result = await createComment({
        projectId: ctx.projectId,
        userId: ctx.botUserId,
        file: path,
        quote,
        content,
      })
      return `Comment added on ${result.file} line ${result.line} (thread ${result.thread_id}).`
    } catch (err) {
      throw reviewError(err)
    }
  },

  async reply(ctx, args) {
    const threadId = requireString(args.thread_id, 'thread_id')
    if (!ID_REGEX.test(threadId)) {
      throw new ToolError('thread_id must be a 24-character id from list_review.')
    }
    const content = requireMessage(args.text, 'text')
    try {
      await sendMessage({
        projectId: ctx.projectId,
        threadId,
        userId: ctx.botUserId,
        content,
      })
    } catch (err) {
      if (err instanceof RequestFailedError && err.response?.status === 404) {
        throw new ToolError('No such thread in this project. Use list_review to see thread ids.')
      }
      throw reviewError(err)
    }
    return `Replied to thread ${threadId}.`
  },

  async list_review(ctx, args) {
    const view = await getReviewView(ctx.projectId)
    if (!args.include_resolved) {
      view.threads = view.threads.filter(t => !t.resolved)
    }
    if (view.threads.length === 0 && view.changes.length === 0) {
      return args.include_resolved
        ? 'No comments and no pending tracked changes.'
        : 'No open comments and no pending tracked changes.'
    }
    const md = toMarkdown(view)
    return md.length > MAX_REVIEW_CHARS
      ? md.slice(0, MAX_REVIEW_CHARS) + '\n\n(truncated)'
      : md
  },

  async compile(ctx) {
    const result = await CompileManager.promises.compile(
      ctx.projectId,
      ctx.botUserId,
      { isAutoCompile: false, fileLineErrors: false, stopOnFirstError: false }
    )
    const status = result.status
    if (status === 'too-recently-compiled' || status === 'compile-in-progress') {
      return `Compile status: ${status}. Wait a few seconds and try again.`
    }
    if (status === 'validation-problems') {
      return `Compile status: validation-problems.\n${JSON.stringify(result.validationProblems, null, 2)}`
    }
    const logFile = (result.outputFiles ?? []).find(f => f.path === 'output.log')
    if (!logFile) {
      return `Compile status: ${status}. No log file was produced.`
    }
    const compileAsUser = Settings.disablePerUserCompiles ? undefined : ctx.botUserId
    const stream = await ClsiManager.promises.getOutputFileStream(
      ctx.projectId,
      compileAsUser,
      result.clsiServerId,
      logFile.build ?? result.buildId,
      'output.log'
    )
    const log = await streamToString(stream, MAX_LOG_BYTES)
    const parsed = new LatexParser(log, { ignoreDuplicates: true }).parse()
    const out = [
      `Compile status: ${status}. ${parsed.errors.length} error(s), ${parsed.warnings.length} warning(s), ${parsed.typesetting.length} box warning(s).`,
    ]
    if (parsed.errors.length > 0) {
      out.push('', 'Errors:')
      for (const e of parsed.errors.slice(0, MAX_LOG_ENTRIES)) out.push(formatLogEntry(e))
      if (parsed.errors.length > MAX_LOG_ENTRIES) out.push(`(${parsed.errors.length - MAX_LOG_ENTRIES} more)`)
    }
    if (parsed.warnings.length > 0) {
      out.push('', 'Warnings:')
      for (const w of parsed.warnings.slice(0, MAX_LOG_ENTRIES)) out.push(formatLogEntry(w))
      if (parsed.warnings.length > MAX_LOG_ENTRIES) out.push(`(${parsed.warnings.length - MAX_LOG_ENTRIES} more)`)
    }
    if (status !== 'success' && parsed.errors.length === 0) {
      const tail = log.split('\n').slice(-40).join('\n')
      out.push('', 'Last lines of the log:', tail)
    }
    return out.join('\n')
  },
}

// compile is opt-in: TeX can read any file the compile process can read
// (\input{/abs/path}), and a bot acts on text it reads, so a planted
// instruction could make it leak other projects' files through the log.
export const COMPILE_ENABLED = process.env.OVERLEAF_BOT_ALLOW_COMPILE === 'true'

export function enabledToolDefinitions() {
  return TOOL_DEFINITIONS.filter(t => COMPILE_ENABLED || t.name !== 'compile')
}

export async function callTool(ctx, name, args) {
  if (name === 'compile' && !COMPILE_ENABLED) return null
  const handler = Object.hasOwn(handlers, name) ? handlers[name] : null
  if (!handler) return null
  return await handler(ctx, args ?? {})
}

export default { TOOL_DEFINITIONS, enabledToolDefinitions, callTool, ToolError }
