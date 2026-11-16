/* eslint-disable react/react-in-jsx-scope */

// The model search in Chromium: real typing, arrows, Enter and Escape, which jsdom does not model.

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { GatewayProviderModel } from '@gadgets/workshop-shared/api'
import { ModelSearchField } from './ModelSearchField'

const MODELS: GatewayProviderModel[] = [
  { provider: 'openrouter', id: 'moonshotai/kimi-k3.1-pro', name: 'MoonshotAI: Kimi K3.1 Pro',
    contextWindow: 1048576, outputLimit: 131072, price: { input: 2, output: 10 } },
  { provider: 'openrouter', id: 'moonshotai/kimi-k3', name: 'MoonshotAI: Kimi K3',
    contextWindow: 1048576, price: { input: 0.6, output: 2.5 } },
  { provider: 'openrouter', id: 'z-ai/glm-5.3', name: 'Z.ai: GLM 5.3', contextWindow: 1048576,
    price: { input: 1.4, output: 4.4 } },
]

let root: Root | undefined

afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
})

it('narrows as it is typed into, moves with the arrows, picks on Enter and closes on Escape', async () => {
  const picked = vi.fn<(model: GatewayProviderModel) => void>()
  const Field = () => {
    const [value, setValue] = useState('')
    return (
      <div style={{ width: 560, padding: 16 }}>
        <ModelSearchField label="Model ID" value={value} models={MODELS}
          onValueChange={setValue} onPick={picked} />
      </div>
    )
  }
  root = createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => root!.render(<Field />))
  const field = page.getByRole('combobox', { name: 'Model ID' })

  await userEvent.click(field)
  await userEvent.keyboard('kimi')
  await expect.element(page.getByRole('option')).toHaveLength(2)
  await expect.element(page.getByText('$2 in · $10 out per M tokens · 1.05M context')).toBeVisible()

  await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}')
  expect(picked).toHaveBeenCalledExactlyOnceWith(MODELS[1])
  await expect.element(field).toHaveValue('moonshotai/kimi-k3')

  await userEvent.keyboard('{Backspace}')
  await expect.element(page.getByRole('option')).toHaveLength(2)
  await userEvent.keyboard('{Escape}')
  await expect.element(field).toHaveAttribute('aria-expanded', 'false')
  await expect.element(field).toHaveValue('moonshotai/kimi-k')
})
