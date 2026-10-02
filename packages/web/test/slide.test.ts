import { describe, expect, it } from 'vitest';
import { SLIDE_MAX_SECONDS, SLIDE_MIN_SECONDS, slideTiming } from '../src/slide.js';

describe('slideTiming', () => {
  it('does not slide a title that fits, or one measured as nonsense', () => {
    for (const hidden of [0, -12, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(slideTiming(hidden).seconds).toBe(0);
    }
  });

  it('never twitches: a one-pixel overhang still takes the shortest readable time', () => {
    expect(slideTiming(1).seconds).toBe(SLIDE_MIN_SECONDS);
  });

  it('never drags: a huge overhang is capped', () => {
    expect(slideTiming(100_000).seconds).toBe(SLIDE_MAX_SECONDS);
    expect(slideTiming(Number.POSITIVE_INFINITY).seconds).toBe(0);
  });

  it('keeps a steady speed in between, so a longer overhang takes longer', () => {
    expect(slideTiming(90).seconds).toBe(2);
    expect(slideTiming(180).seconds).toBeGreaterThan(slideTiming(90).seconds);
  });
});
