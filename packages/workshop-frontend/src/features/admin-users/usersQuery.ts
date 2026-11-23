import type { AdminUserQuery } from '@gadgets/workshop-shared/api'

/** How many users one page of the Users tab's table shows. */
export const USERS_PAGE_SIZE = 50

/** The activity choices of the Users tab: any, signed in within a window, or since a chosen date. */
export type ActiveFilter = 'any' | '7d' | '30d' | 'since'

/** The column the table is ordered by, as AdminUserQuery names it. */
export type UsersSort = NonNullable<AdminUserQuery['sort']>

/** Everything the Users tab's controls choose, before it becomes a query. */
export type UsersFilter = {
  /** The search box's text. */
  search: string
  active: ActiveFilter
  /** The date input's value (`yyyy-mm-dd`), used when `active` is `since`; empty when none. */
  since: string
  sort: UsersSort
  direction: NonNullable<AdminUserQuery['direction']>
}

/** The filter before anything is chosen: everyone, in id order. */
export const DEFAULT_USERS_FILTER: UsersFilter = {
  search: '', active: 'any', since: '', sort: 'id', direction: 'asc',
}

const DAY_MS = 24 * 60 * 60 * 1000

/** The instant a date input's `yyyy-mm-dd` value starts, in the browser's time zone; undefined when it is not a date. */
const startOfDay = (value: string): Date | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/**
 * The listUsers query for `filter`, `now` and the page's `cursor`. A blank search and an unset
 * date send nothing, so "Since a date" with no date lists everyone.
 */
export const usersQueryOf = (filter: UsersFilter, now: Date, cursor?: string): AdminUserQuery => {
  const query = filter.search.trim()
  const activeSince =
    filter.active === '7d' ? new Date(now.getTime() - 7 * DAY_MS)
      : filter.active === '30d' ? new Date(now.getTime() - 30 * DAY_MS)
        : filter.active === 'since' ? startOfDay(filter.since)
          : undefined
  return {
    query: query === '' ? undefined : query,
    cursor,
    limit: USERS_PAGE_SIZE,
    activeSince,
    sort: filter.sort,
    direction: filter.direction,
  }
}

/**
 * The filter after a click on the header of `sort`: the shown column flips its direction, and
 * another starts ascending by id and newest first by time.
 */
export const sortedBy = (filter: UsersFilter, sort: UsersSort): UsersFilter => {
  if (filter.sort === sort) return { ...filter, direction: filter.direction === 'asc' ? 'desc' : 'asc' }
  return { ...filter, sort, direction: sort === 'id' ? 'asc' : 'desc' }
}
