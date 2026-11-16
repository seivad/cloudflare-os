import { useState, type MutableRefObject } from 'react'
import { Autocomplete } from '@cloudflare/kumo'
import type { GatewayProviderModel } from '@gadgets/workshop-shared/api'
import { modelFacts, searchModels } from './providerModels'

/**
 * A Model ID field that searches a provider's model list as it is typed into: every word typed
 * must be in a model's name or ID, the best matches first (see searchModels), each shown with its
 * name, ID, price, context window and rate. Arrows move through the matches, Enter picks one and
 * Escape closes the list. A pick hands the whole model to `onPick`, for the form to fill itself in
 * from; what is typed stays the field's value, so an ID the list lacks can still be entered.
 */
export const ModelSearchField = ({
  label, description, value, models, disabled, error, status, inputRef, onValueChange, onPick,
  onEngage,
}: {
  label: string
  description?: string
  value: string
  /** The models to search, all of one provider. */
  models: readonly GatewayProviderModel[]
  disabled?: boolean
  error?: string
  /** A sentence under the field, such as why the provider's list is not there. */
  status?: string
  /** Set to the field's input, for a form to point at it. */
  inputRef?: MutableRefObject<HTMLInputElement | null>
  onValueChange: (value: string) => void
  onPick: (model: GatewayProviderModel) => void
  /** Called whenever the field is turned to, which is when the list is wanted. */
  onEngage?: () => void
}) => {
  const [open, setOpen] = useState(false)
  const { shown, total } = searchModels(models, value)

  return (
    // Kumo's Autocomplete hands out no ref to its input, and takes neither a focus handler nor
    // aria-invalid for it, so all three go through this wrapper.
    <div
      ref={(wrapper) => {
        const input = wrapper?.querySelector<HTMLInputElement>('[role="combobox"]') ?? null
        if (inputRef) inputRef.current = input
        input?.setAttribute('aria-invalid', String(error !== undefined))
      }}
      className="grid gap-2"
      onFocus={onEngage}
    >
      <Autocomplete<GatewayProviderModel>
        label={label}
        description={description}
        error={error}
        items={shown}
        filter={null}
        open={open && shown.length > 0}
        onOpenChange={setOpen}
        itemToStringValue={(model) => model.id}
        value={value}
        disabled={disabled}
        onValueChange={(next, { reason }) => {
          onEngage?.()
          // With the list closed, Escape asks to empty the field. What was typed stays.
          if (reason === 'escape-key') return
          onValueChange(next)
          const picked = reason === 'item-press' && shown.find((model) => model.id === next)
          if (picked) onPick(picked)
        }}
      >
        <Autocomplete.InputGroup />
        <Autocomplete.Content>
          <Autocomplete.List>
            {(model: GatewayProviderModel) => (
              <Autocomplete.Item key={model.id} value={model}>
                <span className="block text-sm text-kumo-default">{model.name}</span>
                <span className="block break-all font-mono text-xs text-kumo-subtle">{model.id}</span>
                <span className="block text-xs text-kumo-subtle">{modelFacts(model)}</span>
              </Autocomplete.Item>
            )}
          </Autocomplete.List>
          {total > shown.length && (
            <p className="px-3 py-1.5 text-xs text-kumo-subtle">
              {shown.length} of {total} shown. Type to narrow.
            </p>
          )}
        </Autocomplete.Content>
      </Autocomplete>
      {status && (
        <p role="status" className="text-sm leading-snug text-kumo-subtle">{status}</p>
      )}
    </div>
  )
}
