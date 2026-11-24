// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GadgetsTab } from './GadgetsTab'
import type { AdminViews } from './useAdminViews'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previous = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previous === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previous
})

const workspaces = [
  { id: 'w1', title: 'Atlas', totalCost: 1 },
  { id: 'w2', title: 'Borealis', totalCost: 0, owner: { id: 'bob' } },
  { id: 'w3', title: 'Cirrus', totalCost: 0 },
]
const fakeViews = (): AdminViews => {
  const views: Record<string, unknown> = {
    w1: {
      describe: async () => ({
        workpieces: [
          { id: 'a', type: 'gadget', title: 'Todo' },
          { id: 'wt', type: 'worktree', title: 'Branch' },
          { id: 'b', type: 'gadget', title: 'Notes' },
        ],
      }),
      listGatekeepers: async () => [
        { id: 'k1', resourceTitle: 'Sheet 1', vendorId: 'google', bindings: [{ gadgetId: 'a', name: 'SHEET' }], hooks: [] },
        { id: 'k2', creationSpec: { type: 'aiModel', modelId: 'm', provider: 'p', modelName: 'claude-x' },
          bindings: [{ gadgetId: 'a', name: 'AI' }, { gadgetId: 'b', name: 'AI', chatId: 2 }], hooks: [] },
      ],
    },
    w3: {
      describe: async () => ({ workpieces: [{ id: 'c', type: 'gadget', title: 'Clouds' }] }),
      listGatekeepers: async () => [],
    },
  }
  const fakes: AdminViews = {
    reason: 'r', setReason: vi.fn<(reason: string) => void>(),
    userView: async () => ({ listWorkspaces: async () => workspaces }) as never,
    workspaceView: async (id: string) => views[id] as never,
    call: (fn) => fn(fakes),
  }
  return fakes
}

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
const rows = () => [...container.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))

describe('GadgetsTab', () => {
  it('lists the gadgets of owned workspaces only, with workspace and settled connections', async () => {
    await act(async () => { root.render(<GadgetsTab views={fakeViews()} />) })
    await flush()
    await flush()
    expect(rows()).toEqual([
      ['Todo', 'Atlas', 'Sheet 1, claude-x'],
      ['Notes', 'Atlas', '—'],
      ['Clouds', 'Cirrus', '—'],
    ])
  })

  it('gives each row to the size and actions slots', async () => {
    await act(async () => {
      root.render(
        <GadgetsTab
          views={fakeViews()}
          renderSize={({ gadget }) => `size of ${gadget.title}`}
          renderActions={({ gadget }) => <button>Get {gadget.title}</button>}
        />,
      )
    })
    await flush()
    await flush()
    expect(container.textContent).toContain('size of Todo')
    expect(container.textContent).toContain('Get Clouds')
  })

  it('says so when the user owns no gadgets', async () => {
    const views: AdminViews = {
      ...fakeViews(),
      userView: async () => ({ listWorkspaces: async () => [] }) as never,
      call: (fn) => fn(views),
    }
    await act(async () => { root.render(<GadgetsTab views={views} />) })
    await flush()
    expect(container.textContent).toContain('owns no workspaces')
  })
})
