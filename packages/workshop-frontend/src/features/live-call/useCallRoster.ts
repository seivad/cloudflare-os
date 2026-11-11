import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { CallRosterEntry, GadgetClient } from '@gadgets/workshop-shared/api'

/** How often the roster is refreshed; the server reuses its own lookup for about as long. */
export const ROSTER_POLL_MS = 10_000

/**
 * Who is in a gadget's call, polled through `client` while `active` and the page is visible.
 * `key` names the call: its last roster is kept while `client` is null (the gadget's view isn't
 * mounted), and dropped when the key changes. Null until the first answer for `key`.
 */
export const useCallRoster = ({ key, client, active }: {
  key: string | null
  client: RpcStub<GadgetClient> | null
  active: boolean
}): CallRosterEntry[] | null => {
  const [roster, setRoster] = useState<{ key: string; entries: CallRosterEntry[] } | null>(null)

  useEffect(() => {
    if (key === null || !client || !active) return
    let cancelled = false
    let inFlight = false
    const refresh = () => {
      if (inFlight || document.visibilityState !== 'visible') return
      inFlight = true
      client.getCallRoster().then(
        entries => { if (!cancelled) setRoster({ key, entries }) },
        // A failed poll keeps the last roster; the next one tries again.
        () => {},
      ).finally(() => { inFlight = false })
    }
    refresh()
    const interval = setInterval(refresh, ROSTER_POLL_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      cancelled = true
      clearInterval(interval)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [key, client, active])

  return roster !== null && roster.key === key ? roster.entries : null
}
