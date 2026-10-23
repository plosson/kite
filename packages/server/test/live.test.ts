/**
 * The live change stream: GET /api/artifacts/:id/events.
 *
 * What it must get right, in the order a reader of this file would worry:
 * nobody hears about a document they may not read, not at the start and not
 * after their access goes; nothing about one document reaches a listener of
 * another; every write anybody can make is heard by everybody listening; and
 * a stream that ends leaves nothing behind.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { artifacts } from '../src/db/schema.js';
import {
  createTestServer,
  jsonBody,
  signIn,
  signInCodeFor,
  TEST_DESCRIBED,
  type PublishedArtifact,
  type SignedInUser,
  type TestServer,
} from './helpers/server.js';

/** Short, so the heartbeat tests do not wait 25 seconds. Nothing else depends on it. */
const HEARTBEAT_MS = 40;

let server: TestServer;
let owner: SignedInUser;
let colleague: SignedInUser;
let stranger: SignedInUser;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' }, { heartbeatMs: HEARTBEAT_MS });
  owner = await signIn(server, 'owner@example.com');
  colleague = await signIn(server, 'colleague@example.com');
  stranger = await signIn(server, 'stranger@example.com');
});

afterEach(() => {
  server.close();
});

const BOARD = {
  nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'Secret plan' }],
  edges: [],
};

const publishBoard = () => owner.publish({ type: 'canvas', content: JSON.stringify(BOARD) });

const shareWithColleague = (artifact: PublishedArtifact) =>
  owner.as(`/api/artifacts/${artifact.id}/sharing/people`, jsonBody({ email: colleague.email }));

const addNode = (artifact: PublishedArtifact, baseVersion: number, text: string, headers: Record<string, string> = {}) =>
  owner.as(`/api/artifacts/${artifact.id}/canvas/ops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ baseVersion, ops: [{ op: 'add', node: { type: 'text', text, width: 200, height: 80 } }] }),
  });

async function cliToken(email: string): Promise<string> {
  await server.request('/api/auth/code', jsonBody({ email }));
  const response = await server.request(
    '/api/auth/cli-token',
    jsonBody({ email, code: signInCodeFor(server, email) }),
  );
  return ((await response.json()) as { token: string }).token;
}

// ---------------------------------------------------------------------------
// Reading a stream
// ---------------------------------------------------------------------------

interface StreamEvent {
  event: string;
  data: Record<string, unknown> | null;
}

interface Listening {
  response: Response;
  /** The next event, heartbeats skipped. Null once the stream has ended. */
  next: () => Promise<StreamEvent | null>;
  /** The next thing at all, heartbeat comments included (as event ":"). */
  nextRaw: (deadline?: number) => Promise<StreamEvent | null>;
  stop: () => Promise<void>;
}

/** Long enough for anything in-process; a hang fails the test instead of the run. */
const WAIT_MS = 2_000;

function reading(response: Response): Listening {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;

  const nextRaw = async (deadline = Date.now() + WAIT_MS): Promise<StreamEvent | null> => {
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        return parseBlock(block);
      }
      if (ended) return null;
      const chunk = await within(reader.read(), deadline - Date.now());
      if (chunk.done) {
        ended = true;
        continue;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  const next = async (): Promise<StreamEvent | null> => {
    // One deadline for the lot: heartbeats arriving must not keep a test
    // waiting for an event that is never coming.
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const event = await nextRaw(deadline);
      if (event === null || event.event !== ':') return event;
    }
  };

  return { response, next, nextRaw, stop: () => reader.cancel() };
}

function parseBlock(block: string): StreamEvent {
  if (block.startsWith(':')) return { event: ':', data: null };
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice('event: '.length);
    else if (line.startsWith('data: ')) data.push(line.slice('data: '.length));
  }
  return { event, data: data.length ? (JSON.parse(data.join('\n')) as Record<string, unknown>) : null };
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('nothing arrived in time')), Math.max(ms, 0));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Opens a stream as somebody (or nobody) and reads past `ready`. */
async function listen(
  as: SignedInUser | null,
  artifact: PublishedArtifact,
  clientId?: string,
): Promise<Listening & { ready: StreamEvent }> {
  const path = `/api/artifacts/${artifact.id}/events`;
  const init = clientId ? { headers: { 'X-Kite-Client': clientId } } : {};
  const response = as ? await as.as(path, init) : await server.request(path, init);
  expect(response.status).toBe(200);
  const stream = reading(response);
  const ready = await stream.next();
  expect(ready?.event).toBe('ready');
  return { ...stream, ready: ready! };
}

/** Lets aborts and their clean-up run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// ---------------------------------------------------------------------------

describe('who may listen', () => {
  it('refuses anybody who may not read the document, exactly as reading it does', async () => {
    const artifact = await publishBoard();

    expect((await server.request(`/api/artifacts/${artifact.id}/events`)).status).toBe(404);
    expect((await stranger.as(`/api/artifacts/${artifact.id}/events`)).status).toBe(404);
    expect((await owner.as('/api/artifacts/art_nope/events')).status).toBe(404);
    expect(server.changes.listenerCount()).toBe(0);
  });

  it('lets in the owner, somebody it is shared with, and anybody when it is public', async () => {
    const artifact = await publishBoard();
    await shareWithColleague(artifact);

    const asOwner = await listen(owner, artifact);
    const asColleague = await listen(colleague, artifact);
    await owner.as(`/api/artifacts/${artifact.id}/sharing/public`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublic: true }),
    });
    const asAnybody = await listen(null, artifact);

    expect(asOwner.ready.data).toEqual({ version: 1 });
    expect(asColleague.ready.data).toEqual({ version: 1 });
    expect(asAnybody.ready.data).toEqual({ version: 1 });
    expect(server.changes.listenerCount(artifact.id)).toBe(3);
  });

  it('refuses an expired link with 410, as reading does', async () => {
    const artifact = await publishBoard();
    await shareWithColleague(artifact);
    expire(artifact);

    const response = await colleague.as(`/api/artifacts/${artifact.id}/events`);
    expect(response.status).toBe(410);
  });

  it('refuses a malformed client id', async () => {
    const artifact = await publishBoard();
    const response = await owner.as(`/api/artifacts/${artifact.id}/events`, {
      headers: { 'X-Kite-Client': 'no spaces' },
    });
    expect(response.status).toBe(400);
  });

  it('is sent so that no proxy holds it back', async () => {
    const artifact = await publishBoard();
    const { response } = await listen(owner, artifact);

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
  });
});

describe('hearing about changes', () => {
  it('tells everybody listening about a new version, and nothing of what is in it', async () => {
    const artifact = await publishBoard();
    await shareWithColleague(artifact);
    const asOwner = await listen(owner, artifact);
    const asColleague = await listen(colleague, artifact);

    expect((await addNode(artifact, 1, 'Even more secret')).status).toBe(200);

    for (const stream of [asOwner, asColleague]) {
      const event = await stream.next();
      expect(event).toEqual({ event: 'change', data: { kind: 'content', version: 2, via: 'browser', self: false } });
    }
  });

  it('marks a change as the listening tab’s own only for that tab', async () => {
    const artifact = await publishBoard();
    const thisTab = await listen(owner, artifact, 'tab-one-1234');
    const otherTab = await listen(owner, artifact, 'tab-two-1234');

    await addNode(artifact, 1, 'From tab one', { 'X-Kite-Client': 'tab-one-1234' });

    expect((await thisTab.next())?.data).toMatchObject({ version: 2, self: true });
    expect((await otherTab.next())?.data).toMatchObject({ version: 2, self: false });
  });

  it('never marks somebody else’s change as yours, whatever client id they send', async () => {
    const artifact = await publishBoard();
    await shareWithColleague(artifact);
    const asColleague = await listen(colleague, artifact, 'colleague-tab');

    await addNode(artifact, 1, 'Owner borrowing an id', { 'X-Kite-Client': 'colleague-tab' });

    expect((await asColleague.next())?.data).toMatchObject({ version: 2, self: false });
  });

  it('says a write with a token came from an agent', async () => {
    const artifact = await publishBoard();
    const stream = await listen(owner, artifact);
    const token = await cliToken(owner.email);

    await server.request(`/api/artifacts/${artifact.id}/canvas/ops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ baseVersion: 1, ops: [{ op: 'add', node: { type: 'text', text: 'From an agent', width: 200, height: 80 } }] }),
    });

    expect((await stream.next())?.data).toEqual({ kind: 'content', version: 2, via: 'agent', self: false });
  });

  it('hears a replacement, a retitle and every kind of comment', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Plan\n\nShip it.' });
    await shareWithColleague(artifact);
    const stream = await listen(owner, artifact);

    await owner.as(`/api/artifacts/${artifact.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# Plan\n\nShip it today.', baseVersion: 1 }),
    });
    expect((await stream.next())?.data).toMatchObject({ kind: 'content', version: 2 });

    await owner.as(`/api/artifacts/${artifact.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'The plan' }),
    });
    expect((await stream.next())?.data).toMatchObject({ kind: 'details', version: 2 });

    const started = await colleague.as(`/api/artifacts/${artifact.id}/comments`, jsonBody({ body: 'Why today?' }));
    const thread = (await started.json()) as { id: string; comments: { id: string }[] };
    expect((await stream.next())?.data).toEqual({ kind: 'comments', via: 'browser', self: false });

    const replied = await owner.as(`/api/comments/threads/${thread.id}/replies`, jsonBody({ body: 'Because.' }));
    const reply = (await replied.json()) as { id: string };
    expect((await stream.next())?.data).toMatchObject({ kind: 'comments' });

    await owner.as(`/api/comments/${reply.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Because it is ready.' }),
    });
    expect((await stream.next())?.data).toMatchObject({ kind: 'comments' });

    await owner.as(`/api/comments/threads/${thread.id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });
    expect((await stream.next())?.data).toMatchObject({ kind: 'comments' });

    await owner.as(`/api/comments/${reply.id}`, { method: 'DELETE' });
    expect((await stream.next())?.data).toMatchObject({ kind: 'comments' });
  });

  it('hears what an agent does over MCP', async () => {
    const connected = await owner.as('/api/auth/mcp-tokens', jsonBody({ label: 'Claude' }));
    const { token } = (await connected.json()) as { token: string };
    const call = (name: string, args: Record<string, unknown>) =>
      server.request('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }).then(async (response) => ((await response.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text);

    const published = await call('publish_artifact', { ...TEST_DESCRIBED, content: '# Notes', format: 'markdown' });
    const id = /artifact_id: (\S+)/.exec(published)![1]!;
    const stream = await listen(owner, { id } as PublishedArtifact);

    await call('update_artifact', { artifact_id: id, content: '# Notes, revised', base_version: 1 });
    expect((await stream.next())?.data).toEqual({ kind: 'content', version: 2, via: 'agent', self: false });

    await call('describe_artifact', { artifact_id: id, title: 'Revised notes' });
    expect((await stream.next())?.data).toMatchObject({ kind: 'details', via: 'agent' });
  });

  it('keeps every document’s changes to that document’s listeners', async () => {
    const watched = await publishBoard();
    const other = await publishBoard();
    const stream = await listen(owner, watched);

    await addNode(other, 1, 'Somewhere else');
    await addNode(watched, 1, 'Here');

    // The first thing heard is the watched document's own change: the other
    // document's came first and never arrived.
    expect((await stream.next())?.data).toMatchObject({ kind: 'content', version: 2 });
    expect(server.changes.listenerCount(other.id)).toBe(0);
  });

  it('starts every connection with the version as it is now, so a reconnecting page can catch up', async () => {
    const artifact = await publishBoard();
    await addNode(artifact, 1, 'While nobody was listening');
    await addNode(artifact, 2, 'Still nobody');

    const stream = await listen(owner, artifact);
    expect(stream.ready.data).toEqual({ version: 3 });
  });
});

describe('when listening has to stop', () => {
  it('tells a listener whose share was removed, ends their stream, and leaves the owner’s alone', async () => {
    const artifact = await publishBoard();
    await shareWithColleague(artifact);
    const asOwner = await listen(owner, artifact);
    const asColleague = await listen(colleague, artifact);

    await owner.as(`/api/artifacts/${artifact.id}/sharing/people/${encodeURIComponent(colleague.email)}`, {
      method: 'DELETE',
    });

    expect(await asColleague.next()).toEqual({ event: 'gone', data: { reason: 'no-access' } });
    expect(await asColleague.next()).toBeNull();

    await addNode(artifact, 1, 'Only the owner hears this');
    expect((await asOwner.next())?.data).toMatchObject({ version: 2 });
    expect(server.changes.listenerCount(artifact.id)).toBe(1);
  });

  it('ends anybody’s stream when a public link is turned off', async () => {
    const artifact = await publishBoard();
    const setPublic = (isPublic: boolean) =>
      owner.as(`/api/artifacts/${artifact.id}/sharing/public`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPublic }),
      });
    await setPublic(true);
    const asAnybody = await listen(null, artifact);

    await setPublic(false);

    expect(await asAnybody.next()).toEqual({ event: 'gone', data: { reason: 'no-access' } });
    expect(await asAnybody.next()).toBeNull();
  });

  it('stops listening for somebody who signs out', async () => {
    const artifact = await publishBoard();
    await shareWithColleague(artifact);
    const asColleague = await listen(colleague, artifact);

    await colleague.as('/api/auth/sign-out', { method: 'POST' });
    await addNode(artifact, 1, 'After they left');

    expect(await asColleague.next()).toEqual({ event: 'gone', data: { reason: 'no-access' } });
  });

  it('notices a link that expired with nobody writing, at the next heartbeat', async () => {
    const artifact = await publishBoard();
    await shareWithColleague(artifact);
    const asColleague = await listen(colleague, artifact);
    const asOwner = await listen(owner, artifact);

    expire(artifact);

    expect(await asColleague.next()).toEqual({ event: 'gone', data: { reason: 'expired' } });
    // The owner is never locked out by the clock.
    expect((await asOwner.nextRaw())?.event).toBe(':');
    expect(server.changes.listenerCount(artifact.id)).toBe(1);
  });

  it('says a deleted document is gone, and closes', async () => {
    const artifact = await publishBoard();
    await shareWithColleague(artifact);
    const asColleague = await listen(colleague, artifact);

    await owner.as(`/api/artifacts/${artifact.id}?confirm=true`, { method: 'DELETE' });

    expect(await asColleague.next()).toEqual({ event: 'gone', data: { reason: 'deleted' } });
    expect(await asColleague.next()).toBeNull();
    expect(server.changes.listenerCount()).toBe(0);
  });
});

describe('keeping the line open, and letting it go', () => {
  it('sends a heartbeat while nothing happens', async () => {
    const artifact = await publishBoard();
    const stream = await listen(owner, artifact);

    expect((await stream.nextRaw())?.event).toBe(':');
    expect((await stream.nextRaw())?.event).toBe(':');
  });

  it('forgets a listener who goes away', async () => {
    const artifact = await publishBoard();
    const first = await listen(owner, artifact);
    const second = await listen(owner, artifact);
    expect(server.changes.listenerCount(artifact.id)).toBe(2);

    await first.stop();
    await settle();
    expect(server.changes.listenerCount(artifact.id)).toBe(1);

    await second.stop();
    await settle();
    expect(server.changes.listenerCount()).toBe(0);

    // And a write afterwards has nobody to tell and nothing to trip over.
    expect((await addNode(artifact, 1, 'Into the void')).status).toBe(200);
  });

  it('closes every stream when the server stops, so it can', async () => {
    const artifact = await publishBoard();
    const stream = await listen(owner, artifact);

    server.changes.close();

    expect(await stream.next()).toBeNull();
    expect(server.changes.listenerCount()).toBe(0);
  });
});

/** Puts the link's deadline in the past, as time passing would. */
function expire(artifact: PublishedArtifact): void {
  server.database.db
    .update(artifacts)
    .set({ expiresAt: '2000-01-01T00:00:00.000Z' })
    .where(eq(artifacts.id, artifact.id))
    .run();
}
