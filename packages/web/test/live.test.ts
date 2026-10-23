import { describe, it, expect, afterEach } from 'vitest';
import { connectLive, CLIENT_ID, type LiveConnection, type LiveEvent, type LiveFollow } from '../src/live.js';

/**
 * The browser end of the tab's live connection, against a stand-in server:
 * what it asks for, what it passes on, when it gives up, when it carries on
 * with less, and when it tries again.
 */

interface Opened {
  url: string;
  init: RequestInit;
  push: (text: string) => void;
  end: () => void;
}

type Answer = 'stream' | number | { status: number; retryAfter: string };

function server(answers: Answer[]) {
  const opened: Opened[] = [];
  const asked: string[] = [];
  let waiting: ((value: Opened) => void) | null = null;
  const fetch = (async (url: string, init: RequestInit) => {
    asked.push(url);
    const answer = answers.shift() ?? 'stream';
    if (typeof answer === 'number') return new Response('{}', { status: answer });
    if (answer !== 'stream') {
      return new Response('{}', { status: answer.status, headers: { 'Retry-After': answer.retryAfter } });
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    init.signal?.addEventListener('abort', () => {
      try {
        controller.error(new DOMException('aborted', 'AbortError'));
      } catch {
        // Already closed.
      }
    });
    const encoder = new TextEncoder();
    const stream: Opened = {
      url,
      init,
      push: (text) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
    };
    opened.push(stream);
    waiting?.(stream);
    waiting = null;
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    opened,
    asked,
    /** The next stream the client opens (or the one already open, if it has not been taken). */
    next: (count: number) =>
      opened.length >= count ? Promise.resolve(opened[count - 1]!) : new Promise<Opened>((resolve) => (waiting = resolve)),
  };
}

const event = (name: string, data: Record<string, unknown>) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const ready = (data: Record<string, unknown>) => `event: ready\ndata: ${JSON.stringify(data)}\nretry: 2000\n\n`;
const change = (data: Record<string, unknown>) => event('change', data);

let connection: LiveConnection | null = null;
afterEach(() => connection?.close());

function open(
  fake: ReturnType<typeof server>,
  options: { staleMs?: number; follow?: LiveFollow; onVisible?: (resume: () => void) => () => void } = {},
) {
  const events: LiveEvent[] = [];
  const { follow = { artifactId: 'art-1' }, ...rest } = options;
  connection = connectLive(follow, {
    fetch: fake.fetch,
    backoffMs: [5],
    onVisible: () => () => undefined,
    ...rest,
  });
  connection.listen((heard) => events.push(heard));
  return { connection, events };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the live connection, in the browser', () => {
  it('names the tab, passes on others’ changes, and keeps its own to itself', async () => {
    const fake = server(['stream']);
    const { connection, events } = open(fake);
    const stream = await fake.next(1);
    expect(new Headers(stream.init.headers).get('X-Kite-Client')).toBe(CLIENT_ID);

    stream.push(ready({ version: 3 }));
    stream.push(': ping\n\n');
    stream.push(change({ kind: 'content', version: 4, via: 'browser', self: true }));
    stream.push(change({ kind: 'comments', via: 'agent', self: false }));
    stream.push(change({ kind: 'content', version: 5, via: 'agent', self: false }));
    await settle();

    expect(connection.state).toBe('live');
    expect(connection.version).toBe(5);
    expect(connection.unread).toBeNull();
    expect(events).toEqual([
      { type: 'ready', version: 3, unread: null, reconnected: false },
      { type: 'change', kind: 'comments', version: null, via: 'agent' },
      { type: 'change', kind: 'content', version: 5, via: 'agent' },
    ]);
  });

  it('asks for the document by whichever name it has, or for nothing but the person', async () => {
    for (const [follow, url] of [
      [{ slug: 'q3 plan' }, '/api/events?slug=q3%20plan'],
      [{ artifactId: 'art-1' }, '/api/events?artifact=art-1'],
      [null, '/api/events'],
    ] as const) {
      const fake = server(['stream']);
      open(fake, { follow });
      expect((await fake.next(1)).url).toBe(url);
      connection?.close();
    }
  });

  it('keeps the bell’s count, and says whose doing each change of it was', async () => {
    const fake = server(['stream']);
    const { connection, events } = open(fake, { follow: null });
    const stream = await fake.next(1);
    const counts: (number | null)[] = [];
    connection.watch(() => counts.push(connection.unread));

    stream.push(ready({ unread: 2 }));
    stream.push(event('notifications', { unread: 3, self: false }));
    stream.push(event('notifications', { unread: 0, self: true }));
    await settle();

    expect(connection.unread).toBe(0);
    expect(counts).toEqual([2, 2, 3, 0]);
    expect(events).toEqual([
      { type: 'ready', version: null, unread: 2, reconnected: false },
      { type: 'notifications', unread: 3, self: false },
      { type: 'notifications', unread: 0, self: true },
    ]);
  });

  it('carries on for the person when the document goes, and stops asking for it', async () => {
    const fake = server(['stream', 'stream']);
    const { connection, events } = open(fake, { follow: { slug: 'plan' } });
    const first = await fake.next(1);
    first.push(ready({ version: 1, unread: 0 }));
    first.push(event('gone', { reason: 'no-access' }));
    await settle();

    expect(connection.state).toBe('live');
    expect(events.at(-1)).toEqual({ type: 'gone', reason: 'no-access' });

    first.end();
    const second = await fake.next(2);
    expect(second.url).toBe('/api/events');
  });

  it('stops for good when the document goes and there is nobody else to follow', async () => {
    const fake = server(['stream']);
    const { connection, events } = open(fake);
    const stream = await fake.next(1);
    stream.push(ready({ version: 1 }));
    stream.push(event('gone', { reason: 'deleted' }));
    stream.end();
    await settle();

    expect(connection.state).toBe('closed');
    expect(events.at(-1)).toEqual({ type: 'gone', reason: 'deleted' });
    expect(fake.opened).toHaveLength(1);
  });

  it('says the sign-in stopped working, and carries on for a public document', async () => {
    const fake = server(['stream']);
    const { connection, events } = open(fake, { follow: { slug: 'plan' } });
    const stream = await fake.next(1);
    stream.push(ready({ version: 1, unread: 4 }));
    stream.push(event('signed-out', {}));
    stream.push(change({ kind: 'details', via: 'browser', self: false }));
    await settle();

    expect(connection.state).toBe('live');
    expect(connection.unread).toBeNull();
    expect(events.slice(1)).toEqual([
      { type: 'signed-out' },
      { type: 'change', kind: 'details', version: null, via: 'browser' },
    ]);

    stream.push(event('gone', { reason: 'no-access' }));
    await settle();
    expect(connection.state).toBe('closed');
  });

  it('says so and stops when a stream for nobody but the person is refused for want of one', async () => {
    const fake = server([401]);
    const { connection, events } = open(fake, { follow: null });
    await settle();

    expect(connection.state).toBe('closed');
    expect(events).toEqual([{ type: 'signed-out' }]);
    await settle();
    expect(fake.asked).toHaveLength(1);
  });

  it('stops for a request the server will never take, rather than asking again', async () => {
    const fake = server([400]);
    const { connection, events } = open(fake);
    await settle();

    expect(connection.state).toBe('closed');
    expect(events).toEqual([]);
    expect(fake.asked).toHaveLength(1);
  });

  it('waits as long as the server asks when it is too busy, and no less', async () => {
    const fake = server([{ status: 429, retryAfter: '1' }, 'stream']);
    const { connection } = open(fake);
    await settle(200);

    expect(connection.state).toBe('reconnecting');
    expect(fake.asked).toHaveLength(1);

    const stream = await fake.next(1);
    expect(fake.asked).toHaveLength(2);
    stream.push(ready({ version: 1 }));
    await settle();
    expect(connection.state).toBe('live');
  });

  it('waits when replaced by a newer tab, and comes back once this one is looked at', async () => {
    const fake = server(['stream', 'stream']);
    let resume: (() => void) | null = null;
    const { connection, events } = open(fake, {
      follow: null,
      onVisible: (callback) => {
        resume = callback;
        return () => (resume = null);
      },
    });
    const first = await fake.next(1);
    first.push(ready({ unread: 0 }));
    first.push(event('replaced', {}));
    first.end();
    await settle(50);

    expect(connection.state).toBe('paused');
    expect(events.at(-1)).toEqual({ type: 'replaced' });
    expect(fake.asked).toHaveLength(1);

    resume!();
    const second = await fake.next(2);
    second.push(ready({ unread: 1 }));
    await settle();

    expect(resume).toBeNull();
    expect(connection.state).toBe('live');
    expect(events.at(-1)).toEqual({ type: 'ready', version: null, unread: 1, reconnected: true });
  });

  it('tries again after a server error', async () => {
    const fake = server([503, 502, 'stream']);
    const { connection, events } = open(fake);
    expect(connection.state).toBe('connecting');
    const stream = await fake.next(1);
    stream.push(ready({ version: 7 }));
    await settle();

    expect(connection.state).toBe('live');
    // Never ready before, so not a reconnection: nothing was missed.
    expect(events).toEqual([{ type: 'ready', version: 7, unread: null, reconnected: false }]);
  });

  it('reconnects when the stream is cut, and says so when it is back', async () => {
    const fake = server(['stream', 'stream']);
    const { connection, events } = open(fake);
    const first = await fake.next(1);
    first.push(ready({ version: 1 }));
    await settle();
    first.end();
    await settle();

    const second = await fake.next(2);
    second.push(ready({ version: 4 }));
    await settle();

    expect(connection.state).toBe('live');
    expect(events.at(-1)).toEqual({ type: 'ready', version: 4, unread: null, reconnected: true });
  });

  it('gives up on a connection that went quiet, and opens another', async () => {
    const fake = server(['stream', 'stream']);
    const { connection } = open(fake, { staleMs: 30 });
    const first = await fake.next(1);
    first.push(ready({ version: 1 }));

    const second = await fake.next(2);
    expect(first.init.signal?.aborted).toBe(true);
    second.push(ready({ version: 1 }));
    await settle();
    expect(connection.state).toBe('live');
  });

  it('lets go of everything on close', async () => {
    const fake = server(['stream']);
    const { connection, events } = open(fake);
    const stream = await fake.next(1);
    stream.push(ready({ version: 1 }));
    await settle();

    connection.close();
    await settle();
    expect(stream.init.signal?.aborted).toBe(true);
    expect(connection.state).toBe('closed');
    await settle();
    expect(fake.opened).toHaveLength(1);
    expect(events).toEqual([{ type: 'ready', version: 1, unread: null, reconnected: false }]);
  });
});
