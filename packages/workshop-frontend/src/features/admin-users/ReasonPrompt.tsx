import { useState } from 'react'
import { Button, Textarea } from '@cloudflare/kumo'
import { MAX_ADMIN_ACCESS_REASON_LENGTH } from '@gadgets/workshop-shared/api'

/**
 * Asks for the reason a user's account is being looked at. It is recorded in the deployment-wide
 * audit log with the open and every read after it, so it must be given before anything is read:
 * non-blank and, trimmed, at most `MAX_ADMIN_ACCESS_REASON_LENGTH` characters.
 */
export const ReasonPrompt = ({ initial, onConfirm, onCancel }: {
  initial: string
  onConfirm: (reason: string) => void
  onCancel: () => void
}) => {
  const [text, setText] = useState(initial)
  const trimmed = text.trim()
  const valid = trimmed !== '' && trimmed.length <= MAX_ADMIN_ACCESS_REASON_LENGTH
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => { event.preventDefault(); if (valid) onConfirm(trimmed) }}
    >
      <p className="text-sm text-kumo-subtle">
        Viewing a user’s account is recorded in the admin audit log, with this reason.
      </p>
      <Textarea
        label="Reason"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        autoFocus
        error={trimmed.length > MAX_ADMIN_ACCESS_REASON_LENGTH
          ? `At most ${MAX_ADMIN_ACCESS_REASON_LENGTH} characters.`
          : undefined}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!valid}>View account</Button>
      </div>
    </form>
  )
}
