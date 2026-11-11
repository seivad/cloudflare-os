import { useSyncExternalStore } from 'react'

// Tailwind's `md` breakpoint, where the sidebar takes a column of its own.
const WIDE_QUERY = '(min-width: 48rem)'

const subscribe = (onChange: () => void) => {
  const query = window.matchMedia?.(WIDE_QUERY)
  query?.addEventListener('change', onChange)
  return () => query?.removeEventListener('change', onChange)
}

const isWide = () => window.matchMedia?.(WIDE_QUERY).matches ?? true

/**
 * Whether the viewport is at least `md` wide. Decided in script rather than CSS because each
 * layout registers its own video elements, which must not both exist at once.
 */
export const useWideLayout = (): boolean => useSyncExternalStore(subscribe, isWide, () => true)
