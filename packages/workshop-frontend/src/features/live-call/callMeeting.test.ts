import { describe, expect, it, vi } from 'vitest'
import { openRealtimeKitMeeting } from './callMeeting'

const init = vi.hoisted(() => vi.fn<(options: unknown) => Promise<unknown>>(async () => ({})))
vi.mock('@cloudflare/realtimekit', () => ({ default: { init } }))

describe('openRealtimeKitMeeting', () => {
  it("turns on the SDK's own audio playback, without which nobody in the call is heard", async () => {
    await openRealtimeKitMeeting({ authToken: 'ticket', audio: true, video: false })
    expect(init).toHaveBeenCalledExactlyOnceWith({
      authToken: 'ticket',
      defaults: { audio: true, video: false },
      modules: { experimentalAudioPlayback: true },
    })
  })
})
