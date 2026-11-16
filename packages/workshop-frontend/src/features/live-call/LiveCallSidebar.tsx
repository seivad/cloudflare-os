import { VideoCamera } from '@phosphor-icons/react'
import type { CallStatus } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { LiveCallPanel } from './LiveCallPanel'
import { LiveCallResizeHandle } from './LiveCallResizeHandle'
import {
  isSameCall,
  useLiveCallActions,
  useLiveCallState,
  type LiveCallGadget,
  type LiveCallStatus,
} from './liveCallContext'
import { rosterSummary } from './rosterSummary'
import { useCallSnapshot } from './useCallSnapshot'
import { useCallStatus } from './useCallStatus'
import { useLiveCallWidth } from './useLiveCallWidth'
import { useWideLayout } from './useWideLayout'

const IDLE: LiveCallStatus = { phase: 'idle' }

// Collapsed, the call stays one tap away, clear of the top bars (and of the composer at the
// bottom of a phone).
const PILL_POSITION = 'fixed right-3 top-28 z-[60] md:right-4 md:top-16'
const PILL_SURFACE = 'rounded-full border border-kumo-line bg-kumo-base text-[12px] font-medium text-kumo-default shadow-md shadow-kumo-tip-shadow'

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
      className={`${PILL_POSITION} ${PILL_SURFACE} flex h-9 cursor-pointer items-center gap-1.5 px-3 transition-[background-color,transform] duration-150 hover:bg-kumo-tint active:scale-[0.97]`}
    >
      {status.phase === 'live'
        ? <span aria-hidden="true" className="h-2 w-2 rounded-full bg-kumo-danger" />
        : <VideoCamera size={14} className="text-kumo-subtle" />}
      {label}
    </button>
  )
}

// Who is already in the call of the gadget on screen, with Join: one click joins an open call,
// while a locked one opens the sidebar to ask for its PIN.
const LivePresencePill = ({ callStatus, onJoin, onExpand }: {
  callStatus: CallStatus
  onJoin: () => void
  onExpand: () => void
}) => {
  const { currentUser } = useAuthenticatedApi()
  const summary = rosterSummary(callStatus.roster, currentUser?.id ?? null)
  return (
    <div role="region" aria-label="Live call in progress" className={`${PILL_POSITION} ${PILL_SURFACE} flex h-9 max-w-[min(20rem,calc(100vw-1.5rem))] items-center gap-1 pl-1 pr-1`}>
      <button
        type="button"
        onClick={onExpand}
        aria-label={`Show live call (${summary})`}
        className="flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-full px-2 hover:bg-kumo-tint"
      >
        <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-kumo-danger" />
        <span className="truncate">{summary}</span>
      </button>
      <button
        type="button"
        onClick={callStatus.pinRequired ? onExpand : onJoin}
        className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-kumo-brand px-3 font-semibold text-kumo-inverse transition-[background-color,transform] duration-150 hover:bg-kumo-brand-hover active:scale-[0.97]"
      >
        <VideoCamera size={13} weight="fill" aria-hidden="true" /> Join
      </button>
    </div>
  )
}

/**
 * The live call's sidebar, rendered once beside the routed page so a call survives navigation:
 * a column of its own on `md` and wider, which can be dragged wider, a small overlay on phones,
 * and a pill when collapsed during a call. While idle it shows when opened from a gadget view,
 * about that gadget, and otherwise, while someone is in that gadget's call, a pill with Join.
 */
export const LiveCallSidebar = () => {
  const state = useLiveCallState()
  const actions = useLiveCallActions()
  const wide = useWideLayout()
  const [width, setWidth] = useLiveCallWidth()
  const status = state?.status ?? IDLE
  const viewed = state?.viewed ?? null
  const inCall = status.phase !== 'idle'
  const subject = inCall ? status.call : viewed
  const viewingSubject = viewed !== null && subject !== null && isSameCall(viewed, subject)
  const shown = state !== null && state.enabled && (inCall || (state.panelOpen && viewed !== null))
  const { status: callStatus, refresh } = useCallStatus({
    key: subject && `${subject.workspaceId}:${subject.gadgetId}`,
    client: viewingSubject ? viewed.client : null,
    // Idle, it is how a gadget's view learns someone is live in it. While live it names the
    // others' avatars, so it keeps up even when collapsed.
    active: state !== null && state.enabled && (inCall ? state.panelOpen || status.phase === 'live' : viewed !== null),
  })

  if (!state?.enabled || !actions) return null
  if (!shown) {
    if (viewed === null || !callStatus?.roster.length) return null
    const gadget: LiveCallGadget = viewed
    return (
      <LivePresencePill
        callStatus={callStatus}
        onJoin={() => actions.join(gadget)}
        onExpand={() => actions.setPanelOpen(true)}
      />
    )
  }
  if (!state.panelOpen) return <LiveCallPill status={status} onExpand={() => actions.setPanelOpen(true)} />

  const panel = <LiveCallPanel status={status} viewed={viewed} callStatus={callStatus} onCallStatusChange={refresh} />
  return wide ? (
    <aside
      aria-label="Live call"
      style={{ width }}
      className="relative flex h-full max-w-[60vw] shrink-0 flex-col border-l border-kumo-line bg-kumo-base"
    >
      <LiveCallResizeHandle width={width} onWidthChange={setWidth} />
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
