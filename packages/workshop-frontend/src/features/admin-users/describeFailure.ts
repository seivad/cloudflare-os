import { ADMIN_ACCESS_ERROR_CODES, getAdminAccessErrorCode } from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../../rpcErrors'

/** What the panel says when admin access to workspaces and users is switched off. */
export const ACCESS_OFF_TEXT = 'Admin access to workspaces and users is turned off on this deployment.'

/** The sentence for a failed read of `what`, logging the failure; expected refusals get their own. */
export const describeFailure = (err: unknown, what: string): string => {
  switch (getAdminAccessErrorCode(err)) {
    case ADMIN_ACCESS_ERROR_CODES.accessOff: return ACCESS_OFF_TEXT
    case ADMIN_ACCESS_ERROR_CODES.userNotFound: return 'This user’s account no longer exists.'
    case ADMIN_ACCESS_ERROR_CODES.viewExpired: return `The view of this user expired while loading the ${what}. Reload to try again.`
    case ADMIN_ACCESS_ERROR_CODES.notAdmin: return 'You are no longer a deployment admin.'
    default:
      logRpcFailure(`Failed to load the user's ${what}:`, err)
      return `Couldn’t load the ${what}.`
  }
}
