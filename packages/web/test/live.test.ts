import { describe, it, expect, afterEach } from 'vitest';
import { connectLive, CLIENT_ID, type LiveConnection, type LiveEvent } from '../src/live.js';

/**
 * The browser end of the live stream, against a stand-in server: what it
 * passes on, when it gives up, and when it tries again.
 */

interface Opened {
  init: RequestInit;
  push: (text: string) => void;
  end: () => void;
}

function server(answers: (number | 'stream')[]) {
  const opened: Opened[] = [];
  let waiting: ((value: Opened) => void) | null = null;
  const fetch = (async (_url: string, init: RequestInit) => {
    const answer = answers.shift() ?? 'stream';
    if (answer !== 'stream') return new Response('{}', { status: answer });
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
    /** The next stream the client opens (or the one already open, if it has not been taken). */
    next: (count: number) =>
      opened.length >= count ? Promise.resolve(opened[count - 1]!) : new Promise<Opened>((resolve) => (waiting = resolve)),
  };
}

const ready = (version: number) => `event: ready\ndata: {"version":${version}}\nretry: 2000\n\n`;
const change = (data: Record<string, unknown>) => `event: change\ndata: ${JSON.stringify(data)}\n\n`;

let connection: LiveConnection | null = null;
afterEach(() => connection?.close());

function open(fake: ReturnType<typeof server>, options: { staleMs?: number } = {}) {
  const events: LiveEvent[] = [];
  connection = connectLive('art-1', { fetch: fake.fetch, backoffMs: [5], ...options });
  connection.listen((event) => events.push(event));
  return { connection, events };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('the live stream, in the browser', () => {
  it('names the tab, passes on others’ changes, and keeps its own to itself', async () => {
    const fake = server(['stream']);
    const { connection, events } = open(fake);
    const stream = await fake.next(1);
    expect(new Headers(stream.init.headers).get('X-Kite-Client')).toBe(CLIENT_ID);

    stream.push(ready(3));
    stream.push(': ping\n\n');
    stream.push(change({ kind: 'content', version: 4, via: 'browser', self: true }));
    stream.push(change({ kind: 'comments', via: 'agent', self: false }));
    stream.push(change({ kind: 'content', version: 5, via: 'agent', self: false }));
    await settle();

    expect(connection.state).toBe('live');
    expect(connection.version).toBe(5);
    expect(events).toEqual([
      { type: 'ready', version: 3, reconnected: false },
      { type: 'change', kind: 'comments', version: null, via: 'agent' },
      { type: 'change', kind: 'content', version: 5, via: 'agent' },
    ]);
  });

  it('stops for good when the server says this reader may not follow it', async () => {
    for (const [status, reason] of [[404, 'no-access'], [410, 'expired'], [401, 'no-access']] as const) {
      const fake = server([status]);
      const { connection, events } = open(fake);
      await settle();
      expect(connection.state).toBe('closed');
      expect(events).toEqual([{ type: 'gone', reason }]);
      await settle();
      expect(fake.opened).toHaveLength(0);
    }
  });

  it('stops for good on gone, and says why', async () => {
    const fake = server(['stream']);
    const { connection, events } = open(fake);
    const stream = await fake.next(1);
    stream.push(ready(1));
    stream.push('event: gone\ndata: {"reason":"deleted"}\n\n');
    stream.end();
    await settle();

    expect(connection.state).toBe('closed');
    expect(events.at(-1)).toEqual({ type: 'gone', reason: 'deleted' });
    expect(fake.opened).toHaveLength(1);
  });

  it('tries again after a server error, and says it reconnected', async () => {
    const fake = server([503, 502, 'stream']);
    const { connection, events } = open(fake);
    expect(connection.state).toBe('connecting');
    const stream = await fake.next(1);
    stream.push(ready(7));
    await settle();

    expect(connection.state).toBe('live');
    // Never ready before, so not a reconnection: nothing was missed.
    expect(events).toEqual([{ type: 'ready', version: 7, reconnected: false }]);
  });

  it('reconnects when the stream is cut, and says so when it is back', async () => {
    const fake = server(['stream', 'stream']);
    const { connection, events } = open(fake);
    const first = await fake.next(1);
    first.push(ready(1));
    await settle();
    first.end();
    await settle();

    const second = await fake.next(2);
    second.push(ready(4));
    await settle();

    expect(connection.state).toBe('live');
    expect(events.at(-1)).toEqual({ type: 'ready', version: 4, reconnected: true });
  });

  it('gives up on a connection that went quiet, and opens another', async () => {
    const fake = server(['stream', 'stream']);
    const { connection } = open(fake, { staleMs: 30 });
    const first = await fake.next(1);
    first.push(ready(1));

    const second = await fake.next(2);
    expect(first.init.signal?.aborted).toBe(true);
    second.push(ready(1));
    await settle();
    expect(connection.state).toBe('live');
  });

  it('lets go of everything on close', async () => {
    const fake = server(['stream']);
    const { connection, events } = open(fake);
    const stream = await fake.next(1);
    stream.push(ready(1));
    await settle();

    connection.close();
    await settle();
    expect(stream.init.signal?.aborted).toBe(true);
    expect(connection.state).toBe('closed');
    await settle();
    expect(fake.opened).toHaveLength(1);
    expect(events).toEqual([{ type: 'ready', version: 1, reconnected: false }]);
  });
});
