import { useRef } from 'react'
import { LIVE_CALL_MIN_WIDTH, liveCallMaxWidth } from './useLiveCallWidth'

// How far one arrow key press moves the edge.
const KEY_STEP = 16

/**
 * The wide sidebar's left edge, dragged (or moved with the arrow keys) to resize it. Dragging left
 * widens it. The pointer is captured, so the gadget's iframe can't swallow the drag.
 */
export const LiveCallResizeHandle = ({ width, onWidthChange }: {
  width: number
  onWidthChange: (width: number) => void
}) => {
  const drag = useRef<{ x: number; width: number } | null>(null)

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize live call"
      aria-valuemin={LIVE_CALL_MIN_WIDTH}
      aria-valuemax={liveCallMaxWidth()}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize"
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // Not an active pointer (a synthetic event): the drag works while it stays over the edge.
        }
        drag.current = { x: event.clientX, width }
      }}
      onPointerMove={event => {
        if (drag.current) onWidthChange(drag.current.width + drag.current.x - event.clientX)
      }}
      onPointerUp={() => { drag.current = null }}
      onPointerCancel={() => { drag.current = null }}
      onDoubleClick={() => onWidthChange(LIVE_CALL_MIN_WIDTH)}
      onKeyDown={event => {
        const next = event.key === 'ArrowLeft' ? width + KEY_STEP
          : event.key === 'ArrowRight' ? width - KEY_STEP
          : event.key === 'Home' ? LIVE_CALL_MIN_WIDTH
          : event.key === 'End' ? liveCallMaxWidth()
          : null
        if (next === null) return
        event.preventDefault()
        onWidthChange(next)
      }}
      className="group absolute inset-y-0 -left-1.5 z-10 w-3 cursor-col-resize touch-none outline-none"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors duration-150 group-hover:bg-kumo-brand group-focus-visible:bg-kumo-brand group-active:bg-kumo-brand"
      />
    </div>
  )
}
