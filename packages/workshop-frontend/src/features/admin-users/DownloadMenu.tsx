import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { failureMessage } from './downloads'

/** What a menu does: copy code alone, copy with data, and optionally measure. Each may throw. */
export type DownloadActions = {
  code: () => Promise<void>
  everything: () => Promise<void>
  measure?: () => Promise<void>
}

type Kind = keyof DownloadActions

/**
 * A download menu: "Code only", "Everything" and, when `actions.measure` is given, "Measure
 * size". The last two read the gadget through its storage, which makes it reconnect for anyone
 * using it, so they ask first, saying so in `confirmText`. While `disabledReason` is given the
 * items are disabled and say why. A failed action's message stays under the menu. `status`
 * shows progress text beside the button.
 */
export const DownloadMenu = ({ label, actions, confirmText, disabledReason, status }: {
  label: string
  actions: DownloadActions
  confirmText: string
  disabledReason?: string
  status?: string
}) => {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<Kind | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (kind: Kind) => {
    const action = actions[kind]
    if (action === undefined) return
    setOpen(false)
    setConfirming(null)
    setError(null)
    setBusy(true)
    try {
      await action()
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const choose = (kind: Kind) => {
    if (kind === 'code') void run(kind)
    else setConfirming(kind)
  }
  const items: { kind: Kind; text: string }[] = [
    { kind: 'code', text: 'Code only' },
    { kind: 'everything', text: 'Everything' },
    ...(actions.measure !== undefined ? [{ kind: 'measure' as const, text: 'Measure size' }] : []),
  ]
  return (
    <div className="space-y-1 text-sm">
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Download ${label}`}
          aria-expanded={open}
          disabled={busy}
          onClick={() => { setOpen(!open); setConfirming(null) }}
        >
          {busy ? 'Working…' : 'Download'}
        </Button>
        {status !== undefined && <span className="text-xs text-kumo-subtle" aria-live="polite">{status}</span>}
      </div>
      {open && (
        <div role="menu" aria-label={`Download ${label}`} className="flex flex-col items-start gap-1">
          {items.map(({ kind, text }) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              className="text-left text-kumo-link disabled:text-kumo-subtle"
              disabled={disabledReason !== undefined}
              onClick={() => choose(kind)}
            >
              {text}
            </button>
          ))}
          {disabledReason !== undefined && <p className="text-xs text-kumo-subtle">{disabledReason}</p>}
        </div>
      )}
      {confirming !== null && (
        <div role="alertdialog" aria-label="Confirm" className="space-y-2 rounded border border-kumo-line p-2">
          <p>{confirmText}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={() => void run(confirming)}>Continue</Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {error !== null && <p role="alert" className="text-xs text-kumo-danger">{error}</p>}
    </div>
  )
}
