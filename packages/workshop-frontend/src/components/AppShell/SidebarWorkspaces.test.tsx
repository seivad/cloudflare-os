// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AuthenticatedApi, WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { announceWorkspaceShared } from '../../features/shared-workspaces/newShares'
import { SidebarWorkspacesLists, SidebarWorkspacesProvider } from './SidebarWorkspaces'

const listWorkspaces = vi.fn<AuthenticatedApi['listWorkspaces']>()
const api = { listWorkspaces, whoami: async () => ({ type: 'user', id: 'me@example.com', name: 'Me' }) }
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }))
vi.mock('../../features/notifications/UnreadStateBridge', () => ({ useUnreadState: () => null }))
vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: () => {} }),
}))

const owner = { type: 'user' as const, id: 'olive@example.com', name: 'Olive' }
const sam = { type: 'user' as const, id: 'sam@example.com', name: 'Sam' }
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 9, minutes))
const opened: WorkspaceMetadataWithTimestamps = {
  id: 'opened', title: 'Roadmap', owner, role: 'build', created: at(0), lastActive: at(1),
}
const budget: WorkspaceMetadataWithTimestamps = {
  id: 'budget', title: 'Budget', owner, role: 'build', created: at(2), lastActive: at(2),
  newShare: { sharedBy: sam, note: 'Numbers for Q3' },
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  listWorkspaces.mockReset().mockResolvedValue([opened, budget])
  vi.stubGlobal('scrollTo', vi.fn<() => void>())
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const render = async () => {
  const base = createRootRoute({
    component: () => <SidebarWorkspacesProvider><SidebarWorkspacesLists /></SidebarWorkspacesProvider>,
  })
  const router = createRouter({ routeTree: base, history: createMemoryHistory({ initialEntries: ['/'] }) })
  await act(async () => { await router.load(); root.render(<RouterProvider router={router} />) })
}

// The workspace titles listed under the section headed `label`, in order.
const section = (label: string) => {
  const header = [...container.querySelectorAll('button')].find(button => button.textContent?.startsWith(label))
  return header
    ? [...header.parentElement!.querySelectorAll('a[href^="/workspace/"]')].map(link => link.textContent)
    : undefined
}
const row = (title: string) =>
  [...container.querySelectorAll('a')].find(link => link.textContent?.includes(title))!

it('lists an unopened share under Shared with you, marked new with its notice, and an opened one under Recent', async () => {
  await render()
  expect(section('Shared with you')).toEqual([expect.stringContaining('Budget')])
  expect(row('Budget').textContent).toContain('New')
  expect(row('Budget').title).toBe('Sam shared “Budget” with you\nNumbers for Q3')
  expect(section('Recent workspaces')).toEqual([expect.stringContaining('Roadmap')])
  expect(row('Roadmap').textContent).not.toContain('New')
})

it('lists a share the moment this tab is told of it, and drops a withdrawn one on returning to the window', async () => {
  listWorkspaces.mockResolvedValue([opened])
  await render()
  expect(section('Shared with you')).toBeUndefined()

  await act(async () => announceWorkspaceShared(budget))
  expect(section('Shared with you')).toEqual([expect.stringContaining('Budget')])

  // Removed before they opened it: the next read of their listing no longer has it.
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(listWorkspaces).toHaveBeenCalledTimes(2)
  expect(section('Shared with you')).toBeUndefined()
})
