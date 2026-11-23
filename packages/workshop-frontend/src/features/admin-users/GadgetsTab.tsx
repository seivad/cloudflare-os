import type { ReactNode } from 'react'
import { Loader, Table } from '@cloudflare/kumo'
import type { AdminGatekeeperInfo, AdminUserWorkspace, GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { AdminViews } from './useAdminViews'
import { useOwnedWorkspaceData } from './useOwnedWorkspaceData'

type Loaded = { gadgets: GadgetSummary[]; gatekeepers: AdminGatekeeperInfo[] }

/** What a connection is called in a gadget's row: its resource, else its model or vendor. */
const connectionLabel = (gatekeeper: AdminGatekeeperInfo): string => {
  if (gatekeeper.resourceTitle) return gatekeeper.resourceTitle
  const spec = gatekeeper.creationSpec
  if (spec?.type === 'aiModel') return spec.modelName
  if (spec?.type === 'agentSpawner') return spec.config.displayName
  if (spec?.type === 'modelCatalog') return 'Model catalog'
  return gatekeeper.vendorId ?? 'Connection'
}

/** The labels of the settled connections bound to a gadget; pending bindings are not yet its own. */
export const connectionsOf = (gadgetId: WorkpieceId, gatekeepers: AdminGatekeeperInfo[]): string[] =>
  gatekeepers
    .filter((gatekeeper) => gatekeeper.bindings.some((binding) => binding.gadgetId === gadgetId && binding.chatId === undefined))
    .map(connectionLabel)

/** What a row's slots are given, so the extra columns Task 8 adds can act on the gadget. */
export type GadgetRowContext = { workspace: AdminUserWorkspace; gadget: GadgetSummary }

/**
 * The Gadgets tab: every gadget of every workspace the user owns, with its workspace and the
 * connections it is bound to. `renderSize` and `renderActions`, when given, add a column each
 * (the last measured data size, the download menu); they are cells of this table, not part of
 * what it reads.
 */
export const GadgetsTab = ({ views, renderSize, renderActions }: {
  views: AdminViews
  renderSize?: (row: GadgetRowContext) => ReactNode
  renderActions?: (row: GadgetRowContext) => ReactNode
}) => {
  const state = useOwnedWorkspaceData<Loaded>(views, async (view) => {
    const [description, gatekeepers] = await Promise.all([view.describe(), view.listGatekeepers()])
    return {
      gadgets: description.workpieces.filter((piece): piece is GadgetSummary => piece.type === 'gadget'),
      gatekeepers,
    }
  })
  if (state === null) return <div className="flex justify-center py-8"><Loader /></div>
  if ('error' in state) return <p role="alert" className="text-sm text-kumo-danger">{state.error}</p>
  if (state.workspaces.length === 0) {
    return <p className="py-6 text-center text-sm text-kumo-subtle">This user owns no workspaces.</p>
  }
  const rows = state.workspaces.flatMap((workspace) => {
    const data = state.data.get(workspace.id)
    return data === undefined || data === 'unavailable' ? [] : data.gadgets.map((gadget) => ({ workspace, gadget, data }))
  })
  const pending = state.workspaces.some((workspace) => state.data.get(workspace.id) === undefined)
  const unavailable = state.workspaces.filter((workspace) => state.data.get(workspace.id) === 'unavailable')
  return (
    <div className="space-y-3">
      {rows.length === 0 && !pending
        ? <p className="py-6 text-center text-sm text-kumo-subtle">No gadgets in this user’s workspaces.</p>
        : (
          <div className="overflow-x-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Gadget</Table.Head>
                  <Table.Head>Workspace</Table.Head>
                  <Table.Head>Connections</Table.Head>
                  {renderSize !== undefined && <Table.Head>Data size</Table.Head>}
                  {renderActions !== undefined && <Table.Head><span className="sr-only">Actions</span></Table.Head>}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map(({ workspace, gadget, data }) => {
                  const connections = connectionsOf(gadget.id, data.gatekeepers)
                  return (
                    <Table.Row key={`${workspace.id}/${gadget.id}`}>
                      <Table.Cell>{gadget.title}</Table.Cell>
                      <Table.Cell>{workspace.title}</Table.Cell>
                      <Table.Cell>{connections.length === 0 ? '—' : connections.join(', ')}</Table.Cell>
                      {renderSize !== undefined && <Table.Cell>{renderSize({ workspace, gadget })}</Table.Cell>}
                      {renderActions !== undefined && <Table.Cell>{renderActions({ workspace, gadget })}</Table.Cell>}
                    </Table.Row>
                  )
                })}
              </Table.Body>
            </Table>
          </div>
        )}
      {pending && <div className="flex justify-center py-2"><Loader size="sm" /></div>}
      {unavailable.length > 0 && (
        <p className="text-sm text-kumo-subtle">
          Could not read {unavailable.map((workspace) => workspace.title).join(', ')}.
        </p>
      )}
    </div>
  )
}
