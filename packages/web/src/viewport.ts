/**
 * Whether the window is phone-sized.
 *
 * The same line Tailwind's `md` breakpoint draws (48rem), so a screen the
 * stylesheet lays out for a phone is also the one the components behave for a
 * phone on. Most of the difference is CSS; this is for the few things CSS cannot
 * decide, like a panel starting closed rather than open.
 */

import { useSyncExternalStore } from 'react';

const NARROW = '(max-width: 47.999rem)';

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function isNarrow(): boolean {
  return window.matchMedia(NARROW).matches;
}

export function useNarrowScreen(): boolean {
  return useSyncExternalStore(subscribe, isNarrow, () => false);
}
