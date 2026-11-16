import type { GatewayProviderModel } from '@gadgets/workshop-shared/api'

/** How many matches a model search shows at once: type more to narrow the rest. */
export const SEARCH_LIMIT = 40

/**
 * The models of `models` that match `query`, at most `limit` of them, and how many matched in all.
 * Every word typed must be in the model's name or ID. Matches whose name or ID starts with the
 * first word come first, then those with a part of the name or ID starting with it, each kept in
 * the list's own order. An empty query matches every model.
 */
export const searchModels = (
  models: readonly GatewayProviderModel[],
  query: string,
  limit = SEARCH_LIMIT,
): { shown: GatewayProviderModel[]; total: number } => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { shown: models.slice(0, limit), total: models.length }
  const [first] = words
  const scored: { model: GatewayProviderModel; rank: number; at: number }[] = []
  models.forEach((model, at) => {
    const name = model.name.toLowerCase()
    const id = model.id.toLowerCase()
    if (!words.every((word) => name.includes(word) || id.includes(word))) return
    const starts = name.startsWith(first) || id.startsWith(first)
    const partStarts = starts
      || name.split(/[\s:/(-]+/).some((part) => part.startsWith(first))
      || id.split(/[/:@._-]+/).some((part) => part.startsWith(first))
    scored.push({ model, rank: starts ? 0 : partStarts ? 1 : 2, at })
  })
  scored.sort((a, b) => a.rank - b.rank || a.at - b.at)
  return { shown: scored.slice(0, limit).map((entry) => entry.model), total: scored.length }
}

/** A price per million tokens in a few characters: "$0.06", "$3", "free". */
const perMillion = (value: number): string => {
  if (value === 0) return 'free'
  return `$${value >= 100 ? Math.round(value) : Number(value.toPrecision(value < 1 ? 2 : 3))}`
}

/** A token count in a few characters: "131K", "1.05M". */
const tokenCount = (value: number): string =>
  value >= 1_000_000
    ? `${Number((value / 1_000_000).toPrecision(3))}M`
    : `${Math.round(value / 1_000)}K`

/**
 * What a model search shows of a model under its name: its price in and out per million tokens,
 * its context window and its rate, each where the list gives it, such as
 * "$1.4 in · $4.4 out per M tokens · 1.05M context · 20 rpm".
 */
export const modelFacts = (model: GatewayProviderModel): string => {
  const price = model.price
    ? model.price.input === 0 && model.price.output === 0
      ? 'Free'
      : `${perMillion(model.price.input)} in · ${perMillion(model.price.output)} out per M tokens`
    : 'No list price'
  return [
    price,
    model.contextWindow && `${tokenCount(model.contextWindow)} context`,
    model.rateLimit && `${model.rateLimit} rpm`,
  ].filter(Boolean).join(' · ')
}
