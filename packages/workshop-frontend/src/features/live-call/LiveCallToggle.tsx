import { VideoCamera } from '@phosphor-icons/react'
import { WorkshopIconButton } from '../../components/WorkshopControls'
import { isSameCall, useLiveCallActions, useLiveCallState } from './liveCallContext'

/**
 * The gadget view's Live button: shows or hides the live call sidebar for the gadget on screen.
 * Renders nothing unless live calls are enabled and a gadget view is registered.
 */
export const LiveCallToggle = () => {
  const state = useLiveCallState()
  const actions = useLiveCallActions()
  if (!state?.enabled || !state.viewed || !actions) return null
  const { status, viewed, panelOpen } = state
  const liveHere = status.phase === 'live' && isSameCall(status.call, viewed)
  const label = liveHere ? 'Live call (you’re in it)' : 'Live call'
  return (
    <WorkshopIconButton
      aria-label={label}
      title={label}
      aria-pressed={panelOpen}
      onClick={() => actions.setPanelOpen(!panelOpen)}
      className={`relative ${panelOpen ? '!bg-kumo-tint !text-kumo-default' : ''}`}
    >
      <VideoCamera size={16} weight={liveHere ? 'fill' : 'regular'} />
      {liveHere && (
        <span aria-hidden="true" className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-kumo-danger" />
      )}
    </WorkshopIconButton>
  )
}
