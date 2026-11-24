// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AdminUserPage, AdminUserRecord } from '@gadgets/workshop-shared/api'
import { AdminUsersPanel, SEARCH_DEBOUNCE_MS } from './AdminUsersPanel'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const user = (patch: Partial<AdminUserRecord> & { id: string }): AdminUserRecord =>
  ({ name: patch.id.toUpperCase(), isAdmin: false, ownedWorkspaces: 0, ...patch })

const ADA = user({
  id: 'ada@example.com', name: 'Ada', isAdmin: true, ownedWorkspaces: 3, totalCost: 12.345,
  created: new Date('2026-01-02T10:00:00Z'), lastLogin: new Date('2026-11-20T10:00:00Z'),
})
const BOB = user({ id: 'bob@example.com', name: 'Bob' })

const page = (users: AdminUserRecord[], nextCursor?: string): AdminUserPage => ({ users, nextCursor })

const fakeAdmin = () => ({
  listUsers: vi.fn<AdminApi['listUsers']>(async () => page([ADA, BOB])),
})

const type = (element: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
})
const click = (element: HTMLElement) => act(async () => { element.click() })

// By keyboard, as the audit tab's tests do: the option turns Enter into a click built as a
// PointerEvent, which jsdom lacks.
const choose = async (select: HTMLElement, label: string) => {
  if (select.getAttribute('aria-expanded') !== 'true') await click(select)
  const list = document.getElementById(select.getAttribute('aria-controls') ?? '')
  const option = [...list?.querySelectorAll<HTMLElement>('[role="option"]') ?? []]
    .find((element) => element.textContent === label)
  if (!option) throw new Error(`no option ${label}`)
  const view: { PointerEvent?: typeof MouseEvent } = window
  const previous = view.PointerEvent
  view.PointerEvent = MouseEvent
  try {
    await act(async () => { option.focus() })
    await act(async () => {
      option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
  } finally {
    view.PointerEvent = previous
  }
}

describe('AdminUsersPanel', () => {
  let container: HTMLDivElement
  let root: Root

  const render = async (admin = fakeAdmin(), props: { selectedUserId?: string } = {}) => {
    const onSelectUser = vi.fn<(id?: string) => void>()
    await act(async () => {
      root.render(
        <AdminUsersPanel admin={admin as unknown as RpcStub<AdminApi>} onSelectUser={onSelectUser} {...props} />)
    })
    return { ...admin, onSelectUser }
  }
  const rows = () => [...container.querySelectorAll('tbody tr')]
  const button = (name: string) => {
    const element = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)
    if (!element) throw new Error(`no button ${name}`)
    return element
  }
  const activeSelect = () => container.querySelector<HTMLElement>('[role="combobox"]')!
  const searchBox = () => container.querySelector<HTMLInputElement>('input[type="search"]')!
  const lastQuery = (admin: ReturnType<typeof fakeAdmin>) => {
    const query = admin.listUsers.mock.lastCall?.[0]
    if (!query) throw new Error('listUsers was not called with a query')
    return query
  }

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows the columns, the Admin badge and the directory note', async () => {
    await render()

    expect([...container.querySelectorAll('thead th')].map((head) => head.textContent))
      .toEqual(['User', 'Workspaces', 'Last sign-in', 'Joined', 'Total cost'])
    const cells = [...rows()[0].querySelectorAll('td')]
    expect(cells[0].textContent).toContain('Ada')
    expect(cells[0].textContent).toContain('ada@example.com')
    expect(cells[0].textContent).toContain('Admin')
    expect(cells[1].textContent).toBe('3')
    expect(cells[2].textContent).not.toBe('—')
    expect(cells[4].textContent).toBe('$12.35')
    expect([...rows()[1].querySelectorAll('td')][4].textContent).toBe('—')
    expect(rows()[1].textContent).not.toContain('Admin')
    expect([...rows()[1].querySelectorAll('td')].slice(2).map((cell) => cell.textContent)).toEqual(['—', '—', '—'])
    expect(container.textContent)
      .toContain('Lists everyone who has signed in since the user directory was added.')
  })

  it('loads the first page of 50 in id order', async () => {
    const admin = (await render()).listUsers
    expect(admin).toHaveBeenCalledTimes(1)
    expect(admin.mock.lastCall?.[0]).toMatchObject({ limit: 50, sort: 'id', direction: 'asc' })
    expect(admin.mock.lastCall?.[0]?.query).toBeUndefined()
  })

  it('searches after typing pauses, from the first page', async () => {
    const admin = fakeAdmin()
    admin.listUsers.mockResolvedValueOnce(page([ADA], 'c1'))
    await render(admin)
    await click(button('Next'))
    expect(lastQuery(admin).cursor).toBe('c1')

    await type(searchBox(), 'bo')
    await type(searchBox(), 'bob')
    expect(admin.listUsers).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS) })

    expect(admin.listUsers).toHaveBeenCalledTimes(3)
    expect(lastQuery(admin)).toMatchObject({ query: 'bob', cursor: undefined })
  })

  it('filters by activity: a window counted back from now, or a chosen date', async () => {
    vi.setSystemTime(new Date('2026-11-23T12:00:00Z'))
    const admin = fakeAdmin()
    await render(admin)

    await choose(activeSelect(), 'Last 7 days')
    expect(lastQuery(admin).activeSince).toEqual(new Date('2026-11-16T12:00:00Z'))

    await choose(activeSelect(), 'Since a date')
    expect(lastQuery(admin).activeSince).toBeUndefined()
    await type(container.querySelector<HTMLInputElement>('input[type="date"]')!, '2026-11-01')
    expect(lastQuery(admin).activeSince).toEqual(new Date('2026-11-01T00:00:00'))

    await choose(activeSelect(), 'Any time')
    expect(lastQuery(admin).activeSince).toBeUndefined()
  })

  it('orders by a header, and flips the direction on a second click', async () => {
    const admin = fakeAdmin()
    await render(admin)

    await click(button('Last sign-in'))
    expect(lastQuery(admin)).toMatchObject({ sort: 'lastLogin', direction: 'desc' })
    await click(button('Last sign-in'))
    expect(lastQuery(admin)).toMatchObject({ sort: 'lastLogin', direction: 'asc' })
    await click(button('Joined'))
    expect(lastQuery(admin)).toMatchObject({ sort: 'created', direction: 'desc' })
    await click(button('User'))
    expect(lastQuery(admin)).toMatchObject({ sort: 'id', direction: 'asc' })
  })

  it('orders by total cost, and lists only users who have spent when Has spend is ticked', async () => {
    const admin = fakeAdmin()
    await render(admin)
    expect(lastQuery(admin).hasSpend).toBeUndefined()

    await click(button('Total cost'))
    expect(lastQuery(admin)).toMatchObject({ sort: 'totalCost', direction: 'desc' })
    await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!)
    expect(lastQuery(admin)).toMatchObject({ hasSpend: true, sort: 'totalCost' })
    await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!)
    expect(lastQuery(admin).hasSpend).toBeUndefined()
  })

  it('turns pages through the cursors', async () => {
    const admin = fakeAdmin()
    admin.listUsers.mockResolvedValueOnce(page([ADA], 'c1')).mockResolvedValueOnce(page([BOB]))
    await render(admin)

    await click(button('Next'))
    expect(lastQuery(admin)).toMatchObject({ cursor: 'c1', limit: 50 })
    expect(rows()).toHaveLength(1)
    expect(button('Next').disabled).toBe(true)

    await click(button('Previous'))
    expect(lastQuery(admin).cursor).toBeUndefined()
  })

  it('reports the row clicked, and marks the selected one', async () => {
    const { onSelectUser } = await render(fakeAdmin(), { selectedUserId: 'bob@example.com' })

    await click(rows()[0] as HTMLElement)
    expect(onSelectUser).toHaveBeenCalledExactlyOnceWith('ada@example.com')
    expect(rows()[1].getAttribute('aria-selected')).toBe('true')
    await click(rows()[1].querySelector('button')!)
    expect(onSelectUser).toHaveBeenLastCalledWith('bob@example.com')
  })

  it('says so when nobody matches, and offers a retry when the load fails', async () => {
    const admin = fakeAdmin()
    admin.listUsers.mockResolvedValueOnce(page([]))
    await render(admin)
    expect(container.textContent).toContain('No users are listed yet.')

    admin.listUsers.mockRejectedValueOnce(new Error('boom'))
    await click(button('Joined'))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Couldn’t load the users.')
    await click(button('Retry'))
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(rows()).toHaveLength(2)
  })
})
