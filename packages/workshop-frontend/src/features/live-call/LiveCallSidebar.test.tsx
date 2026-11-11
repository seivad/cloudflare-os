// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { CallRosterEntry, CallTicket, GadgetClient, ServerConfig } from '@gadgets/workshop-shared/api'
import { ServerConfigContext } from '../../ServerConfigContext'
import type { OpenCallMeeting } from './callMeeting'
import { useLiveCallGadget, type LiveCallGadgetView } from './liveCallContext'
import { LiveCallProvider } from './LiveCallProvider'
import { LiveCallSidebar } from './LiveCallSidebar'
import { LiveCallToggle } from './LiveCallToggle'
import { FakeMeeting, FakeParticipant, type FakeTrack } from './liveCallTestHarness'

const toastAdd = vi.hoisted(() => vi.fn<(toast: { title: string }) => void>())

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: toastAdd }),
  Loader: () => <span />,
}))
vi.mock('../../components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))
vi.mock('../../components/PersonAvatar', () => ({
  PersonAvatar: ({ userId }: { userId: string }) => <span data-testid="avatar" data-user={userId} />,
  initials: (name: string) => name.slice(0, 2).toUpperCase(),
}))
vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: {},
    currentUser: { type: 'user', id: 'mick@example.com', name: 'Mick' },
  }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ params, search, className, children }: {
    params: { id: string }; search: { w: number }; className?: string; children: ReactNode
  }) => <a href={`/workspace/${params.id}?w=${search.w}`} className={className}>{children}</a>,
}))

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => { testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment })

const ROSTER: CallRosterEntry[] = [
  { profileId: 'sam@example.com', name: 'Sam', callParticipantId: 'user-sam' },
  { profileId: 'ann@example.com', name: 'Ann', callParticipantId: 'user-ann' },
]

type FakeClient = {
  joinCall: ReturnType<typeof vi.fn<() => Promise<CallTicket>>>
  getCallRoster: ReturnType<typeof vi.fn<() => Promise<CallRosterEntry[]>>>
}

const fakeClient = (roster: CallRosterEntry[] = []): FakeClient => ({
  joinCall: vi.fn<() => Promise<CallTicket>>(async () => ({
    authToken: 'ticket', expiresAt: new Date(Date.now() + 3_600_000), displayName: 'Mick',
  })),
  getCallRoster: vi.fn<() => Promise<CallRosterEntry[]>>(async () => roster),
})

const viewOf = (client: FakeClient, overrides: Partial<LiveCallGadgetView> = {}): LiveCallGadgetView => ({
  workspaceId: 'trip-planner',
  gadgetId: 3,
  gadgetTitle: 'Itinerary',
  client: client as unknown as RpcStub<GadgetClient>,
  onInvite: () => {},
  ...overrides,
})

// A gadget view on screen: what GadgetEditor does, minus the editor.
const GadgetView = ({ view, joinRequest = null }: {
  view: LiveCallGadgetView
  joinRequest?: { onJoinRequested: () => void } | null
}) => {
  useLiveCallGadget(view, joinRequest)
  return <LiveCallToggle />
}

const click = (element: Element) => act(async () => {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})

const flush = () => act(async () => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0))
})

const setVisibility = (visibilityState: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibilityState })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('live call sidebar', () => {
  let container: HTMLDivElement
  let root: Root
  let openMeeting: ReturnType<typeof vi.fn<OpenCallMeeting>>
  let meetings: FakeMeeting[]

  const render = (page: ReactNode) => act(async () => root.render(
    <ServerConfigContext.Provider value={{ liveCallsEnabled: true } as ServerConfig}>
      <LiveCallProvider openMeeting={openMeeting}>
        {page}
        <LiveCallSidebar />
      </LiveCallProvider>
    </ServerConfigContext.Provider>,
  ))

  const sidebar = () => container.querySelector<HTMLElement>('aside[aria-label="Live call"]')
  const button = (label: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll('button')].find(candidate =>
      candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
    if (!found) throw new Error(`No button labelled “${label}”`)
    return found
  }
  const tiles = () => [...container.querySelectorAll('ul[aria-label="People in the call"] > li')]
  const tileLabels = () => tiles().map(tile => tile.getAttribute('aria-label'))

  /** Opens the sidebar from the gadget view's Live toggle and joins its call. */
  const openAndJoin = async () => {
    await click(button('Live call'))
    await flush()
    await click(button('Start call'))
    await flush()
  }

  beforeEach(() => {
    toastAdd.mockClear()
    setVisibility('visible')
    meetings = []
    openMeeting = vi.fn<OpenCallMeeting>(async () => {
      const meeting = meetings.shift()
      if (!meeting) throw new Error('No meeting prepared')
      return meeting.asMeeting()
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('shows who is live without touching the SDK, camera or microphone until Join', async () => {
    const getUserMedia = vi.fn<() => Promise<MediaStream>>()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true, value: { getUserMedia, enumerateDevices: vi.fn<() => Promise<MediaDeviceInfo[]>>() },
    })
    const client = fakeClient(ROSTER)
    await render(<GadgetView view={viewOf(client)} />)
    expect(sidebar()).toBeNull()

    await click(button('Live call'))
    await flush()
    expect(sidebar()?.textContent).toContain('Sam and Ann are live')
    expect([...sidebar()!.querySelectorAll('[data-testid="avatar"]')].map(a => a.getAttribute('data-user')))
      .toEqual(['sam@example.com', 'ann@example.com'])
    expect(openMeeting).not.toHaveBeenCalled()
    expect(client.joinCall).not.toHaveBeenCalled()
    expect(getUserMedia).not.toHaveBeenCalled()
    Reflect.deleteProperty(navigator, 'mediaDevices')
  })

  it('says so when no one is live, and polls the roster only while visible', async () => {
    vi.useFakeTimers()
    const client = fakeClient([])
    await render(<GadgetView view={viewOf(client)} />)
    await click(button('Live call'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(sidebar()?.textContent).toContain('No one is live yet')
    expect(client.getCallRoster).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(client.getCallRoster).toHaveBeenCalledTimes(2)
    act(() => setVisibility('hidden'))
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(client.getCallRoster).toHaveBeenCalledTimes(2)
    act(() => setVisibility('visible'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(client.getCallRoster).toHaveBeenCalledTimes(3)
  })

  it('shows joining, then a tile per person: you first, then everyone in join order', async () => {
    const meeting = new FakeMeeting()
    const sam = new FakeParticipant('peer-sam', 'Sam', 'user-sam')
    const ann = new FakeParticipant('peer-ann', 'Ann', 'user-ann')
    ann.videoEnabled = false
    meeting.seed(sam, ann)
    let joined!: () => void
    meeting.joinImpl = () => new Promise(resolve => { joined = resolve })
    meetings.push(meeting)
    const client = fakeClient(ROSTER)
    await render(<GadgetView view={viewOf(client)} />)
    await click(button('Live call'))
    await flush()
    await click(button('Join call'))
    await flush()

    expect(sidebar()?.textContent).toContain('Joining the call…')
    expect(openMeeting).toHaveBeenCalledExactlyOnceWith({ authToken: 'ticket', audio: true, video: true })
    await act(async () => joined())
    await flush()

    const bo = new FakeParticipant('peer-bo', 'Bo', 'user-bo')
    act(() => meeting.add(bo))
    expect(tileLabels()).toEqual(['You', 'Sam', 'Ann', 'Bo'])
    // Camera off: the avatar of the profile the roster matches to them.
    expect(tiles()[2].querySelector('[data-testid="avatar"]')?.getAttribute('data-user')).toBe('ann@example.com')
    expect(meeting.self.previewElements.size).toBe(1)
    expect(sam.videoElements.size).toBe(1)

    act(() => meeting.setAudio(sam, false))
    act(() => meeting.speak('peer-ann'))
    expect(tileLabels()).toEqual(['You', 'Sam, muted', 'Ann, speaking', 'Bo'])
    expect(tiles()[2].hasAttribute('data-speaking')).toBe(true)

    act(() => meeting.remove(bo))
    expect(tileLabels()).toEqual(['You', 'Sam, muted', 'Ann, speaking'])
    expect(bo.videoElements.size).toBe(0)
  })

  it('stays in the call receive-only when the camera and microphone are refused', async () => {
    const meeting = new FakeMeeting()
    meeting.self.audioEnabled = false
    meeting.self.videoEnabled = false
    meetings.push(meeting)
    openMeeting.mockImplementationOnce(async () => {
      throw new DOMException('Permission denied', 'NotAllowedError')
    })
    await render(<GadgetView view={viewOf(fakeClient())} />)
    await openAndJoin()

    expect(openMeeting).toHaveBeenLastCalledWith({ authToken: 'ticket', audio: false, video: false })
    expect(sidebar()?.textContent).toContain(
      'Camera and microphone are blocked — others can’t see or hear you. Allow access in your browser to share.')
    expect(tileLabels()).toEqual(['You, muted'])
  })

  it('explains a camera refused mid-call', async () => {
    const meeting = new FakeMeeting()
    meetings.push(meeting)
    await render(<GadgetView view={viewOf(fakeClient())} />)
    await openAndJoin()
    expect(sidebar()?.textContent).not.toContain('blocked')

    act(() => meeting.self.emit('mediaPermissionUpdate', { message: 'DENIED', kind: 'video' }))
    expect(sidebar()?.textContent).toContain('Your camera is blocked — others can’t see you.')
  })

  it('leaves completely: the meeting, the camera and microphone, video elements and listeners', async () => {
    const meeting = new FakeMeeting()
    const sam = new FakeParticipant('peer-sam', 'Sam', 'user-sam')
    meeting.seed(sam)
    meetings.push(meeting)
    const { videoTrack, audioTrack } = meeting.self as { videoTrack: FakeTrack; audioTrack: FakeTrack }
    await render(<GadgetView view={viewOf(fakeClient())} />)
    await openAndJoin()
    expect(tiles()).toHaveLength(2)

    await click(button('Leave call'))
    await flush()
    expect(meeting.leaveCalls).toBe(1)
    expect(videoTrack.stopCount).toBeGreaterThan(0)
    expect(audioTrack.stopCount).toBeGreaterThan(0)
    expect(meeting.self.videoElements.size).toBe(0)
    expect(sam.videoElements.size).toBe(0)
    expect(meeting.listenerCount()).toBe(0)
    expect(tiles()).toHaveLength(0)
    expect(button('Start call')).toBeTruthy()
  })

  it.each([
    ['kicked', 'You were removed from the live call.'],
    ['ended', 'The live call ended.'],
  ] as const)('ends the call when %s, and says so', async (state, message) => {
    const meeting = new FakeMeeting()
    meetings.push(meeting)
    const { videoTrack } = meeting.self as { videoTrack: FakeTrack }
    await render(<GadgetView view={viewOf(fakeClient())} />)
    await openAndJoin()

    act(() => meeting.roomLeft(state))
    await flush()
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: message }))
    expect(videoTrack.stopCount).toBeGreaterThan(0)
    expect(meeting.listenerCount()).toBe(0)
    expect(tiles()).toHaveLength(0)
    expect(openMeeting).toHaveBeenCalledTimes(1)
  })

  it('reconnects once with a fresh ticket after a dropped connection, then offers Rejoin', async () => {
    const first = new FakeMeeting()
    const second = new FakeMeeting()
    meetings.push(first, second)
    const client = fakeClient()
    await render(<GadgetView view={viewOf(client)} />)
    await openAndJoin()

    act(() => first.roomLeft('failed'))
    await flush()
    expect(client.joinCall).toHaveBeenCalledTimes(2)
    expect(second.joinCalls).toBe(1)
    expect(tileLabels()).toEqual(['You'])

    act(() => second.roomLeft('disconnected'))
    await flush()
    expect(client.joinCall).toHaveBeenCalledTimes(2)
    expect(sidebar()?.textContent).toContain('The connection to the live call was lost.')
    expect(button('Rejoin')).toBeTruthy()
  })

  it('keeps the call, and offers the way back, after the gadget view goes away', async () => {
    const meeting = new FakeMeeting()
    meetings.push(meeting)
    await render(<GadgetView view={viewOf(fakeClient())} />)
    await openAndJoin()
    expect(button('Invite')).toBeTruthy()

    // Navigating anywhere else unmounts the gadget view; the sidebar lives above it.
    await render(<p>Home</p>)
    expect(meeting.leaveCalls).toBe(0)
    expect(tileLabels()).toEqual(['You'])
    const back = [...sidebar()!.querySelectorAll('a')].find(link => link.textContent?.includes('Back to gadget'))
    expect(back?.getAttribute('href')).toBe('/workspace/trip-planner?w=3')
    expect(sidebar()?.textContent).toContain('Open Itinerary to invite')
    expect(() => button('Invite')).toThrow('No button labelled')
  })

  it('switches the call to the gadget on screen, leaving the first', async () => {
    const first = new FakeMeeting()
    const second = new FakeMeeting()
    meetings.push(first, second)
    const budget = fakeClient()
    await render(<GadgetView view={viewOf(fakeClient())} />)
    await openAndJoin()

    await render(<GadgetView view={viewOf(budget, { gadgetId: 4, gadgetTitle: 'Budget' })} />)
    expect(sidebar()?.textContent).toContain('Viewing Budget')
    await click(button('Switch call'))
    await flush()
    expect(first.leaveCalls).toBe(1)
    expect(budget.joinCall).toHaveBeenCalledOnce()
    expect(second.joinCalls).toBe(1)
    expect(sidebar()?.textContent).toContain('Budget')
    expect(sidebar()?.textContent).not.toContain('Switch call')
  })

  it('offers to start the sound when the browser blocks it', async () => {
    const meeting = new FakeMeeting()
    meetings.push(meeting)
    await render(<GadgetView view={viewOf(fakeClient())} />)
    await openAndJoin()

    act(() => meeting.self.emit('autoplayError', new Error('NotAllowedError')))
    await click(button('Click to enable sound'))
    await flush()
    expect(meeting.self.playAudioCalls).toBe(1)
    expect(() => button('Click to enable sound')).toThrow('No button labelled')
  })

  it('joins once when asked to, as soon as the gadget is registered', async () => {
    meetings.push(new FakeMeeting())
    const onJoinRequested = vi.fn<() => void>()
    const client = fakeClient()
    await render(<GadgetView view={viewOf(client)} joinRequest={{ onJoinRequested }} />)
    await flush()
    await render(<GadgetView view={viewOf(client)} joinRequest={{ onJoinRequested }} />)
    await flush()

    expect(client.joinCall).toHaveBeenCalledOnce()
    expect(onJoinRequested).toHaveBeenCalledOnce()
    expect(tileLabels()).toEqual(['You'])
  })

  it('shows nothing when the deployment has no live calls', async () => {
    await act(async () => root.render(
      <ServerConfigContext.Provider value={{} as ServerConfig}>
        <LiveCallProvider openMeeting={openMeeting}>
          <GadgetView view={viewOf(fakeClient())} />
          <LiveCallSidebar />
        </LiveCallProvider>
      </ServerConfigContext.Provider>,
    ))
    expect(container.querySelector('button')).toBeNull()
    expect(sidebar()).toBeNull()
  })
})
