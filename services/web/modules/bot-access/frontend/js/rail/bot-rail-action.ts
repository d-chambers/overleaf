// Left-rail button (next to Help) that opens the Connect bot dialog.
import getMeta from '@/utils/meta'
import { dispatchOpenRailModal } from '@/features/ide-react/context/rail-context'
import type { RailAction } from '@/features/ide-react/components/rail/rail-action-element'

const botRailAction: RailAction = {
  key: 'bot-access',
  icon: 'smart_toy',
  title: 'Bot',
  // Only when the module is on (OVERLEAF_BOT_ACCESS_ENABLED).
  hide: !getMeta('ol-ExposedSettings')?.botAccessEnabled,
  action: () => dispatchOpenRailModal('bot-access'),
}

export default botRailAction
