// The Connect bot dialog, mounted with the other rail modals and opened by
// the rail button. Non-editors see an explanation instead of the dialog.
import { useContext } from 'react'
import { useRailContext } from '@/features/ide-react/context/rail-context'
import { PermissionsContext } from '@/features/ide-react/context/permissions-context'
import { useProjectContext } from '@/shared/context/project-context'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import BotAccessModal from '../components/bot-access-modal'

function BotRailModal({ show }: { show: boolean }) {
  const { setActiveModal } = useRailContext()
  const permissions = useContext(PermissionsContext)
  const { projectId, name } = useProjectContext()
  const handleHide = () => setActiveModal(null)

  if (permissions && !permissions.write) {
    return (
      <OLModal show={show} onHide={handleHide}>
        <OLModalHeader closeButton>
          <OLModalTitle>Bot</OLModalTitle>
        </OLModalHeader>
        <OLModalBody>
          Only the project owner and editors can connect bots to this project.
        </OLModalBody>
        <OLModalFooter>
          <OLButton variant="secondary" onClick={handleHide}>
            Close
          </OLButton>
        </OLModalFooter>
      </OLModal>
    )
  }

  return (
    <BotAccessModal
      show={show}
      handleHide={handleHide}
      projectId={projectId}
      projectName={name}
    />
  )
}

export default {
  key: 'bot-access' as const,
  modalComponentFunction: BotRailModal,
}
