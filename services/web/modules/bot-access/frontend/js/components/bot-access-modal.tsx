import { useCallback, useEffect, useState } from 'react'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import Notification from '@/shared/components/notification'
import { CopyToClipboard } from '@/shared/components/copy-to-clipboard'
import {
  deleteJSON,
  FetchError,
  getJSON,
  postJSON,
} from '@/infrastructure/fetch-json'
import { debugConsole } from '@/utils/debugging'

type Bot = {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  createdBy: string
  createdByName: string | null
  tokenPartial: string
}

type ListResponse = { mcpUrl: string; maxBots: number; bots: Bot[] }

type CreateResponse = {
  bot: Bot
  token: string
  serverName: string
  mcpUrl: string
  claudeCommand: string
  jsonConfig: string
  note: string
}

type Props = {
  show: boolean
  handleHide: () => void
  projectId: string
  projectName: string
}

function errorMessage(err: unknown) {
  if (err instanceof FetchError) {
    if (err.response?.status === 404) {
      return 'Bot access is not enabled on this server (OVERLEAF_BOT_ACCESS_ENABLED).'
    }
    const message = (err.data as { message?: string } | undefined)?.message
    if (message) return message
  }
  return 'Something went wrong. Please try again.'
}

function formatTime(value: string | null) {
  if (!value) return 'never'
  const d = new Date(value)
  return isNaN(d.getTime()) ? 'unknown' : d.toLocaleString()
}

export default function BotAccessModal({
  show,
  handleHide,
  projectId,
  projectName,
}: Props) {
  const [list, setList] = useState<ListResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState('Claude')
  const [created, setCreated] = useState<CreateResponse | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)

  const base = `/project/${projectId}/bot-access`

  const load = useCallback(() => {
    setLoading(true)
    getJSON<ListResponse>(base)
      .then(data => {
        setList(data)
        setError(null)
      })
      .catch(err => {
        debugConsole.error(err)
        setError(errorMessage(err))
      })
      .finally(() => setLoading(false))
  }, [base])

  useEffect(() => {
    if (!show) return
    setCreated(null)
    setConfirmRevoke(null)
    load()
  }, [show, load])

  const handleCreate = (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    postJSON<CreateResponse>(base, { body: { name } })
      .then(data => {
        setCreated(data)
        setError(null)
        load()
      })
      .catch(err => {
        debugConsole.error(err)
        setError(errorMessage(err))
      })
      .finally(() => setLoading(false))
  }

  const handleRevoke = (botId: string) => {
    setLoading(true)
    deleteJSON(`${base}/${botId}`)
      .then(() => {
        setConfirmRevoke(null)
        load()
      })
      .catch(err => {
        debugConsole.error(err)
        setError(errorMessage(err))
      })
      .finally(() => setLoading(false))
  }

  const bots = list?.bots ?? []
  const atLimit = list ? bots.length >= list.maxBots : false

  return (
    <OLModal show={show} onHide={handleHide} backdrop="static" size="lg">
      <OLModalHeader closeButton>
        <OLModalTitle>Connect a bot to “{projectName}”</OLModalTitle>
      </OLModalHeader>

      <OLModalBody>
        {error && <Notification type="error" content={error} />}

        {created ? (
          <>
            <Notification
              type="warning"
              content="Copy this now: the token is shown only once. Anyone with it can edit and comment in this project until you revoke it."
            />
            <p className="mt-3">
              <strong>Claude Code</strong> — run this in a terminal on the
              computer where the bot runs:
            </p>
            <pre className="p-2 bg-light" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {created.claudeCommand}
            </pre>
            <CopyToClipboard
              content={created.claudeCommand}
              tooltipId="bot-access-copy-command"
              kind="button"
            />
            <p className="mt-3">
              <strong>Other MCP clients</strong> — add this server
              configuration (Streamable HTTP):
            </p>
            <pre className="p-2 bg-light" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {created.jsonConfig}
            </pre>
            <CopyToClipboard
              content={created.jsonConfig}
              tooltipId="bot-access-copy-json"
              kind="button"
            />
            <p className="mt-3 text-muted">{created.note}</p>
          </>
        ) : (
          <>
            <p>
              A connected bot can read this project&apos;s text files, edit them
              (as <strong>tracked changes</strong> unless you ask it to edit
              directly), create new text files, comment and reply to comments.
              It cannot accept changes, delete files, upload images, change
              settings, or see other projects.
            </p>

            <form onSubmit={handleCreate}>
              <OLFormGroup controlId="bot-access-name">
                <OLFormLabel>Bot name (shown on its changes and comments)</OLFormLabel>
                <OLFormControl
                  type="text"
                  value={name}
                  maxLength={40}
                  onChange={e => setName((e.target as HTMLInputElement).value)}
                  disabled={loading || atLimit}
                />
              </OLFormGroup>
              <OLButton
                type="submit"
                variant="primary"
                disabled={loading || atLimit || name.trim() === ''}
              >
                Connect bot
              </OLButton>
              {atLimit && (
                <span className="ms-2 text-muted">
                  Limit reached: revoke a bot first.
                </span>
              )}
            </form>

            <h4 className="mt-4">Connected bots</h4>
            {bots.length === 0 ? (
              <p className="text-muted">{loading ? 'Loading…' : 'No bots connected.'}</p>
            ) : (
              <ul className="list-unstyled">
                {bots.map(bot => (
                  <li key={bot.id} className="d-flex align-items-center justify-content-between py-2 border-bottom">
                    <div>
                      <strong>{bot.name}</strong>{' '}
                      <span className="text-muted">({bot.tokenPartial})</span>
                      <div className="small text-muted">
                        Connected by {bot.createdByName ?? 'unknown'} on{' '}
                        {formatTime(bot.createdAt)} · last used{' '}
                        {formatTime(bot.lastUsedAt)}
                      </div>
                    </div>
                    {confirmRevoke === bot.id ? (
                      <div>
                        <OLButton
                          variant="danger"
                          size="sm"
                          disabled={loading}
                          onClick={() => handleRevoke(bot.id)}
                        >
                          Revoke now
                        </OLButton>{' '}
                        <OLButton
                          variant="secondary"
                          size="sm"
                          onClick={() => setConfirmRevoke(null)}
                        >
                          Cancel
                        </OLButton>
                      </div>
                    ) : (
                      <OLButton
                        variant="secondary"
                        size="sm"
                        onClick={() => setConfirmRevoke(bot.id)}
                      >
                        Revoke
                      </OLButton>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </OLModalBody>

      <OLModalFooter>
        {created ? (
          <OLButton variant="primary" onClick={() => setCreated(null)}>
            Done
          </OLButton>
        ) : (
          <OLButton variant="secondary" onClick={handleHide}>
            Close
          </OLButton>
        )}
      </OLModalFooter>
    </OLModal>
  )
}
