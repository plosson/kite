/** The in-process feed on its own: who hears what, and nothing left behind. */

import { describe, it, expect } from 'vitest';
import { ChangeFeed, type ArtifactChange, type ChangeListener } from '../src/live/feed.js';
import { createLogger } from '../src/logging.js';

const actor = { userId: 'usr_1', via: 'browser' as const, clientId: null };
const content = (artifactId: string, version: number): ArtifactChange => ({
  kind: 'content',
  artifactId,
  version,
  actor,
});

function recorder(): ChangeListener & { heard: ArtifactChange[]; closed: number } {
  const heard: ArtifactChange[] = [];
  return {
    heard,
    closed: 0,
    change(change) {
      heard.push(change);
    },
    close() {
      this.closed += 1;
    },
  };
}

describe('the change feed', () => {
  it('tells every listener of an artifact, and only of that artifact', () => {
    const feed = new ChangeFeed();
    const a1 = recorder();
    const a2 = recorder();
    const b = recorder();
    feed.subscribe('art_a', a1);
    feed.subscribe('art_a', a2);
    feed.subscribe('art_b', b);

    feed.publish(content('art_a', 2));

    expect(a1.heard).toEqual([content('art_a', 2)]);
    expect(a2.heard).toEqual([content('art_a', 2)]);
    expect(b.heard).toEqual([]);
  });

  it('forgets an artifact entirely once its last listener leaves', () => {
    const feed = new ChangeFeed();
    const stopA = feed.subscribe('art_a', recorder());
    const stopB = feed.subscribe('art_a', recorder());
    expect(feed.listenerCount('art_a')).toBe(2);

    stopA();
    stopA();
    expect(feed.listenerCount('art_a')).toBe(1);
    stopB();
    expect(feed.listenerCount()).toBe(0);
  });

  it('keeps going past a listener that throws, and reports it', () => {
    const lines: string[] = [];
    const feed = new ChangeFeed({ logger: createLogger({ level: 'error', write: (line) => lines.push(line) }) });
    const after = recorder();
    feed.subscribe('art_a', {
      change: () => {
        throw new Error('boom');
      },
      close: () => {},
    });
    feed.subscribe('art_a', after);

    expect(() => feed.publish(content('art_a', 2))).not.toThrow();
    expect(after.heard).toHaveLength(1);
    expect(lines.join('\n')).toContain('change listener failed');
  });

  it('lets a listener leave while it is being told', () => {
    const feed = new ChangeFeed();
    const second = recorder();
    const stop = feed.subscribe('art_a', { change: () => stop(), close: () => {} });
    feed.subscribe('art_a', second);

    feed.publish(content('art_a', 2));

    expect(second.heard).toHaveLength(1);
    expect(feed.listenerCount('art_a')).toBe(1);
  });

  it('closes every listener once when it shuts down', () => {
    const feed = new ChangeFeed();
    const one = recorder();
    const two = recorder();
    feed.subscribe('art_a', one);
    feed.subscribe('art_b', two);

    feed.close();
    feed.publish(content('art_a', 2));

    expect([one.closed, two.closed]).toEqual([1, 1]);
    expect(one.heard).toEqual([]);
    expect(feed.listenerCount()).toBe(0);
  });
});
