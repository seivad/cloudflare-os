import {
  ADMIN_ACCESS_ERROR_CODES, getAdminAccessErrorCode,
  type AdminGadgetExportMode, type AdminWorkspaceAccess, type WorkpieceId,
} from '@gadgets/workshop-shared/api'
import { fileNameSlug, zipFiles } from '@gadgets/workshop-shared/zip'
import type { AdminViews } from './useAdminViews'

/** What a disabled download control says: downloads need the "content" access level. */
export const CONTENT_LEVEL_TEXT = 'Downloads need the content access level'

/** What the confirmation says before a gadget is read through its storage. */
export const RECONNECT_NOTICE = 'Anyone using this gadget will see it reconnect once while it is read.'

/** The same, for a copy of several gadgets. */
export const RECONNECT_NOTICE_ALL = 'Anyone using these gadgets will see each of them reconnect once while it is read.'

/** The reason downloads are unavailable at `level`, or undefined when they may be tried (the
 * level is unknown or "content"; the server still refuses what the level does not allow). */
export const downloadsDisabledReason = (level: AdminWorkspaceAccess | undefined): string | undefined =>
  level === undefined || level === 'content' ? undefined : CONTENT_LEVEL_TEXT

/** The file name a copy is saved under: `<slug>.gadget` for code alone, `<slug>.zip` with data. */
export const exportFileName = (title: string, mode: AdminGadgetExportMode): string =>
  `${fileNameSlug(title)}${mode === 'code' ? '.gadget' : '.zip'}`

/** One sentence for why a download or measurement failed. */
export const failureMessage = (err: unknown): string => {
  const code = getAdminAccessErrorCode(err)
  if (code === ADMIN_ACCESS_ERROR_CODES.accessInsufficient) return CONTENT_LEVEL_TEXT
  return err instanceof Error && err.message !== '' ? err.message : 'It failed for an unknown reason.'
}

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(stream).arrayBuffer())

/** Copies one gadget, returning the file's bytes. Runs through `views.call`, so an expired view
 * is reopened once. */
export const exportGadgetBytes = (
  views: Pick<AdminViews, 'call'>,
  workspaceId: string,
  gadgetId: WorkpieceId,
  mode: AdminGadgetExportMode,
): Promise<Uint8Array> =>
  views.call(async ({ workspaceView }) => readAll(await (await workspaceView(workspaceId)).exportGadget(gadgetId, mode)))

/** A gadget to copy, with the workspace that holds it. */
export type GadgetToCopy = { workspace: { id: string; title: string }; gadget: { id: WorkpieceId; title: string } }

/** The first of `name`, `name-2`, … that `taken` does not hold; adds it to `taken`. */
const uniqueName = (name: string, taken: Set<string>): string => {
  let candidate = name
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${name}-${n}`
  taken.add(candidate)
  return candidate
}

/**
 * Copies each gadget in turn and zips the copies into one archive, a folder per workspace (named
 * by its title) holding each gadget's file as `exportFileName` names it. A gadget that fails does
 * not stop the rest: the top-level README.md lists it with its message, and `notes` (what could
 * not be listed at all) after it. `onProgress` reports gadgets done of the total, before the
 * first and after each.
 */
export const downloadAll = async (
  views: Pick<AdminViews, 'call'>,
  gadgets: readonly GadgetToCopy[],
  mode: AdminGadgetExportMode,
  onProgress: (done: number, total: number) => void,
  notes: readonly string[] = [],
): Promise<Blob> => {
  const files = new Map<string, Uint8Array | string>()
  const failures: string[] = []
  const folders = new Map<string, string>()
  const folderNames = new Set<string>()
  const fileNames = new Set<string>()
  onProgress(0, gadgets.length)
  let done = 0
  for (const { workspace, gadget } of gadgets) {
    try {
      const bytes = await exportGadgetBytes(views, workspace.id, gadget.id, mode)
      if (!folders.has(workspace.id)) folders.set(workspace.id, uniqueName(fileNameSlug(workspace.title, 'workspace'), folderNames))
      const folder = folders.get(workspace.id)!
      const name = exportFileName(gadget.title, mode)
      const extension = name.slice(name.lastIndexOf('.'))
      const path = uniqueName(`${folder}/${name.slice(0, -extension.length)}`, fileNames)
      files.set(`${path}${extension}`, bytes)
    } catch (err) {
      failures.push(`- ${workspace.title} / ${gadget.title}: ${failureMessage(err)}`)
    }
    done += 1
    onProgress(done, gadgets.length)
  }
  const readme = [
    '# Gadget copies',
    '',
    mode === 'code'
      ? 'Each file is a gadget\'s code, a .gadget archive any Cloudflare OS can import with Import blueprint.'
      : 'Each file is a ZIP of a gadget\'s code (.gadget), its stored data (.data.json) and a README.',
    '',
    failures.length === 0 && notes.length === 0
      ? `All ${gadgets.length} gadgets were copied.`
      : 'These could not be copied:',
    ...failures,
    ...notes.map((note) => `- ${note}`),
    '',
  ].join('\n')
  files.set('README.md', readme)
  return new Blob([await zipFiles(files) as BlobPart], { type: 'application/zip' })
}
