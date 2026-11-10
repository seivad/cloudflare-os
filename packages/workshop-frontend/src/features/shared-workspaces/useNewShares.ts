import { useEffect, useState } from 'react'
import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { logRpcFailure } from '../../rpcErrors'
import { onWorkspaceShared } from './newShares'

/**
 * The workspaces shared with the user that they haven't opened since, newest first. Read from
 * their listing on mount and whenever they return to the window, and joined in between by this
 * tab's share notifications. (Opening one leaves the page: the editor has no app chrome.)
 */
export const useNewShares = (): WorkspaceMetadataWithTimestamps[] => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [shares, setShares] = useState<WorkspaceMetadataWithTimestamps[]>([])
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.listWorkspaces().then(
      (list) => { if (!cancelled) setShares(list.filter((workspace) => workspace.newShare)) },
      (err) => logRpcFailure('Failed to load workspaces shared with you:', err),
    )
    return () => { cancelled = true }
  }, [authenticatedApi, reloadToken])

  useEffect(() => {
    const refresh = () => setReloadToken((n) => n + 1)
    window.addEventListener('focus', refresh)
    const unsubscribe = onWorkspaceShared((workspace) => setShares((prev) =>
      [workspace, ...prev.filter((x) => x.id !== workspace.id)].filter((x) => x.newShare)))
    return () => {
      window.removeEventListener('focus', refresh)
      unsubscribe()
    }
  }, [])

  return shares.toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())
}
