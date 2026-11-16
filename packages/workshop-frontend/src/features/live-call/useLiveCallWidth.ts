import { useState } from 'react'

const STORAGE_KEY = 'liveCall.sidebarWidth'

/** The sidebar's narrowest width, and its width until someone resizes it (in CSS pixels). */
export const LIVE_CALL_MIN_WIDTH = 224

/** The widest the sidebar may be now: up to 60% of the viewport, so the gadget keeps room. */
export const liveCallMaxWidth = (): number =>
  Math.max(LIVE_CALL_MIN_WIDTH, Math.round(window.innerWidth * 0.6))

const clamp = (width: number): number =>
  Math.min(liveCallMaxWidth(), Math.max(LIVE_CALL_MIN_WIDTH, Math.round(width)))

const storedWidth = (): number => {
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY))
    return Number.isFinite(stored) && stored > 0 ? clamp(stored) : LIVE_CALL_MIN_WIDTH
  } catch {
    return LIVE_CALL_MIN_WIDTH
  }
}

/** The wide sidebar's width, kept within its bounds and remembered in this browser. */
export const useLiveCallWidth = (): [width: number, setWidth: (width: number) => void] => {
  const [width, setWidthState] = useState(storedWidth)
  const setWidth = (requested: number) => {
    const next = clamp(requested)
    setWidthState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next))
    } catch {
      // Storage refused: the width lasts until the page is reloaded.
    }
  }
  return [width, setWidth]
}
