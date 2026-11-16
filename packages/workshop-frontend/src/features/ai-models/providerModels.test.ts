import { describe, expect, it } from 'vitest'
import type { GatewayProviderModel } from '@gadgets/workshop-shared/api'
import { modelFacts, searchModels } from './providerModels'

const model = (id: string, name: string, extra: Partial<GatewayProviderModel> = {}): GatewayProviderModel =>
  ({ provider: 'openrouter', id, name, ...extra })

const MODELS = [
  model('qwen/qwen3.8-27b', 'Qwen: Qwen3.8 27B'),
  model('z-ai/glm-5.3', 'Z.ai: GLM 5.3'),
  model('acme/glm-helper', 'Acme helper for GLM'),
  model('glm/original', 'Original'),
]

describe('searchModels', () => {
  it('needs every word in the name or ID, and puts what starts with the first word first', () => {
    expect(searchModels(MODELS, 'glm').shown.map((m) => m.id))
      .toEqual(['glm/original', 'z-ai/glm-5.3', 'acme/glm-helper'])
    expect(searchModels(MODELS, 'GLM 5.3').shown.map((m) => m.id)).toEqual(['z-ai/glm-5.3'])
    expect(searchModels(MODELS, 'nothing like it')).toEqual({ shown: [], total: 0 })
  })

  it('shows every model for an empty query, at most the limit, and counts them all', () => {
    expect(searchModels(MODELS, '  ', 2)).toEqual({ shown: MODELS.slice(0, 2), total: 4 })
    expect(searchModels(MODELS, 'glm', 1).total).toBe(3)
  })
})

describe('modelFacts', () => {
  it('says the price in and out per million tokens, the window and the rate, as far as known', () => {
    expect(modelFacts(model('a', 'A', { price: { input: 1.4, output: 4.4 }, contextWindow: 1048576, rateLimit: 20 })))
      .toBe('$1.4 in · $4.4 out per M tokens · 1.05M context · 20 rpm')
    expect(modelFacts(model('a', 'A', { price: { input: 0.045, output: 0.5 }, contextWindow: 131072 })))
      .toBe('$0.045 in · $0.5 out per M tokens · 131K context')
    expect(modelFacts(model('a', 'A', { price: { input: 0, output: 0 } }))).toBe('Free')
    expect(modelFacts(model('a', 'A'))).toBe('No list price')
  })
})
