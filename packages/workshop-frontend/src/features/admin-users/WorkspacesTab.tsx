import { useEffect, useState } from 'react'
import { Loader, Table } from '@cloudflare/kumo'
import type { AdminUserWorkspace } from '@gadgets/workshop-shared/api'
import { formatAttachmentSize } from '../chat/attachmentFormatting'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { describeFailure } from './describeFailure'
import type { AdminViews } from './useAdminViews'

/** What one owned workspace's own view adds to the account's listing. */
type Detail = { gadgets: number; cost: number | undefined; storageBytes: number } | 'unavailable'

const dateOrDash = (date: Date | undefined) => date === undefined ? '—' : formatFullTimestamp(date)
const formatCost = (cost: number | undefined) => cost === undefined ? '—' : `$${cost.toFixed(4)}`

const OwnedRow = ({ workspace, views }: { workspace: AdminUserWorkspace; views: AdminViews }) => {
  const [detail, setDetail] = useState<Detail | null>(null)
  const { call } = views
  useEffect(() => {
    let current = true
    call(async ({ workspaceView }) => {
      const view = await workspaceView(workspace.id)
      const [description, diagnostics] = await Promise.all([view.describe(), view.getDiagnostics()])
      return {
        gadgets: description.workpieces.filter((piece) => piece.type === 'gadget').length,
        cost: description.totalCost,
        storageBytes: diagnostics.storageBytes,
      } satisfies Detail
    }).then(
      (found) => { if (current) setDetail(found) },
      () => { if (current) setDetail('unavailable') },
    )
    return () => { current = false }
  }, [call, workspace.id])

  const loading = detail === null
  const known = detail !== null && detail !== 'unavailable' ? detail : null
  const cell = (text: string | undefined) => loading ? <Loader size="sm" /> : (text ?? '—')
  return (
    <Table.Row>
      <Table.Cell>{workspace.title}</Table.Cell>
      <Table.Cell>{dateOrDash(workspace.created)}</Table.Cell>
      <Table.Cell>{dateOrDash(workspace.lastActive)}</Table.Cell>
      <Table.Cell>{cell(known === null ? undefined : String(known.gadgets))}</Table.Cell>
      <Table.Cell>{cell(known === null ? undefined : formatCost(known.cost ?? workspace.totalCost))}</Table.Cell>
      <Table.Cell>{cell(known === null ? undefined : formatAttachmentSize(known.storageBytes) ?? undefined)}</Table.Cell>
    </Table.Row>
  )
}

/**
 * The Workspaces tab: the workspaces the user owns, each with its gadget count, cost and storage
 * read through that workspace's own audited view, and the ones shared with them. A workspace
 * whose view cannot be opened (a provisional one, say) shows dashes.
 */
export const WorkspacesTab = ({ views }: { views: AdminViews }) => {
  const [state, setState] = useState<{ workspaces: AdminUserWorkspace[] } | { error: string } | null>(null)
  const { call } = views
  useEffect(() => {
    let current = true
    call(async ({ userView }) => (await userView()).listWorkspaces()).then(
      (workspaces) => { if (current) setState({ workspaces }) },
      (err: unknown) => { if (current) setState({ error: describeFailure(err, 'workspaces') }) },
    )
    return () => { current = false }
  }, [call])

  if (state === null) return <div className="flex justify-center py-8"><Loader /></div>
  if ('error' in state) return <p role="alert" className="text-sm text-kumo-danger">{state.error}</p>
  const owned = state.workspaces.filter((workspace) => workspace.owner === undefined)
  const shared = state.workspaces.filter((workspace) => workspace.owner !== undefined)
  if (state.workspaces.length === 0) {
    return <p className="py-6 text-center text-sm text-kumo-subtle">This user has no workspaces.</p>
  }
  return (
    <div className="space-y-6">
      <section aria-label="Owned workspaces" className="space-y-2">
        <h3 className="text-sm font-semibold">Owned ({owned.length})</h3>
        {owned.length === 0
          ? <p className="text-sm text-kumo-subtle">Owns no workspaces.</p>
          : (
            <div className="overflow-x-auto">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Title</Table.Head>
                    <Table.Head>Created</Table.Head>
                    <Table.Head>Last active</Table.Head>
                    <Table.Head>Gadgets</Table.Head>
                    <Table.Head>Cost</Table.Head>
                    <Table.Head>Storage</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {owned.map((workspace) => <OwnedRow key={workspace.id} workspace={workspace} views={views} />)}
                </Table.Body>
              </Table>
            </div>
          )}
      </section>
      <section aria-label="Shared with them" className="space-y-2">
        <h3 className="text-sm font-semibold">Shared with them ({shared.length})</h3>
        {shared.length === 0
          ? <p className="text-sm text-kumo-subtle">Has opened no one else’s workspace.</p>
          : (
            <div className="overflow-x-auto">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Title</Table.Head>
                    <Table.Head>Owner</Table.Head>
                    <Table.Head>Role</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {shared.map((workspace) => (
                    <Table.Row key={workspace.id}>
                      <Table.Cell>{workspace.title}</Table.Cell>
                      <Table.Cell>{workspace.owner?.name || workspace.owner?.id}</Table.Cell>
                      <Table.Cell>{workspace.role ?? '—'}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          )}
      </section>
    </div>
  )
}
