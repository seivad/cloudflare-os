import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AdminUserWorkspace, AdminWorkspaceView } from '@gadgets/workshop-shared/api'
import { describeFailure } from './describeFailure'
import type { AdminViews } from './useAdminViews'

/** What was read of one owned workspace: still loading (absent), its data, or 'unavailable'. */
export type WorkspaceData<T> = T | 'unavailable' | undefined

/** The user's owned workspaces and what `load` read of each, or why the listing failed. */
export type OwnedWorkspaces<T> =
  | { workspaces: AdminUserWorkspace[]; data: ReadonlyMap<string, WorkspaceData<T>> }
  | { error: string }
  | null

/**
 * Lists the workspaces the user owns, then reads each through its own audited view with `load`
 * (opens are bounded and shared with the other tabs by `useAdminViews`). Each workspace's data
 * arrives as it is read; one whose view cannot be opened (a provisional workspace, say) is
 * 'unavailable' and the rest still show. Null while the listing loads.
 */
export const useOwnedWorkspaceData = <T,>(
  views: AdminViews,
  load: (view: RpcStub<AdminWorkspaceView>, workspace: AdminUserWorkspace) => Promise<T>,
): OwnedWorkspaces<T> => {
  const [state, setState] = useState<OwnedWorkspaces<T>>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  const { call, userView, workspaceView } = views
  useEffect(() => {
    let current = true
    const data = new Map<string, WorkspaceData<T>>()
    call(async () => (await userView()).listWorkspaces()).then(
      (listed) => {
        if (!current) return
        const workspaces = listed.filter((workspace) => workspace.owner === undefined)
        setState({ workspaces, data: new Map(data) })
        for (const workspace of workspaces) {
          call(async () => loadRef.current(await workspaceView(workspace.id), workspace)).then(
            (found) => { data.set(workspace.id, found) },
            () => { data.set(workspace.id, 'unavailable') },
          ).then(() => { if (current) setState({ workspaces, data: new Map(data) }) })
        }
      },
      (err: unknown) => { if (current) setState({ error: describeFailure(err, 'workspaces') }) },
    )
    return () => { current = false }
  }, [call, userView, workspaceView])
  return state
}
