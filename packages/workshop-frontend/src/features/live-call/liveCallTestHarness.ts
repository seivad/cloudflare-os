// A stand-in for a RealtimeKit meeting, for the live call's tests: the events the SDK emits, the
// calls it takes, and enough bookkeeping (tracks stopped, video elements attached) to assert on.

import type { CallLeaveReason, CallMeeting } from './callMeeting'

type Handler = (...args: never[]) => void

class FakeEmitter {
  readonly #handlers = new Map<string, Set<Handler>>()

  on(event: string, handler: Handler): this {
    let handlers = this.#handlers.get(event)
    if (!handlers) this.#handlers.set(event, handlers = new Set())
    handlers.add(handler)
    return this
  }

  off(event: string, handler: Handler): this {
    this.#handlers.get(event)?.delete(handler)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.#handlers.get(event) ?? []) (handler as (...a: unknown[]) => void)(...args)
  }

  /** How many handlers are attached, across every event. */
  listenerCount(): number {
    return [...this.#handlers.values()].reduce((count, handlers) => count + handlers.size, 0)
  }
}

/** A local media track that records being stopped. */
export class FakeTrack {
  stopCount = 0
  constructor(readonly kind: 'audio' | 'video') {}
  stop() { this.stopCount++ }
}

/** Someone else in the fake call. */
export class FakeParticipant extends FakeEmitter {
  audioEnabled = true
  videoEnabled = true
  readonly videoElements = new Set<HTMLVideoElement>()

  constructor(
    readonly id: string,
    readonly name: string,
    readonly customParticipantId?: string,
    /** Called as each video element is registered, e.g. to give it a stream. */
    readonly onVideoElement?: (element: HTMLVideoElement) => void,
  ) {
    super()
  }

  registerVideoElement(element: HTMLVideoElement) {
    this.videoElements.add(element)
    this.onVideoElement?.(element)
  }

  deregisterVideoElement(element?: HTMLVideoElement) {
    if (element) this.videoElements.delete(element)
    else this.videoElements.clear()
  }
}

/** The local participant in the fake call. */
export class FakeSelf extends FakeParticipant {
  audioTrack: FakeTrack | undefined = new FakeTrack('audio')
  videoTrack: FakeTrack | undefined = new FakeTrack('video')
  mediaPermissions: { audio?: string; video?: string } = { audio: 'ACCEPTED', video: 'ACCEPTED' }
  playAudioCalls = 0
  previewElements = new Set<HTMLVideoElement>()

  async enableAudio() { this.audioEnabled = true; this.emit('audioUpdate', { audioEnabled: true }) }
  async disableAudio() { this.audioEnabled = false; this.emit('audioUpdate', { audioEnabled: false }) }
  async enableVideo() { this.videoEnabled = true; this.emit('videoUpdate', { videoEnabled: true }) }
  async disableVideo() { this.videoEnabled = false; this.emit('videoUpdate', { videoEnabled: false }) }
  async playAudio() { this.playAudioCalls++ }

  override registerVideoElement(element: HTMLVideoElement, isPreview?: boolean) {
    super.registerVideoElement(element)
    if (isPreview) this.previewElements.add(element)
  }
}

class FakeJoined extends FakeEmitter {
  readonly byId = new Map<string, FakeParticipant>()
  toArray() { return [...this.byId.values()] }
}

/** A fake RealtimeKit meeting, opened and joined the way the SDK's are. */
export class FakeMeeting {
  readonly self: FakeSelf
  readonly participants = Object.assign(new FakeEmitter(), { joined: new FakeJoined() })
  joinCalls = 0
  leaveCalls = 0
  /** Replaced to make join() or leave() slow or fail. */
  joinImpl: () => Promise<void> = async () => {}
  leaveImpl: () => Promise<void> = async () => {}

  constructor(self: { id?: string; name?: string; customParticipantId?: string; onVideoElement?: (element: HTMLVideoElement) => void } = {}) {
    this.self = new FakeSelf(self.id ?? 'self', self.name ?? 'Mick', self.customParticipantId ?? 'user-mick', self.onVideoElement)
  }

  async join() {
    this.joinCalls++
    await this.joinImpl()
  }

  async leave() {
    this.leaveCalls++
    await this.leaveImpl()
  }

  /** Someone who was in the call before this participant joined. */
  seed(...participants: FakeParticipant[]) {
    for (const participant of participants) this.participants.joined.byId.set(participant.id, participant)
  }

  add(participant: FakeParticipant) {
    this.participants.joined.byId.set(participant.id, participant)
    this.participants.joined.emit('participantJoined', participant)
  }

  remove(participant: FakeParticipant) {
    this.participants.joined.byId.delete(participant.id)
    this.participants.joined.emit('participantLeft', participant)
  }

  setAudio(participant: FakeParticipant, enabled: boolean) {
    participant.audioEnabled = enabled
    this.participants.joined.emit('audioUpdate', participant, { audioEnabled: enabled })
  }

  setVideo(participant: FakeParticipant, enabled: boolean) {
    participant.videoEnabled = enabled
    this.participants.joined.emit('videoUpdate', participant, { videoEnabled: enabled })
  }

  speak(participantId: string) {
    this.participants.emit('activeSpeaker', { peerId: participantId, volume: 80 })
  }

  /** The SDK leaving the room on its own, as revocation, an ended call or a dropped link do. */
  roomLeft(state: CallLeaveReason) {
    this.self.emit('roomLeft', { state })
  }

  /** Every handler still attached to the meeting. */
  listenerCount() {
    return this.self.listenerCount() + this.participants.listenerCount() + this.participants.joined.listenerCount()
  }

  asMeeting(): CallMeeting {
    return this as unknown as CallMeeting
  }
}
