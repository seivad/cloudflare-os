import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { CallStatus, GadgetClient } from '@gadgets/workshop-shared/api'

/** How often the call's status is refreshed; the server reuses its roster lookup for about as long. */
export const CALL_STATUS_POLL_MS = 10_000

/**
 * Who is in a gadget's call and whether joining needs a PIN, polled through `client` while
 * `active` and the page is visible. `key` names the call: its last status is kept while `client`
 * is null (the gadget's view isn't mounted), and dropped when the key changes. `status` is null
 * until the first answer for `key`; `refresh` asks again at once, as after changing the PIN.
 */
export const useCallStatus = ({ key, client, active }: {
  key: string | null
  client: RpcStub<GadgetClient> | null
  active: boolean
}): { status: CallStatus | null; refresh: () => void } => {
  const [status, setStatus] = useState<{ key: string; value: CallStatus } | null>(null)
  // Bumped by refresh(), which restarts the polling below with an immediate poll.
  const [asked, setAsked] = useState(0)

  useEffect(() => {
    if (key === null || !client || !active) return
    let cancelled = false
    let inFlight = false
    const poll = () => {
      if (inFlight || document.visibilityState !== 'visible') return
      inFlight = true
      client.getCallStatus().then(
        value => { if (!cancelled) setStatus({ key, value }) },
        // A failed poll keeps the last status; the next one tries again.
        () => {},
      ).finally(() => { inFlight = false })
    }
    poll()
    const interval = setInterval(poll, CALL_STATUS_POLL_MS)
    document.addEventListener('visibilitychange', poll)
    return () => {
      cancelled = true
      clearInterval(interval)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [key, client, active, asked])

  return {
    status: status !== null && status.key === key ? status.value : null,
    refresh: () => setAsked(count => count + 1),
  }
}
