import { createFileRoute } from '@tanstack/react-router'
import AdminPage from '../AdminPage'
import { isAdminTab, type AdminTab } from '../adminTab'
import { auditFilterOf, type AuditFilter } from '../features/admin-audit/auditFilter'

/** `user` names the user whose panel the Users tab has open. */
type AdminSearch = { tab?: AdminTab; user?: string } & AuditFilter

export const Route = createFileRoute('/admin')({
  component: AdminPage,
  validateSearch: (search: Record<string, unknown>): AdminSearch => ({
    tab: isAdminTab(search.tab) ? search.tab : undefined,
    user: typeof search.user === 'string' && search.user !== '' ? search.user : undefined,
    ...auditFilterOf(search),
  }),
})
