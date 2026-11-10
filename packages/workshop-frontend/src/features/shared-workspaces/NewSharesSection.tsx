import { useId } from 'react'
import { ShareNetwork } from '@phosphor-icons/react'
import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { NewShareBadge } from './NewShareBadge'
import { shareNoticeText } from './newShares'

/**
 * Workspaces newly shared with the user, for the Outputs page: their outputs reach the user's index
 * only once they open the workspace, so until then the workspace itself is listed here.
 */
export const NewSharesSection = ({
  shares,
  onOpen,
}: {
  shares: WorkspaceMetadataWithTimestamps[]
  onOpen: (workspaceId: string) => void
}) => {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="px-3 pb-4">
      <h2 id={headingId} className="flex items-center gap-1.5 text-[12px] font-medium text-kumo-subtle">
        <ShareNetwork size={12} />
        New in Shared with you
      </h2>
      <ul className="mt-2 flex flex-col gap-1.5">
        {shares.map((workspace) => workspace.newShare && (
          <li key={workspace.id}>
            <button
              type="button"
              onClick={() => onOpen(workspace.id)}
              className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2.5 text-left transition-colors hover:bg-kumo-tint"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">
                  {shareNoticeText({ title: workspace.title, newShare: workspace.newShare })}
                </p>
                <p className="mt-0.5 truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
                  {[workspace.role === 'use' ? 'You can use the gadgets shared with you' : 'You can edit it',
                    workspace.newShare.note].filter(Boolean).join(' · ')}
                </p>
              </div>
              <NewShareBadge />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
