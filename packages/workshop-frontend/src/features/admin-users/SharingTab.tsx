import { Loader, Table } from '@cloudflare/kumo'
import type { AdminWorkspaceDescription, ShareLinkInfo, WorkpieceId } from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import type { AdminViews } from './useAdminViews'
import { useOwnedWorkspaceData } from './useOwnedWorkspaceData'

type Loaded = { description: AdminWorkspaceDescription; links: ShareLinkInfo[] }

/** A gadget's title among the workspace's workpieces, falling back to its id. */
const titleOf = (description: AdminWorkspaceDescription, gadgetId: WorkpieceId) =>
  description.workpieces.find((piece) => piece.id === gadgetId)?.title ?? String(gadgetId)

/** What a share link grants: the one gadget, the gadgets of an old multi-gadget link, or the workspace. */
const linkScope = (description: AdminWorkspaceDescription, link: ShareLinkInfo): string => {
  if (link.gadgetId !== undefined) return titleOf(description, link.gadgetId)
  if (link.gadgets !== undefined && link.gadgets.length > 0) return link.gadgets.map((gadget) => gadget.title).join(', ')
  return 'Workspace-wide'
}

const Workspace = ({ title, data }: { title: string; data: Loaded | 'unavailable' | undefined }) => {
  const heading = <h3 className="text-sm font-semibold">{title}</h3>
  if (data === undefined) return <section className="space-y-2" aria-label={title}>{heading}<Loader size="sm" /></section>
  if (data === 'unavailable') {
    return <section className="space-y-2" aria-label={title}>{heading}<p className="text-sm text-kumo-subtle">Could not be read.</p></section>
  }
  const { description, links } = data
  if (description.collaborators.length === 0 && links.length === 0) {
    return <section className="space-y-2" aria-label={title}>{heading}<p className="text-sm text-kumo-subtle">Not shared</p></section>
  }
  return (
    <section className="space-y-3" aria-label={title}>
      {heading}
      {description.collaborators.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Collaborator</Table.Head>
                <Table.Head>Role</Table.Head>
                <Table.Head>Access</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {description.collaborators.map((collaborator) => (
                <Table.Row key={collaborator.profile.id}>
                  <Table.Cell>{collaborator.profile.name || collaborator.profile.id}</Table.Cell>
                  <Table.Cell>{collaborator.access.role}</Table.Cell>
                  <Table.Cell>
                    {collaborator.access.role === 'build'
                      ? 'Workspace-wide'
                      : collaborator.access.gadgetIds.map((id) => titleOf(description, id)).join(', ') || '—'}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
      {links.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Share link</Table.Head>
                <Table.Head>Role</Table.Head>
                <Table.Head>Gadget</Table.Head>
                <Table.Head>Created</Table.Head>
                <Table.Head>Created by</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {links.map((link) => (
                <Table.Row key={link.linkId}>
                  <Table.Cell>{link.note || '—'}</Table.Cell>
                  <Table.Cell>{link.role ?? 'build'}</Table.Cell>
                  <Table.Cell>{linkScope(description, link)}</Table.Cell>
                  <Table.Cell>{formatFullTimestamp(link.created)}</Table.Cell>
                  <Table.Cell>{link.createdBy.name || link.createdBy.id}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
    </section>
  )
}

/**
 * The Sharing tab: for each workspace the user owns, who it is shared with (and what they may
 * open) and its active share links. The share-link listing holds active links only, so a revoked
 * link never appears. A workspace shared with nobody says "Not shared".
 */
export const SharingTab = ({ views }: { views: AdminViews }) => {
  const state = useOwnedWorkspaceData<Loaded>(views, async (view) => {
    const [description, links] = await Promise.all([view.describe(), view.listShareLinks()])
    return { description, links }
  })
  if (state === null) return <div className="flex justify-center py-8"><Loader /></div>
  if ('error' in state) return <p role="alert" className="text-sm text-kumo-danger">{state.error}</p>
  if (state.workspaces.length === 0) {
    return <p className="py-6 text-center text-sm text-kumo-subtle">This user owns no workspaces.</p>
  }
  return (
    <div className="space-y-6">
      {state.workspaces.map((workspace) => (
        <Workspace key={workspace.id} title={workspace.title} data={state.data.get(workspace.id)} />
      ))}
    </div>
  )
}
