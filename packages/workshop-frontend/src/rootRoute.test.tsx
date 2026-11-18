// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  pathname: '/',
  isLoading: false,
  // A signed-in tab's stub: the shell would call this first, so a popup routed into the shell by
  // mistake shows up as a call here.
  authenticatedApi: null as { isOnboardingCompleted: () => Promise<boolean>; [method: string]: () => Promise<unknown> } | null,
}))

// The root decides standalone-vs-shell from the pathname and the auth state alone; both are faked
// here, and the routed page is a marker so no real screen renders.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: testState.pathname } }),
  useMatch: () => undefined,
  Outlet: () => <div data-testid="outlet">routed page</div>,
}))

vi.mock('./useAuth', () => ({
  CF_ACCESS_MODE: false,
  useAuth: () => ({
    isAuthenticated: testState.authenticatedApi !== null,
    authenticatedApi: testState.authenticatedApi,
    isLoading: testState.isLoading,
    error: null,
    login: vi.fn<(token: string) => void>(),
    logout: vi.fn<() => void>(),
  }),
}))

vi.mock('./components/Header', () => ({ default: () => <header data-testid="header">Header</header> }))
vi.mock('./LoginPage', () => ({ default: () => <div data-testid="login">Login</div> }))

// The signed-in shell's surroundings, each a pass-through or nothing: the shell test below is about
// what the root mounts around the routed page, not about these.
vi.mock('./FeatureFlagsContext', () => ({ FeatureFlagsProvider: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('./features/notifications/UnreadStateBridge', () => ({ UnreadStateBridge: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('./features/notifications/NotificationBridge', () => ({ NotificationBridge: () => null }))
vi.mock('./features/notifications/BrowserPushBridge', () => ({ BrowserPushBridge: () => null }))
vi.mock('./features/native-app/NativeAppBridge', () => ({ NativeAppBridge: () => null }))
vi.mock('./features/stale-session/PageUpdateNotice', () => ({ PageUpdateNotice: () => null }))
vi.mock('./features/live-call/LiveCallProvider', () => ({ LiveCallProvider: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('./features/live-call/LiveCallSidebar', () => ({ LiveCallSidebar: () => null }))
vi.mock('./components/billing/AccountSelectionModal', () => ({ default: () => null }))
vi.mock('./components/AppShell/AppShell', () => ({ default: () => <VoiceProbe /> }))

import { Route } from './routes/__root'
import { RpcContext } from './RpcContext'
import { HANDOFF_PATH } from './connectHandoff'
import { useVoice } from './features/voice/VoiceContext'

/** Stands in for the app shell: says whether voice reached it, and with how many models. */
function VoiceProbe() {
  const voice = useVoice()
  return <div data-testid="shell" data-voice={voice ? String(voice.models.length) : 'none'} />
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RootComponent = Route.options.component as ComponentType

describe('root route standalone rendering', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  const stub = {} as RpcStub<PublicApi>

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    testState.pathname = '/'
    testState.isLoading = false
    testState.authenticatedApi = null
  })

  async function renderAt(pathname: string, isLoading = false) {
    testState.pathname = pathname
    testState.isLoading = isLoading
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <RpcContext.Provider value={{ stub, connectionLost: false }}>
          <RootComponent />
        </RpcContext.Provider>,
      )
    })
    return container
  }

  it('renders the handoff page standalone, without waiting on auth', async () => {
    const page = await renderAt(HANDOFF_PATH, true)

    expect(page.querySelector('[data-testid="outlet"]')).not.toBeNull()
    expect(page.querySelector('[data-testid="header"]')).toBeNull()
    expect(page.querySelector('[data-testid="login"]')).toBeNull()
    expect(page.textContent).not.toContain('Loading')
  })

  it('renders the handoff page standalone for a signed-in popup, never the app shell', async () => {
    // The common case: a connect popup shares the tab's authToken, so it is authenticated. It must
    // still bypass the shell (onboarding gate, account modal, sidebar) and render the page itself.
    const isOnboardingCompleted = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
    testState.authenticatedApi = { isOnboardingCompleted }
    const page = await renderAt(HANDOFF_PATH)

    expect(page.querySelector('[data-testid="outlet"]')).not.toBeNull()
    expect(page.querySelector('[data-testid="header"]')).toBeNull()
    expect(page.querySelector('[data-testid="login"]')).toBeNull()
    expect(isOnboardingCompleted).not.toHaveBeenCalled()
  })

  it('renders the handoff page headerless for a signed-out popup too', async () => {
    const page = await renderAt(HANDOFF_PATH)

    expect(page.querySelector('[data-testid="outlet"]')).not.toBeNull()
    expect(page.querySelector('[data-testid="header"]')).toBeNull()
    expect(page.querySelector('[data-testid="login"]')).toBeNull()
  })

  it('still renders signup headerless', async () => {
    const page = await renderAt('/signup')

    expect(page.querySelector('[data-testid="outlet"]')).not.toBeNull()
    expect(page.querySelector('[data-testid="header"]')).toBeNull()
    expect(page.querySelector('[data-testid="login"]')).toBeNull()
  })

  it('gives the signed-in shell voice, which the composer microphone and a gadget voice global depend on', async () => {
    const listVoiceModels = vi.fn<() => Promise<unknown[]>>().mockResolvedValue([
      { id: '@cf/openai/whisper-large-v3-turbo', kind: 'transcribe', isDefault: true },
      { id: '@cf/deepgram/aura-2-en', kind: 'speak', isDefault: true },
    ])
    testState.authenticatedApi = {
      isOnboardingCompleted: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
      // What the shell's AuthProvider asks as it mounts.
      whoami: vi.fn<() => Promise<unknown>>().mockResolvedValue({ type: 'user', id: 'ada', name: 'Ada' }),
      amIAdmin: vi.fn<() => Promise<unknown>>().mockResolvedValue(false),
      listVoiceModels,
    }
    const page = await renderAt('/')
    await act(async () => {})

    expect(listVoiceModels).toHaveBeenCalledTimes(1)
    expect(page.querySelector('[data-testid="shell"]')?.getAttribute('data-voice')).toBe('2')
  })

  it('shows the login page for a signed-out visitor elsewhere', async () => {
    const page = await renderAt('/')

    expect(page.querySelector('[data-testid="login"]')).not.toBeNull()
    expect(page.querySelector('[data-testid="outlet"]')).toBeNull()
  })
})
