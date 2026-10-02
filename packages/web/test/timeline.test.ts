/**
 * Laying out the timeline: one scale inside a cluster, a fixed-height marker
 * for every quiet spell, and no two labels on top of each other. The cases are
 * the inputs that break a naive layout: nothing, one thing, ties, junk, and
 * gaps right at the threshold.
 */

import { describe, expect, it } from 'vitest';
import { describeGap, layoutTimeline, type TimelineLayoutOptions } from '../src/timeline.js';

const OPTIONS: TimelineLayoutOptions = { pxPerHour: 60, breakAfterMs: 3 * 3_600_000, minSpacing: 40, gapHeight: 44 };
const HOUR = 3_600_000;
const at = (hours: number) => ({ at: new Date(Date.UTC(2026, 0, 10) + hours * HOUR).toISOString(), hours });

function events(layout: ReturnType<typeof layoutTimeline<{ at: string; hours: number }>>) {
  return layout.items.flatMap((item) => (item.kind === 'event' ? [item] : []));
}

describe('layoutTimeline', () => {
  it('lays out nothing as nothing, with no height', () => {
    expect(layoutTimeline([], OPTIONS)).toEqual({ items: [], height: 0 });
  });

  it('gives a single event a row at the top that starts a cluster', () => {
    const layout = layoutTimeline([at(0)], OPTIONS);
    expect(layout.items).toEqual([{ kind: 'event', event: at(0), y: 0, startsCluster: true }]);
    expect(layout.height).toBe(OPTIONS.minSpacing);
  });

  it('puts the newest first, whatever order they came in', () => {
    const layout = layoutTimeline([at(1), at(2.5), at(0), at(2)], OPTIONS);
    expect(events(layout).map((item) => item.event.hours)).toEqual([2.5, 2, 1, 0]);
  });

  it('keeps the scale inside a cluster: two hours apart is twice one hour apart', () => {
    const [newest, middle, oldest] = events(layoutTimeline([at(3), at(2), at(0)], OPTIONS));
    expect(middle!.y - newest!.y).toBe(60);
    expect(oldest!.y - middle!.y).toBe(120);
  });

  it('never lets two events overlap, even at the same instant', () => {
    const layout = layoutTimeline([at(0), at(0), at(0), at(0.01)], OPTIONS);
    const ys = events(layout).map((item) => item.y);
    for (let index = 1; index < ys.length; index += 1) {
      expect(ys[index]! - ys[index - 1]!).toBeGreaterThanOrEqual(OPTIONS.minSpacing);
    }
  });

  it('keeps ties in the order they came in', () => {
    const first = { at: at(0).at, hours: 1 };
    const second = { at: at(0).at, hours: 2 };
    expect(events(layoutTimeline([first, second], OPTIONS)).map((item) => item.event.hours)).toEqual([1, 2]);
  });

  it('does not break at exactly the threshold, and does one millisecond past it', () => {
    const exactly = layoutTimeline([at(3), at(0)], OPTIONS);
    expect(exactly.items.some((item) => item.kind === 'gap')).toBe(false);

    const past = layoutTimeline([{ at: new Date(Date.parse(at(3).at) + 1).toISOString(), hours: 3 }, at(0)], OPTIONS);
    expect(past.items.map((item) => item.kind)).toEqual(['event', 'gap', 'event']);
  });

  it('draws a gap the same height whether it lasted a day or a year, and says how long it was', () => {
    const day = layoutTimeline([at(24), at(0)], OPTIONS);
    const year = layoutTimeline([at(24 * 365), at(0)], OPTIONS);
    expect(day.height).toBe(year.height);

    const gap = year.items.find((item) => item.kind === 'gap');
    expect(gap).toMatchObject({ kind: 'gap', ms: 365 * 24 * HOUR });
  });

  it('starts a new cluster after every gap, and only there', () => {
    const layout = layoutTimeline([at(100), at(99), at(50), at(49.5), at(0)], OPTIONS);
    expect(layout.items.map((item) => (item.kind === 'gap' ? 'gap' : item.startsCluster ? 'start' : 'event'))).toEqual(
      ['start', 'event', 'gap', 'start', 'event', 'gap', 'start'],
    );
  });

  it('places a gap marker between the events it separates, never over either', () => {
    const layout = layoutTimeline([at(48), at(0)], OPTIONS);
    const [before, gap, after] = layout.items;
    expect(gap!.y).toBeGreaterThanOrEqual(before!.y + OPTIONS.minSpacing);
    expect(after!.y).toBeGreaterThanOrEqual(gap!.y + OPTIONS.gapHeight);
  });

  it('leaves out events whose time cannot be read, rather than placing them in 1970', () => {
    const layout = layoutTimeline([at(1), { at: 'not a date', hours: -1 }, { at: '', hours: -2 }, at(0)], OPTIONS);
    expect(events(layout).map((item) => item.event.hours)).toEqual([1, 0]);
  });

  it('makes room for the last row in its height', () => {
    const layout = layoutTimeline([at(1), at(0)], OPTIONS);
    const last = events(layout).at(-1)!;
    expect(layout.height).toBe(last.y + OPTIONS.minSpacing);
  });
});

describe('describeGap', () => {
  it.each([
    [10_000, '1 min'],
    [45 * 60_000, '45 min'],
    [HOUR, '1 hour'],
    [5 * HOUR, '5 hours'],
    [24 * HOUR, '1 day'],
    [3 * 24 * HOUR, '3 days'],
    [16 * 24 * HOUR, '2 weeks'],
    [90 * 24 * HOUR, '3 months'],
    [800 * 24 * HOUR, '2 years'],
  ])('%i ms reads as %s', (ms, text) => {
    expect(describeGap(ms)).toBe(text);
  });
});
