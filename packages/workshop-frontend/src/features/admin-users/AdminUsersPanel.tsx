import { useEffect, useRef, useState } from 'react'
import { Button, Input, Loader, Select } from '@cloudflare/kumo'
import { CaretLeft, CaretRight } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AdminUserPage, AdminWorkspaceAccess } from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../../rpcErrors'
import { UserPanel } from './UserPanel'
import { UsersTable } from './UsersTable'
import {
  DEFAULT_USERS_FILTER, sortedBy, usersQueryOf, type ActiveFilter, type UsersFilter,
} from './usersQuery'

/** How long typing in the search box pauses before the table loads again, in milliseconds. */
export const SEARCH_DEBOUNCE_MS = 300

const ACTIVE_NAMES: Record<ActiveFilter, string> = {
  any: 'Any time', '7d': 'Last 7 days', '30d': 'Last 30 days', since: 'Since a date',
}

// The answer to one load, for the request it answered.
type Answer = { request: string } & ({ page: AdminUserPage } | { failed: true })

/**
 * The Users tab: a table of every account, searched by name or id, filtered by when the user last
 * signed in, and ordered by id, last sign-in or joined date, 50 to a page. Pages are reached
 * through each page's cursor and left by going back through the cursors used; any change to the
 * search, the filter or the order starts again from the first page. A row opens that user through
 * `onSelectUser`; `selectedUserId` names the open one.
 */
export const AdminUsersPanel = ({ admin, accessLevel, selectedUserId, onSelectUser }: {
  admin: RpcStub<AdminApi>
  /** The admin access level in force, when known (see UserPanel). */
  accessLevel?: AdminWorkspaceAccess
  selectedUserId?: string
  onSelectUser: (id?: string) => void
}) => {
  const [filter, setFilter] = useState<UsersFilter>(DEFAULT_USERS_FILTER)
  // What the box shows now; `filter.search` follows it once typing pauses.
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (typed === filter.search) return
    const timer = setTimeout(() => setFilter((current) => ({ ...current, search: typed })), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [typed, filter.search])

  // The cursors of the pages turned to under the current filter, forgotten as soon as it changes.
  const filterKey = JSON.stringify(filter)
  const [turned, setTurned] = useState<{ filter: string; cursors: string[] }>({ filter: filterKey, cursors: [] })
  if (turned.filter !== filterKey) setTurned({ filter: filterKey, cursors: [] })
  const cursors = turned.filter === filterKey ? turned.cursors : []
  const cursor = cursors.at(-1)
  const [retries, setRetries] = useState(0)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const request = JSON.stringify([filterKey, cursor ?? null, retries])
  // The moment a load's relative window ("Last 7 days") counts back from, fixed per request so a
  // re-render never changes the query.
  const requestedAt = useRef({ request, at: new Date() })
  if (requestedAt.current.request !== request) requestedAt.current = { request, at: new Date() }

  useEffect(() => {
    let current = true
    admin.listUsers(usersQueryOf(filter, requestedAt.current.at, cursor)).then(
      (page) => { if (current) setAnswer({ request, page }) },
      (err: unknown) => {
        if (!current) return
        logRpcFailure('Failed to load the users:', err)
        setAnswer({ request, failed: true })
      },
    )
    return () => { current = false }
    // `request` stands for the filter, cursor and retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin, request])

  const page = answer !== null && 'page' in answer ? answer.page : null
  const busy = answer?.request !== request
  const failed = answer !== null && 'failed' in answer && !busy
  const nextCursor = page?.nextCursor
  const pageNumber = cursors.length + 1
  const filtered = filter.search.trim() !== '' || filter.active !== 'any'

  return (
    <div className="space-y-4">
      <p className="text-sm text-kumo-subtle">
        Lists everyone who has signed in since the user directory was added.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="search" aria-label="Filter users">
        <Input
          label="Search"
          type="search"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="Name or id"
          maxLength={1000}
        />
        <Select<ActiveFilter>
          label="Active"
          className="w-full"
          value={filter.active}
          onValueChange={(active) => { if (active !== null) setFilter({ ...filter, active }) }}
          renderValue={(active) => ACTIVE_NAMES[active]}
        >
          {(Object.keys(ACTIVE_NAMES) as ActiveFilter[]).map((active) => (
            <Select.Option key={active} value={active}>{ACTIVE_NAMES[active]}</Select.Option>
          ))}
        </Select>
        {filter.active === 'since' && (
          <Input
            label="Signed in since"
            type="date"
            value={filter.since}
            onChange={(event) => setFilter({ ...filter, since: event.target.value })}
          />
        )}
      </div>

      {page === null && !failed && (
        <div className="flex justify-center py-12">
          <Loader size="lg" />
        </div>
      )}
      {failed && (
        <div className="py-8 text-center">
          <p role="alert" className="text-sm text-kumo-danger">Couldn’t load the users.</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => setRetries((n) => n + 1)}>
            Retry
          </Button>
        </div>
      )}
      {page !== null && !failed && (
        <>
          <div className={`overflow-x-auto${busy ? ' opacity-60' : ''}`} aria-busy={busy}>
            <UsersTable
              users={page.users}
              sort={filter.sort}
              direction={filter.direction}
              onSort={(sort) => setFilter(sortedBy(filter, sort))}
              selectedId={selectedUserId}
              onSelect={onSelectUser}
              emptyText={filtered ? 'No users match these filters.' : 'No users are listed yet.'}
            />
          </div>
          {(pageNumber > 1 || nextCursor !== undefined) && (
            <nav className="flex items-center justify-between gap-4" aria-label="Users pages">
              <Button
                variant="secondary"
                size="sm"
                icon={CaretLeft}
                disabled={pageNumber === 1}
                onClick={() => { if (!busy) setTurned({ filter: filterKey, cursors: cursors.slice(0, -1) }) }}
              >
                Previous
              </Button>
              <span className="text-sm text-kumo-subtle" aria-live="polite">Page {pageNumber}</span>
              <Button
                variant="secondary"
                size="sm"
                disabled={nextCursor === undefined}
                onClick={() => {
                  if (!busy && nextCursor !== undefined) setTurned({ filter: filterKey, cursors: [...cursors, nextCursor] })
                }}
              >
                Next
                <CaretRight aria-hidden="true" />
              </Button>
            </nav>
          )}
        </>
      )}
      {selectedUserId !== undefined && (
        <UserPanel
          admin={admin}
          userId={selectedUserId}
          accessLevel={accessLevel}
          userName={page?.users.find((user) => user.id === selectedUserId)?.name}
          onClose={() => onSelectUser(undefined)}
        />
      )}
    </div>
  )
}
