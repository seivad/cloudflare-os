import { useSyncExternalStore } from 'react'
import type { CallSession, CallSnapshot } from './callSession'

const subscribeToNothing = () => () => {}
const noSnapshot = () => null

/** What `session` shows now, re-rendering as it changes; null without a session. */
export const useCallSnapshot = (session: CallSession | null): CallSnapshot | null =>
  useSyncExternalStore<CallSnapshot | null>(
    session?.subscribe ?? subscribeToNothing,
    session?.getSnapshot ?? noSnapshot,
  )
