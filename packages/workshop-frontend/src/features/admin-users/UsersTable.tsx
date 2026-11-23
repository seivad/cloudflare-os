import { Badge, Table } from '@cloudflare/kumo'
import { CaretDown, CaretUp } from '@phosphor-icons/react'
import type { AdminUserRecord } from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import type { UsersSort } from './usersQuery'

const dateOrDash = (date: Date | undefined) => date === undefined ? '—' : formatFullTimestamp(date)

// A header that orders the table: a button naming the column, with the direction when it is the one in force.
const SortHead = ({ label, sort, current, direction, onSort }: {
  label: string
  sort: UsersSort
  current: UsersSort
  direction: 'asc' | 'desc'
  onSort: (sort: UsersSort) => void
}) => {
  const active = current === sort
  return (
    <Table.Head aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="inline-flex items-center gap-1 font-semibold" onClick={() => onSort(sort)}>
        {label}
        {active && (direction === 'asc'
          ? <CaretUp aria-hidden="true" size={12} />
          : <CaretDown aria-hidden="true" size={12} />)}
      </button>
    </Table.Head>
  )
}

/**
 * One page of users: name (with id and an Admin badge), workspaces owned, last sign-in and joined
 * date. The User, Last sign-in and Joined headers order the table. A row opens that user through
 * `onSelect`; the row of `selectedId` is highlighted.
 */
export const UsersTable = ({ users, sort, direction, onSort, selectedId, onSelect, emptyText }: {
  users: AdminUserRecord[]
  sort: UsersSort
  direction: 'asc' | 'desc'
  onSort: (sort: UsersSort) => void
  selectedId?: string
  onSelect: (id: string) => void
  /** What the table says when `users` is empty. */
  emptyText: string
}) => (
  <Table>
    <Table.Header>
      <Table.Row>
        <SortHead label="User" sort="id" current={sort} direction={direction} onSort={onSort} />
        <Table.Head>Workspaces</Table.Head>
        <SortHead label="Last sign-in" sort="lastLogin" current={sort} direction={direction} onSort={onSort} />
        <SortHead label="Joined" sort="created" current={sort} direction={direction} onSort={onSort} />
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {users.length === 0
        ? (
          <Table.Row>
            <Table.Cell colSpan={4} className="py-8 text-center text-kumo-subtle">{emptyText}</Table.Cell>
          </Table.Row>
        )
        : users.map((user) => (
          <Table.Row
            key={user.id}
            aria-selected={user.id === selectedId}
            className={`cursor-pointer${user.id === selectedId ? ' bg-kumo-tint' : ''}`}
            onClick={() => onSelect(user.id)}
          >
            <Table.Cell>
              <button
                type="button"
                className="block text-left"
                aria-label={`Open ${user.name === '' ? user.id : user.name}`}
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium">{user.name}</span>
                  {user.isAdmin && <Badge variant="neutral">Admin</Badge>}
                </span>
                <span className="block font-mono text-xs text-kumo-subtle">{user.id}</span>
              </button>
            </Table.Cell>
            <Table.Cell>{user.ownedWorkspaces}</Table.Cell>
            <Table.Cell>{dateOrDash(user.lastLogin)}</Table.Cell>
            <Table.Cell>{dateOrDash(user.created)}</Table.Cell>
          </Table.Row>
        ))}
    </Table.Body>
  </Table>
)
