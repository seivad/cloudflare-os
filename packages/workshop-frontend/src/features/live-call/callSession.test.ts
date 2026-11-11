import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CallLeaveReason } from './callMeeting'
import { CallSession } from './callSession'
import { FakeMeeting, type FakeTrack } from './liveCallTestHarness'

describe('CallSession', () => {
  afterEach(() => { vi.useRealTimers() })

  it('releases the camera and microphone even when the SDK never finishes leaving', async () => {
    vi.useFakeTimers()
    const meeting = new FakeMeeting()
    meeting.leaveImpl = () => new Promise(() => {})
    const { videoTrack, audioTrack } = meeting.self as { videoTrack: FakeTrack; audioTrack: FakeTrack }
    const onLeft = vi.fn<(reason: CallLeaveReason) => void>()
    const session = new CallSession(meeting.asMeeting(), { onLeft, mediaFailed: false })

    const leaving = session.leave()
    // Not under the SDK while it is still tearing down, which would restart an ended camera.
    expect(videoTrack.stopCount).toBe(0)
    await vi.advanceTimersByTimeAsync(3_000)
    await leaving
    expect(videoTrack.stopCount).toBe(1)
    expect(audioTrack.stopCount).toBe(1)

    // Its own leaving is not reported back as the room being left.
    meeting.roomLeft('left')
    expect(onLeft).not.toHaveBeenCalled()
  })

  it('treats a camera that could not start as unavailable rather than blocked', () => {
    const meeting = new FakeMeeting()
    meeting.self.mediaPermissions = { audio: 'ACCEPTED', video: 'NO_DEVICES_AVAILABLE' }
    const session = new CallSession(meeting.asMeeting(), { onLeft: () => {}, mediaFailed: false })
    expect(session.getSnapshot().media).toEqual({ audio: null, video: 'unavailable' })
    session.close()
  })
})
