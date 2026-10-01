import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, signIn, jsonBody, type TestServer, type SignedInUser } from './helpers/server.js';

/**
 * Workspaces over HTTP: a person's private sorting of what they can see.
 *
 * The guarantees: a workspace and a placement are invisible to everybody else
 * and grant nothing; somebody else's workspace id behaves exactly like one that
 * does not exist; and losing access to a kite takes it out of your workspaces.
 */

let server: TestServer;
let owner: SignedInUser;
let reader: SignedInUser;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  reader = await signIn(server, 'reader@example.com');
});

afterEach(() => server.close());

function send(user: SignedInUser, method: string, path: string, body?: unknown) {
  return user.as(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createWorkspace(user: SignedInUser, name: string, description = `${name} things`) {
  const response = await send(user, 'POST', '/api/workspaces', { name, description });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; name: string };
}

async function workspacesOf(user: SignedInUser) {
  const body = (await (await user.as('/api/workspaces')).json()) as {
    workspaces: { id: string; name: string; count: number }[];
  };
  return body.workspaces;
}

async function workspaceIdIn(user: SignedInUser, listing: string, artifactId: string) {
  const body = (await (await user.as(listing)).json()) as { artifacts: { id: string; workspaceId: string }[] };
  return body.artifacts.find((a) => a.id === artifactId)?.workspaceId;
}

async function share(artifactId: string, email: string) {
  await owner.as(`/api/artifacts/${artifactId}/sharing/people`, jsonBody({ email }));
}

describe('the workspace routes', () => {
  it('need a signed-in caller', async () => {
    expect((await server.request('/api/workspaces')).status).toBe(401);
    expect((await server.request('/api/workspaces', jsonBody({ name: 'x', description: 'y' }))).status).toBe(401);
  });

  it('list Inbox alone for somebody with no workspaces', async () => {
    expect(await workspacesOf(owner)).toEqual([
      { id: 'inbox', name: 'Inbox', description: 'Kites that are not sorted into a workspace yet.', count: 0 },
    ]);
  });

  it('refuse a duplicate in another case with 409 name_taken', async () => {
    await createWorkspace(owner, 'Research');
    const response = await send(owner, 'POST', '/api/workspaces', { name: 'RESEARCH', description: 'x' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('name_taken');
  });

  it('refuse a body that is not an object', async () => {
    const response = await owner.as('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '"Research"',
    });
    expect(response.status).toBe(400);
  });

  it('answer another person’s workspace with the same 404 as a missing one', async () => {
    const theirs = await createWorkspace(reader, 'Private');
    const missing = await send(owner, 'PATCH', '/api/workspaces/ws_doesnotexist', { name: 'x' });
    const foreign = await send(owner, 'PATCH', `/api/workspaces/${theirs.id}`, { name: 'x' });
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
    expect((await send(owner, 'DELETE', `/api/workspaces/${theirs.id}`)).status).toBe(404);
    // And it is untouched.
    expect((await workspacesOf(reader)).map((w) => w.name)).toContain('Private');
  });

  it('refuse to change or delete Inbox', async () => {
    expect((await send(owner, 'PATCH', '/api/workspaces/inbox', { name: 'Other' })).status).toBe(400);
    expect((await send(owner, 'DELETE', '/api/workspaces/inbox')).status).toBe(400);
  });
});

describe('placing kites', () => {
  it('moves your kite and shows it on your listing', async () => {
    const research = await createWorkspace(owner, 'Research');
    const kite = await owner.publish({ type: 'markdown', content: '# Paper' });
    expect(await workspaceIdIn(owner, '/api/artifacts', kite.id)).toBe('inbox');

    const moved = await send(owner, 'PUT', `/api/artifacts/${kite.id}/workspace`, { workspaceId: research.id });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ workspaceId: research.id });
    expect(await workspaceIdIn(owner, '/api/artifacts', kite.id)).toBe(research.id);
  });

  it('refuses a kite you cannot see, and writes nothing', async () => {
    const mine = await createWorkspace(reader, 'Mine');
    const kite = await owner.publish({ type: 'markdown', content: '# Private' });
    const response = await send(reader, 'PUT', `/api/artifacts/${kite.id}/workspace`, { workspaceId: mine.id });
    expect(response.status).toBe(404);
    expect((await workspacesOf(reader)).find((w) => w.id === mine.id)?.count).toBe(0);
  });

  it('refuses another person’s workspace as a target', async () => {
    const theirs = await createWorkspace(reader, 'Theirs');
    const kite = await owner.publish({ type: 'markdown', content: '# Mine' });
    const response = await send(owner, 'PUT', `/api/artifacts/${kite.id}/workspace`, { workspaceId: theirs.id });
    expect(response.status).toBe(404);
    expect(await workspaceIdIn(owner, '/api/artifacts', kite.id)).toBe('inbox');
  });

  it('refuses a missing or non-text workspaceId', async () => {
    const kite = await owner.publish({ type: 'markdown', content: '# x' });
    expect((await send(owner, 'PUT', `/api/artifacts/${kite.id}/workspace`, {})).status).toBe(400);
    expect((await send(owner, 'PUT', `/api/artifacts/${kite.id}/workspace`, { workspaceId: 7 })).status).toBe(400);
  });

  it('keeps a reader’s placement and the owner’s apart', async () => {
    const ownersPlace = await createWorkspace(owner, 'Reports');
    const readersPlace = await createWorkspace(reader, 'To read');
    const kite = await owner.publish({ type: 'markdown', content: '# Shared' });
    await share(kite.id, 'reader@example.com');

    await send(reader, 'PUT', `/api/artifacts/${kite.id}/workspace`, { workspaceId: readersPlace.id });
    expect(await workspaceIdIn(owner, '/api/artifacts', kite.id)).toBe('inbox');
    expect(await workspaceIdIn(reader, '/api/shared-with-me', kite.id)).toBe(readersPlace.id);

    await send(owner, 'PUT', `/api/artifacts/${kite.id}/workspace`, { workspaceId: ownersPlace.id });
    expect(await workspaceIdIn(reader, '/api/shared-with-me', kite.id)).toBe(readersPlace.id);
  });

  it('drops a kite from a reader’s workspace and count once they lose access', async () => {
    const readersPlace = await createWorkspace(reader, 'To read');
    const kite = await owner.publish({ type: 'markdown', content: '# Shared' });
    await share(kite.id, 'reader@example.com');
    await send(reader, 'PUT', `/api/artifacts/${kite.id}/workspace`, { workspaceId: readersPlace.id });
    expect((await workspacesOf(reader)).find((w) => w.id === readersPlace.id)?.count).toBe(1);

    await owner.as(`/api/artifacts/${kite.id}/sharing/people/reader%40example.com`, { method: 'DELETE' });

    expect(await workspaceIdIn(reader, '/api/shared-with-me', kite.id)).toBeUndefined();
    expect((await workspacesOf(reader)).find((w) => w.id === readersPlace.id)?.count).toBe(0);
  });

  it('puts a deleted workspace’s kites back in Inbox and deletes none', async () => {
    const doomed = await createWorkspace(owner, 'Doomed');
    const kite = await owner.publish({ type: 'markdown', content: '# Keep me' });
    await send(owner, 'PUT', `/api/artifacts/${kite.id}/workspace`, { workspaceId: doomed.id });

    expect((await send(owner, 'DELETE', `/api/workspaces/${doomed.id}`)).status).toBe(200);
    expect(await workspaceIdIn(owner, '/api/artifacts', kite.id)).toBe('inbox');
    expect((await owner.as(`/api/artifacts/${kite.id}`)).status).toBe(200);
  });
});

describe('publishing into a workspace', () => {
  it('places the new kite for its owner', async () => {
    const research = await createWorkspace(owner, 'Research');
    const response = await owner.as(
      '/api/artifacts',
      jsonBody({ type: 'markdown', content: '# Paper', workspaceId: research.id }),
    );
    expect(response.status).toBe(201);
    const kite = (await response.json()) as { id: string };
    expect(await workspaceIdIn(owner, '/api/artifacts', kite.id)).toBe(research.id);
  });

  it('creates no kite when the workspace is unknown or somebody else’s', async () => {
    const theirs = await createWorkspace(reader, 'Theirs');
    for (const workspaceId of ['ws_doesnotexist', theirs.id]) {
      const response = await owner.as(
        '/api/artifacts',
        jsonBody({ type: 'markdown', content: '# Nope', workspaceId }),
      );
      expect(response.status, workspaceId).toBe(404);
    }
    const listing = (await (await owner.as('/api/artifacts')).json()) as { artifacts: unknown[] };
    expect(listing.artifacts).toHaveLength(0);
  });

  it('leaves the placement alone when the kite is updated', async () => {
    const research = await createWorkspace(owner, 'Research');
    const kite = await owner.publish({ type: 'markdown', content: '# v1' });
    await send(owner, 'PUT', `/api/artifacts/${kite.id}/workspace`, { workspaceId: research.id });

    const updated = await send(owner, 'PUT', `/api/artifacts/${kite.id}`, {
      content: '# v2',
      baseVersion: kite.version,
      workspaceId: 'inbox',
    });
    expect(updated.status).toBe(200);
    expect(await workspaceIdIn(owner, '/api/artifacts', kite.id)).toBe(research.id);
  });
});
