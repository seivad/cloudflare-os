import { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import type { RpcStub } from 'capnweb'
import type { GadgetClient, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CallSession } from './callSession'

/** Which gadget's call: one gadget of one workspace. */
export type LiveCallTarget = {
  workspaceId: string
  gadgetId: WorkpieceId
  gadgetTitle: string
}

/**
 * A gadget view on screen, as it registers with the provider: what the call may borrow from it
 * while it stays mounted.
 */
export type LiveCallGadget = LiveCallTarget & {
  /**
   * The view's own capability, used to fetch tickets and the roster. The view owns it: the call
   * never disposes it, and stops using it once the view unregisters.
   */
  client: RpcStub<GadgetClient>
  /** Opens the share dialog to invite people to this gadget's call, or null if they can't. */
  invite: (() => void) | null
}

/** The call in progress, as it was when it was joined. */
export type LiveCallInfo = LiveCallTarget & {
  /** Whether this session may invite people to it (owner or "build", as for sharing). */
  canInvite: boolean
}

/** Where the live call stands. */
export type LiveCallStatus =
  | { phase: 'idle'; failure?: { target: LiveCallTarget; message: string } }
  | { phase: 'joining'; call: LiveCallInfo }
  | { phase: 'live'; call: LiveCallInfo; session: CallSession }
  /** The connection was lost and couldn't be restored on its own; the person may rejoin. */
  | { phase: 'interrupted'; call: LiveCallInfo }

/** What the sidebar and the Live toggle render from. */
export type LiveCallState = {
  /** Whether this deployment offers live calls at all (`ServerConfig.liveCallsEnabled`). */
  enabled: boolean
  status: LiveCallStatus
  /** The gadget view on screen, if one is registered. */
  viewed: LiveCallGadget | null
  /** Whether the sidebar is expanded rather than closed (idle) or collapsed to a pill (in a call). */
  panelOpen: boolean
}

/** The provider's actions. Their identities never change. */
export type LiveCallActions = {
  /** Lends the provider a gadget view's capability until the returned function is called. */
  registerGadget: (gadget: LiveCallGadget) => () => void
  /** Joins `gadget`'s call, leaving any other first; does nothing if already in or joining it. */
  join: (gadget: LiveCallGadget) => void
  leave: () => void
  setPanelOpen: (open: boolean) => void
}

/** Holds the provider's state. */
export const LiveCallStateContext = createContext<LiveCallState | null>(null)
/** Holds the provider's actions. */
export const LiveCallActionsContext = createContext<LiveCallActions | null>(null)

/** The live call's state, or null outside a LiveCallProvider. */
export const useLiveCallState = (): LiveCallState | null => useContext(LiveCallStateContext)

/** The live call's actions, or null outside a LiveCallProvider. */
export const useLiveCallActions = (): LiveCallActions | null => useContext(LiveCallActionsContext)

/** Whether two targets name the same gadget's call. */
export const isSameCall = (a: LiveCallTarget, b: LiveCallTarget): boolean =>
  a.workspaceId === b.workspaceId && a.gadgetId === b.gadgetId

declare module '@tanstack/react-router' {
  interface HistoryState {
    /**
     * Set by a call invitation's Join, which the person just clicked: join the call of the gadget
     * the address names at once. Navigation state, unlike the address's `?call=join`, can't come
     * from a pasted link, which only opens the sidebar and leaves joining to the person.
     */
    liveCallJoin?: true
  }
}

/**
 * What a gadget view asks of its gadget's call once registered: to show it (`?call=join`), or to
 * join it (a call invitation's own Join). `onHonoured` runs once it has, so the caller can drop
 * the request.
 */
export type LiveCallRequest = { join: boolean; onHonoured: () => void }

/** What a gadget view tells the live call about itself; see useLiveCallGadget(). */
export type LiveCallGadgetView = LiveCallTarget & {
  client: RpcStub<GadgetClient>
  /** Opens the share dialog in call mode, or null for a session that can't share. */
  onInvite: (() => void) | null
}

/**
 * Registers the gadget a view shows with the live call while the view is mounted, so the sidebar
 * can show its call and join it. `view` is null while there is nothing to register (no committed
 * gadget selected, or its capability not open yet). `request` is honoured once, as soon as the
 * gadget is registered: it opens the sidebar on the gadget's call, or joins it only when
 * `request.join` says the person asked to (see HistoryState.liveCallJoin).
 */
export const useLiveCallGadget = (
  view: LiveCallGadgetView | null,
  request: LiveCallRequest | null = null,
): void => {
  const actions = useLiveCallActions()
  // Kept current in refs so that a new callback each render doesn't re-register the gadget.
  const onInvite = useRef(view?.onInvite ?? null)
  onInvite.current = view?.onInvite ?? null
  const onHonoured = useRef(request?.onHonoured)
  onHonoured.current = request?.onHonoured
  const canInvite = view?.onInvite != null
  const workspaceId = view?.workspaceId
  const gadgetId = view?.gadgetId
  const gadgetTitle = view?.gadgetTitle
  const client = view?.client
  const gadget = useMemo<LiveCallGadget | null>(() =>
    workspaceId !== undefined && gadgetId !== undefined && gadgetTitle !== undefined && client
      ? {
          workspaceId, gadgetId, gadgetTitle, client,
          invite: canInvite ? () => onInvite.current?.() : null,
        }
      : null,
  [workspaceId, gadgetId, gadgetTitle, client, canInvite])

  useEffect(() => {
    if (!actions || !gadget) return
    return actions.registerGadget(gadget)
  }, [actions, gadget])

  const requested = request === null ? null : request.join ? 'join' : 'open'
  useEffect(() => {
    if (!actions || !gadget || requested === null) return
    if (requested === 'join') actions.join(gadget)
    else actions.setPanelOpen(true)
    onHonoured.current?.()
  }, [actions, gadget, requested])
}
