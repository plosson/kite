/**
 * The live stream, GET /api/events: one per tab, carrying the person's
 * notifications and one document's changes.
 *
 * What it must get right, in the order a reader of this file would worry:
 * nobody hears about a document they may not read, not at the start and not
 * after their access goes; nobody hears about anybody else's notifications;
 * nothing about one document reaches a listener of another; every write
 * anybody can make is heard by everybody listening; losing one thing a stream
 * follows does not lose the other; a stream that ends leaves nothing behind;
 * and nobody can open streams without limit.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { artifacts } from '../src/db/schema.js';
import { topics } from '../src/live/feed.js';
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

/** The stream's address, following a document or nothing but the person. */
const eventsPath = (artifact?: { id: string } | null) =>
  artifact ? `/api/events?artifact=${encodeURIComponent(artifact.id)}` : '/api/events';

function open(as: SignedInUser | null, path: string, clientId?: string): Promise<Response> {
  const init = clientId ? { headers: { 'X-Kite-Client': clientId } } : {};
  return as ? as.as(path, init) : server.request(path, init);
}

/** Opens a stream as somebody (or nobody) and reads past `ready`. Null follows no document. */
async function listen(
  as: SignedInUser | null,
  artifact: { id: string } | null,
  clientId?: string,
): Promise<Listening & { ready: StreamEvent }> {
  const response = await open(as, eventsPath(artifact), clientId);
  expect(response.status).toBe(200);
  const stream = reading(response);
  const ready = await stream.next();
  expect(ready?.event).toBe('ready');
  return { ...stream, ready: ready! };
}

/** Listeners of one document. */
const followers = (artifact: { id: string }) => server.changes.listenerCount(topics.artifact(artifact.id));

/** Lets aborts and their clean-up run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// ---------------------------------------------------------------------------

describe('who may listen', () => {
  it('never follows a document for anybody who may not read it, and says so as it says no such document', async () => {
    const artifact = await publishBoard();

    // Nobody signed in has nothing else to follow: told, and the stream ends.
    const asNobody = await listen(null, artifact);
    expect(asNobody.ready.data).toEqual({});
    expect(await asNobody.next()).toEqual({ event: 'gone', data: { reason: 'no-access' } });
    expect(await asNobody.next()).toBeNull();

    // Somebody signed in keeps their notifications.
    const asStranger = await listen(stranger, artifact);
    const nothingThere = await listen(stranger, { id: 'art_nope' });
    for (const stream of [asStranger, nothingThere]) {
      expect(stream.ready.data).toEqual({ unread: 0 });
      expect(await stream.next()).toEqual({ event: 'gone', data: { reason: 'no-access' } });
      expect((await stream.nextRaw())?.event).toBe(':');
    }

    expect(followers(artifact)).toBe(0);
    await addNode(artifact, 1, 'Not for them');
    expect((await asStranger.nextRaw())?.event).toBe(':');
  });

  it('finds the document by its slug, the way the page names it', async () => {
    const artifact = await publishBoard();
    const stream = await listen(owner, artifact);
    const bySlug = reading(await owner.as(`/api/events?slug=${artifact.slug}`));

    expect((await bySlug.next())?.data).toEqual(stream.ready.data);
    expect(followers(artifact)).toBe(2);
    expect((await owner.as(`/api/events?slug=${artifact.slug}&artifact=${artifact.id}`)).status).toBe(400);
  });

  it('needs somebody signed in, or a document, to follow anything', async () => {
    expect((await server.request('/api/events')).status).toBe(401);

    const justMe = await listen(owner, null);
    expect(justMe.ready.data).toEqual({ unread: 0 });
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

    expect(asOwner.ready.data).toEqual({ version: 1, unread: 0 });
    expect(asColleague.ready.data).toMatchObject({ version: 1 });
    expect(asAnybody.ready.data).toEqual({ version: 1 });
    expect(followers(artifact)).toBe(3);
  });

  it('says an expired link has expired, as reading does', async () => {
    const artifact = await publishBoard();
    await shareWithColleague(artifact);
    expire(artifact);

    const stream = await listen(colleague, artifact);
    expect(await stream.next()).toEqual({ event: 'gone', data: { reason: 'expired' } });
    expect(followers(artifact)).toBe(0);
  });

  it('refuses a malformed client id', async () => {
    const artifact = await publishBoard();
    const response = await owner.as(eventsPath(artifact), {
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
    expect(followers(other)).toBe(0);
  });

  it('starts every connection with the version as it is now, so a reconnecting page can catch up', async () => {
    const artifact = await publishBoard();
    await addNode(artifact, 1, 'While nobody was listening');
    await addNode(artifact, 2, 'Still nobody');

    const stream = await listen(owner, artifact);
    expect(stream.ready.data).toMatchObject({ version: 3 });
  });
});

describe('when listening has to stop', () => {
  it('tells a listener whose share was removed, stops following it for them, and leaves the owner’s alone', async () => {
    const artifact = await publishBoard();
    await shareWithColleague(artifact);
    const asOwner = await listen(owner, artifact);
    const asColleague = await listen(colleague, artifact);

    await owner.as(`/api/artifacts/${artifact.id}/sharing/people/${encodeURIComponent(colleague.email)}`, {
      method: 'DELETE',
    });

    expect(await asColleague.next()).toEqual({ event: 'gone', data: { reason: 'no-access' } });

    await addNode(artifact, 1, 'Only the owner hears this');
    expect((await asOwner.next())?.data).toMatchObject({ version: 2 });
    expect(followers(artifact)).toBe(1);
    // Still there for their own notifications.
    expect((await asColleague.nextRaw())?.event).toBe(':');
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

  it('stops following everything for somebody who signs out, and ends', async () => {
    const artifact = await publishBoard();
    await shareWithColleague(artifact);
    const asColleague = await listen(colleague, artifact);

    await colleague.as('/api/auth/sign-out', { method: 'POST' });
    await addNode(artifact, 1, 'After they left');

    expect(await asColleague.next()).toEqual({ event: 'signed-out', data: {} });
    expect(await asColleague.next()).toEqual({ event: 'gone', data: { reason: 'no-access' } });
    expect(await asColleague.next()).toBeNull();
    expect(server.changes.listenerCount()).toBe(0);
  });

  it('keeps following a public document as anybody for somebody who signs out', async () => {
    const artifact = await publishBoard();
    await owner.as(`/api/artifacts/${artifact.id}/sharing/public`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublic: true }),
    });
    const asColleague = await listen(colleague, artifact);

    await colleague.as('/api/auth/sign-out', { method: 'POST' });
    await addNode(artifact, 1, 'Still public');

    expect(await asColleague.next()).toEqual({ event: 'signed-out', data: {} });
    expect((await asColleague.next())?.data).toMatchObject({ kind: 'content', version: 2 });
    expect(server.changes.listenerCount(topics.user(colleague.id))).toBe(0);
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
    expect(followers(artifact)).toBe(1);
  });

  it('says a deleted document is gone, and closes once nothing else is followed', async () => {
    const artifact = await publishBoard();
    await shareWithColleague(artifact);
    await owner.as(`/api/artifacts/${artifact.id}/sharing/public`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublic: true }),
    });
    const asColleague = await listen(colleague, artifact);
    const asAnybody = await listen(null, artifact);

    await owner.as(`/api/artifacts/${artifact.id}?confirm=true`, { method: 'DELETE' });

    expect(await asColleague.next()).toEqual({ event: 'gone', data: { reason: 'deleted' } });
    expect(await asAnybody.next()).toEqual({ event: 'gone', data: { reason: 'deleted' } });
    expect(await asAnybody.next()).toBeNull();
    expect(followers(artifact)).toBe(0);
    expect((await asColleague.nextRaw())?.event).toBe(':');
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
    expect(followers(artifact)).toBe(2);
    expect(server.streams.count({ userId: owner.id })).toBe(2);

    await first.stop();
    await settle();
    expect(followers(artifact)).toBe(1);

    await second.stop();
    await settle();
    expect(server.changes.listenerCount()).toBe(0);
    expect(server.streams.count()).toBe(0);

    // And a write afterwards has nobody to tell and nothing to trip over.
    expect((await addNode(artifact, 1, 'Into the void')).status).toBe(200);
  });

  it('closes every stream when the server stops, so it can', async () => {
    const artifact = await publishBoard();
    const stream = await listen(owner, artifact);

    server.changes.close();

    expect(await stream.next()).toBeNull();
    expect(server.changes.listenerCount()).toBe(0);
    await settle();
    expect(server.streams.count()).toBe(0);
  });
});

describe('notifications', () => {
  const comment = (as: SignedInUser, artifact: PublishedArtifact, body: string) =>
    as.as(`/api/artifacts/${artifact.id}/comments`, jsonBody({ body }));

  it('tells somebody the moment something lands in their bell, with the count and nothing else', async () => {
    const artifact = await publishBoard();
    const asColleague = await listen(colleague, null);
    const asStranger = await listen(stranger, null);
    const asOwner = await listen(owner, null);

    await shareWithColleague(artifact);

    expect(await asColleague.next()).toEqual({ event: 'notifications', data: { unread: 1, self: false } });
    // Nobody else's bell moved, so nobody else hears a thing.
    expect((await asStranger.nextRaw())?.event).toBe(':');
    expect((await asOwner.nextRaw())?.event).toBe(':');
  });

  it('arrives on the same stream as the document being read', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Plan' });
    await shareWithColleague(artifact);
    const asOwner = await listen(owner, artifact);

    await comment(colleague, artifact, 'Over to you, @owner@example.com');

    const heard = [await asOwner.next(), await asOwner.next()];
    expect(heard).toContainEqual({ event: 'change', data: { kind: 'comments', via: 'browser', self: false } });
    expect(heard).toContainEqual({ event: 'notifications', data: { unread: 1, self: false } });
  });

  it('marks the tab’s own reading as its own, and tells the person’s other tabs', async () => {
    const artifact = await publishBoard();
    await shareWithColleague(artifact);
    const thisTab = await listen(colleague, null, 'bell-tab-one');
    const otherTab = await listen(colleague, null, 'bell-tab-two');
    const inbox = (await (await colleague.as('/api/notifications')).json()) as { notifications: { id: string }[] };

    await colleague.as(`/api/notifications/${inbox.notifications[0]!.id}/read`, {
      method: 'POST',
      headers: { 'X-Kite-Client': 'bell-tab-one' },
    });

    expect(await thisTab.next()).toEqual({ event: 'notifications', data: { unread: 0, self: true } });
    expect(await otherTab.next()).toEqual({ event: 'notifications', data: { unread: 0, self: false } });

    // Reading what is already read changes nothing, and says nothing.
    await colleague.as('/api/notifications/read-all', { method: 'POST' });
    expect((await otherTab.nextRaw())?.event).toBe(':');
  });

  it('holds a mention back with the notification, and tells them when it is let through', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Plan' });
    await shareWithColleague(artifact);
    const asStranger = await listen(stranger, null);
    const asOwner = await listen(owner, null);

    await comment(colleague, artifact, 'This needs @stranger@example.com to look');

    // The owner is asked; the stranger is told nothing, because there is nothing they could open.
    expect(await asOwner.next()).toEqual({ event: 'notifications', data: { unread: 1, self: false } });
    expect((await asStranger.nextRaw())?.event).toBe(':');

    const requests = (await (await owner.as('/api/access-requests')).json()) as { requests: { id: string }[] };
    await owner.as(`/api/access-requests/${requests.requests[0]!.id}/decide`, {
      ...jsonBody({ grant: true }),
      headers: { 'Content-Type': 'application/json', 'X-Kite-Client': 'owner-tab-1' },
    });

    expect(await asStranger.next()).toEqual({ event: 'notifications', data: { unread: 1, self: false } });
    // The request is off the owner's list; their bell still holds the request's row.
    expect((await asOwner.next())?.event).toBe('notifications');
  });

  it('starts every connection with the count as it is now, so a reconnecting bell can catch up', async () => {
    const first = await publishBoard();
    const second = await publishBoard();
    await shareWithColleague(first);
    await shareWithColleague(second);

    expect((await listen(colleague, null)).ready.data).toEqual({ unread: 2 });
  });

  it('is never anybody else’s: a person’s topic is theirs, whatever the stream asks for', async () => {
    await listen(owner, null);
    await listen(stranger, null);

    expect(server.changes.listenerCount(topics.user(owner.id))).toBe(1);
    expect(server.changes.listenerCount(topics.user(stranger.id))).toBe(1);
    expect(server.changes.listenerCount(topics.user(colleague.id))).toBe(0);
  });
});

describe('how many may be open', () => {
  const limited = async (env: Record<string, string>) => {
    server.close();
    server = createTestServer({ SIGNUP_MODE: 'open', ...env }, { heartbeatMs: HEARTBEAT_MS });
    owner = await signIn(server, 'owner@example.com');
    colleague = await signIn(server, 'colleague@example.com');
    stranger = await signIn(server, 'stranger@example.com');
  };

  it('closes somebody’s oldest stream when they open one too many, and tells it not to come back', async () => {
    await limited({ MAX_LIVE_STREAMS_PER_USER: '2' });
    const oldest = await listen(owner, null);
    const middle = await listen(owner, null);
    const newest = await listen(owner, null);

    expect(await oldest.next()).toEqual({ event: 'replaced', data: {} });
    expect(await oldest.next()).toBeNull();
    expect(server.streams.count({ userId: owner.id })).toBe(2);
    for (const stream of [middle, newest]) expect((await stream.nextRaw())?.event).toBe(':');

    // Only ever their own: somebody else opening streams closes nothing of theirs.
    await listen(colleague, null);
    await listen(colleague, null);
    await listen(colleague, null);
    expect(server.streams.count({ userId: owner.id })).toBe(2);
  });

  it('refuses a new stream on a full document, and leaves everybody already there alone', async () => {
    await limited({ MAX_LIVE_STREAMS_PER_ARTIFACT: '2' });
    const artifact = await publishBoard();
    await shareWithColleague(artifact);
    await owner.as(`/api/artifacts/${artifact.id}/sharing/public`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublic: true }),
    });
    const asOwner = await listen(owner, artifact);
    const asColleague = await listen(colleague, artifact);

    const refused = await server.request(eventsPath(artifact));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('30');
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('rate_limited');

    expect(followers(artifact)).toBe(2);
    for (const stream of [asOwner, asColleague]) expect((await stream.nextRaw())?.event).toBe(':');
    // Following something else is still fine.
    await listen(stranger, null);
  });

  it('refuses anything past the total, whoever asks', async () => {
    await limited({ MAX_LIVE_STREAMS: '2' });
    await listen(owner, null);
    await listen(colleague, null);

    expect((await stranger.as(eventsPath(null))).status).toBe(429);
    expect(server.streams.count()).toBe(2);
  });

  it('never closes somebody’s stream to make room for one that is then refused', async () => {
    await limited({ MAX_LIVE_STREAMS_PER_USER: '1', MAX_LIVE_STREAMS_PER_ARTIFACT: '1' });
    const artifact = await publishBoard();
    await shareWithColleague(artifact);
    await listen(colleague, artifact);
    const ownersOnly = await listen(owner, null);

    expect((await owner.as(eventsPath(artifact))).status).toBe(429);
    expect((await ownersOnly.nextRaw())?.event).toBe(':');
    expect(server.streams.count({ userId: owner.id })).toBe(1);
  });

  it('counts a stream that ends as gone, so its room comes back', async () => {
    await limited({ MAX_LIVE_STREAMS: '1' });
    const only = await listen(owner, null);
    expect((await colleague.as(eventsPath(null))).status).toBe(429);

    await only.stop();
    await settle();

    await listen(colleague, null);
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
