import type { CallLeaveReason, CallMeeting, CallParticipant } from './callMeeting'

/** Why someone's camera or microphone isn't reaching the call, if it isn't. */
export type CallMediaIssue = 'blocked' | 'unavailable' | null

/** One webcam tile: the local participant or someone else in the call. */
export type CallTile = {
  /** The participant's id within this meeting. */
  id: string
  name: string
  /** RealtimeKit's `customParticipantId`, which `CallRosterEntry.callParticipantId` matches. */
  callParticipantId: string | undefined
  audioEnabled: boolean
  videoEnabled: boolean
  self: boolean
}

/** What the call looks like now, as `CallSession.getSnapshot()` reports it. */
export type CallSnapshot = {
  /** The local participant first, then everyone else in the order they joined. */
  tiles: CallTile[]
  /** The tile id of whoever spoke last, or null. */
  speakingId: string | null
  media: { audio: CallMediaIssue; video: CallMediaIssue }
  /** The browser refused to start the others' audio until the page is interacted with. */
  soundBlocked: boolean
}

// How long Leave waits for the SDK before stopping the camera and microphone itself.
const LEAVE_TIMEOUT_MS = 3_000

const mediaIssue = (permission: string | undefined): CallMediaIssue => {
  switch (permission) {
    case 'DENIED': case 'SYSTEM_DENIED': case 'CANCELED': return 'blocked'
    case 'COULD_NOT_START': case 'NO_DEVICES_AVAILABLE': return 'unavailable'
    default: return null
  }
}

const stopTrack = (track: MediaStreamTrack | undefined) => {
  try {
    track?.stop()
  } catch {
    // Already ended.
  }
}

/**
 * A meeting the local participant has joined (or is joining), as a store React can subscribe to
 * with useSyncExternalStore. It owns every subscription to the meeting's events, and the video
 * elements registered with it, so closing it leaves nothing attached to the SDK.
 */
export class CallSession {
  readonly #meeting: CallMeeting
  readonly #onLeft: (reason: CallLeaveReason) => void
  // Insertion order is join order.
  readonly #others = new Map<string, CallParticipant>()
  readonly #listeners = new Set<() => void>()
  readonly #videos = new Map<HTMLVideoElement, () => void>()
  readonly #unsubscribe: (() => void)[] = []
  #speakingId: string | null = null
  #media: CallSnapshot['media']
  #soundBlocked = false
  #closed = false
  #snapshot: CallSnapshot

  /**
   * `mediaFailed` records that the meeting had to be opened without a camera or microphone, as
   * the browser refused them.
   */
  constructor(meeting: CallMeeting, options: { onLeft: (reason: CallLeaveReason) => void; mediaFailed: boolean }) {
    this.#meeting = meeting
    this.#onLeft = options.onLeft
    const permissions = meeting.self.mediaPermissions
    this.#media = options.mediaFailed
      ? { audio: 'blocked', video: 'blocked' }
      : { audio: mediaIssue(permissions.audio), video: mediaIssue(permissions.video) }
    this.#subscribe()
    this.#addJoined()
    this.#snapshot = this.#takeSnapshot()
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  readonly getSnapshot = (): CallSnapshot => this.#snapshot

  /** Picks up whoever was already in the call once joining completes. */
  syncParticipants(): void {
    this.#addJoined()
    this.#changed()
  }

  /** Shows a tile's camera in `element` until the returned function is called. */
  attachVideo(tileId: string, element: HTMLVideoElement): () => void {
    if (this.#closed) return () => {}
    const { self } = this.#meeting
    let detach: () => void
    if (tileId === self.id) {
      self.registerVideoElement(element, true)
      detach = () => self.deregisterVideoElement(element, true)
    } else {
      const participant = this.#others.get(tileId)
      if (!participant) return () => {}
      participant.registerVideoElement(element)
      detach = () => participant.deregisterVideoElement(element)
    }
    this.#videos.set(element, detach)
    return () => {
      if (this.#videos.get(element) !== detach) return
      this.#videos.delete(element)
      try {
        detach()
      } catch {
        // The participant already left.
      }
    }
  }

  async setAudioEnabled(enabled: boolean): Promise<void> {
    const { self } = this.#meeting
    try {
      await (enabled ? self.enableAudio() : self.disableAudio())
      if (enabled) this.#media = { ...this.#media, audio: mediaIssue(self.mediaPermissions.audio) }
    } catch {
      if (enabled) this.#media = { ...this.#media, audio: 'blocked' }
    }
    this.#changed()
  }

  async setVideoEnabled(enabled: boolean): Promise<void> {
    const { self } = this.#meeting
    try {
      await (enabled ? self.enableVideo() : self.disableVideo())
      if (enabled) this.#media = { ...this.#media, video: mediaIssue(self.mediaPermissions.video) }
    } catch {
      if (enabled) this.#media = { ...this.#media, video: 'blocked' }
    }
    this.#changed()
  }

  /** Starts the others' audio after the browser blocked autoplay; must run in a user gesture. */
  async playAudio(): Promise<void> {
    try {
      await this.#meeting.self.playAudio()
      this.#soundBlocked = false
    } catch {
      // Still blocked: the button stays for another try.
    }
    this.#changed()
  }

  /**
   * Leaves the meeting and makes sure the camera and microphone are released, even when the SDK
   * is slow to let go of them or never does.
   */
  async leave(): Promise<void> {
    if (this.#closed) return
    const tracks = this.#localTracks()
    this.#detach()
    // The tracks are stopped only once the SDK has let go of them: it restarts a camera whose
    // track ends under it.
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.#meeting.leave().catch(() => {}),
      new Promise<void>(resolve => { timer = setTimeout(resolve, LEAVE_TIMEOUT_MS) }),
    ])
    clearTimeout(timer)
    for (const track of new Set([...tracks, ...this.#localTracks()])) stopTrack(track)
  }

  /**
   * Detaches from a meeting the SDK has already left: drops every listener and video element,
   * and stops the local tracks.
   */
  close(): void {
    if (this.#closed) return
    this.#detach()
    for (const track of this.#localTracks()) stopTrack(track)
  }

  #detach() {
    this.#closed = true
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe()
    for (const detach of this.#videos.values()) {
      try {
        detach()
      } catch {
        // Already gone with the meeting.
      }
    }
    this.#videos.clear()
    this.#listeners.clear()
  }

  #localTracks(): (MediaStreamTrack | undefined)[] {
    try {
      const { self } = this.#meeting
      return [self.videoTrack, self.audioTrack]
    } catch {
      return []
    }
  }

  #subscribe() {
    const { self, participants } = this.#meeting
    const { joined } = participants
    const refresh = () => this.#changed()
    const onPermission = ({ message, kind }: { message: string; kind: 'audio' | 'video' | 'screenshare' }) => {
      if (kind === 'screenshare') return
      this.#media = { ...this.#media, [kind]: mediaIssue(message) }
      this.#changed()
    }
    const onAutoplayError = () => {
      this.#soundBlocked = true
      this.#changed()
    }
    const onRoomLeft = ({ state }: { state: CallLeaveReason }) => {
      if (!this.#closed) this.#onLeft(state)
    }
    const onJoined = (participant: CallParticipant) => {
      this.#others.set(participant.id, participant)
      this.#changed()
    }
    const onLeft = (participant: CallParticipant) => {
      this.#others.delete(participant.id)
      if (this.#speakingId === participant.id) this.#speakingId = null
      this.#changed()
    }
    const onActiveSpeaker = ({ peerId }: { peerId: string }) => {
      this.#speakingId = peerId
      this.#changed()
    }
    self.on('audioUpdate', refresh)
    self.on('videoUpdate', refresh)
    self.on('mediaPermissionUpdate', onPermission)
    self.on('autoplayError', onAutoplayError)
    self.on('roomLeft', onRoomLeft)
    // The joined map re-emits each participant's own events, so one subscription covers everyone.
    joined.on('participantJoined', onJoined)
    joined.on('participantLeft', onLeft)
    joined.on('audioUpdate', refresh)
    joined.on('videoUpdate', refresh)
    participants.on('activeSpeaker', onActiveSpeaker)
    this.#unsubscribe.push(() => {
      self.off('audioUpdate', refresh)
      self.off('videoUpdate', refresh)
      self.off('mediaPermissionUpdate', onPermission)
      self.off('autoplayError', onAutoplayError)
      self.off('roomLeft', onRoomLeft)
      joined.off('participantJoined', onJoined)
      joined.off('participantLeft', onLeft)
      joined.off('audioUpdate', refresh)
      joined.off('videoUpdate', refresh)
      participants.off('activeSpeaker', onActiveSpeaker)
    })
  }

  #addJoined() {
    const selfId = this.#meeting.self.id
    for (const participant of this.#meeting.participants.joined.toArray()) {
      if (participant.id !== selfId && !this.#others.has(participant.id)) {
        this.#others.set(participant.id, participant)
      }
    }
  }

  #changed() {
    if (this.#closed) return
    this.#snapshot = this.#takeSnapshot()
    for (const listener of this.#listeners) listener()
  }

  #takeSnapshot(): CallSnapshot {
    const { self } = this.#meeting
    type Shown = Pick<CallParticipant, 'id' | 'name' | 'customParticipantId' | 'audioEnabled' | 'videoEnabled'>
    const tile = (participant: Shown, isSelf: boolean): CallTile => ({
      id: participant.id,
      name: participant.name,
      callParticipantId: participant.customParticipantId,
      audioEnabled: participant.audioEnabled,
      videoEnabled: participant.videoEnabled,
      self: isSelf,
    })
    return {
      tiles: [tile(self, true), ...[...this.#others.values()].map(other => tile(other, false))],
      speakingId: this.#speakingId,
      media: this.#media,
      soundBlocked: this.#soundBlocked,
    }
  }
}
