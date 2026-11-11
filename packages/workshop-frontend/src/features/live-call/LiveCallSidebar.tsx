import { VideoCamera } from '@phosphor-icons/react'
import { LiveCallPanel } from './LiveCallPanel'
import { isSameCall, useLiveCallActions, useLiveCallState, type LiveCallStatus } from './liveCallContext'
import { useCallRoster } from './useCallRoster'
import { useCallSnapshot } from './useCallSnapshot'
import { useWideLayout } from './useWideLayout'

const IDLE: LiveCallStatus = { phase: 'idle' }

// Collapsed, the call stays one tap away, clear of the top bars (and of the composer at the
// bottom of a phone).
const PILL_POSITION = 'fixed right-3 top-28 z-[60] md:right-4 md:top-16'

const LiveCallPill = ({ status, onExpand }: { status: LiveCallStatus; onExpand: () => void }) => {
  const snapshot = useCallSnapshot(status.phase === 'live' ? status.session : null)
  const label = status.phase === 'live'
    ? `Live · ${snapshot?.tiles.length ?? 1}`
    : status.phase === 'joining' ? 'Joining…' : 'Call interrupted'
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={`Show live call (${label})`}
      className={`${PILL_POSITION} flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-kumo-line bg-kumo-base px-3 text-[12px] font-medium text-kumo-default transition-[background-color,transform] duration-150 hover:bg-kumo-tint active:scale-[0.97] shadow-md shadow-kumo-tip-shadow`}
    >
      {status.phase === 'live'
        ? <span aria-hidden="true" className="h-2 w-2 rounded-full bg-kumo-danger" />
        : <VideoCamera size={14} className="text-kumo-subtle" />}
      {label}
    </button>
  )
}

/**
 * The live call's sidebar, rendered once beside the routed page so a call survives navigation:
 * a column of its own on `md` and wider, a small overlay on phones, and a pill when collapsed
 * during a call. While idle it shows only when opened from a gadget view, about that gadget.
 */
export const LiveCallSidebar = () => {
  const state = useLiveCallState()
  const actions = useLiveCallActions()
  const wide = useWideLayout()
  const status = state?.status ?? IDLE
  const viewed = state?.viewed ?? null
  const inCall = status.phase !== 'idle'
  const subject = inCall ? status.call : viewed
  const viewingSubject = viewed !== null && subject !== null && isSameCall(viewed, subject)
  const shown = state !== null && state.enabled && (inCall || (state.panelOpen && viewed !== null))
  const roster = useCallRoster({
    key: subject && `${subject.workspaceId}:${subject.gadgetId}`,
    client: viewingSubject ? viewed.client : null,
    // While live the roster names the others' avatars, so it keeps up even when collapsed.
    active: shown && (state.panelOpen || status.phase === 'live'),
  })

  if (!shown || !actions) return null
  if (!state.panelOpen) return <LiveCallPill status={status} onExpand={() => actions.setPanelOpen(true)} />

  const panel = <LiveCallPanel status={status} viewed={viewed} roster={roster} />
  return wide ? (
    <aside aria-label="Live call" className="flex h-full w-56 shrink-0 flex-col border-l border-kumo-line bg-kumo-base">
      {panel}
    </aside>
  ) : (
    <aside
      aria-label="Live call"
      className="fixed right-3 top-28 z-[60] flex max-h-[calc(100dvh-8rem)] w-[min(11rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-kumo-line bg-kumo-base shadow-lg shadow-kumo-tip-shadow"
    >
      {panel}
    </aside>
  )
}
