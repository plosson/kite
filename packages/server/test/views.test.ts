import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { ArtifactViewsResponse, ViewsSummaryResponse, ArtifactSummary } from '@open-artifact/shared';
import {
  createTestServer,
  jsonBody,
  signIn,
  type PublishedArtifact,
  type SignedInUser,
  type TestServer,
} from './helpers/server.js';
import { ViewService } from '../src/views/service.js';

/**
 * Who opened a document, as its owner sees it.
 *
 * The number that matters is people other than the owner opening it in a
 * browser. Everything else that reads a document, the owner's own tab and an
 * agent checking its work, is recorded beside that number, never inside it.
 * And none of it is anybody's business but the owner's.
 */

let server: TestServer;
let owner: SignedInUser;
let reader: SignedInUser;
let doc: PublishedArtifact;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  reader = await signIn(server, 'reader@example.com');
  doc = await owner.publish({ type: 'markdown', content: '# Plan', title: 'Plan' });
});

afterEach(() => {
  server.close();
});

const open = (user: SignedInUser | null, headers: Record<string, string> = {}) =>
  user
    ? user.as(`/api/artifacts/by-slug/${doc.slug}`, { headers })
    : server.request(`/api/artifacts/by-slug/${doc.slug}`, { headers });

async function viewsOf(user: SignedInUser = owner, id = doc.id): Promise<ArtifactViewsResponse> {
  const response = await user.as(`/api/artifacts/${id}/views`);
  expect(response.status).toBe(200);
  return (await response.json()) as ArtifactViewsResponse;
}

async function shareWith(email: string): Promise<void> {
  const response = await owner.as(`/api/artifacts/${doc.id}/sharing/people`, jsonBody({ email }));
  expect(response.ok).toBe(true);
}

async function makePublic(): Promise<void> {
  const response = await owner.as(`/api/artifacts/${doc.id}/sharing/public`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isPublic: true }),
  });
  expect(response.ok).toBe(true);
}

async function update(content: string, baseVersion: number): Promise<void> {
  const response = await owner.as(`/api/artifacts/${doc.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, baseVersion }),
  });
  expect(response.ok).toBe(true);
}

/** Signs a command line in, the way agentio does. */
async function tokenFor(user: SignedInUser): Promise<string> {
  const started = (await (
    await server.request('/api/auth/device', jsonBody({ label: 'agentio' }))
  ).json()) as { deviceCode: string; userCode: string };
  await user.as('/api/auth/device/approve', jsonBody({ userCode: started.userCode }));
  const polled = (await (
    await server.request('/api/auth/device/token', jsonBody({ deviceCode: started.deviceCode }))
  ).json()) as { token: string };
  return polled.token;
}

describe('what counts as a view', () => {
  it('counts somebody it was shared with opening it, by their email', async () => {
    await shareWith(reader.email);
    expect((await open(reader)).status).toBe(200);

    const views = await viewsOf();
    expect(views.totals).toMatchObject({ views: 1, uniqueViewers: 1, ownerViews: 0, agentFetches: 0 });
    expect(views.viewers).toHaveLength(1);
    expect(views.viewers[0]).toMatchObject({
      viewer: { kind: 'user', email: reader.email },
      views: 1,
      access: 'shared-with-you',
      lastVersion: 1,
    });
    expect(views.lastViewedAt).not.toBeNull();
    expect(views.openedSinceLatestVersion).toBe(true);
  });

  it('keeps the owner opening their own document out of the count', async () => {
    await open(owner);
    const views = await viewsOf();
    expect(views.totals).toMatchObject({ views: 0, uniqueViewers: 0, ownerViews: 1 });
    expect(views.viewers).toHaveLength(0);
    expect(views.recent[0]).toMatchObject({ access: 'owner', client: 'browser' });
    expect(views.openedSinceLatestVersion).toBe(false);
  });

  it('counts a command-line read as an agent fetch, not a view', async () => {
    const token = await tokenFor(owner);
    const auth = { Authorization: `Bearer ${token}` };
    expect((await server.request(`/api/artifacts/${doc.id}`, { headers: auth })).status).toBe(200);
    expect((await server.request(`/api/artifacts/by-slug/${doc.slug}`, { headers: auth })).status).toBe(200);

    // Two calls for one read, as a client makes them, fold into one fetch.
    const views = await viewsOf();
    expect(views.totals).toMatchObject({ views: 0, ownerViews: 0, agentFetches: 1 });
    expect(views.recent.map((event) => event.client)).toEqual(['api']);
  });

  it('counts somebody else’s agent as an agent fetch too', async () => {
    await shareWith(reader.email);
    const token = await tokenFor(reader);
    await server.request(`/api/artifacts/${doc.id}`, { headers: { Authorization: `Bearer ${token}` } });
    expect((await viewsOf()).totals).toMatchObject({ views: 0, agentFetches: 1 });
  });

  it('does not count the web editor reading the source', async () => {
    // The editor reads by id with a cookie, after the page has counted the open.
    await owner.as(`/api/artifacts/${doc.id}`);
    await shareWith(reader.email);
    await reader.as(`/api/artifacts/${doc.id}`);
    const views = await viewsOf();
    expect(views.recent).toHaveLength(0);
  });

  it('counts the content opened straight in a tab, but not inside the page’s frame', async () => {
    await makePublic();
    await server.request(`/a/${doc.slug}/content`, { headers: { 'Sec-Fetch-Dest': 'iframe' } });
    await server.request(`/a/${doc.slug}/content`, { headers: { 'Sec-Fetch-Dest': 'empty' } });
    expect((await viewsOf()).totals.views).toBe(0);

    await server.request(`/a/${doc.slug}/content`, { headers: { 'Sec-Fetch-Dest': 'document' } });
    expect((await viewsOf()).totals.views).toBe(1);
  });

  it('records nothing when access was refused', async () => {
    expect((await open(reader)).status).toBe(404);
    expect((await open(null)).status).toBe(404);
    expect((await viewsOf()).recent).toHaveLength(0);
  });
});

describe('a reload is not a second reader', () => {
  it('folds the same reader opening the same version again into one view', async () => {
    await shareWith(reader.email);
    await open(reader);
    await open(reader);
    await open(reader);
    expect((await viewsOf()).totals.views).toBe(1);
  });

  it('counts them again once there is a new version to read', async () => {
    await shareWith(reader.email);
    await open(reader);
    await update('# Plan, revised', 1);
    await open(reader);

    const views = await viewsOf();
    expect(views.totals).toMatchObject({ views: 2, uniqueViewers: 1 });
    expect(views.viewers[0]).toMatchObject({ views: 2, lastVersion: 2 });
  });

  it('counts them again after half an hour', () => {
    let now = '2026-10-01T10:00:00.000Z';
    const service = new ViewService({ db: server.database.db, secret: 'x'.repeat(32), retentionDays: 180, now: () => now });
    const input = { artifact: doc, principal: null, access: 'public' as const, client: 'browser' as const, address: '203.0.113.9', userAgent: 'Firefox' };
    expect(service.record(input)).toBe(true);
    now = '2026-10-01T10:29:00.000Z';
    expect(service.record(input)).toBe(false);
    now = '2026-10-01T10:31:00.000Z';
    expect(service.record(input)).toBe(true);
  });
});

describe('a signed-out reader of a public link', () => {
  beforeEach(async () => {
    await makePublic();
  });

  it('is an anonymous id, told apart by address and browser', async () => {
    await open(null, { 'X-Forwarded-For': '203.0.113.9', 'User-Agent': 'Firefox' });
    await open(null, { 'X-Forwarded-For': '203.0.113.9', 'User-Agent': 'Firefox' });
    await open(null, { 'X-Forwarded-For': '198.51.100.7', 'User-Agent': 'Safari' });

    const views = await viewsOf();
    expect(views.totals).toMatchObject({ views: 2, uniqueViewers: 2, anonymousViewers: 2 });
    for (const viewer of views.viewers) {
      expect(viewer.viewer.kind).toBe('anonymous');
      expect(viewer.access).toBe('public');
    }
  });

  it('never has their address stored, or handed to the owner', async () => {
    await open(null, { 'X-Forwarded-For': '203.0.113.9', 'User-Agent': 'Firefox' });

    const rows = server.database.db.all<Record<string, unknown>>(sql`select * from artifact_views`);
    expect(rows).toHaveLength(1);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain('203.0.113.9');
    expect(stored).not.toContain('Firefox');

    const response = JSON.stringify(await viewsOf());
    expect(response).not.toContain('203.0.113.9');
    expect(response).not.toContain('Firefox');
  });

  it('is a different id on an instance with a different secret', () => {
    const input = { artifact: doc, principal: null, access: 'public' as const, client: 'browser' as const, address: '203.0.113.9', userAgent: 'Firefox' };
    const one = new ViewService({ db: server.database.db, secret: 'a'.repeat(32), retentionDays: 180 });
    const two = new ViewService({ db: server.database.db, secret: 'b'.repeat(32), retentionDays: 180 });
    one.record(input);
    two.record(input);
    const keys = server.database.db.all<{ viewer_key: string }>(sql`select viewer_key from artifact_views`);
    expect(new Set(keys.map((row) => row.viewer_key)).size).toBe(2);
  });
});

describe('who can see the record', () => {
  it('is the owner and nobody else, not even somebody it is shared with', async () => {
    await shareWith(reader.email);
    await open(reader);
    expect((await reader.as(`/api/artifacts/${doc.id}/views`)).status).toBe(404);
    expect((await server.request(`/api/artifacts/${doc.id}/views`)).status).toBe(401);
  });

  it('answers an agent signed in as the owner, so `kite views` works', async () => {
    const token = await tokenFor(owner);
    const response = await server.request(`/api/artifacts/${doc.id}/views`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('caps and checks the recent list’s limit', async () => {
    expect((await owner.as(`/api/artifacts/${doc.id}/views?limit=0`)).status).toBe(400);
    expect((await owner.as(`/api/artifacts/${doc.id}/views?limit=abc`)).status).toBe(400);
    expect((await owner.as(`/api/artifacts/${doc.id}/views?limit=100000`)).status).toBe(200);
  });

  it('shows the owner’s list the counts, and nobody else’s list any', async () => {
    await shareWith(reader.email);
    await open(reader);

    const mine = (await (await owner.as('/api/artifacts')).json()) as { artifacts: ArtifactSummary[] };
    expect(mine.artifacts[0]?.views).toMatchObject({ views: 1, uniqueViewers: 1, openedSinceLatestVersion: true });

    const shared = JSON.stringify(await (await reader.as('/api/shared-with-me')).json());
    expect(shared).not.toContain('uniqueViewers');
  });
});

describe('the account summary', () => {
  it('says which documents have a version nobody has opened', async () => {
    const other = await owner.publish({ type: 'markdown', content: '# Never read', title: 'Never read' });
    await shareWith(reader.email);
    await open(reader);
    await update('# Plan, revised', 1);

    const summary = (await (await owner.as('/api/views')).json()) as ViewsSummaryResponse;
    expect(summary.retentionDays).toBe(180);
    expect(summary.totals).toMatchObject({ documents: 2, opened: 1, neverOpened: 1, notOpenedSinceLatestVersion: 2, views: 1 });

    const plan = summary.artifacts.find((artifact) => artifact.artifactId === doc.id);
    expect(plan).toMatchObject({ version: 2, lastViewedVersion: 1, openedSinceLatestVersion: false, views: 1 });
    const never = summary.artifacts.find((artifact) => artifact.artifactId === other.id);
    expect(never).toMatchObject({ views: 0, lastViewedAt: null, openedSinceLatestVersion: false });
    expect(never?.url).toContain(other.slug);

    await open(reader);
    const after = (await (await owner.as('/api/views')).json()) as ViewsSummaryResponse;
    expect(after.totals.notOpenedSinceLatestVersion).toBe(1);
  });

  it('covers only what the caller owns', async () => {
    await reader.publish({ type: 'markdown', content: '# Theirs' });
    const summary = (await (await owner.as('/api/views')).json()) as ViewsSummaryResponse;
    expect(summary.artifacts.map((artifact) => artifact.artifactId)).toEqual([doc.id]);
  });
});

describe('how long it is kept', () => {
  it('drops records past the retention window, from reads and from the table', () => {
    let now = '2026-01-01T10:00:00.000Z';
    const service = new ViewService({ db: server.database.db, secret: 'x'.repeat(32), retentionDays: 30, now: () => now });
    service.record({ artifact: doc, principal: null, access: 'public', client: 'browser', address: '1', userAgent: 'a' });

    now = '2026-01-20T10:00:00.000Z';
    expect(service.forArtifact(doc).totals.views).toBe(1);

    now = '2026-02-15T10:00:00.000Z';
    expect(service.forArtifact(doc).totals.views).toBe(0);
    service.prune();
    expect(server.database.db.all(sql`select id from artifact_views`)).toHaveLength(0);
  });

  it('goes with the document', async () => {
    await shareWith(reader.email);
    await open(reader);
    expect((await owner.as(`/api/artifacts/${doc.id}?confirm=true`, { method: 'DELETE' })).ok).toBe(true);
    expect(server.database.db.all(sql`select id from artifact_views`)).toHaveLength(0);
  });

  it('goes with the reader’s account when they close it', async () => {
    await shareWith(reader.email);
    await open(reader);
    const closed = await reader.as('/api/auth/account?confirm=true', { method: 'DELETE' });
    expect(closed.ok).toBe(true);
    expect((await viewsOf()).totals.views).toBe(0);
  });
});

describe('the privacy policy', () => {
  it('says opens are recorded, how a signed-out reader is kept, and for how long', async () => {
    const body = await (await server.request('/privacy.md')).text();
    expect(body).toContain('When a document is opened');
    expect(body).toContain('keyed hash');
    expect(body).toContain('deleted after 180 days');
  });
});
