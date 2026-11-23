// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageTab } from './UsageTab'
import type { AdminViews } from './useAdminViews'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previous = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previous === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previous
})

const keepers: Record<string, unknown[]> = {
  w1: [
    { id: 'k', creationSpec: { type: 'aiModel', modelId: 'claude-x', provider: 'p', modelName: 'x' }, bindings: [{ gadgetId: 'a', name: 'AI' }], hooks: [] },
    { id: 'v', vendorId: 'google', bindings: [{ gadgetId: 'a', name: 'G' }], hooks: [] },
  ],
  w2: [{ id: 'k2', creationSpec: { type: 'aiModel', modelId: 'claude-x', provider: 'p', modelName: 'x' }, bindings: [{ gadgetId: 'z', name: 'AI' }], hooks: [] }],
}
const sizes: Record<string, number> = { w1: 2048, w2: 1048576 }
const fakeViews = (list: unknown[]): AdminViews => ({
  reason: 'r', setReason: vi.fn<(reason: string) => void>(),
  userView: async () => ({ listWorkspaces: async () => list }) as never,
  workspaceView: async (id: string) => ({
    getDiagnostics: async () => ({ storageBytes: sizes[id] }),
    listGatekeepers: async () => keepers[id],
  }) as never,
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

describe('UsageTab', () => {
  it('totals the owned workspaces’ cost, shows storage per workspace and the services', async () => {
    const views = fakeViews([
      { id: 'w1', title: 'Atlas', totalCost: 1.25 },
      { id: 'w2', title: 'Borealis', totalCost: 2.5 },
      { id: 'w3', title: 'Theirs', totalCost: 99, owner: { id: 'o' } },
    ])
    await act(async () => { root.render(<UsageTab views={views} />) })
    await flush()
    await flush()
    const text = container.textContent ?? ''
    expect(text).toContain('$3.75')
    expect(text).toContain('2.0 KB')
    expect(text).toContain('1.0 MB')
    expect(text).not.toContain('Theirs')
    expect(text).toContain('claude-x (2 gadgets)')
    expect(text).toContain('google (1 gadget)')
    expect(text).toContain('Agent spawners: 0')
  })

  it('shows $0.00 and empty lists for a user with no workspaces', async () => {
    await act(async () => { root.render(<UsageTab views={fakeViews([])} />) })
    await flush()
    const text = container.textContent ?? ''
    expect(text).toContain('$0.00')
    expect(text).toContain('No workspaces.')
    expect(text.match(/None/g)).toHaveLength(2)
  })

  it('gives each workspace to the data-size slot', async () => {
    const views = fakeViews([{ id: 'w1', title: 'Atlas', totalCost: 0 }])
    await act(async () => { root.render(<UsageTab views={views} renderDataSizes={(w) => `sizes of ${w.title}`} />) })
    await flush()
    expect(container.textContent).toContain('sizes of Atlas')
  })
})
