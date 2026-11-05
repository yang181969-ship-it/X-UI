import { useMemo, useSyncExternalStore } from 'react';

/** Same breakpoint as the stylesheet's `@media (max-width: 768px)`: phones and narrow windows. */
export const NARROW_QUERY = '(max-width: 768px)';

function subscribe(query: string) {
  return (onChange: () => void) => {
    const mq = window.matchMedia(query);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  };
}

/** Whether `query` matches now (re-renders when it changes). */
export function useMedia(query: string): boolean {
  const sub = useMemo(() => subscribe(query), [query]);
  return useSyncExternalStore(
    sub,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const useNarrow = () => useMedia(NARROW_QUERY);

/**
 * Above the phone layout's fixed menu button (.drawer-handle, z-index 1100): drawers and dialogs of
 * the transaction pages must never have their close button covered by it.
 */
export const OVERLAY_Z = 1200;
