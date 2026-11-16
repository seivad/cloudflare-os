import { useState } from 'react'
import { Switch } from '@cloudflare/kumo'
import { Check, Copy } from '@phosphor-icons/react'
import { WorkshopIconButton } from '../../components/WorkshopControls'
import { randomCallPin } from './callPin'

const failureMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'Couldn’t change the PIN.'

/**
 * The PIN of a call the person started, shown only to them: whether joining needs one, and the
 * PIN itself to pass on. `onPinChange` locks the call with a new PIN or unlocks it (null); it is
 * null while the call's gadget isn't on screen, and then the PIN is only shown.
 */
export const LiveCallPinControl = ({ pin, onPinChange }: {
  pin: string | null
  onPinChange: ((pin: string | null) => Promise<void>) | null
}) => {
  // What was just set, shown until the next status poll reports it.
  const [changed, setChanged] = useState<{ pin: string | null } | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const shown = changed ? changed.pin : pin

  const change = async (next: string | null) => {
    if (!onPinChange) return
    setPending(true)
    setFailure(null)
    try {
      await onPinChange(next)
      setChanged({ pin: next })
      setCopied(false)
    } catch (error) {
      setFailure(failureMessage(error))
    } finally {
      setPending(false)
    }
  }

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      // Clipboard refused; the PIN is on screen to read out.
    }
  }

  return (
    <div className="shrink-0 space-y-1.5 rounded-xl border border-kumo-line px-2.5 py-2">
      <Switch
        size="sm"
        label="PIN to join"
        checked={shown !== null}
        disabled={pending || !onPinChange}
        onCheckedChange={(on: boolean) => void change(on ? randomCallPin() : null)}
      />
      {shown !== null && (
        <div className="flex items-center gap-1.5">
          <span
            aria-label={`PIN ${shown.split('').join(' ')}`}
            className="font-mono text-[18px] leading-6 font-semibold tracking-[0.2em] text-kumo-default tabular-nums"
          >
            {shown}
          </span>
          <WorkshopIconButton
            aria-label={copied ? 'PIN copied' : 'Copy PIN'}
            title={copied ? 'Copied' : 'Copy PIN'}
            onClick={() => void copy(shown)}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </WorkshopIconButton>
        </div>
      )}
      <p className="text-[11px] leading-4 text-kumo-subtle">
        {shown === null
          ? 'Anyone who can open this gadget can join.'
          : 'Give it to the people you want in. Only you can see it; anyone already in stays.'}
      </p>
      {failure !== null && <p role="alert" className="text-[11px] leading-4 text-kumo-danger">{failure}</p>}
    </div>
  )
}
