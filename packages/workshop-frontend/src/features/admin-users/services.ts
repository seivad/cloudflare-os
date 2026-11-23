import type { AdminGatekeeperInfo } from '@gadgets/workshop-shared/api'

/** What a user's gadgets are connected to, counted in gadgets (spawners in agent spawners). */
export type ServicesSummary = {
  models: { id: string; gadgets: number }[]
  vendors: { id: string; gadgets: number }[]
  spawners: number
}

type Count = { id: string; gadgets: number }

const byCount = (a: Count, b: Count) => b.gadgets - a.gadgets || a.id.localeCompare(b.id)

const addGadget = (into: Map<string, Set<string>>, key: string, gadgetId: string) => {
  const gadgets = into.get(key) ?? new Set<string>()
  gadgets.add(gadgetId)
  into.set(key, gadgets)
}

const counted = (from: Map<string, Set<string>>): Count[] =>
  [...from].map(([id, gadgets]) => ({ id, gadgets: gadgets.size })).toSorted(byCount)

/**
 * Counts the connections of one or more workspaces the way the Usage tab shows them: the gadgets
 * bound to each AI model (its `creationSpec` model id) and to each Gatekeeper vendor, and how many
 * agent spawners are bound at all. A binding still pending in a chat (`chatId` set) is not yet
 * part of a gadget, so it counts for nothing. Gadget ids belong to one workspace, so summaries of
 * different workspaces are summed with `mergeServices`.
 */
export const summarizeServices = (gatekeepers: AdminGatekeeperInfo[]): ServicesSummary => {
  const models = new Map<string, Set<string>>()
  const vendors = new Map<string, Set<string>>()
  let spawners = 0
  for (const gatekeeper of gatekeepers) {
    const bound = gatekeeper.bindings.filter((binding) => binding.chatId === undefined)
    if (bound.length === 0) continue
    const spec = gatekeeper.creationSpec
    if (spec?.type === 'aiModel') for (const binding of bound) addGadget(models, spec.modelId, binding.gadgetId)
    if (spec?.type === 'agentSpawner') spawners += 1
    if (gatekeeper.vendorId !== undefined) for (const binding of bound) addGadget(vendors, gatekeeper.vendorId, binding.gadgetId)
  }
  return { models: counted(models), vendors: counted(vendors), spawners }
}

/** Adds up summaries of separate workspaces (their gadgets are disjoint). */
export const mergeServices = (summaries: ServicesSummary[]): ServicesSummary => {
  const total = (pick: (summary: ServicesSummary) => { id: string; gadgets: number }[]) => {
    const sums = new Map<string, number>()
    for (const summary of summaries) for (const { id, gadgets } of pick(summary)) sums.set(id, (sums.get(id) ?? 0) + gadgets)
    return [...sums].map(([id, gadgets]) => ({ id, gadgets })).toSorted(byCount)
  }
  return {
    models: total((summary) => summary.models),
    vendors: total((summary) => summary.vendors),
    spawners: summaries.reduce((sum, summary) => sum + summary.spawners, 0),
  }
}
