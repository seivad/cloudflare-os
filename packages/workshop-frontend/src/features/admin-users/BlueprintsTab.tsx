import { useEffect, useState } from 'react'
import { Badge, Loader, Table } from '@cloudflare/kumo'
import type { AdminUserBlueprint } from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { describeFailure } from './describeFailure'
import type { AdminViews } from './useAdminViews'

const HELD_NAMES: Record<AdminUserBlueprint['held'], string> = {
  published: 'Published', imported: 'Imported', uploaded: 'Uploaded', added: 'Added',
}

/** The Blueprints tab: every blueprint the account holds, the user's own and their library. */
export const BlueprintsTab = ({ views }: { views: AdminViews }) => {
  const [state, setState] = useState<{ blueprints: AdminUserBlueprint[] } | { error: string } | null>(null)
  const { call } = views
  useEffect(() => {
    let current = true
    call(async ({ userView }) => (await userView()).listBlueprints()).then(
      (blueprints) => { if (current) setState({ blueprints }) },
      (err: unknown) => { if (current) setState({ error: describeFailure(err, 'blueprints') }) },
    )
    return () => { current = false }
  }, [call])

  if (state === null) return <div className="flex justify-center py-8"><Loader /></div>
  if ('error' in state) return <p role="alert" className="text-sm text-kumo-danger">{state.error}</p>
  if (state.blueprints.length === 0) {
    return <p className="py-6 text-center text-sm text-kumo-subtle">This user holds no blueprints.</p>
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Title</Table.Head>
            <Table.Head>Held</Table.Head>
            <Table.Head>Version</Table.Head>
            <Table.Head>Updated</Table.Head>
            <Table.Head>Featured</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {state.blueprints.map((blueprint, index) => (
            <Table.Row key={index}>
              <Table.Cell>{blueprint.title}</Table.Cell>
              <Table.Cell>{HELD_NAMES[blueprint.held]}</Table.Cell>
              <Table.Cell>{blueprint.version}</Table.Cell>
              <Table.Cell>{formatFullTimestamp(blueprint.lastUpdated)}</Table.Cell>
              <Table.Cell>{blueprint.featured === true ? <Badge variant="neutral">Featured</Badge> : '—'}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  )
}
