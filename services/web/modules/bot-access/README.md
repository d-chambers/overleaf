# bot-access

Connect an AI assistant ("bot") to **one project**. The bot talks to Overleaf
over [MCP](https://modelcontextprotocol.io) (Streamable HTTP) at
`POST /api/v1/bot/mcp`. By default its edits are **tracked changes** that a
human reviews; it is instructed to edit directly (`track_changes: false`) only
when the user explicitly asks, and it can create new text files. It cannot
accept, reject or resolve changes, or delete files. Images and PDFs are uploaded
through single-use links from `prepare_upload`.

Enable with `OVERLEAF_BOT_ACCESS_ENABLED=true`.

## Connecting a bot

1. Open the project → click **Bot** (robot icon, left rail, just below Help) → **Connect bot**.
2. Name the bot (its changes and comments appear as "<name> (bot)").
3. Copy the command shown once, e.g. for Claude Code:

       claude mcp add --transport http overleaf-my-paper \
         https://overleaf.example/api/v1/bot/mcp \
         --header "Authorization: Bearer olb_…"

   Other MCP clients get an equivalent JSON server configuration.
4. Revoke from the same card at any time.

Only the project owner and editors can connect or revoke bots. A project can
have at most 10 bots.

## Tools

| Tool | Arguments | Effect |
| --- | --- | --- |
| `list_files` | — | Text files (readable/editable) and binary files of the project, and the main file. |
| `read_file` | `path`, `start_line?`, `end_line?` | Current text with line numbers and doc version, at most 2000 lines per call. Pending tracked insertions are included, pending deletions are not. |
| `edit_file` | `path`, `old_text`, `new_text`, `track_changes?` (default `true`), `comment?` | Replaces the single occurrence of `old_text` with `new_text`: as a tracked change by the bot, or directly when `track_changes` is `false`. Refused if `old_text` is missing or ambiguous, or if the doc changed between read and write. |
| `create_file` | `path`, `content` | Creates a new text file (`.tex`, `.bib`, `.sty`, ...; folders as needed) directly. Never overwrites; binaries are not allowed. |
| `prepare_upload` | `path`, `overwrite?` (default `false`) | Returns a one-time link and `curl` command to upload a binary file (`.png`, `.jpg`, `.pdf`, `.svg`, `.eps`, ...) to that path. The bot PUTs the raw file there (`Content-Type: application/octet-stream`); bytes never pass through the model. The link is bound to this bot, project and path, works once, expires after 10 minutes, and is checked again on upload (bot not revoked, creator can still edit, path still free, file starts with the right signature, at most `MAX_UPLOAD_SIZE`). |
| `comment` | `path`, `quote`, `text` | Review comment anchored to the single occurrence of `quote`. |
| `reply` | `thread_id`, `text` | Reply to a comment thread of this project. |
| `list_review` | `include_resolved?` | Comment threads (with ids) and pending tracked changes, as Markdown. |
| `compile` | — | Compiles with the project's settings (including pending tracked changes, in a per-bot build directory) and returns errors and warnings parsed from the LaTeX log. |

## Security model

- **Scope.** A token belongs to one project. Every call resolves files through
  that project's file tree; ids from other projects are never accepted.
- **Identity.** Each token gets its own user (`bot-<id>@bot.invalid`, no
  password, no single-sign-on link), so it cannot log in to the website and
  password resets cannot reach anyone. The bot user is not a project member.
  Revoking deletes the token; the user remains so past changes keep an author.
- **Liveness.** A token works only while the project exists and the person who
  connected the bot still has edit access to it.
- **Storage.** Tokens are `olb_` + 40 random characters; only their SHA-256 is
  stored (`botTokens` collection). The last-used time is recorded (1 minute
  resolution) and shown on the card.
- **Limits.** 600 requests/minute per IP before authentication, 120 per bot
  after. Requests with an `Origin` header from another site are refused
  (DNS-rebinding protection required by the MCP transport spec).
- **Writes are attributed, and tracked by default.** Edits go through
  document-updater's set-document path, so they appear live in open editors,
  attributed to the bot; with `track_changes` (the default) they are tracked
  changes. Direct edits and new files are recorded in project history under
  the bot's name. The bot has no tool to accept, reject, resolve or delete.
- **Compiles are not a security boundary.** In Community Edition compiles run
  inside the main container, and on TeX Live 2026 `openin_any = p` does not
  stop `\openin`/`\input` of absolute or `../` paths (tested). A bot (or any
  editor) can therefore make a compile read files the compile process can
  read, and see them through the `compile` tool's log output. Treat a bot like
  an editor of the project, and use sandboxed compiles if that is not
  acceptable.
- **Prompt injection.** Document text is written by other people; the server
  instructions tell the bot to treat it as content, but a bot can still be
  misled. Keep direct edits for requests you made yourself; everything the
  bot does stays in project history.

## Protocol notes

Stateless JSON responses (no SSE stream, no `Mcp-Session-Id`); `GET` and
other methods answer `405`. Supported protocol versions: 2025-06-18,
2025-03-26, 2024-11-05. Tool failures the bot can fix are returned as tool
results with `isError: true`.

## Compile is opt-in

The `compile` tool is only offered when `OVERLEAF_BOT_ALLOW_COMPILE=true`.
TeX's `openin_any` setting does not confine `\input`/`\openin` in this image
(tested), so a compile can read any file the compile process can read, and the
log comes back to the bot. A bot acts on text it reads, so an instruction
planted in a document or comment could make it exfiltrate other projects'
files this way. Leave it off unless every collaborator on projects you connect
bots to is trusted.

