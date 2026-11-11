import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { useServerConfig } from '../../ServerConfigContext'
import { openRealtimeKitMeeting, type CallLeaveReason, type CallMeeting, type OpenCallMeeting } from './callMeeting'
import { CallSession } from './callSession'
import {
  isSameCall,
  LiveCallActionsContext,
  LiveCallStateContext,
  type LiveCallActions,
  type LiveCallGadget,
  type LiveCallInfo,
  type LiveCallState,
  type LiveCallStatus,
} from './liveCallContext'

const IDLE: LiveCallStatus = { phase: 'idle' }

const failureMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'Something went wrong.'

/**
 * Owns the one live call this tab can be in, so it outlives navigation: the RealtimeKit meeting,
 * its state machine (idle → joining → live, and back), and the gadget view currently lending its
 * capability. Rendered once, inside the authenticated app.
 */
export const LiveCallProvider = ({
  children,
  openMeeting = openRealtimeKitMeeting,
}: {
  children: ReactNode
  /** Opens a RealtimeKit meeting; tests pass a fake. */
  openMeeting?: OpenCallMeeting
}) => {
  const enabled = useServerConfig()?.liveCallsEnabled === true
  const toasts = useKumoToastManager()
  // Kumo hands out a new manager each render; the call outlives any one of them.
  const addToast = useRef(toasts.add)
  addToast.current = toasts.add
  const openMeetingRef = useRef(openMeeting)
  openMeetingRef.current = openMeeting

  const [status, setStatusState] = useState<LiveCallStatus>(IDLE)
  const statusRef = useRef(status)
  const [viewed, setViewed] = useState<LiveCallGadget | null>(null)
  const viewedRef = useRef<LiveCallGadget | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  // Bumped by every join and leave, so work started for an earlier one stands down.
  const generation = useRef(0)
  // Whether this call has already reconnected on its own; a second loss asks the person.
  const reconnected = useRef(false)

  const setStatus = useCallback((next: LiveCallStatus) => {
    statusRef.current = next
    setStatusState(next)
  }, [])

  // Everything below reads only refs and stable setters, so it is built once.
  const actions = useMemo<LiveCallActions>(() => {
    const connect = async (gadget: LiveCallGadget, call: LiveCallInfo, run: number) => {
      const stale = () => run !== generation.current
      let session: CallSession | null = null
      try {
        const { authToken } = await gadget.client.joinCall()
        if (stale()) return
        let meeting: CallMeeting
        let mediaFailed = false
        try {
          meeting = await openMeetingRef.current({ authToken, audio: true, video: true })
        } catch {
          // Most often the camera or microphone was refused. Without them they can still see
          // and hear everyone else; if that fails too, the error is a real one.
          meeting = await openMeetingRef.current({ authToken, audio: false, video: false })
          mediaFailed = true
        }
        const opened: CallSession = new CallSession(meeting, {
          mediaFailed,
          onLeft: reason => handleLeft(opened, call, reason),
        })
        session = opened
        if (stale()) {
          await opened.leave()
          return
        }
        await meeting.join()
        if (stale()) {
          await opened.leave()
          return
        }
        opened.syncParticipants()
        setStatus({ phase: 'live', call, session: opened })
      } catch (error) {
        if (session) void session.leave()
        if (stale()) return
        setStatus({ phase: 'idle', failure: { target: call, message: failureMessage(error) } })
      }
    }

    const handleLeft = (session: CallSession, call: LiveCallInfo, reason: CallLeaveReason) => {
      const current = statusRef.current
      if (current.phase !== 'live' || current.session !== session) return
      session.close()
      switch (reason) {
        case 'kicked':
          addToast.current({ title: 'You were removed from the live call.', variant: 'info' })
          break
        case 'ended':
          addToast.current({ title: 'The live call ended.', variant: 'info' })
          break
        case 'rejected':
          addToast.current({ title: 'You couldn’t join the live call.', variant: 'error' })
          break
        case 'disconnected':
        case 'failed': {
          // A dropped connection reconnects once with a fresh ticket -- the old one may have
          // expired -- but only through a view of this gadget, which holds the capability.
          const gadget = viewedRef.current
          if (!reconnected.current && gadget && isSameCall(gadget, call)) {
            reconnected.current = true
            const run = ++generation.current
            setStatus({ phase: 'joining', call })
            void connect(gadget, call, run)
          } else {
            setStatus({ phase: 'interrupted', call })
          }
          return
        }
      }
      setStatus(IDLE)
    }

    return {
      registerGadget: gadget => {
        viewedRef.current = gadget
        setViewed(gadget)
        return () => {
          if (viewedRef.current !== gadget) return
          viewedRef.current = null
          setViewed(null)
        }
      },

      join: gadget => {
        const current = statusRef.current
        if ((current.phase === 'joining' || current.phase === 'live') && isSameCall(current.call, gadget)) {
          return
        }
        const run = ++generation.current
        reconnected.current = false
        const call: LiveCallInfo = {
          workspaceId: gadget.workspaceId,
          gadgetId: gadget.gadgetId,
          gadgetTitle: gadget.gadgetTitle,
          canInvite: gadget.invite !== null,
        }
        setStatus({ phase: 'joining', call })
        setPanelOpen(true)
        void (async () => {
          // One camera at a time: the old call lets go of it before the new one asks.
          if (current.phase === 'live') await current.session.leave()
          if (run === generation.current) await connect(gadget, call, run)
        })()
      },

      leave: () => {
        const current = statusRef.current
        generation.current++
        setStatus(IDLE)
        if (current.phase === 'live') void current.session.leave()
      },

      setPanelOpen,
    }
  }, [setStatus])

  // Signing out unmounts the app: nobody stays in a call they can no longer see.
  useEffect(() => () => {
    generation.current++
    const current = statusRef.current
    if (current.phase === 'live') void current.session.leave()
  }, [])

  const state = useMemo<LiveCallState>(
    () => ({ enabled, status, viewed, panelOpen }),
    [enabled, status, viewed, panelOpen],
  )

  return (
    <LiveCallActionsContext.Provider value={actions}>
      <LiveCallStateContext.Provider value={state}>
        {children}
      </LiveCallStateContext.Provider>
    </LiveCallActionsContext.Provider>
  )
}
