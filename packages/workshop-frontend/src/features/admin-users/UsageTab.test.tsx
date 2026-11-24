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
const fakeViews = (list: unknown[], summary?: unknown): AdminViews => {
  const fakes: AdminViews = {
    reason: 'r', setReason: vi.fn<(reason: string) => void>(),
    userView: async () => ({
      listWorkspaces: async () => list,
      getCostSummary: async () => { if (summary === undefined) throw new Error('no summary'); return summary },
    }) as never,
    workspaceView: async (id: string) => ({
      getDiagnostics: async () => ({ storageBytes: sizes[id] }),
      listGatekeepers: async () => keepers[id],
    }) as never,
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

  it('headlines the cost summary, and breaks it down by kind and by model', async () => {
    const text: Record<string, unknown> = { source: 'chat', kind: 'text', model: 'glm', estimated: false, usd: 1.5, requests: 3, inputTokens: 1000, outputTokens: 234 }
    const image = { source: 'action', kind: 'image', model: 'flux', estimated: true, usd: 0.5, requests: 1 }
    const old = { source: 'chat', kind: 'text', model: 'earlier', estimated: false, usd: 0.25, requests: 0 }
    const summary = {
      totalCost: 4.75,
      byKind: { text: 2.25, image: 0.5, speech: 2 },
      byModel: { glm: 1.5, flux: 0.5, earlier: 0.25, tts: 2.5 },
      workspaces: [{ workspaceId: 'w1', title: 'Atlas', totalCost: 2, lines: [text, image] }],
      deletedWorkspaces: { totalCost: 0.25, lines: [old] },
      own: { totalCost: 2.5, lines: [{ source: 'voice', kind: 'speech', model: 'tts', estimated: false, usd: 2.5, requests: 7 }] },
    }
    const views = fakeViews([{ id: 'w1', title: 'Atlas', totalCost: 2 }], summary)
    await act(async () => { root.render(<UsageTab views={views} />) })
    await flush()
    await flush()
    const text0 = container.textContent ?? ''
    expect(text0).toContain('$4.75')
    const kindRows = [...container.querySelectorAll('section[aria-label="Cost by kind"] tbody tr')].map((row) => row.textContent)
    expect(kindRows).toEqual(['Text$2.25', 'Speech$2.00', 'Image$0.50'])
    const modelRows = [...container.querySelectorAll('section[aria-label="Cost by model"] tbody tr')]
      .map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent))
    expect(modelRows).toEqual([
      ['tts', '$2.50', '7', '—'],
      ['glm', '$1.50', '3', '1,234'],
      ['flux', '$0.50 (estimated)', '1', '—'],
      ['earlier (not broken down)', '$0.25', '0', '—'],
    ])
    expect(text0).toContain('Deleted workspaces: $0.25')
  })

  it('falls back to the workspaces’ total and says so when the summary cannot be read', async () => {
    const views = fakeViews([{ id: 'w1', title: 'Atlas', totalCost: 1.25 }])
    await act(async () => { root.render(<UsageTab views={views} />) })
    await flush()
    await flush()
    expect(container.textContent).toContain('$1.25')
    expect(container.textContent).toContain('Couldn’t load the cost breakdown.')
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
