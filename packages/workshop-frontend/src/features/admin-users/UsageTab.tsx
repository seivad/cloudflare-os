import type { ReactNode } from 'react'
import { Loader, Table } from '@cloudflare/kumo'
import type { AdminUserWorkspace } from '@gadgets/workshop-shared/api'
import { formatAttachmentSize } from '../chat/attachmentFormatting'
import { mergeServices, summarizeServices, type ServicesSummary } from './services'
import type { AdminViews } from './useAdminViews'
import { useOwnedWorkspaceData } from './useOwnedWorkspaceData'

type Loaded = { storageBytes: number; services: ServicesSummary }

const ServiceList = ({ label, items, unit }: { label: string; items: { id: string; gadgets: number }[]; unit?: string }) => (
  <div className="space-y-1">
    <h4 className="text-xs font-semibold uppercase text-kumo-subtle">{label}</h4>
    {items.length === 0
      ? <p className="text-sm text-kumo-subtle">None</p>
      : (
        <ul className="text-sm">
          {items.map((item) => (
            <li key={item.id}>{item.id} <span className="text-kumo-subtle">({item.gadgets} {item.gadgets === 1 ? 'gadget' : 'gadgets'}{unit ?? ''})</span></li>
          ))}
        </ul>
      )}
  </div>
)

/**
 * The Usage tab: the total cost across the workspaces the user owns, each one's storage, and the
 * services their gadgets are connected to. `renderDataSizes`, when given, adds a section under
 * the storage table for the gadgets' measured data sizes of one workspace.
 */
export const UsageTab = ({ views, renderDataSizes }: {
  views: AdminViews
  renderDataSizes?: (workspace: AdminUserWorkspace) => ReactNode
}) => {
  const state = useOwnedWorkspaceData<Loaded>(views, async (view) => {
    const [diagnostics, gatekeepers] = await Promise.all([view.getDiagnostics(), view.listGatekeepers()])
    return { storageBytes: diagnostics.storageBytes, services: summarizeServices(gatekeepers) }
  })
  if (state === null) return <div className="flex justify-center py-8"><Loader /></div>
  if ('error' in state) return <p role="alert" className="text-sm text-kumo-danger">{state.error}</p>

  const totalCost = state.workspaces.reduce((sum, workspace) => sum + (workspace.totalCost ?? 0), 0)
  const loaded = state.workspaces.flatMap((workspace) => {
    const data = state.data.get(workspace.id)
    return data === undefined || data === 'unavailable' ? [] : [data]
  })
  const services = mergeServices(loaded.map((data) => data.services))
  const loading = state.workspaces.some((workspace) => state.data.get(workspace.id) === undefined)
  return (
    <div className="space-y-6">
      <section aria-label="Total cost" className="space-y-1">
        <h3 className="text-sm font-semibold">Total cost</h3>
        <p className="text-2xl font-semibold">${totalCost.toFixed(2)}</p>
        <p className="text-xs text-kumo-subtle">Across the {state.workspaces.length} {state.workspaces.length === 1 ? 'workspace' : 'workspaces'} they own.</p>
      </section>
      <section aria-label="Storage" className="space-y-2">
        <h3 className="text-sm font-semibold">Storage</h3>
        {state.workspaces.length === 0
          ? <p className="text-sm text-kumo-subtle">No workspaces.</p>
          : (
            <div className="overflow-x-auto">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Workspace</Table.Head>
                    <Table.Head>Storage</Table.Head>
                    {renderDataSizes !== undefined && <Table.Head>Gadget data</Table.Head>}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {state.workspaces.map((workspace) => {
                    const data = state.data.get(workspace.id)
                    return (
                      <Table.Row key={workspace.id}>
                        <Table.Cell>{workspace.title}</Table.Cell>
                        <Table.Cell>
                          {data === undefined ? <Loader size="sm" />
                            : data === 'unavailable' ? '—'
                            : formatAttachmentSize(data.storageBytes) ?? '—'}
                        </Table.Cell>
                        {renderDataSizes !== undefined && <Table.Cell>{renderDataSizes(workspace)}</Table.Cell>}
                      </Table.Row>
                    )
                  })}
                </Table.Body>
              </Table>
            </div>
          )}
      </section>
      <section aria-label="Services" className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">Services {loading && <Loader size="sm" />}</h3>
        <ServiceList label="AI models" items={services.models} />
        <ServiceList label="Gatekeepers" items={services.vendors} />
        <p className="text-sm">Agent spawners: {services.spawners}</p>
      </section>
    </div>
  )
}
