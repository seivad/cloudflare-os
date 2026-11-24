import { describe, expect, it } from 'vitest'
import type { AdminGatekeeperInfo } from '@gadgets/workshop-shared/api'
import { mergeServices, summarizeServices } from './services'

const keeper = (over: Partial<AdminGatekeeperInfo>): AdminGatekeeperInfo =>
  ({ id: 0, bindings: [], hooks: [], ...over }) as AdminGatekeeperInfo
const model = (modelId: string) => ({ type: 'aiModel', modelId, provider: 'p', modelName: modelId }) as const

describe('summarizeServices', () => {
  it('counts distinct gadgets per model and per vendor, and agent spawners', () => {
    const summary = summarizeServices([
      keeper({ creationSpec: model('claude'), bindings: [{ gadgetId: 1, name: 'AI' }, { gadgetId: 2, name: 'AI' }] }),
      keeper({ id: 2, creationSpec: model('claude'), bindings: [{ gadgetId: 1, name: 'AI2' }] }),
      keeper({ id: 3, vendorId: 'google', bindings: [{ gadgetId: 1, name: 'G' }, { gadgetId: 1, name: 'G2' }] }),
      keeper({
        id: 4, bindings: [{ gadgetId: 2, name: 'S' }],
        creationSpec: { type: 'agentSpawner', config: { displayName: 's', modelId: null, bindings: {} } } as never,
      }),
    ])
    expect(summary.models).toEqual([{ id: 'claude', gadgets: 2 }])
    expect(summary.vendors).toEqual([{ id: 'google', gadgets: 1 }])
    expect(summary.spawners).toBe(1)
  })

  it('leaves out bindings pending in a chat, and connections nothing else is bound to', () => {
    const summary = summarizeServices([
      keeper({ creationSpec: model('claude'), bindings: [{ gadgetId: 1, name: 'AI', chatId: 3 }] }),
      keeper({ id: 2, vendorId: 'google', bindings: [{ gadgetId: 1, name: 'G', chatId: 3 }, { gadgetId: 2, name: 'G' }] }),
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
