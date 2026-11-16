import { useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Input, Loader, Switch } from '@cloudflare/kumo'
import {
  ArrowLeft,
  Microphone,
  MicrophoneSlash,
  Minus,
  PhoneDisconnect,
  SpeakerHigh,
  UserPlus,
  VideoCamera,
  VideoCameraSlash,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import type { CallJoinOptions, CallStatus } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { PersonAvatar } from '../../components/PersonAvatar'
import { WorkshopButton, WorkshopIconButton } from '../../components/WorkshopControls'
import { isCallPin, pinDigits, randomCallPin } from './callPin'
import type { CallSnapshot } from './callSession'
import { LiveCallPinControl } from './LiveCallPinControl'
import { LiveCallTile } from './LiveCallTile'
import {
  isSameCall,
  useLiveCallActions,
  type LiveCallGadget,
  type LiveCallInfo,
  type LiveCallStatus,
  type LiveCallTarget,
} from './liveCallContext'
import { rosterSummary } from './rosterSummary'
import { useCallSnapshot } from './useCallSnapshot'

// What to tell someone whose camera or microphone isn’t reaching the call, if anything.
const mediaHint = ({ audio, video }: CallSnapshot['media']): string | null => {
  if (audio === 'blocked' && video === 'blocked') {
    return 'Camera and microphone are blocked — others can’t see or hear you. Allow access in your browser to share.'
  }
  if (video === 'blocked') {
    return 'Your camera is blocked — others can’t see you. Allow access in your browser to share it.'
  }
  if (audio === 'blocked') {
    return 'Your microphone is blocked — others can’t hear you. Allow access in your browser to share it.'
  }
  if (audio === 'unavailable' && video === 'unavailable') {
    return 'No camera or microphone was found — others can’t see or hear you.'
  }
  if (video === 'unavailable') return 'No camera was found — others can’t see you.'
  if (audio === 'unavailable') return 'No microphone was found — others can’t hear you.'
  return null
}

const GadgetLink = ({ target, className, children }: {
  target: LiveCallTarget
  className: string
  children: ReactNode
}) => (
  <Link
    to="/workspace/$id"
    params={{ id: target.workspaceId }}
    search={{ w: target.gadgetId }}
    className={className}
  >
    {children}
  </Link>
)

const Header = ({ eyebrow, title, live, action }: {
  eyebrow: string
  title: string
  live: boolean
  action: { label: string; icon: ReactNode; onClick: () => void }
}) => (
  <div className="flex h-14 shrink-0 items-center gap-2 border-b border-kumo-line px-3">
    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-kumo-tint text-kumo-subtle">
      <VideoCamera size={15} weight={live ? 'fill' : 'duotone'} className={live ? 'text-kumo-danger' : undefined} />
    </div>
    <div className="min-w-0 flex-1">
      <p className="flex items-center gap-1.5 text-[11px] leading-4 font-medium tracking-[-0.1px] text-kumo-subtle">
        {live && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-kumo-danger" />}
        {eyebrow}
      </p>
      <p className="truncate text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default">
        {title || 'Gadget'}
      </p>
    </div>
    <WorkshopIconButton aria-label={action.label} title={action.label} onClick={action.onClick}>
      {action.icon}
    </WorkshopIconButton>
  </div>
)

const Notice = ({ tone = 'subtle', children }: { tone?: 'subtle' | 'danger'; children: ReactNode }) => (
  <div
    role={tone === 'danger' ? 'alert' : 'status'}
    className={`flex items-start gap-2 rounded-xl px-2.5 py-2 text-[12px] leading-4 ${
      tone === 'danger' ? 'bg-kumo-danger-tint text-kumo-default' : 'bg-kumo-tint text-kumo-default'
    }`}
  >
    <WarningCircle size={14} className={`mt-px shrink-0 ${tone === 'danger' ? 'text-kumo-danger' : 'text-kumo-subtle'}`} />
    <div className="min-w-0">{children}</div>
  </div>
)

const InviteFooterAction = ({ call, viewed }: { call: LiveCallInfo; viewed: LiveCallGadget | null }) => {
  if (!call.canInvite) return null
  if (viewed && isSameCall(viewed, call) && viewed.invite) {
    const { invite } = viewed
    return (
      <WorkshopButton tone="secondary" className="w-full gap-1.5" onClick={() => invite()}>
        <UserPlus size={14} /> Invite
      </WorkshopButton>
    )
  }
  return (
    <GadgetLink
      target={call}
      className="block truncate rounded-lg px-2 py-1.5 text-center text-[12px] leading-4 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
    >
      Open {call.gadgetTitle || 'the gadget'} to invite
    </GadgetLink>
  )
}

// A PIN typed into a field: digits only, entered with Enter.
const PinInput = ({ label, description, value, onValueChange, onEnter }: {
  label: string
  description: string
  value: string
  onValueChange: (pin: string) => void
  onEnter: () => void
}) => (
  <Input
    size="sm"
    className="w-full font-mono tracking-[0.2em] tabular-nums"
    label={label}
    description={description}
    value={value}
    inputMode="numeric"
    autoComplete="off"
    passwordManagerIgnore
    maxLength={6}
    onChange={event => onValueChange(pinDigits(event.target.value))}
    onKeyDown={event => {
      if (event.key === 'Enter') onEnter()
    }}
  />
)

const IdleContent = ({ viewed, callStatus, failure }: {
  viewed: LiveCallGadget
  callStatus: CallStatus | null
  failure: string | null
}) => {
  const actions = useLiveCallActions()
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const [locking, setLocking] = useState(false)
  const [startPin, setStartPin] = useState(randomCallPin)
  const [pin, setPin] = useState('')
  const { invite } = viewed
  const roster = callStatus?.roster ?? null
  const live = roster !== null && roster.length > 0
  const pinRequired = live && callStatus?.pinRequired === true
  // Joining a call someone is in, or starting one; only the starter chooses a PIN.
  const join: { label: string; options: CallJoinOptions; ready: boolean } = live
    ? { label: 'Join call', options: pinRequired ? { pin } : {}, ready: !pinRequired || isCallPin(pin) }
    : { label: 'Start call', options: { startPin: locking ? startPin : null }, ready: !locking || isCallPin(startPin) }
  const submit = () => {
    if (join.ready) actions?.join(viewed, join.options)
  }
  return (
    <>
      <Header
        eyebrow="Live call"
        title={viewed.gadgetTitle}
        live={false}
        action={{ label: 'Close live call', icon: <X size={15} />, onClick: () => actions?.setPanelOpen(false) }}
      />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
        <p role="status" className="text-[13px] leading-[18px] tracking-[-0.2px] text-kumo-default">
          {roster === null ? 'Checking who’s live…' : rosterSummary(roster, currentUser?.id ?? null)}
        </p>
        {roster !== null && roster.length > 0 && (
          <ul aria-label="In the call" className="space-y-1.5">
            {roster.map(entry => (
              <li key={entry.callParticipantId} className="flex items-center gap-2">
                <PersonAvatar api={authenticatedApi} userId={entry.profileId} name={entry.name} size={24} />
                <span className="truncate text-[12px] leading-4 text-kumo-default">
                  {entry.profileId === currentUser?.id ? `${entry.name} (you)` : entry.name}
                </span>
              </li>
            ))}
          </ul>
        )}
        {pinRequired && (
          <PinInput
            label="Call PIN"
            description="This call is locked. Ask the person who started it for its PIN."
            value={pin}
            onValueChange={setPin}
            onEnter={submit}
          />
        )}
        {roster !== null && !live && (
          <div className="space-y-2 rounded-xl border border-kumo-line px-2.5 py-2">
            <Switch size="sm" label="Require a PIN to join" checked={locking} onCheckedChange={setLocking} />
            {locking && (
              <PinInput
                label="PIN"
                description="4 to 6 digits. You’ll see it during the call, to give to the people you want in."
                value={startPin}
                onValueChange={setStartPin}
                onEnter={submit}
              />
            )}
          </div>
        )}
        {failure !== null && (
          <Notice tone="danger">
            <p className="font-medium">Couldn’t join the live call.</p>
            <p className="mt-0.5 break-words text-kumo-subtle">{failure}</p>
          </Notice>
        )}
      </div>
      <div className="shrink-0 space-y-2 border-t border-kumo-line p-3">
        <WorkshopButton tone="primary" className="w-full gap-1.5" disabled={!join.ready} onClick={submit}>
          <VideoCamera size={15} weight="fill" /> {join.label}
        </WorkshopButton>
        {invite && (
          <WorkshopButton tone="secondary" className="w-full gap-1.5" onClick={() => invite()}>
            <UserPlus size={14} /> Invite
          </WorkshopButton>
        )}
      </div>
    </>
  )
}

const JoiningContent = ({ call }: { call: LiveCallInfo }) => {
  const actions = useLiveCallActions()
  return (
    <>
      <Header
        eyebrow="Joining…"
        title={call.gadgetTitle}
        live={false}
        action={{ label: 'Hide live call', icon: <Minus size={15} />, onClick: () => actions?.setPanelOpen(false) }}
      />
      <div className="min-h-0 flex-1 p-3">
        <div role="status" className="grid aspect-video place-items-center rounded-xl bg-kumo-recessed ring-1 ring-inset ring-kumo-line">
          <span className="flex flex-col items-center gap-2 text-[12px] text-kumo-subtle">
            <Loader size="sm" />
            Joining the call…
          </span>
        </div>
      </div>
      <div className="shrink-0 border-t border-kumo-line p-3">
        <WorkshopButton tone="secondary" className="w-full" onClick={() => actions?.leave()}>
          Cancel
        </WorkshopButton>
      </div>
    </>
  )
}

const InterruptedContent = ({ call, viewed }: { call: LiveCallInfo; viewed: LiveCallGadget | null }) => {
  const actions = useLiveCallActions()
  const rejoinable = viewed !== null && isSameCall(viewed, call) ? viewed : null
  return (
    <>
      <Header
        eyebrow="Call interrupted"
        title={call.gadgetTitle}
        live={false}
        action={{ label: 'Hide live call', icon: <Minus size={15} />, onClick: () => actions?.setPanelOpen(false) }}
      />
      <div className="min-h-0 flex-1 space-y-3 p-3">
        <Notice>The connection to the live call was lost.</Notice>
        {rejoinable ? (
          <WorkshopButton tone="primary" className="w-full gap-1.5" onClick={() => actions?.join(rejoinable)}>
            <VideoCamera size={15} weight="fill" /> Rejoin
          </WorkshopButton>
        ) : (
          <GadgetLink
            target={call}
            className="block truncate rounded-lg bg-kumo-tint px-2 py-2 text-center text-[12px] font-medium text-kumo-default hover:bg-kumo-fill"
          >
            Open {call.gadgetTitle || 'the gadget'} to rejoin
          </GadgetLink>
        )}
      </div>
      <div className="shrink-0 border-t border-kumo-line p-3">
        <WorkshopButton tone="secondary" className="w-full" onClick={() => actions?.leave()}>
          Dismiss
        </WorkshopButton>
      </div>
    </>
  )
}

const LiveContent = ({ status, viewed, callStatus, onCallStatusChange }: {
  status: Extract<LiveCallStatus, { phase: 'live' }>
  viewed: LiveCallGadget | null
  callStatus: CallStatus | null
  onCallStatusChange: () => void
}) => {
  const actions = useLiveCallActions()
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const { call, session } = status
  const snapshot = useCallSnapshot(session)
  if (!snapshot) return null
  const viewingCall = viewed !== null && isSameCall(viewed, call)
  const switchTo = viewed !== null && !viewingCall ? viewed : null
  const hint = mediaHint(snapshot.media)
  const profiles = new Map(callStatus?.roster.map(entry => [entry.callParticipantId, entry.profileId]))
  const self = snapshot.tiles[0]
  const viewedClient = viewingCall && viewed ? viewed.client : null

  return (
    <>
      <Header
        eyebrow="Live"
        title={call.gadgetTitle}
        live
        action={{ label: 'Hide live call', icon: <Minus size={15} />, onClick: () => actions?.setPanelOpen(false) }}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-3">
        {!viewingCall && (
          <GadgetLink
            target={call}
            className="flex items-center gap-1.5 rounded-lg px-1 text-[12px] leading-5 font-medium text-kumo-brand hover:underline"
          >
            <ArrowLeft size={12} weight="bold" /> Back to gadget
          </GadgetLink>
        )}
        {switchTo && (
          <div className="rounded-xl border border-kumo-line px-2.5 py-2">
            <p className="truncate text-[12px] leading-4 text-kumo-subtle">
              Viewing {switchTo.gadgetTitle || 'another gadget'}
            </p>
            <WorkshopButton tone="secondary" className="mt-1.5 w-full" onClick={() => actions?.join(switchTo)}>
              Switch call
            </WorkshopButton>
          </div>
        )}
        {hint && <Notice>{hint}</Notice>}
        {snapshot.soundBlocked && (
          <WorkshopButton tone="secondary" className="w-full shrink-0 gap-1.5" onClick={() => void session.playAudio()}>
            <SpeakerHigh size={14} /> Click to enable sound
          </WorkshopButton>
        )}
        {callStatus?.startedByYou && (
          <LiveCallPinControl
            pin={callStatus.pin}
            onPinChange={viewedClient && (async pin => {
              await viewedClient.setCallPin(pin)
              onCallStatusChange()
            })}
          />
        )}
        {/* As the sidebar widens, the tiles grow and then wrap into columns. */}
        <ul aria-label="People in the call" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-2">
          {snapshot.tiles.map(tile => (
            <LiveCallTile
              key={tile.id}
              tile={tile}
              session={session}
              speaking={snapshot.speakingId === tile.id}
              profileId={tile.self
                ? currentUser?.id ?? null
                : tile.callParticipantId === undefined ? null : profiles.get(tile.callParticipantId) ?? null}
              authenticatedApi={authenticatedApi}
            />
          ))}
        </ul>
      </div>
      <div className="shrink-0 space-y-2 border-t border-kumo-line p-3">
        <div className="flex items-center justify-center gap-2">
          <WorkshopIconButton
            aria-label={self.audioEnabled ? 'Mute microphone' : 'Unmute microphone'}
            title={self.audioEnabled ? 'Mute microphone' : 'Unmute microphone'}
            className={self.audioEnabled ? '' : '!text-kumo-danger'}
            onClick={() => void session.setAudioEnabled(!self.audioEnabled)}
          >
            {self.audioEnabled ? <Microphone size={16} /> : <MicrophoneSlash size={16} />}
          </WorkshopIconButton>
          <WorkshopIconButton
            aria-label={self.videoEnabled ? 'Turn camera off' : 'Turn camera on'}
            title={self.videoEnabled ? 'Turn camera off' : 'Turn camera on'}
            className={self.videoEnabled ? '' : '!text-kumo-danger'}
            onClick={() => void session.setVideoEnabled(!self.videoEnabled)}
          >
            {self.videoEnabled ? <VideoCamera size={16} /> : <VideoCameraSlash size={16} />}
          </WorkshopIconButton>
          <WorkshopIconButton danger aria-label="Leave call" title="Leave call" onClick={() => actions?.leave()}>
            <PhoneDisconnect size={16} />
          </WorkshopIconButton>
        </div>
        <InviteFooterAction call={call} viewed={viewed} />
      </div>
    </>
  )
}

/**
 * The sidebar's content for whatever phase the call is in: who's live and Join when idle, then
 * the webcams with the local controls and Invite pinned at the bottom.
 */
export const LiveCallPanel = ({ status, viewed, callStatus, onCallStatusChange }: {
  status: LiveCallStatus
  /** The gadget view on screen; required while idle, since the idle panel is about it. */
  viewed: LiveCallGadget | null
  /** Who is in the call and whether it needs a PIN, or null until known. */
  callStatus: CallStatus | null
  /** Asks for the call's status again, as after its PIN changed. */
  onCallStatusChange: () => void
}) => {
  switch (status.phase) {
    case 'idle': {
      if (!viewed) return null
      const failure = status.failure && isSameCall(status.failure.target, viewed) ? status.failure.message : null
      return <IdleContent viewed={viewed} callStatus={callStatus} failure={failure} />
    }
    case 'joining':
      return <JoiningContent call={status.call} />
    case 'interrupted':
      return <InterruptedContent call={status.call} viewed={viewed} />
    case 'live':
      return <LiveContent status={status} viewed={viewed} callStatus={callStatus} onCallStatusChange={onCallStatusChange} />
  }
}
