import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import {
  ADMIN_ACCESS_ERROR_CODES, getAdminAccessErrorCode,
  type AdminApi, type AdminUserView, type AdminWorkspaceView,
} from '@gadgets/workshop-shared/api'

/** The most workspace views opened at once: each open is recorded and wakes a workspace. */
export const MAX_CONCURRENT_WORKSPACE_OPENS = 4

/** What `useAdminViews` gives: the reason and the audited views opened with it. */
export type AdminViews = {
  /** The reason every open is recorded with; null until the admin has given one. */
  reason: string | null
  /** Give the reason; later opens use it. Views already open stay open. */
  setReason: (reason: string) => void
  /** The user's view, opened on the first call and reused while it lives. */
  userView: () => Promise<RpcStub<AdminUserView>>
  /** A workspace's view, opened on the first call and reused; at most
   * `MAX_CONCURRENT_WORKSPACE_OPENS` opens are in flight at once. */
  workspaceView: (workspaceId: string) => Promise<RpcStub<AdminWorkspaceView>>
  /** Run `fn`, which gets its views through the `ViewAccess` it is given. When it fails because a
   * view expired, the views it got are dropped, and `fn` runs once more on fresh ones; a second
   * expiry is thrown. Views other calls got stay open: they may be in use, or just reopened. A
   * `fn` that got no view through its `ViewAccess` drops every cached view. */
  call: <T>(fn: (views: ViewAccess) => Promise<T>) => Promise<T>
}

/** The views a `call` gives its function: `userView` and `workspaceView`, noting which it got. */
export type ViewAccess = Pick<AdminViews, 'userView' | 'workspaceView'>

const disposeQuietly = (stub: unknown) => {
  try { (stub as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.() } catch { /* already gone */ }
}

/**
 * Opens a user's audited admin views lazily, with the reason the admin gave. Each open is
 * recorded server side, so views are cached while they live, and a user's workspaces are opened
 * a few at a time. The reason, and every view, belong to one `userId`: another user starts over.
 */
export const useAdminViews = (admin: RpcStub<AdminApi>, userId: string): AdminViews => {
  // The reason belongs to the user it was given for: no render sees it under another id.
  const [given, setGiven] = useState<{ userId: string; reason: string } | null>(null)
  const reason = given !== null && given.userId === userId ? given.reason : null
  const givenRef = useRef(given)
  const views = useRef({
    user: null as Promise<RpcStub<AdminUserView>> | null,
    workspaces: new Map<string, Promise<RpcStub<AdminWorkspaceView>>>(),
    inFlight: 0,
    waiting: [] as (() => void)[],
  })

  // Forgets and disposes the cached views in `which`, or every one when it is undefined. A view
  // `which` names that is no longer cached (another call reopened it) leaves its successor be.
  const dropViews = useCallback((which?: ReadonlySet<Promise<unknown>>) => {
    const held = views.current
    const drops = (opened: Promise<unknown>) => which === undefined || which.has(opened)
    const dropped: Promise<unknown>[] = []
    if (held.user !== null && drops(held.user)) {
      dropped.push(held.user)
      held.user = null
    }
    for (const [workspaceId, opened] of held.workspaces) {
      if (!drops(opened)) continue
      dropped.push(opened)
      held.workspaces.delete(workspaceId)
    }
    for (const opened of dropped) opened.then(disposeQuietly, () => {})
  }, [])

  // A different user: forget every view (the reason is already out of reach, being keyed).
  const userIdRef = useRef(userId)
  useEffect(() => {
    if (userIdRef.current === userId) return
    userIdRef.current = userId
    dropViews()
  }, [userId, dropViews])
  useEffect(() => () => dropViews(), [dropViews])

  const setReason = useCallback((next: string) => {
    givenRef.current = { userId, reason: next }
    setGiven(givenRef.current)
  }, [userId])

  const reasonOrThrow = () => {
    if (givenRef.current === null || givenRef.current.userId !== userId) {
      throw new Error('A reason is needed before a view can be opened.')
    }
    return givenRef.current.reason
  }

  const userView = useCallback(() => {
    const held = views.current
    if (held.user === null) {
      const opened = Promise.resolve().then(() => admin.inspectUser(userId, reasonOrThrow()))
      held.user = opened
      // A failed open is not cached: the next call tries again.
      opened.catch(() => { if (held.user === opened) held.user = null })
    }
    return held.user
  }, [admin, userId])

  const workspaceView = useCallback((workspaceId: string) => {
    const held = views.current
    let opened = held.workspaces.get(workspaceId)
    if (opened === undefined) {
      const open = async () => {
        // A finishing open hands its slot straight to the next waiter, so `inFlight` never dips
        // for a newcomer to take.
        if (held.inFlight >= MAX_CONCURRENT_WORKSPACE_OPENS) {
          await new Promise<void>((resolve) => held.waiting.push(resolve))
        } else {
          held.inFlight += 1
        }
        try {
          return await admin.inspectWorkspace(workspaceId, reasonOrThrow())
        } finally {
          const next = held.waiting.shift()
          if (next === undefined) held.inFlight -= 1
          else next()
        }
      }
      const started = open()
      opened = started
      held.workspaces.set(workspaceId, started)
      started.catch(() => { if (held.workspaces.get(workspaceId) === started) held.workspaces.delete(workspaceId) })
    }
    return opened
  }, [admin, userId])

  const call = useCallback(async <T,>(fn: (views: ViewAccess) => Promise<T>): Promise<T> => {
    const got = new Set<Promise<unknown>>()
    const access: ViewAccess = {
      userView: () => {
        const opened = userView()
        got.add(opened)
        return opened
      },
      workspaceView: (workspaceId) => {
        const opened = workspaceView(workspaceId)
        got.add(opened)
        return opened
      },
    }
    try {
      return await fn(access)
    } catch (err) {
      if (getAdminAccessErrorCode(err) !== ADMIN_ACCESS_ERROR_CODES.viewExpired) throw err
      dropViews(got.size > 0 ? new Set(got) : undefined)
      return await fn(access)
    }
  }, [dropViews, userView, workspaceView])

  return useMemo(
    () => ({ reason, setReason, userView, workspaceView, call }),
    [reason, setReason, userView, workspaceView, call],
  )
}
