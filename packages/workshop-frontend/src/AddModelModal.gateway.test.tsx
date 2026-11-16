// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AiGatewayInfo, AuthenticatedApi, GatewayProviderModels } from '@gadgets/workshop-shared/api'

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

import AddModelModal from './AddModelModal'

const GATEWAY: AiGatewayInfo = {
  enabled: true, enabledProviders: ['cloudflare', 'openrouter'],
  builtInModelIds: ['z-ai/glm-5.3'], userModelsEnabled: true,
}

const LIST: GatewayProviderModels = {
  provider: 'openrouter', state: 'ready', models: [
    { provider: 'openrouter', id: 'z-ai/glm-5.3', name: 'Z.ai: GLM 5.3', contextWindow: 1048576 },
    { provider: 'openrouter', id: 'moonshotai/kimi-k3.1-pro', name: 'MoonshotAI: Kimi K3.1 Pro',
      contextWindow: 1048576, outputLimit: 131072, price: { input: 2, output: 10 } },
  ],
}

const labeledInput = (label: string) => {
  const element = Array.from(document.body.querySelectorAll('label'))
    .find((labelElement) => labelElement.textContent?.startsWith(label))
  const input = element && document.getElementById(element.htmlFor)
  if (!(input instanceof HTMLInputElement)) throw new Error(`No input labeled ${label}`)
  return input
}

const type = (element: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
})

const options = () => {
  const list = document.getElementById(labeledInput('Model ID').getAttribute('aria-controls') ?? '')
  return Array.from(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
}

describe('AddModelModal in AI Gateway mode', () => {
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
  })

  // A clone starts on its source's provider, which is how the dialog is opened on one here.
  const render = async (listing: () => Promise<GatewayProviderModels>) => {
    const listGatewayProviderModels = vi.fn<() => Promise<GatewayProviderModels>>(listing)
    const api = { listGatewayProviderModels } as unknown as RpcStub<AuthenticatedApi>
    const container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => root!.render(
      <AddModelModal
        visible onCancel={() => {}} onSuccess={() => {}} authenticatedApi={api} aiConfig={GATEWAY}
        mode={{ type: 'clone', source: {
          profile: { type: 'agent', id: 'old', name: 'Old' },
          config: { provider: 'openrouter', model: 'old', apiToken: '' },
        } }}
      />))
    return { listGatewayProviderModels }
  }

  it('searches the provider’s list, leaving out the deployment’s own models, and a pick fills the form', async () => {
    const { listGatewayProviderModels } = await render(async () => LIST)
    expect(listGatewayProviderModels).toHaveBeenCalledExactlyOnceWith('openrouter')

    await act(async () => labeledInput('Model ID').focus())
    await type(labeledInput('Model ID'), 'k')
    expect(options().map((option) => option.textContent)).toEqual([
      'MoonshotAI: Kimi K3.1 Promoonshotai/kimi-k3.1-pro$2 in · $10 out per M tokens · 1.05M context',
    ])

    await act(async () => { options()[0].click() })
    expect(labeledInput('Model ID').value).toBe('moonshotai/kimi-k3.1-pro')
    expect(labeledInput('Display Name').value).toBe('MoonshotAI: Kimi K3.1 Pro')
  })

  it('says why the list is missing, and still takes an ID typed by hand', async () => {
    await render(async () => ({ provider: 'openrouter', state: 'not-connected', models: [],
      note: 'The AI Gateway holds no OpenRouter key.' }))

    expect(document.body.querySelector('[role="status"]')?.textContent)
      .toBe('The AI Gateway holds no OpenRouter key.')
    await type(labeledInput('Model ID'), 'acme/model')
    expect(labeledInput('Model ID').value).toBe('acme/model')
    expect(options()).toEqual([])
  })
})
