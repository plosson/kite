import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  ArtifactVersionDetail,
  ArtifactVersionsResponse,
  ArtifactViewsResponse,
} from '@open-artifact/shared';
import {
  createTestServer,
  jsonBody,
  signIn,
  type PublishedArtifact,
  type SignedInUser,
  type TestServer,
} from './helpers/server.js';

/**
 * A document's version history, as its owner reads it back.
 *
 * Every write has always made a version. What is under test here is reading
 * them: the owner (and the owner's own token) can list and open every one; a
 * person the document is shared with cannot, because a past version may hold
 * exactly what the owner took out. And opening an old version is reading it,
 * so it is counted against that version.
 */

let server: TestServer;
let owner: SignedInUser;
let reader: SignedInUser;
let doc: PublishedArtifact;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  reader = await signIn(server, 'reader@example.com');
  doc = await owner.publish({ type: 'markdown', content: '# Plan\n\nFirst draft.', title: 'Plan' });
});

afterEach(() => {
  server.close();
});

async function update(content: string, baseVersion: number, title?: string): Promise<void> {
  const response = await owner.as(`/api/artifacts/${doc.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, baseVersion, ...(title ? { title } : {}) }),
  });
  expect(response.ok).toBe(true);
}

async function shareWith(email: string): Promise<void> {
  const response = await owner.as(`/api/artifacts/${doc.id}/sharing/people`, jsonBody({ email }));
  expect(response.ok).toBe(true);
}

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

async function versionsOf(user: SignedInUser = owner): Promise<ArtifactVersionsResponse> {
  const response = await user.as(`/api/artifacts/${doc.id}/versions`);
  expect(response.status).toBe(200);
  return (await response.json()) as ArtifactVersionsResponse;
}

async function viewsOf(): Promise<ArtifactViewsResponse> {
  return (await (await owner.as(`/api/artifacts/${doc.id}/views`)).json()) as ArtifactViewsResponse;
}

describe('listing versions', () => {
  it('lists every version newest first, without content', async () => {
    await update('# Plan\n\nSecond draft.', 1);
    await update('# Plan B\n\nThird draft, longer.', 2, 'Plan B');

    const body = await versionsOf();
    expect(body.artifactId).toBe(doc.id);
    expect(body.currentVersion).toBe(3);
    expect(body.url).toContain(`/a/${doc.slug}`);
    expect(body.publishedBy.email).toBe(owner.email);
    expect(body.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(body.versions[0]).toMatchObject({ version: 3, kind: 'edited', isCurrent: true, title: 'Plan B', type: 'markdown' });
    expect(body.versions[2]).toMatchObject({ version: 1, kind: 'published', isCurrent: false, title: 'Plan' });
    expect(body.versions[2]?.bytes).toBe(Buffer.byteLength('# Plan\n\nFirst draft.', 'utf8'));
    expect(JSON.stringify(body)).not.toContain('First draft');
  });

  it('counts bytes, not characters', async () => {
    await update('# Café ☕', 1);
    const body = await versionsOf();
    expect(body.versions[0]?.bytes).toBe(Buffer.byteLength('# Café ☕', 'utf8'));
  });

  it('carries per-version views, the owner included', async () => {
    await shareWith(reader.email);
    await owner.as(`/api/artifacts/by-slug/${doc.slug}`);
    await update('# Plan\n\nSecond draft.', 1);
    await reader.as(`/api/artifacts/by-slug/${doc.slug}`);

    const body = await versionsOf();
    expect(body.versions.find((v) => v.version === 1)?.views).toEqual({ views: 1, ownerViews: 1, otherViews: 0 });
    expect(body.versions.find((v) => v.version === 2)?.views).toEqual({ views: 1, ownerViews: 0, otherViews: 1 });
  });

  it('is the owner’s alone: a shared reader is told not found', async () => {
    await shareWith(reader.email);
    expect((await reader.as(`/api/artifacts/${doc.id}/versions`)).status).toBe(404);
    expect((await reader.as(`/api/artifacts/${doc.id}/versions/1`)).status).toBe(404);
  });

  it('needs somebody signed in', async () => {
    expect((await server.request(`/api/artifacts/${doc.id}/versions`)).status).toBe(401);
    expect((await server.request(`/api/artifacts/${doc.id}/versions/1`)).status).toBe(401);
  });

  it('works with the owner’s command-line token', async () => {
    const token = await tokenFor(owner);
    const response = await server.request(`/api/artifacts/${doc.id}/versions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });
});

describe('reading one version', () => {
  it('returns that version in the shape of GET /api/artifacts/:id', async () => {
    await update('# Plan B\n\nSecond draft.', 1, 'Plan B');

    const response = await owner.as(`/api/artifacts/${doc.id}/versions/1`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ArtifactVersionDetail;
    expect(body).toMatchObject({
      id: doc.id,
      slug: doc.slug,
      version: 1,
      currentVersion: 2,
      isCurrent: false,
      title: 'Plan',
      type: 'markdown',
      content: '# Plan\n\nFirst draft.',
    });
    expect(body.url).toContain(`/a/${doc.slug}`);

    const current = (await (await owner.as(`/api/artifacts/${doc.id}`)).json()) as Record<string, unknown>;
    for (const key of Object.keys(current)) expect(body).toHaveProperty(key);
  });

  it('marks the current version as current', async () => {
    const body = (await (await owner.as(`/api/artifacts/${doc.id}/versions/1`)).json()) as ArtifactVersionDetail;
    expect(body).toMatchObject({ version: 1, currentVersion: 1, isCurrent: true });
  });

  it('refuses a version that does not exist, and one that is not a number', async () => {
    const missing = await owner.as(`/api/artifacts/${doc.id}/versions/9`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('no version 9');
    expect((await owner.as(`/api/artifacts/${doc.id}/versions/0`)).status).toBe(400);
    expect((await owner.as(`/api/artifacts/${doc.id}/versions/two`)).status).toBe(400);
  });
});

describe('opening an old version is counted against it', () => {
  it('counts the owner opening a past version in a browser as a view of that version', async () => {
    await update('# Plan\n\nSecond draft.', 1);
    await owner.as(`/api/artifacts/${doc.id}/versions/1`);

    const views = await viewsOf();
    expect(views.totals).toMatchObject({ views: 1, ownerViews: 1, agentFetches: 0 });
    expect(views.recent[0]).toMatchObject({ version: 1, client: 'browser', access: 'owner' });
    // Reading an old version is not reading the current one.
    expect(views.openedSinceLatestVersion).toBe(false);
  });

  it('does not count a fetch made only to compare against', async () => {
    await update('# Plan\n\nSecond draft.', 1);
    await owner.as(`/api/artifacts/${doc.id}/versions/1?record=false`);
    expect((await viewsOf()).totals.views).toBe(0);
  });

  it('records the owner’s token reading a version as an agent read', async () => {
    const token = await tokenFor(owner);
    await server.request(`/api/artifacts/${doc.id}/versions/1`, { headers: { Authorization: `Bearer ${token}` } });
    const views = await viewsOf();
    expect(views.totals).toMatchObject({ views: 0, agentFetches: 1 });
  });

  it('folds a reload into one view, as for the current version', async () => {
    await update('# Plan\n\nSecond draft.', 1);
    await owner.as(`/api/artifacts/${doc.id}/versions/1`);
    await owner.as(`/api/artifacts/${doc.id}/versions/1`);
    expect((await viewsOf()).totals.views).toBe(1);
  });
});

describe('the content of a past version', () => {
  it('is rendered for the owner, under the same sandbox', async () => {
    await update('# Plan\n\nSecond draft.', 1);
    const response = await owner.as(`/a/${doc.slug}/content?version=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox allow-scripts');
    expect(response.headers.get('X-Artifact-Version')).toBe('1');
    const html = await response.text();
    expect(html).toContain('First draft');
    expect(html).not.toContain('Second draft');
  });

  it('is refused to a shared reader, who still gets the current one', async () => {
    await shareWith(reader.email);
    await update('# Plan\n\nSecond draft.', 1);
    expect((await reader.as(`/a/${doc.slug}/content?version=1`)).status).toBe(404);
    const current = await reader.as(`/a/${doc.slug}/content?version=2`);
    expect(current.status).toBe(200);
    expect(await current.text()).toContain('Second draft');
  });

  it('serves an old HTML version as-is and never with the comment bridge', async () => {
    const page = await owner.publish({ type: 'html', content: '<!doctype html><p>Old page</p>', title: 'Page' });
    const put = await owner.as(`/api/artifacts/${page.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '<!doctype html><p>New page</p>', baseVersion: 1 }),
    });
    expect(put.ok).toBe(true);

    const response = await owner.as(`/a/${page.slug}/content?version=1&frame=1`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<!doctype html><p>Old page</p>');
  });
});
