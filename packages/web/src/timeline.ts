/**
 * Where each event sits on the timeline, worked out apart from drawing it.
 *
 * Time runs down the page at one scale, so an afternoon of edits spreads out
 * and a burst of them bunches up: the shape says how the work went. But a scale
 * that honest would put a blank metre between Tuesday and the following month.
 * So any quiet spell longer than `breakAfterMs` is cut out and replaced by a
 * marker of fixed height that says how long it was. What is left between two
 * markers is a cluster: work that happened together.
 *
 * Two events can never sit closer than `minSpacing`, or their labels would
 * overlap. That bends the scale for events minutes apart, which is the honest
 * trade: you can still read both.
 */

export interface TimelineLayoutOptions {
  /** How tall an hour is, inside a cluster. */
  pxPerHour: number;
  /** A quiet spell longer than this is cut out and shown as a gap marker. */
  breakAfterMs: number;
  /** The least distance between two events, so their labels never overlap. */
  minSpacing: number;
  /** How tall a gap marker is, however long the gap. */
  gapHeight: number;
}

export const DEFAULT_TIMELINE_LAYOUT: TimelineLayoutOptions = {
  pxPerHour: 48,
  breakAfterMs: 3 * 60 * 60 * 1000,
  minSpacing: 40,
  gapHeight: 44,
};

export type TimelineItem<T> =
  | {
      kind: 'event';
      event: T;
      /** The top of its row. */
      y: number;
      /** First event after a gap, or the very first: the place to say which day it is. */
      startsCluster: boolean;
    }
  | {
      kind: 'gap';
      y: number;
      /** How long the quiet spell was. */
      ms: number;
    };

export interface TimelineLayout<T> {
  items: TimelineItem<T>[];
  /** The height the whole thing needs. */
  height: number;
}

/**
 * Lays out events newest first. Input in any order; anything whose time cannot
 * be read is left out rather than placed at the epoch.
 */
export function layoutTimeline<T extends { at: string }>(
  events: readonly T[],
  options: TimelineLayoutOptions = DEFAULT_TIMELINE_LAYOUT,
): TimelineLayout<T> {
  const timed = events
    .map((event, index) => ({ event, time: Date.parse(event.at), index }))
    .filter((entry) => Number.isFinite(entry.time))
    // Newest first. Ties keep the order they came in, so a list the server
    // already ordered is not reshuffled.
    .sort((a, b) => b.time - a.time || a.index - b.index);

  const items: TimelineItem<T>[] = [];
  let y = 0;

  timed.forEach((entry, position) => {
    if (position > 0) {
      const previous = timed[position - 1]!;
      const ms = previous.time - entry.time;
      if (ms > options.breakAfterMs) {
        items.push({ kind: 'gap', y: y + options.minSpacing, ms });
        y += options.minSpacing + options.gapHeight;
        items.push({ kind: 'event', event: entry.event, y, startsCluster: true });
        return;
      }
      y += Math.max(options.minSpacing, (ms / 3_600_000) * options.pxPerHour);
    }
    items.push({ kind: 'event', event: entry.event, y, startsCluster: position === 0 });
  });

  return { items, height: timed.length === 0 ? 0 : y + options.minSpacing };
}

/** A gap's length the way a person says it: "45 min", "5 hours", "3 days", "2 months". */
export function describeGap(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} min`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return plural(hours, 'hour');
  const days = Math.round(ms / 86_400_000);
  if (days < 14) return plural(days, 'day');
  if (days < 60) return plural(Math.round(days / 7), 'week');
  if (days < 365) return plural(Math.round(days / 30), 'month');
  return plural(Math.round(days / 365), 'year');
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}
