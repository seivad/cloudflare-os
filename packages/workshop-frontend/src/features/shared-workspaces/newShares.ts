import type { ShareNotice, WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'

// A workspace someone has shared with the user that they haven't opened since (see
// `WorkspaceMetadata.newShare`). The listing carries the notice until the next open clears it.

/** "Alice shared “Budget” with you". A restricted workspace's title is withheld until it's opened. */
export const shareNoticeText = ({ title, newShare }: { title: string; newShare: ShareNotice }): string =>
  `${newShare.sharedBy.name} shared ${title ? `“${title}”` : 'a workspace'} with you`

// The live share notification arrives in NotificationBridge, far from the listings, which aren't
// live subscriptions, so it reaches them as a window event, like openCommandPalette().
const SHARED_EVENT = 'gadgets:workspace-shared'

/** Tells listings in this tab that the user was just given access to `workspace`. */
export const announceWorkspaceShared = (workspace: WorkspaceMetadataWithTimestamps): void => {
  window.dispatchEvent(new CustomEvent(SHARED_EVENT, { detail: workspace }))
}

/** Calls `listener` with each workspace announced as shared, until the returned function is called. */
export const onWorkspaceShared = (
  listener: (workspace: WorkspaceMetadataWithTimestamps) => void,
): (() => void) => {
  const handle = (event: Event) => listener((event as CustomEvent<WorkspaceMetadataWithTimestamps>).detail)
  window.addEventListener(SHARED_EVENT, handle)
  return () => window.removeEventListener(SHARED_EVENT, handle)
}
