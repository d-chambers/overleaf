import { useContext, useState } from 'react'
import IntegrationCard from '@/features/integrations-panel/integration-card'
import MaterialIcon from '@/shared/components/material-icon'
import { PermissionsContext } from '@/features/ide-react/context/permissions-context'
import { useProjectContext } from '@/shared/context/project-context'
import getMeta from '@/utils/meta'
import BotAccessModal from './bot-access-modal'

export default function BotIntegrationCard() {
  const permissions = useContext(PermissionsContext)
  const { projectId, name } = useProjectContext()
  const [showModal, setShowModal] = useState(false)

  // Hidden unless the module is on (OVERLEAF_BOT_ACCESS_ENABLED), and only
  // owners and editors can connect bots (the server enforces this too).
  if (!getMeta('ol-ExposedSettings').botAccessEnabled) return null
  if (permissions && !permissions.write) return null

  return (
    <>
      <IntegrationCard
        title="Bot"
        description="Connect an AI assistant that can edit (tracked by default) and comment in this project."
        icon={<MaterialIcon type="smart_toy" />}
        showPaywallBadge={false}
        onClick={() => setShowModal(true)}
      />
      <BotAccessModal
        show={showModal}
        handleHide={() => setShowModal(false)}
        projectId={projectId}
        projectName={name}
      />
    </>
  )
}
