import { describe, expect, it, vi } from 'vitest'
import { createAdminAccessError, ADMIN_ACCESS_ERROR_CODES } from '@gadgets/workshop-shared/api'
import { downloadAll, downloadsDisabledReason, exportFileName, CONTENT_LEVEL_TEXT } from './downloads'

const streamOf = (text: string) => new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() },
})

const viewsFor = (exporter: (gadgetId: number, mode: string) => Promise<ReadableStream<Uint8Array>>) => ({
  call: <T,>(fn: () => Promise<T>) => fn(),
  workspaceView: async () => ({ exportGadget: exporter }) as never,
})

// Entry names of a ZIP, read from its central directory.
const entryNames = async (blob: Blob): Promise<string[]> => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(bytes.buffer)
  const names: string[] = []
  for (let i = 0; i + 46 < bytes.length; i += 1) {
    if (view.getUint32(i, true) !== 0x02014b50) continue
    const length = view.getUint16(i + 28, true)
    names.push(new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + length)))
  }
  return names
}

// The text of a deflated entry, found through the central directory.
const readEntry = async (bytes: Uint8Array, name: string): Promise<string> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i + 46 < bytes.length; i += 1) {
    if (view.getUint32(i, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(i + 28, true)
    if (new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + nameLength)) !== name) continue
    const local = view.getUint32(i + 42, true)
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const data = bytes.subarray(start, start + view.getUint32(i + 20, true))
    const method = view.getUint16(i + 10, true)
    if (method === 0) return new TextDecoder().decode(data)
    return new Response(new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text()
  }
  throw new Error(`no entry ${name}`)
}

describe('exportFileName', () => {
  it('uses the gadget title’s slug, with .gadget for code and .zip for everything', () => {
    expect(exportFileName('My Todo List', 'code')).toBe('my-todo-list.gadget')
    expect(exportFileName('My Todo List', 'everything')).toBe('my-todo-list.zip')
  })
})

describe('downloadsDisabledReason', () => {
  it('disables below content only', () => {
    expect(downloadsDisabledReason('metadata')).toBe(CONTENT_LEVEL_TEXT)
    expect(downloadsDisabledReason('off')).toBe(CONTENT_LEVEL_TEXT)
    expect(downloadsDisabledReason('content')).toBeUndefined()
    expect(downloadsDisabledReason(undefined)).toBeUndefined()
  })
})

describe('downloadAll', () => {
  const gadgets = [
    { workspace: { id: 'w1', title: 'Atlas' }, gadget: { id: 1, title: 'Todo' } },
    { workspace: { id: 'w1', title: 'Atlas' }, gadget: { id: 2, title: 'Broken' } },
    { workspace: { id: 'w2', title: 'Cirrus' }, gadget: { id: 3, title: 'Todo' } },
  ]

  it('resolves with the others when one gadget fails, and reports progress', async () => {
    const views = viewsFor(async (id: number) => {
      if (id === 2) throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.accessInsufficient)
      return streamOf(`bytes of ${id}`)
    })
    const progress = vi.fn<(done: number, total: number) => void>()
    const blob = await downloadAll(views, gadgets, 'code', progress)
    expect(await entryNames(blob)).toEqual(['atlas/todo.gadget', 'cirrus/todo.gadget', 'README.md'])
    expect(progress.mock.calls).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]])
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(await readEntry(bytes, 'atlas/todo.gadget')).toBe('bytes of 1')
    const readme = await readEntry(bytes, 'README.md')
    expect(readme).toContain('Atlas / Broken: ' + CONTENT_LEVEL_TEXT)
    expect(readme).not.toContain('Cirrus')
  })

  it('names a failure’s own message in the README', async () => {
    const blob = await downloadAll(viewsFor(async () => { throw new Error('too big') }), [gadgets[1]!], 'code', () => {})
    expect(await readEntry(new Uint8Array(await blob.arrayBuffer()), 'README.md')).toContain('Atlas / Broken: too big')
  })
})
