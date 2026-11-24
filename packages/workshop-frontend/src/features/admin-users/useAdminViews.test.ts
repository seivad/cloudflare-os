// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import { ADMIN_ACCESS_ERROR_CODES, createAdminAccessError, type AdminApi } from '@gadgets/workshop-shared/api'
import { MAX_CONCURRENT_WORKSPACE_OPENS, useAdminViews, type AdminViews } from './useAdminViews'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

let root: Root | null = null
afterEach(() => { act(() => root?.unmount()); root = null })

const mount = async (admin: unknown, userId = 'ada@example.com') => {
  const out: { views?: AdminViews } = {}
  const Probe = () => { out.views = useAdminViews(admin as RpcStub<AdminApi>, userId); return null }
  root = createRoot(document.createElement('div'))
  await act(async () => { root!.render(createElement(Probe)) })
  return out as { views: AdminViews }
}

describe('useAdminViews', () => {
  it('opens the user view once with the reason and reuses it', async () => {
    const view = { describe: vi.fn<() => void>() }
    const admin = { inspectUser: vi.fn<() => Promise<unknown>>(async () => view) }
    const hook = await mount(admin)
    await act(async () => { hook.views.setReason('Reviewing') })
    const [a, b] = await Promise.all([hook.views.userView(), hook.views.userView()])
    expect(a).toBe(view)
    expect(b).toBe(view)
    expect(admin.inspectUser).toHaveBeenCalledOnce()
    expect(admin.inspectUser).toHaveBeenCalledWith('ada@example.com', 'Reviewing')
  })

  it('refuses to open before a reason is given', async () => {
    const admin = { inspectUser: vi.fn<() => Promise<unknown>>() }
    const hook = await mount(admin)
    await expect(hook.views.userView()).rejects.toThrow(/reason/)
    expect(admin.inspectUser).not.toHaveBeenCalled()
  })

  it('reopens once when a view has expired and retries', async () => {
    const admin = { inspectUser: vi.fn<() => Promise<unknown>>(async () => ({ describe: vi.fn<() => void>() })) }
    const hook = await mount(admin)
    await act(async () => { hook.views.setReason('r') })
    let attempts = 0
    const result = await hook.views.call(async ({ userView }) => {
      await userView()
      if (attempts++ === 0) throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.viewExpired)
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(attempts).toBe(2)
    expect(admin.inspectUser).toHaveBeenCalledTimes(2)
  })

  it('drops and reopens only the view that expired, leaving the others open', async () => {
    const opened: string[] = []
    const disposed: string[] = []
    const admin = {
      inspectWorkspace: vi.fn<(id: string) => Promise<unknown>>(async (id: string) => {
        const name = `${id}#${opened.filter((entry) => entry.startsWith(`${id}#`)).length + 1}`
        opened.push(name)
        return { name, [Symbol.dispose]: () => { disposed.push(name) } }
      }),
    }
    const hook = await mount(admin)
    await act(async () => { hook.views.setReason('r') })
    const sibling = await hook.views.workspaceView('w2')
    let attempts = 0
    const name = await hook.views.call(async ({ workspaceView }) => {
      const view = await workspaceView('w1') as unknown as { name: string }
      if (attempts++ === 0) throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.viewExpired)
      return view.name
    })
    expect(name).toBe('w1#2')
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(opened).toEqual(['w2#1', 'w1#1', 'w1#2'])
    expect(disposed).toEqual(['w1#1'])
    expect(await hook.views.workspaceView('w2')).toBe(sibling)
  })

  it('leaves a view another call just reopened, when both found it expired', async () => {
    const opened: string[] = []
    const disposed: string[] = []
    const admin = {
      inspectWorkspace: vi.fn<(id: string) => Promise<unknown>>(async (id: string) => {
        const name = `${id}#${opened.length + 1}`
        opened.push(name)
        return { name, [Symbol.dispose]: () => { disposed.push(name) } }
      }),
    }
    const hook = await mount(admin)
    await act(async () => { hook.views.setReason('r') })
    const read = () => {
      let attempts = 0
      return hook.views.call(async ({ workspaceView }) => {
        const view = await workspaceView('w1') as unknown as { name: string }
        if (attempts++ === 0) throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.viewExpired)
        return view.name
      })
    }
    expect(await Promise.all([read(), read()])).toEqual(['w1#2', 'w1#2'])
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(opened).toEqual(['w1#1', 'w1#2'])
    expect(disposed).toEqual(['w1#1'])
  })

  it('surfaces a second expiry without looping', async () => {
    const admin = { inspectUser: vi.fn<() => Promise<unknown>>(async () => ({})) }
    const hook = await mount(admin)
    await act(async () => { hook.views.setReason('r') })
    const fn = vi.fn<() => Promise<never>>(async () => { throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.viewExpired) })
    await expect(hook.views.call(fn)).rejects.toMatchObject({ code: ADMIN_ACCESS_ERROR_CODES.viewExpired })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does not retry other failures', async () => {
    const hook = await mount({})
    const fn = vi.fn<() => Promise<never>>(async () => { throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.accessOff) })
    await expect(hook.views.call(fn)).rejects.toMatchObject({ code: ADMIN_ACCESS_ERROR_CODES.accessOff })
    expect(fn).toHaveBeenCalledOnce()
  })

  it('never has more than 4 workspace opens in flight', async () => {
    let inFlight = 0
    let peak = 0
    const releases: (() => void)[] = []
    const admin = {
      inspectWorkspace: vi.fn<(id: string) => Promise<unknown>>((id: string) => new Promise((resolve) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        releases.push(() => { inFlight -= 1; resolve({ id }) })
      })),
    }
    const hook = await mount(admin)
    await act(async () => { hook.views.setReason('r') })
    const opened = Array.from({ length: 10 }, (_, i) => hook.views.workspaceView(`w${i}`))
    await act(async () => { await Promise.resolve() })
    expect(admin.inspectWorkspace).toHaveBeenCalledTimes(MAX_CONCURRENT_WORKSPACE_OPENS)
    while (releases.length > 0) {
      await act(async () => { releases.shift()!(); await new Promise((r) => setTimeout(r, 0)) })
    }
    await Promise.all(opened)
    expect(admin.inspectWorkspace).toHaveBeenCalledTimes(10)
    expect(peak).toBe(MAX_CONCURRENT_WORKSPACE_OPENS)
  })

  // A newcomer arriving at any microtask depth after a slot frees must not take it from a waiter.
  it.each([0, 1, 2, 3, 4, 5, 6])('hands a freed slot to a waiter, not to a newcomer %i microtasks later', async (depth) => {
    let inFlight = 0
    let peak = 0
    const releases: (() => void)[] = []
    const admin = {
      inspectWorkspace: vi.fn<(id: string) => Promise<unknown>>((id: string) => new Promise((resolve) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        releases.push(() => { inFlight -= 1; resolve({ id }) })
      })),
    }
    const hook = await mount(admin)
    await act(async () => { hook.views.setReason('r') })
    const opened = Array.from({ length: 5 }, (_, i) => hook.views.workspaceView(`w${i}`))
    await act(async () => { await Promise.resolve() })
    expect(admin.inspectWorkspace).toHaveBeenCalledTimes(4)
    await act(async () => {
      releases.shift()!()
      for (let tick = 0; tick < depth; tick += 1) await Promise.resolve()
      opened.push(hook.views.workspaceView('late'))
      await new Promise((r) => setTimeout(r, 0))
    })
    while (releases.length > 0) {
      await act(async () => { releases.shift()!(); await new Promise((r) => setTimeout(r, 0)) })
    }
    await Promise.all(opened)
    expect(admin.inspectWorkspace).toHaveBeenCalledTimes(6)
    expect(peak).toBe(MAX_CONCURRENT_WORKSPACE_OPENS)
  })

  it('does not carry a reason over to another user', async () => {
    const admin = { inspectUser: vi.fn<() => Promise<unknown>>(async () => ({})) }
    const out: { views?: AdminViews } = {}
    const Probe = ({ id }: { id: string }) => { out.views = useAdminViews(admin as unknown as RpcStub<AdminApi>, id); return null }
    root = createRoot(document.createElement('div'))
    await act(async () => { root!.render(createElement(Probe, { id: 'a' })) })
    await act(async () => { out.views!.setReason('r') })
    expect(out.views!.reason).toBe('r')
    await act(async () => { root!.render(createElement(Probe, { id: 'b' })) })
    expect(out.views!.reason).toBeNull()
    await expect(out.views!.userView()).rejects.toThrow(/reason/)
    expect(admin.inspectUser).not.toHaveBeenCalled()
  })
})
