// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_ACCESS_ERROR_CODES, createAdminAccessError } from '@gadgets/workshop-shared/api'
import { DownloadAll, GadgetsWithDownloads, UsageWithSizes } from './GadgetDownloads'
import { CONTENT_LEVEL_TEXT } from './downloads'
import type { AdminViews } from './useAdminViews'

const saved = vi.hoisted(() => [] as { name: string; type: string; text: string }[])
// The files the last ZIP was made of.
const zipped = vi.hoisted(() => ({ files: new Map<string, string | Uint8Array>() }))
// jsdom's Blob cannot be read with text(); a FileReader can.
const readText = (blob: Blob) => new Promise<string>((resolve) => {
  const reader = new FileReader()
  reader.addEventListener('load', () => resolve(String(reader.result)))
  reader.readAsText(blob)
})
// zipFiles reads jsdom's Blob with stream(), which jsdom lacks; downloads.test.ts covers the ZIP itself.
vi.mock('@gadgets/workshop-shared/zip', async (original) => ({
  ...await original<typeof import('@gadgets/workshop-shared/zip')>(),
  zipFiles: async (files: ReadonlyMap<string, string | Uint8Array>) => {
    zipped.files = new Map(files)
    return new TextEncoder().encode([...files.keys()].join('|'))
  },
}))
vi.mock('../../fileTransfers', () => ({
  saveBlobToFile: async (blob: Blob, name: string) => { saved.push({ name, type: blob.type, text: await readText(blob) }) },
}))

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previous = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previous === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previous
})

const streamOf = (text: string) => new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() },
})

const fakeViews = (overrides: Record<string, unknown> = {}) => {
  const view = {
    describe: async () => ({ workpieces: [{ id: 'a', type: 'gadget', title: 'My Todo' }] }),
    listGatekeepers: async () => [],
    getDiagnostics: async () => ({ storageBytes: 1 }),
    getGadgetStorageSizes: async () => [{ gadgetId: 'a', bytes: 2048, measuredAt: new Date('2026-11-20T10:00:00Z') }],
    exportGadget: vi.fn<(id: string, mode: string) => Promise<ReadableStream<Uint8Array>>>(async (_id, mode) => streamOf(`export ${mode}`)),
    measureGadget: vi.fn<(id: string) => Promise<{ bytes: number; measuredAt: Date }>>(
      async () => ({ bytes: 5120, measuredAt: new Date('2026-11-23T10:00:00Z') })),
    ...overrides,
  }
  const views: AdminViews = {
    reason: 'r', setReason: vi.fn<(reason: string) => void>(),
    userView: async () => ({ listWorkspaces: async () => [{ id: 'w1', title: 'Atlas', totalCost: 0 }] }) as never,
    workspaceView: async () => view as never,
    call: (fn) => fn(views),
  }
  return { views, view }
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  saved.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const click = (element: Element) => act(async () => { (element as HTMLElement).click() })
const button = (name: string) =>
  [...container.querySelectorAll('button')].find((el) => el.textContent === name || el.getAttribute('aria-label') === name)!
const renderGadgets = async (views: AdminViews, level?: 'metadata' | 'content') => {
  await act(async () => { root.render(<GadgetsWithDownloads views={views} level={level} />) })
  await flush()
  await flush()
}

describe('GadgetsWithDownloads', () => {
  it('shows the last measured size and saves Code only under the gadget file name', async () => {
    const { views, view } = fakeViews()
    await renderGadgets(views, 'content')
    expect(container.textContent).toContain('2.0 KB, measured')
    await click(button('Download My Todo'))
    await click(button('Code only'))
    await flush()
    expect(view.exportGadget).toHaveBeenCalledWith('a', 'code')
    expect(saved).toEqual([{ name: 'my-todo.gadget', type: '', text: 'export code' }])
  })

  it('asks before Everything, saying people will see the gadget reconnect, then saves the ZIP', async () => {
    const { views, view } = fakeViews()
    await renderGadgets(views, 'content')
    await click(button('Download My Todo'))
    await click(button('Everything'))
    expect(view.exportGadget).not.toHaveBeenCalled()
    expect(container.textContent).toContain('reconnect once')
    await click(button('Continue'))
    await flush()
    expect(view.exportGadget).toHaveBeenCalledWith('a', 'everything')
    expect(saved.map((file) => file.name)).toEqual(['my-todo.zip'])
  })

  it('measures after confirming and shows the bytes and time', async () => {
    const { views, view } = fakeViews()
    await renderGadgets(views, 'content')
    await click(button('Download My Todo'))
    await click(button('Measure size'))
    expect(container.textContent).toContain('reconnect once')
    await click(button('Continue'))
    await flush()
    expect(view.measureGadget).toHaveBeenCalledWith('a')
    expect(container.textContent).toContain('5.0 KB, measured')
  })

  it('disables the items below the content level, saying why', async () => {
    const { views, view } = fakeViews()
    await renderGadgets(views, 'metadata')
    await click(button('Download My Todo'))
    expect(container.textContent).toContain(CONTENT_LEVEL_TEXT)
    const item = [...container.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === 'Code only') as HTMLButtonElement
    expect(item.disabled).toBe(true)
    expect(view.exportGadget).not.toHaveBeenCalled()
  })

  it('offers no download or size for a gadget still pending in a chat, saying so', async () => {
    const { views } = fakeViews({
      describe: async () => ({
        workpieces: [
          { id: 'a', type: 'gadget', title: 'My Todo' },
          { id: 'p', type: 'gadget', title: 'Draft', chatId: 3 },
        ],
      }),
    })
    await renderGadgets(views, 'content')
    const draft = [...container.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.startsWith('Draft'))!
    expect(draft.querySelector('button')).toBeNull()
    expect(draft.textContent).toContain('Pending in a chat')
    expect(draft.textContent).not.toContain('Not measured')
    expect(button('Download My Todo')).toBeDefined()
  })

  it('shows the same text when the server refuses with accessInsufficient', async () => {
    const { views } = fakeViews({
      exportGadget: async () => { throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.accessInsufficient) },
    })
    await renderGadgets(views)
    await click(button('Download My Todo'))
    await click(button('Code only'))
    await flush()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(CONTENT_LEVEL_TEXT)
  })
})

describe('UsageWithSizes', () => {
  it('shows each workspace’s last measured gadget data', async () => {
    const { views } = fakeViews()
    await act(async () => { root.render(<UsageWithSizes views={views} />) })
    await flush()
    await flush()
    expect(container.textContent).toContain('2.0 KB in 1 gadget measured')
  })
})

describe('DownloadAll', () => {
  it('builds one ZIP of every owned gadget, after confirming Everything', async () => {
    const { views, view } = fakeViews()
    await act(async () => { root.render(<DownloadAll views={views} userId="ada@example.com" level="content" />) })
    await click(button('Download all gadgets'))
    await click(button('Everything'))
    expect(container.textContent).toContain('reconnect once')
    await click(button('Continue'))
    await flush()
    await flush()
    await flush()
    expect(view.exportGadget).toHaveBeenCalledWith('a', 'everything')
    expect(saved).toEqual([{ name: 'ada-example.com-gadgets.zip', type: 'application/zip', text: 'atlas/my-todo.zip|README.md' }])
    expect(container.textContent).toContain('Done')
  })

  it('leaves out a gadget still pending in a chat, listing it in the README', async () => {
    const { views, view } = fakeViews({
      describe: async () => ({
        workpieces: [
          { id: 'p', type: 'gadget', title: 'Draft', chatId: 3 },
          { id: 'a', type: 'gadget', title: 'My Todo' },
        ],
      }),
    })
    await act(async () => { root.render(<DownloadAll views={views} userId="ada" level="content" />) })
    await click(button('Download all gadgets'))
    await click(button('Code only'))
    await flush()
    await flush()
    await flush()
    expect(view.exportGadget.mock.calls).toEqual([['a', 'code']])
    expect([...zipped.files.keys()]).toEqual(['atlas/my-todo.gadget', 'README.md'])
    expect(zipped.files.get('README.md')).toContain('- Atlas / Draft: pending in a chat')
  })
})
