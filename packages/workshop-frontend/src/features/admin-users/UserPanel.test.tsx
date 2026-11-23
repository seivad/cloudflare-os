// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  ADMIN_ACCESS_ERROR_CODES, createAdminAccessError,
  type AdminApi, type AdminUserBlueprint, type AdminUserWorkspace,
} from '@gadgets/workshop-shared/api'
import { UserPanel } from './UserPanel'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const OWNED: AdminUserWorkspace = {
  id: 'w1', title: 'Atlas', totalCost: 0.5, created: new Date('2026-01-02T10:00:00Z'),
  lastActive: new Date('2026-11-20T10:00:00Z'),
} as AdminUserWorkspace
const SHARED = {
  id: 'w2', title: 'Borealis', totalCost: 0, created: new Date('2026-02-02T10:00:00Z'),
  owner: { type: 'user', id: 'bob@example.com', name: 'Bob' }, role: 'use',
} as unknown as AdminUserWorkspace
const BLUEPRINT: AdminUserBlueprint = {
  held: 'published', title: 'Todo list', version: 3, lastUpdated: new Date('2026-10-01T10:00:00Z'), featured: true,
}

const fakeAdmin = (workspaces: AdminUserWorkspace[] = [OWNED, SHARED]) => {
  const userView = {
    describe: vi.fn<() => Promise<unknown>>(async () => ({
      profile: { type: 'user', id: 'ada@example.com', name: 'Ada' }, isAdmin: false,
    })),
    listWorkspaces: vi.fn<() => Promise<AdminUserWorkspace[]>>(async () => workspaces),
    listBlueprints: vi.fn<() => Promise<AdminUserBlueprint[]>>(async () => [BLUEPRINT]),
  }
  const workspaceView = {
    describe: vi.fn<() => Promise<unknown>>(async () => ({
      totalCost: 1.25,
      workpieces: [{ type: 'gadget' }, { type: 'gadget' }, { type: 'worktree' }],
    })),
    getDiagnostics: vi.fn<() => Promise<unknown>>(async () => ({ storageBytes: 2048 })),
  }
  return {
    inspectUser: vi.fn<(id: string, reason: string) => Promise<typeof userView>>(async () => userView),
    inspectWorkspace: vi.fn<(id: string, reason: string) => Promise<typeof workspaceView>>(async () => workspaceView),
    userView,
  }
}

// Kumo's Tabs measure with ResizeObserver, which jsdom lacks.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }

Element.prototype.scrollIntoView ??= () => {}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const click = (element: Element) => act(async () => { (element as HTMLElement).click() })
const text = () => document.body.textContent ?? ''
const render = async (admin: unknown, onClose = vi.fn<() => void>()) => {
  await act(async () => {
    root.render(<UserPanel admin={admin as RpcStub<AdminApi>} userId="ada@example.com" userName="Ada" onClose={onClose} />)
  })
  return onClose
}
const confirmReason = async () => {
  await click(document.querySelector('button[type="submit"]')!)
  await flush()
  await flush()
}
const tab = (name: string) =>
  [...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent === name)!

describe('UserPanel', () => {
  it('asks for a reason prefilled, and opens the user with it', async () => {
    const admin = fakeAdmin()
    await render(admin)
    const area = document.querySelector('textarea') as HTMLTextAreaElement
    expect(area.value).toBe('Reviewing Ada’s work')
    expect(admin.inspectUser).not.toHaveBeenCalled()
    await confirmReason()
    expect(admin.inspectUser).toHaveBeenCalledWith('ada@example.com', 'Reviewing Ada’s work')
    expect(text()).toContain('Ada')
  })

  it('lists owned workspaces with gadgets, cost and storage, and shared ones with owner and role', async () => {
    const admin = fakeAdmin()
    await render(admin)
    await confirmReason()
    await flush()
    expect(admin.inspectWorkspace).toHaveBeenCalledOnce()
    expect(admin.inspectWorkspace).toHaveBeenCalledWith('w1', 'Reviewing Ada’s work')
    const body = text()
    expect(body).toContain('Atlas')
    expect(body).toContain('$1.2500')
    expect(body).toContain('2.0 KB')
    const owned = document.querySelector('section[aria-label="Owned workspaces"]')!
    expect([...owned.querySelectorAll('td')].map((c) => c.textContent)).toContain('2')
    expect(body).toContain('Borealis')
    expect(body).toContain('Bob')
    expect(body).toContain('use')
  })

  it('shows an empty state for a user with no workspaces', async () => {
    await render(fakeAdmin([]))
    await confirmReason()
    expect(text()).toContain('This user has no workspaces.')
  })

  it('lists blueprints', async () => {
    await render(fakeAdmin())
    await confirmReason()
    await click(tab('Blueprints'))
    await flush()
    const body = text()
    expect(body).toContain('Todo list')
    expect(body).toContain('Published')
    expect(body).toContain('Featured')
  })

  it('says admin access is off and shows only the header', async () => {
    const admin = fakeAdmin()
    admin.userView.describe.mockRejectedValue(createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.accessOff))
    await render(admin)
    await confirmReason()
    expect(text()).toContain('Admin access to workspaces and users is turned off on this deployment.')
    expect(document.querySelector('[role="tab"]')).toBeNull()
    expect(text()).toContain('ada@example.com')
  })

  it('calls onClose from the close button', async () => {
    const onClose = await render(fakeAdmin())
    await click(document.querySelector('button[aria-label="Close"]')!)
    expect(onClose).toHaveBeenCalled()
  })

  it('asks again, prefilled for the new user, when the panel is shown for another one', async () => {
    const admin = fakeAdmin()
    await render(admin)
    await confirmReason()
    admin.inspectUser.mockClear()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      root.render(<UserPanel admin={admin as unknown as RpcStub<AdminApi>} userId="bob@example.com" userName="Bob" onClose={vi.fn<() => void>()} />)
    })
    await flush()
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Reviewing Bob’s work')
    expect(admin.inspectUser).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(logged).not.toHaveBeenCalled()
    logged.mockRestore()
  })
})
