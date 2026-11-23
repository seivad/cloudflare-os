import { useEffect, useState } from 'react'
import { Badge, Button, Loader, Tabs } from '@cloudflare/kumo'
import { Drawer } from '@cloudflare/kumo/primitives/drawer'
import { X } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AdminUserDescription } from '@gadgets/workshop-shared/api'
import { BlueprintsTab } from './BlueprintsTab'
import { describeFailure, ACCESS_OFF_TEXT } from './describeFailure'
import { GadgetsTab } from './GadgetsTab'
import { ReasonPrompt } from './ReasonPrompt'
import { SharingTab } from './SharingTab'
import { UsageTab } from './UsageTab'
import { useAdminViews } from './useAdminViews'
import { WorkspacesTab } from './WorkspacesTab'

/** The tabs of the profile panel. */
export type UserPanelTab = 'usage' | 'workspaces' | 'gadgets' | 'blueprints' | 'sharing'

const TABS: { value: UserPanelTab; label: string }[] = [
  { value: 'usage', label: 'Usage' },
  { value: 'workspaces', label: 'Workspaces' },
  { value: 'gadgets', label: 'Gadgets' },
  { value: 'blueprints', label: 'Blueprints' },
  { value: 'sharing', label: 'Sharing' },
]

/**
 * A user's profile as a drawer over the Users table. It asks for a reason first, then reads the
 * account through `AdminApi.inspectUser()` and each workspace through `inspectWorkspace()`, so
 * every read is recorded in the admin audit log. `userName` only prefills the reason. When admin
 * access is turned off the panel says so and shows nothing of the account.
 */
export const UserPanel = ({ admin, userId, userName, onClose }: {
  admin: RpcStub<AdminApi>
  userId: string
  userName?: string
  onClose: () => void
}) => {
  const views = useAdminViews(admin, userId)
  const [tab, setTab] = useState<UserPanelTab>('usage')
  const [profile, setProfile] = useState<{ userId: string; description: AdminUserDescription } | { userId: string; error: string } | null>(null)

  const { reason, call, userView } = views
  useEffect(() => {
    if (reason === null) return
    let current = true
    call(async () => (await userView()).describe()).then(
      (description) => { if (current) setProfile({ userId, description }) },
      (err: unknown) => { if (current) setProfile({ userId, error: describeFailure(err, 'profile') }) },
    )
    return () => { current = false }
  }, [reason, userId, call, userView])

  const shown = profile !== null && profile.userId === userId ? profile : null
  const description = shown !== null && 'description' in shown ? shown.description : null
  const error = shown !== null && 'error' in shown ? shown.error : null
  const displayName = description?.profile.name || userName || userId

  return (
    <Drawer.Root open onOpenChange={(open) => { if (!open) onClose() }} swipeDirection="right">
      <Drawer.Portal>
        <Drawer.Backdrop className="fixed inset-0 z-40 bg-black/30" />
        <Drawer.Viewport className="fixed inset-0 z-50">
          <Drawer.Popup
            className="fixed top-0 right-0 flex h-full w-full max-w-3xl flex-col border-l border-kumo-line bg-kumo-base shadow-xl"
            aria-label={`Profile of ${displayName}`}
          >
            <header className="flex items-start justify-between gap-4 border-b border-kumo-line p-4">
              <div className="min-w-0">
                <Drawer.Title className="flex items-center gap-2 text-lg font-semibold">
                  <span className="truncate">{displayName}</span>
                  {description?.isAdmin === true && <Badge variant="neutral">Admin</Badge>}
                </Drawer.Title>
                <p className="truncate font-mono text-xs text-kumo-subtle">{userId}</p>
              </div>
              <Button variant="ghost" shape="square" aria-label="Close" icon={X} onClick={onClose} />
            </header>
            <div className="flex-1 overflow-y-auto p-4">
              {reason === null && (
                <ReasonPrompt
                  key={userId}
                  initial={`Reviewing ${userName || userId}’s work`}
                  onConfirm={views.setReason}
                  onCancel={onClose}
                />
              )}
              {reason !== null && shown === null && <div className="flex justify-center py-12"><Loader size="lg" /></div>}
              {error !== null && (
                <p role="alert" className={`text-sm ${error === ACCESS_OFF_TEXT ? 'text-kumo-subtle' : 'text-kumo-danger'}`}>
                  {error}
                </p>
              )}
              {description !== null && (
                <div className="space-y-4">
                  <Tabs
                    variant="underline"
                    value={tab}
                    onValueChange={(value) => setTab(value as UserPanelTab)}
                    tabs={TABS}
                  />
                  {tab === 'workspaces' && <WorkspacesTab views={views} />}
                  {tab === 'blueprints' && <BlueprintsTab views={views} />}
                  {tab === 'usage' && <UsageTab views={views} />}
                  {tab === 'gadgets' && <GadgetsTab views={views} />}
                  {tab === 'sharing' && <SharingTab views={views} />}
                </div>
              )}
            </div>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
