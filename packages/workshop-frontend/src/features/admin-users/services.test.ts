import { describe, expect, it } from 'vitest'
import type { AdminGatekeeperInfo } from '@gadgets/workshop-shared/api'
import { mergeServices, summarizeServices } from './services'

const keeper = (over: Partial<AdminGatekeeperInfo>): AdminGatekeeperInfo =>
  ({ id: 'g', bindings: [], hooks: [], ...over }) as AdminGatekeeperInfo
const model = (modelId: string) => ({ type: 'aiModel', modelId, provider: 'p', modelName: modelId }) as const

describe('summarizeServices', () => {
  it('counts distinct gadgets per model and per vendor, and agent spawners', () => {
    const summary = summarizeServices([
      keeper({ creationSpec: model('claude'), bindings: [{ gadgetId: 'a', name: 'AI' }, { gadgetId: 'b', name: 'AI' }] }),
      keeper({ id: 'g2', creationSpec: model('claude'), bindings: [{ gadgetId: 'a', name: 'AI2' }] }),
      keeper({ id: 'g3', vendorId: 'google', bindings: [{ gadgetId: 'a', name: 'G' }, { gadgetId: 'a', name: 'G2' }] }),
      keeper({
        id: 'g4', bindings: [{ gadgetId: 'b', name: 'S' }],
        creationSpec: { type: 'agentSpawner', config: { displayName: 's', modelId: null, bindings: {} } } as never,
      }),
    ])
    expect(summary.models).toEqual([{ id: 'claude', gadgets: 2 }])
    expect(summary.vendors).toEqual([{ id: 'google', gadgets: 1 }])
    expect(summary.spawners).toBe(1)
  })

  it('leaves out bindings pending in a chat, and connections nothing else is bound to', () => {
    const summary = summarizeServices([
      keeper({ creationSpec: model('claude'), bindings: [{ gadgetId: 'a', name: 'AI', chatId: 3 }] }),
      keeper({ id: 'g2', vendorId: 'google', bindings: [{ gadgetId: 'a', name: 'G', chatId: 3 }, { gadgetId: 'b', name: 'G' }] }),
    ])
    expect(summary).toEqual({ models: [], vendors: [{ id: 'google', gadgets: 1 }], spawners: 0 })
  })

  it('merges summaries of separate workspaces by adding', () => {
    const one = { models: [{ id: 'm', gadgets: 1 }], vendors: [], spawners: 1 }
    const two = { models: [{ id: 'm', gadgets: 2 }], vendors: [{ id: 'v', gadgets: 1 }], spawners: 0 }
    expect(mergeServices([one, two])).toEqual({
      models: [{ id: 'm', gadgets: 3 }], vendors: [{ id: 'v', gadgets: 1 }], spawners: 1,
    })
  })
})
