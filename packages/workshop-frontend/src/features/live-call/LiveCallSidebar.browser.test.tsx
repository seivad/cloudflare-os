/* eslint-disable react/react-in-jsx-scope */

// The live call sidebar's layout in Chromium: a column of its own beside the page, webcams stacked
// in order and scrolling while the controls and Invite stay pinned beneath them, and on a phone an
// overlay that stays inside the viewport. Each state is also captured, light and dark, into the
// suite's (untracked) screenshot directory for review.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { Toasty, TooltipProvider } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { CallRosterEntry, CallTicket, GadgetClient, ServerConfig } from '@gadgets/workshop-shared/api'
import { ServerConfigContext } from '../../ServerConfigContext'
import { useLiveCallGadget, type LiveCallGadgetView } from './liveCallContext'
import { LiveCallProvider } from './LiveCallProvider'
import { LiveCallSidebar } from './LiveCallSidebar'
import { LiveCallToggle } from './LiveCallToggle'
import { FakeMeeting, FakeParticipant } from './liveCallTestHarness'
import '../../styles.css'

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: { getAvatar: async () => null },
    currentUser: { type: 'user', id: 'mick@example.com', name: 'Mick Davies' },
  }),
}))

// Relative to this file: the browser suite's screenshot directory, which git ignores.
const SCREENSHOTS = '../../../node_modules/.vite/vitest-browser/screenshots/live-call'

const ROSTER: CallRosterEntry[] = [
  { profileId: 'sam@example.com', name: 'Sam Rivera', callParticipantId: 'user-sam' },
  { profileId: 'ann@example.com', name: 'Ann Okafor', callParticipantId: 'user-ann' },
]

const streams: { stop: () => void }[] = []

// A webcam stand-in: a softly lit backdrop and a head-and-shoulders silhouette, repainted so the
// stream keeps producing frames.
const fakeCamera = (hue: number) => (element: HTMLVideoElement) => {
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 180
  const context = canvas.getContext('2d')!
  const paint = () => {
    const backdrop = context.createLinearGradient(0, 0, 320, 180)
    backdrop.addColorStop(0, `hsl(${hue} 30% 72%)`)
    backdrop.addColorStop(1, `hsl(${hue + 30} 25% 48%)`)
    context.fillStyle = backdrop
    context.fillRect(0, 0, 320, 180)
    context.fillStyle = `hsl(${hue} 20% 28%)`
    context.beginPath()
    context.ellipse(160, 200, 92, 70, 0, Math.PI, 0)
    context.fill()
    context.beginPath()
    context.arc(160, 82, 38, 0, Math.PI * 2)
    context.fill()
  }
  paint()
  const timer = setInterval(paint, 100)
  const stream = canvas.captureStream(10)
  streams.push({ stop: () => { clearInterval(timer); stream.getTracks().forEach(track => track.stop()) } })
  element.srcObject = stream
  void element.play().catch(() => {})
}

const fakeClient = (roster: CallRosterEntry[]) => ({
  joinCall: async (): Promise<CallTicket> => ({ authToken: 'ticket', expiresAt: new Date(), displayName: 'Mick Davies' }),
  getCallRoster: async () => roster,
}) as unknown as RpcStub<GadgetClient>

const GadgetStage = ({ view }: { view: LiveCallGadgetView }) => {
  useLiveCallGadget(view)
  return (
    <div className="flex h-full flex-col bg-kumo-base">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-kumo-line px-4 sm:px-6">
        <span className="truncate text-[14px] font-medium text-kumo-default">Ops / {view.gadgetTitle}</span>
        <LiveCallToggle />
      </div>
      <div className="min-h-0 flex-1 p-4">
        <div className="h-full rounded-xl border border-kumo-line bg-kumo-elevated p-4 font-mono text-[12px] leading-5 text-kumo-subtle">
          <p>$ claude</p>
          <p>Reading packages/harness-runner/src/index.ts…</p>
          <p>Editing 3 files</p>
        </div>
      </div>
    </div>
  )
}

let root: Root | undefined
let host: HTMLDivElement | undefined

const render = async (view: LiveCallGadgetView, meetings: FakeMeeting[]) => {
  const openMeeting = async () => meetings.shift()!.asMeeting()
  const base = createRootRoute({
    component: () => (
      <ServerConfigContext.Provider value={{ liveCallsEnabled: true } as ServerConfig}>
        <TooltipProvider>
          <Toasty>
            <LiveCallProvider openMeeting={openMeeting}>
              <div className="flex h-screen min-h-0 bg-kumo-base">
                <div className="h-full min-w-0 flex-1"><GadgetStage view={view} /></div>
                <LiveCallSidebar />
              </div>
            </LiveCallProvider>
          </Toasty>
        </TooltipProvider>
      </ServerConfigContext.Provider>
    ),
  })
  const router = createRouter({ routeTree: base, history: createMemoryHistory({ initialEntries: ['/'] }) })
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => {
    await router.load()
    root!.render(<RouterProvider router={router} />)
  })
}

const press = async (name: string) => {
  await act(async () => { await page.getByRole('button', { name, exact: true }).click() })
}

const sidebar = () => document.querySelector<HTMLElement>('aside[aria-label="Live call"]')!

const setMode = (mode: 'light' | 'dark') => {
  document.documentElement.setAttribute('data-mode', mode)
  document.documentElement.style.colorScheme = mode
}

// Captures the page as it settles: the pointer off the controls, and colours past their 150ms
// transitions after a change of mode.
const capture = async (name: string) => {
  await userEvent.hover(page.getByText(/^Ops \//))
  await new Promise(resolve => setTimeout(resolve, 300))
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png` })
}

// Four people: you, Sam (speaking), Ann with her camera off, Bo muted.
const liveCall = async (view: LiveCallGadgetView) => {
  const meeting = new FakeMeeting({ name: 'Mick Davies', onVideoElement: fakeCamera(28) })
  const sam = new FakeParticipant('peer-sam', 'Sam Rivera', 'user-sam', fakeCamera(200))
  const ann = new FakeParticipant('peer-ann', 'Ann Okafor', 'user-ann')
  const bo = new FakeParticipant('peer-bo', 'Bo Lindqvist', 'user-bo', fakeCamera(140))
  ann.videoEnabled = false
  meeting.seed(sam, ann, bo)
  await render(view, [meeting])
  await press('Live call')
  await press('Join call')
  await expect.poll(() => document.querySelectorAll('ul[aria-label="People in the call"] > li').length).toBe(4)
  act(() => {
    meeting.setAudio(bo, false)
    meeting.speak('peer-sam')
  })
  // Every camera that is on has a frame to show.
  await expect.poll(() => [...document.querySelectorAll('video')]
    .filter(video => !video.classList.contains('invisible'))
    .every(video => video.readyState >= 2)).toBe(true)
  return meeting
}

const view = (roster: CallRosterEntry[] = ROSTER): LiveCallGadgetView => ({
  workspaceId: 'ops', gadgetId: 1, gadgetTitle: 'Claude Code', client: fakeClient(roster), onInvite: () => {},
})

beforeEach(async () => {
  setMode('light')
  await page.viewport(1280, 800)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  for (const stream of streams.splice(0)) stream.stop()
  setMode('light')
})

it('takes a column of its own beside the page and lists who is live before joining', async () => {
  await render(view(), [])
  await press('Live call')
  await expect.element(page.getByText('Sam Rivera and Ann Okafor are live')).toBeVisible()

  const aside = sidebar().getBoundingClientRect()
  expect(aside.width).toBeGreaterThanOrEqual(208)
  expect(aside.width).toBeLessThanOrEqual(240)
  expect(aside.right).toBe(window.innerWidth)
  // Beside the page, not over it.
  expect(document.querySelector('.font-mono')!.getBoundingClientRect().right).toBeLessThanOrEqual(aside.left)

  await capture('live-call-sidebar-idle-light')
  setMode('dark')
  await capture('live-call-sidebar-idle-dark')
})

it('stacks the webcams in order, you first, with the controls and Invite pinned beneath', async () => {
  await liveCall(view())
  const tiles = [...sidebar().querySelectorAll('ul[aria-label="People in the call"] > li')]
  expect(tiles.map(tile => tile.getAttribute('aria-label')))
    .toEqual(['You', 'Sam Rivera, speaking', 'Ann Okafor', 'Bo Lindqvist, muted'])
  for (let i = 1; i < tiles.length; i++) {
    expect(tiles[i].getBoundingClientRect().top).toBeGreaterThan(tiles[i - 1].getBoundingClientRect().bottom)
  }
  const invite = page.getByRole('button', { name: 'Invite' }).element().getBoundingClientRect()
  expect(sidebar().getBoundingClientRect().bottom - invite.bottom).toBeLessThanOrEqual(16)

  await capture('live-call-sidebar-live-light')
  setMode('dark')
  await capture('live-call-sidebar-live-dark')
})

it('scrolls a long call’s webcams while Invite stays in view', async () => {
  await page.viewport(1280, 600)
  const meeting = new FakeMeeting()
  meeting.seed(...Array.from({ length: 7 }, (_, i) => new FakeParticipant(`peer-${i}`, `Guest ${i + 1}`)))
  await render(view(), [meeting])
  await press('Live call')
  await press('Join call')
  await expect.poll(() => sidebar().querySelectorAll('ul[aria-label="People in the call"] > li').length).toBe(8)

  const scroller = sidebar().querySelector('ul[aria-label="People in the call"]')!.parentElement!
  expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight)
  const invite = page.getByRole('button', { name: 'Invite' }).element().getBoundingClientRect()
  expect(invite.bottom).toBeLessThanOrEqual(window.innerHeight)
})

it('fits a phone as an overlay, without scrolling the page sideways', async () => {
  await page.viewport(390, 844)
  await liveCall(view())

  const aside = sidebar().getBoundingClientRect()
  expect(getComputedStyle(sidebar()).position).toBe('fixed')
  expect(aside.left).toBeGreaterThanOrEqual(0)
  expect(aside.right).toBeLessThanOrEqual(window.innerWidth)
  expect(aside.bottom).toBeLessThanOrEqual(window.innerHeight)
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
  await capture('live-call-sidebar-mobile-light')

  await press('Hide live call')
  await expect.element(page.getByRole('button', { name: 'Show live call (Live · 4)' })).toBeVisible()
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
})
