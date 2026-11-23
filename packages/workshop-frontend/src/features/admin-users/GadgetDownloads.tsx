import { useState } from 'react'
import { formatAttachmentSize } from '../chat/attachmentFormatting'
import { saveBlobToFile } from '../../fileTransfers'
import type { AdminGadgetDataSize, AdminWorkspaceAccess, WorkpieceId } from '@gadgets/workshop-shared/api'
import { DownloadMenu } from './DownloadMenu'
import {
  downloadAll, downloadsDisabledReason, exportFileName, exportGadgetBytes, failureMessage,
  RECONNECT_NOTICE, RECONNECT_NOTICE_ALL, type GadgetToCopy,
} from './downloads'
import { GadgetsTab, type GadgetRowContext } from './GadgetsTab'
import { UsageTab } from './UsageTab'
import type { AdminViews } from './useAdminViews'
import { useOwnedWorkspaceData } from './useOwnedWorkspaceData'

type Measured = Pick<AdminGadgetDataSize, 'bytes' | 'measuredAt'>

/** "12.0 KB, measured 11/20/2026, 10:00 AM", or why there is no size. */
export const describeMeasurement = (measured: Measured | undefined): string =>
  measured === undefined
    ? 'Not measured'
    : `${formatAttachmentSize(measured.bytes) ?? '—'}, measured ${measured.measuredAt.toLocaleString()}`

/**
 * The last measured size of each gadget the user's workspaces hold, by gadget id, and a way to
 * record a fresh measurement. Reading them is a metadata call and pauses nothing.
 */
const useGadgetSizes = (views: AdminViews) => {
  const state = useOwnedWorkspaceData<AdminGadgetDataSize[]>(views, (view) => view.listGadgetDataSizes())
  const [measured, setMeasured] = useState<ReadonlyMap<WorkpieceId, Measured>>(new Map())
  const sizeOf = (gadgetId: WorkpieceId): Measured | undefined => {
    const fresh = measured.get(gadgetId)
    if (fresh !== undefined) return fresh
    if (state === null || 'error' in state) return undefined
    for (const data of state.data.values()) {
      const found = data === undefined || data === 'unavailable' ? undefined : data.find((entry) => entry.gadgetId === gadgetId)
      if (found !== undefined) return found
    }
    return undefined
  }
  const sizesOfWorkspace = (workspaceId: string): AdminGadgetDataSize[] | 'unavailable' | undefined => {
    if (state === null || 'error' in state) return undefined
    return state.data.get(workspaceId)
  }
  return { sizeOf, sizesOfWorkspace, record: (gadgetId: WorkpieceId, size: Measured) => setMeasured(new Map(measured).set(gadgetId, size)) }
}

/** The Gadgets tab with each gadget's last measured size and its download menu. */
export const GadgetsWithDownloads = ({ views, level }: { views: AdminViews; level?: AdminWorkspaceAccess }) => {
  const { sizeOf, record } = useGadgetSizes(views)
  const disabledReason = downloadsDisabledReason(level)
  const actionsOf = ({ workspace, gadget }: GadgetRowContext) => (
    <DownloadMenu
      label={gadget.title}
      confirmText={RECONNECT_NOTICE}
      disabledReason={disabledReason}
      actions={{
        code: async () => {
          const bytes = await exportGadgetBytes(views, workspace.id, gadget.id, 'code')
          saveBlobToFile(new Blob([bytes as BlobPart]), exportFileName(gadget.title, 'code'))
        },
        everything: async () => {
          const bytes = await exportGadgetBytes(views, workspace.id, gadget.id, 'everything')
          saveBlobToFile(new Blob([bytes as BlobPart], { type: 'application/zip' }), exportFileName(gadget.title, 'everything'))
        },
        measure: async () => {
          const result = await views.call(async () => (await views.workspaceView(workspace.id)).measureGadget(gadget.id))
          record(gadget.id, result)
        },
      }}
    />
  )
  return (
    <GadgetsTab
      views={views}
      renderSize={({ gadget }) => <span className="text-xs">{describeMeasurement(sizeOf(gadget.id))}</span>}
      renderActions={actionsOf}
    />
  )
}

/** The Usage tab with the last measured data sizes of each workspace's gadgets. */
export const UsageWithSizes = ({ views }: { views: AdminViews }) => {
  const { sizesOfWorkspace } = useGadgetSizes(views)
  return (
    <UsageTab
      views={views}
      renderDataSizes={(workspace) => {
        const sizes = sizesOfWorkspace(workspace.id)
        if (sizes === undefined) return '…'
        if (sizes === 'unavailable') return '—'
        const total = sizes.reduce((sum, entry) => sum + entry.bytes, 0)
        return sizes.length === 0
          ? 'Not measured'
          : `${formatAttachmentSize(total) ?? '—'} in ${sizes.length} ${sizes.length === 1 ? 'gadget' : 'gadgets'} measured`
      }}
    />
  )
}

/** Every gadget in the workspaces the user owns, and the workspaces that could not be read. */
const collectGadgets = async (views: AdminViews): Promise<{ gadgets: GadgetToCopy[]; notes: string[] }> => {
  const workspaces = (await views.call(async () => (await views.userView()).listWorkspaces()))
    .filter((workspace) => workspace.owner === undefined)
  const gadgets: GadgetToCopy[] = []
  const notes: string[] = []
  for (const workspace of workspaces) {
    try {
      const description = await views.call(async () => (await views.workspaceView(workspace.id)).describe())
      for (const piece of description.workpieces) {
        if (piece.type === 'gadget') gadgets.push({ workspace, gadget: piece })
      }
    } catch (err) {
      notes.push(`${workspace.title}: its gadgets could not be listed (${failureMessage(err)})`)
    }
  }
  return { gadgets, notes }
}

/** The panel header's "Download all": one ZIP of every gadget the user owns, with progress. */
export const DownloadAll = ({ views, userId, level }: {
  views: AdminViews
  userId: string
  level?: AdminWorkspaceAccess
}) => {
  const [status, setStatus] = useState<string | undefined>()
  const run = (mode: 'code' | 'everything') => async () => {
    setStatus('Listing gadgets…')
    try {
      const { gadgets, notes } = await collectGadgets(views)
      const blob = await downloadAll(views, gadgets, mode, (done, total) => setStatus(`${done} of ${total} gadgets`), notes)
      saveBlobToFile(blob, `${userId.replace(/[^A-Za-z0-9._-]+/g, '-')}-gadgets.zip`)
      setStatus('Done')
    } catch (err) {
      setStatus(undefined)
      throw err
    }
  }
  return (
    <DownloadMenu
      label="all gadgets"
      confirmText={RECONNECT_NOTICE_ALL}
      disabledReason={downloadsDisabledReason(level)}
      status={status}
      actions={{ code: run('code'), everything: run('everything') }}
    />
  )
}
