// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SharingTab } from './SharingTab'
import type { AdminViews } from './useAdminViews'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previous = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previous === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previous
})

const workpieces = [{ id: 'a', type: 'gadget', title: 'Todo' }]
const views: Record<string, unknown> = {
  w1: {
    describe: async () => ({
      workpieces,
      collaborators: [
        { profile: { id: 'bob@x', name: 'Bob' }, access: { role: 'build' }, addedBy: [] },
        { profile: { id: 'cy@x', name: '' }, access: { role: 'use', gadgetIds: ['a'] }, addedBy: [] },
      ],
    }),
    listShareLinks: async () => [
      { linkId: 'l1', note: 'for Dee', created: new Date('2026-05-01T10:00:00Z'), createdBy: { id: 'ada@x', name: 'Ada' }, role: 'use', gadgetId: 'a' },
      { linkId: 'l2', created: new Date('2026-05-02T10:00:00Z'), createdBy: { id: 'ada@x', name: 'Ada' } },
    ],
  },
  w2: { describe: async () => ({ workpieces: [], collaborators: [] }), listShareLinks: async () => [] },
}
const fakeViews = (): AdminViews => ({
  reason: 'r', setReason: vi.fn<(reason: string) => void>(),
  userView: async () => ({
    listWorkspaces: async () => [{ id: 'w1', title: 'Atlas' }, { id: 'w2', title: 'Quiet' }, { id: 'w3', title: 'Theirs', owner: { id: 'o' } }],
  }) as never,
  workspaceView: async (id: string) => views[id] as never,
  call: (fn) => fn(),
})

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

describe('SharingTab', () => {
  it('shows collaborators with role and scope, and share links, per owned workspace', async () => {
    await act(async () => { root.render(<SharingTab views={fakeViews()} />) })
    await flush()
    await flush()
    const atlas = container.querySelector('section[aria-label="Atlas"]')!
    const cells = [...atlas.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))
    expect(cells).toContainEqual(['Bob', 'build', 'Workspace-wide'])
    expect(cells).toContainEqual(['cy@x', 'use', 'Todo'])
    expect(cells.find((row) => row[0] === 'for Dee')).toEqual(['for Dee', 'use', 'Todo', expect.any(String), 'Ada'])
    expect(cells.find((row) => row[0] === '—')?.slice(1, 3)).toEqual(['build', 'Workspace-wide'])
  })

  it('says "Not shared" for a workspace nobody holds, and skips workspaces shared with the user', async () => {
    await act(async () => { root.render(<SharingTab views={fakeViews()} />) })
    await flush()
    await flush()
    expect(container.querySelector('section[aria-label="Quiet"]')!.textContent).toContain('Not shared')
    expect(container.textContent).not.toContain('Theirs')
  })
})
