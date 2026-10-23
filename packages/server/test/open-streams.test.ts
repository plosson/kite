/**
 * The bookkeeping behind the live stream limits (src/live/streams.ts): who is
 * closed to make room, who is refused, and that a refusal never costs anybody
 * a stream they already had. The stream route's own tests (live.test.ts) cover
 * what a browser sees.
 */
import { describe, expect, it } from 'vitest';
import { OpenStreams, type StreamTicket } from '../src/live/streams.js';

interface Ticket extends StreamTicket {
  replaced: boolean;
}

function ticket(userId: string | null, artifactId: string | null = null): Ticket {
  const made: Ticket = {
    userId,
    artifactId,
    replaced: false,
    replace: () => {
      made.replaced = true;
    },
  };
  return made;
}

describe('OpenStreams', () => {
  it('closes only the person’s own oldest stream when they reach their limit', () => {
    const streams = new OpenStreams({ perUser: 2, perArtifact: 10, total: 10 });
    const [first, second, third] = [ticket('ada'), ticket('ada'), ticket('ada')];
    const theirs = ticket('grace');
    streams.admit(theirs);
    streams.admit(first);
    streams.admit(second);

    expect(streams.admit(third).admitted).toBe(true);

    expect(first.replaced).toBe(true);
    expect(second.replaced || third.replaced || theirs.replaced).toBe(false);
    expect(streams.count({ userId: 'ada' })).toBe(2);
    expect(streams.count()).toBe(3);
  });

  it('refuses past a document’s limit or the total, and closes nothing', () => {
    const streams = new OpenStreams({ perUser: 10, perArtifact: 2, total: 3 });
    const open = [ticket('ada', 'art_1'), ticket(null, 'art_1')];
    for (const stream of open) streams.admit(stream);

    expect(streams.admit(ticket(null, 'art_1'))).toEqual({ admitted: false, full: 'artifact' });
    expect(streams.admit(ticket('grace', 'art_2')).admitted).toBe(true);
    expect(streams.admit(ticket('grace'))).toEqual({ admitted: false, full: 'total' });
    expect(open.some((stream) => stream.replaced)).toBe(false);
    expect(streams.count()).toBe(3);
  });

  it('lets a person replace their own stream even when everything is full', () => {
    const streams = new OpenStreams({ perUser: 1, perArtifact: 1, total: 1 });
    const old = ticket('ada', 'art_1');
    streams.admit(old);

    expect(streams.admit(ticket('ada', 'art_1')).admitted).toBe(true);
    expect(old.replaced).toBe(true);
  });

  it('never closes a stream for one that is then refused', () => {
    const streams = new OpenStreams({ perUser: 1, perArtifact: 1, total: 10 });
    const someoneElse = ticket('grace', 'art_1');
    const theirOnly = ticket('ada');
    streams.admit(someoneElse);
    streams.admit(theirOnly);

    expect(streams.admit(ticket('ada', 'art_1'))).toEqual({ admitted: false, full: 'artifact' });
    expect(theirOnly.replaced).toBe(false);
    expect(streams.count({ userId: 'ada' })).toBe(1);
  });

  it('gives the room back when a stream is released, and anonymous streams count only against documents and the total', () => {
    const streams = new OpenStreams({ perUser: 1, perArtifact: 5, total: 2 });
    const first = streams.admit(ticket(null, 'art_1'));
    streams.admit(ticket(null, 'art_1'));
    expect(streams.admit(ticket(null, 'art_1')).admitted).toBe(false);

    if (!first.admitted) throw new Error('first stream was refused');
    first.release();

    expect(streams.admit(ticket(null, 'art_1')).admitted).toBe(true);
    expect(streams.count({ artifactId: 'art_1' })).toBe(2);
  });
});
