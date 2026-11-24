import { describe, expect, it } from 'vitest'
import { DEFAULT_USERS_FILTER, sortedBy, usersQueryOf } from './usersQuery'

const now = new Date('2026-11-23T12:00:00Z')

describe('usersQueryOf', () => {
  it('asks for the first page in id order when nothing is chosen', () => {
    expect(usersQueryOf(DEFAULT_USERS_FILTER, now)).toEqual({
      query: undefined, cursor: undefined, limit: 50, activeSince: undefined, sort: 'id', direction: 'asc',
    })
  })

  it('trims the search and drops a blank one', () => {
    expect(usersQueryOf({ ...DEFAULT_USERS_FILTER, search: '  ada ' }, now).query).toBe('ada')
    expect(usersQueryOf({ ...DEFAULT_USERS_FILTER, search: '   ' }, now).query).toBeUndefined()
  })

  it('counts the relative windows back from now', () => {
    expect(usersQueryOf({ ...DEFAULT_USERS_FILTER, active: '7d' }, now).activeSince)
      .toEqual(new Date('2026-11-16T12:00:00Z'))
    expect(usersQueryOf({ ...DEFAULT_USERS_FILTER, active: '30d' }, now).activeSince)
      .toEqual(new Date('2026-10-24T12:00:00Z'))
  })

  it('starts a chosen date at local midnight, and sends nothing without a valid one', () => {
    expect(usersQueryOf({ ...DEFAULT_USERS_FILTER, active: 'since', since: '2026-11-01' }, now).activeSince)
      .toEqual(new Date('2026-11-01T00:00:00'))
    expect(usersQueryOf({ ...DEFAULT_USERS_FILTER, active: 'since', since: '' }, now).activeSince).toBeUndefined()
    expect(usersQueryOf({ ...DEFAULT_USERS_FILTER, active: 'since', since: '2026-13-45' }, now).activeSince)
      .toBeUndefined()
  })

  it('sends hasSpend only when it is ticked', () => {
    expect(usersQueryOf({ ...DEFAULT_USERS_FILTER, hasSpend: true }, now).hasSpend).toBe(true)
    expect(usersQueryOf(DEFAULT_USERS_FILTER, now).hasSpend).toBeUndefined()
  })

  it('passes the cursor on', () => {
    expect(usersQueryOf(DEFAULT_USERS_FILTER, now, 'c1').cursor).toBe('c1')
  })
})

describe('sortedBy', () => {
  it('flips the direction of the column in force', () => {
    expect(sortedBy(DEFAULT_USERS_FILTER, 'id').direction).toBe('desc')
    expect(sortedBy(sortedBy(DEFAULT_USERS_FILTER, 'id'), 'id').direction).toBe('asc')
  })

  it('starts another column newest first, and id ascending', () => {
    expect(sortedBy(DEFAULT_USERS_FILTER, 'lastLogin')).toMatchObject({ sort: 'lastLogin', direction: 'desc' })
    expect(sortedBy(DEFAULT_USERS_FILTER, 'totalCost')).toMatchObject({ sort: 'totalCost', direction: 'desc' })
    expect(sortedBy({ ...DEFAULT_USERS_FILTER, sort: 'created', direction: 'desc' }, 'id'))
      .toMatchObject({ sort: 'id', direction: 'asc' })
  })
})
