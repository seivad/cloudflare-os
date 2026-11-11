// Type-only imports: they are erased from the bundle, so the ~5 MB SDK is fetched only by the
// dynamic import in openRealtimeKitMeeting(), when someone clicks Join.
import type RealtimeKitClient from '@cloudflare/realtimekit'
import type {
  LeaveRoomState,
  RTKParticipant,
  RTKParticipantMap,
  RTKParticipants,
  RTKSelf,
} from '@cloudflare/realtimekit'

/** Why the SDK left a meeting, as its `roomLeft` event reports it. */
export type CallLeaveReason = LeaveRoomState

/** The local participant: the parts of RealtimeKit's `self` the live call uses. */
export type CallSelf = Pick<RTKSelf,
  | 'id' | 'name' | 'customParticipantId'
  | 'audioEnabled' | 'videoEnabled' | 'audioTrack' | 'videoTrack' | 'mediaPermissions'
  | 'enableAudio' | 'disableAudio' | 'enableVideo' | 'disableVideo' | 'playAudio'
  | 'registerVideoElement' | 'deregisterVideoElement' | 'on' | 'off'>

/** Someone else in the call: the parts of a RealtimeKit participant the live call uses. */
export type CallParticipant = Pick<RTKParticipant,
  | 'id' | 'name' | 'customParticipantId' | 'audioEnabled' | 'videoEnabled'
  | 'registerVideoElement' | 'deregisterVideoElement' | 'on' | 'off'>

/** The parts of a RealtimeKit meeting (`RealtimeKitClient`) the live call uses. */
export type CallMeeting = Pick<RealtimeKitClient, 'join' | 'leave'> & {
  readonly self: CallSelf
  readonly participants: Pick<RTKParticipants, 'on' | 'off'> & {
    readonly joined: Pick<RTKParticipantMap, 'toArray' | 'on' | 'off'>
  }
}

/** Initialises (but does not join) a meeting. Tests substitute a fake. */
export type OpenCallMeeting =
  (options: { authToken: string; audio: boolean; video: boolean }) => Promise<CallMeeting>

/** Loads the RealtimeKit SDK on first use and initialises a meeting with it. */
export const openRealtimeKitMeeting: OpenCallMeeting = async ({ authToken, audio, video }) => {
  const { default: RealtimeKit } = await import('@cloudflare/realtimekit')
  return RealtimeKit.init({ authToken, defaults: { audio, video } })
}
