/**
 * How long a cut-off title takes to slide into view: a steady speed a person
 * can read at, never so fast for a short overhang that it twitches, and never
 * so slow for a very long one that it drags.
 */

/** Pixels a second. Slow enough to read the words going past. */
export const SLIDE_SPEED = 45;
export const SLIDE_MIN_SECONDS = 0.6;
export const SLIDE_MAX_SECONDS = 6;

export function slideTiming(hiddenPx: number): { seconds: number } {
  if (!Number.isFinite(hiddenPx) || hiddenPx <= 0) return { seconds: 0 };
  const seconds = Math.min(SLIDE_MAX_SECONDS, Math.max(SLIDE_MIN_SECONDS, hiddenPx / SLIDE_SPEED));
  return { seconds: Math.round(seconds * 100) / 100 };
}
