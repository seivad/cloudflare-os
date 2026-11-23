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
  /** Run `fn`, which gets its views from `userView()`/`workspaceView()`. When it fails because a
   * view expired, the cached views are dropped and `fn` runs once more on fresh ones; a second
   * expiry is thrown. */
  call: <T>(fn: () => Promise<T>) => Promise<T>
}

const disposeQuietly = (stub: unknown) => {
  try { (stub as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.() } catch { /* already gone */ }
}

/**
 * Opens a user's audited admin views lazily, with the reason the admin gave. Each open is
 * recorded server side, so views are cached while they live, and a user's workspaces are opened
 * a few at a time. The reason, and every view, belong to one `userId`: another user starts over.
 */
export const useAdminViews = (admin: RpcStub<AdminApi>, userId: string): AdminViews => {
  const [reason, setReasonState] = useState<string | null>(null)
  const reasonRef = useRef<string | null>(null)
  const views = useRef({
    user: null as Promise<RpcStub<AdminUserView>> | null,
    workspaces: new Map<string, Promise<RpcStub<AdminWorkspaceView>>>(),
    inFlight: 0,
    waiting: [] as (() => void)[],
  })

  const dropViews = useCallback(() => {
    const held = views.current
    const dropped = [held.user, ...held.workspaces.values()]
    held.user = null
    held.workspaces.clear()
    for (const opened of dropped) opened?.then(disposeQuietly, () => {})
  }, [])

  // A different user: forget the reason and every view.
  const userIdRef = useRef(userId)
  useEffect(() => {
    if (userIdRef.current === userId) return
    userIdRef.current = userId
    reasonRef.current = null
    setReasonState(null)
    dropViews()
  }, [userId, dropViews])
  useEffect(() => dropViews, [dropViews])

  const setReason = useCallback((next: string) => {
    reasonRef.current = next
    setReasonState(next)
  }, [])

  const reasonOrThrow = () => {
    if (reasonRef.current === null) throw new Error('A reason is needed before a view can be opened.')
    return reasonRef.current
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
        if (held.inFlight >= MAX_CONCURRENT_WORKSPACE_OPENS) {
          await new Promise<void>((resolve) => held.waiting.push(resolve))
        }
        held.inFlight += 1
        try {
          return await admin.inspectWorkspace(workspaceId, reasonOrThrow())
        } finally {
          held.inFlight -= 1
          held.waiting.shift()?.()
        }
      }
      const started = open()
      opened = started
      held.workspaces.set(workspaceId, started)
      started.catch(() => { if (held.workspaces.get(workspaceId) === started) held.workspaces.delete(workspaceId) })
    }
    return opened
  }, [admin])

  const call = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      if (getAdminAccessErrorCode(err) !== ADMIN_ACCESS_ERROR_CODES.viewExpired) throw err
      dropViews()
      return await fn()
    }
  }, [dropViews])

  return useMemo(
    () => ({ reason, setReason, userView, workspaceView, call }),
    [reason, setReason, userView, workspaceView, call],
  )
}
