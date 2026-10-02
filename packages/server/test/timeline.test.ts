import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createTestServer,
  jsonBody,
  signIn,
  type PublishedArtifact,
  type SignedInUser,
  type TestServer,
} from './helpers/server.js';
import { artifacts, artifactVersions } from '../src/db/schema.js';
import type { TimelineEvent } from '@open-artifact/shared';

/**
 * The timeline: when everything in a person's sidebar was published and
 * edited.
 *
 * It is a second way of listing documents, so it has to keep the same secret
 * the listings keep. Most of what follows is about the documents it must never
 * mention, and the one thing it must never carry: their content.
 */

let server: TestServer;
let owner: SignedInUser;
let reader: SignedInUser;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  reader = await signIn(server, 'reader@example.com');
});

afterEach(() => {
  server.close();
});

async function timeline(as: SignedInUser, query = ''): Promise<TimelineEvent[]> {
  const response = await as.as(`/api/timeline${query}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { events: TimelineEvent[] }).events;
}

function edit(doc: PublishedArtifact, baseVersion: number, content: string): Promise<Response> {
  return owner.as(`/api/artifacts/${doc.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, baseVersion }),
  });
}

/** Moves a version's timestamp, so ordering is tested on times rather than on insert order. */
function stamp(id: string, version: number, at: string): void {
  server.database.raw
    .prepare('UPDATE artifact_versions SET created_at = ? WHERE artifact_id = ? AND version = ?')
    .run(at, id, version);
}

function share(doc: PublishedArtifact, email: string): Promise<Response> {
  return owner.as(`/api/artifacts/${doc.id}/sharing/people`, jsonBody({ email }));
}

describe('what the timeline shows', () => {
  it('a publish, then each edit, newest first, with the version each made', async () => {
    const doc = await owner.publish({ type: 'markdown', content: '# Plan' });
    await edit(doc, 1, '# Plan v2');
    await edit(doc, 2, '# Plan v3');
    stamp(doc.id, 1, '2026-01-01T09:00:00.000Z');
    stamp(doc.id, 2, '2026-01-01T10:00:00.000Z');
    stamp(doc.id, 3, '2026-01-03T08:00:00.000Z');

    const events = await timeline(owner);
    expect(events.map((event) => [event.kind, event.version, event.at])).toEqual([
      ['edited', 3, '2026-01-03T08:00:00.000Z'],
      ['edited', 2, '2026-01-01T10:00:00.000Z'],
      ['published', 1, '2026-01-01T09:00:00.000Z'],
    ]);
  });

  it('interleaves documents by time, not by document', async () => {
    const a = await owner.publish({ type: 'markdown', content: '# A' });
    const b = await owner.publish({ type: 'html', content: '<h1>B</h1>' });
    await edit(a, 1, '# A\n\nMore.');
    stamp(a.id, 1, '2026-01-01T09:00:00.000Z');
    stamp(b.id, 1, '2026-01-01T10:00:00.000Z');
    stamp(a.id, 2, '2026-01-01T11:00:00.000Z');

    const events = await timeline(owner);
    expect(events.map((event) => `${event.title} v${event.version}`)).toEqual(['A v2', 'B v1', 'A v1']);
    expect(events.find((event) => event.artifactId === b.id)?.type).toBe('html');
  });

  it('names a document by its title now, even on events from before a rename', async () => {
    const doc = await owner.publish({ type: 'markdown', content: '# Draft' });
    await owner.as(`/api/artifacts/${doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Launch plan' }),
    });
    expect((await timeline(owner)).map((event) => event.title)).toEqual(['Launch plan']);
  });

  it('does not count a change of title, description or summary as an event', async () => {
    const doc = await owner.publish({ type: 'markdown', content: '# Draft' });
    await owner.as(`/api/artifacts/${doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'T', description: 'D.', summary: 'S.' }),
    });
    expect(await timeline(owner)).toHaveLength(1);
  });

  it('never carries content, not even the current version\'s', async () => {
    await owner.publish({ type: 'markdown', content: '# Plan\n\nThe secret ingredient is paprika.' });
    const raw = await (await owner.as('/api/timeline')).text();
    expect(raw).not.toContain('paprika');
    expect(Object.keys(JSON.parse(raw).events[0]).sort()).toEqual(
      ['artifactId', 'at', 'kind', 'slug', 'title', 'type', 'version'],
    );
  });

  it('is empty, not an error, for somebody with nothing', async () => {
    expect(await timeline(reader)).toEqual([]);
  });
});

describe('what the timeline never shows', () => {
  it('somebody else\'s document that was never shared', async () => {
    await owner.publish({ type: 'markdown', content: '# Private' });
    expect(await timeline(reader)).toEqual([]);
  });

  it('a public document the reader merely could open, but which is not in their sidebar', async () => {
    const doc = await owner.publish({ type: 'markdown', content: '# Public' });
    await owner.as(`/api/artifacts/${doc.id}/sharing/public`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublic: true }),
    });
    expect(await timeline(reader)).toEqual([]);
  });

  it('a shared document once it is unshared, including its old events', async () => {
    const doc = await owner.publish({ type: 'markdown', content: '# Shared' });
    await share(doc, reader.email);
    await edit(doc, 1, '# Shared v2');
    expect(await timeline(reader)).toHaveLength(2);

    await owner.as(`/api/artifacts/${doc.id}/sharing/people/${encodeURIComponent(reader.email)}`, { method: 'DELETE' });
    expect(await timeline(reader)).toEqual([]);
  });

  it('a shared document whose link has expired', async () => {
    const doc = await owner.publish({ type: 'markdown', content: '# Shared' });
    await share(doc, reader.email);
    server.database.db
      .update(artifacts)
      .set({ expiresAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(artifacts.id, doc.id))
      .run();
    expect(await timeline(reader)).toEqual([]);
    // The owner is never subject to expiry, so their own timeline keeps it.
    expect(await timeline(owner)).toHaveLength(1);
  });

  it('a deleted document', async () => {
    const doc = await owner.publish({ type: 'markdown', content: '# Gone' });
    await owner.as(`/api/artifacts/${doc.id}?confirm=true`, { method: 'DELETE' });
    expect(await timeline(owner)).toEqual([]);
    expect(server.database.db.select().from(artifactVersions).all()).toHaveLength(0);
  });

  it('anything at all to somebody signed out', async () => {
    await owner.publish({ type: 'markdown', content: '# Plan' });
    expect((await server.request('/api/timeline')).status).toBe(401);
  });
});

describe('how much one request returns', () => {
  beforeEach(async () => {
    const doc = await owner.publish({ type: 'markdown', content: '# v1' });
    for (let version = 1; version < 5; version += 1) await edit(doc, version, `# v${version + 1}`);
  });

  it('honours a limit, keeping the newest', async () => {
    const events = await timeline(owner, '?limit=2');
    expect(events.map((event) => event.version)).toEqual([5, 4]);
  });

  it('caps a limit above the most rather than refusing it', async () => {
    expect(await timeline(owner, '?limit=999999')).toHaveLength(5);
  });

  for (const bad of ['0', '-3', 'abc', '2.5', '', '1e3']) {
    it(`refuses limit=${JSON.stringify(bad)}`, async () => {
      const response = await owner.as(`/api/timeline?limit=${encodeURIComponent(bad)}`);
      expect(response.status).toBe(400);
    });
  }
});
