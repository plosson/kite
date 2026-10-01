import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, signIn, jsonBody, type TestServer, type SignedInUser } from './helpers/server.js';

/**
 * Workspaces through MCP.
 *
 * The rule under test: once somebody has workspaces, an assistant cannot publish
 * without saying where. A missing or wrong choice publishes nothing and hands
 * the assistant the list it should have chosen from.
 */

let server: TestServer;
let owner: SignedInUser;
let token: string;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  const response = await owner.as('/api/auth/mcp-tokens', jsonBody({ label: 'Claude' }));
  token = ((await response.json()) as { token: string }).token;
});

afterEach(() => server.close());

async function call(name: string, args: Record<string, unknown>) {
  const response = await server.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: body.result.content.map((p) => p.text).join('\n'), isError: body.result.isError === true };
}

async function kiteCount(): Promise<number> {
  const listing = (await (await owner.as('/api/artifacts')).json()) as { artifacts: unknown[] };
  return listing.artifacts.length;
}

async function makeWorkspace(name: string, description: string) {
  const result = await call('create_workspace', { name, description });
  expect(result.isError, result.text).toBe(false);
}

describe('publishing with workspaces', () => {
  it('publishes without a workspace when the person has none', async () => {
    const result = await call('publish_artifact', { content: '# Hi', format: 'markdown' });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('workspace: Inbox');
  });

  it('refuses to publish without a workspace once one exists, and lists them', async () => {
    await makeWorkspace('Research', 'Papers and literature notes');
    const result = await call('publish_artifact', { content: '# Hi', format: 'markdown' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Research');
    expect(result.text).toContain('Papers and literature notes');
    expect(result.text).toContain('Inbox');
    expect(result.text).toContain('ask the user');
    expect(await kiteCount()).toBe(0);
  });

  it('refuses an unknown workspace and creates nothing', async () => {
    await makeWorkspace('Research', 'Papers');
    const result = await call('publish_artifact', { content: '# Hi', format: 'markdown', workspace: 'Reserch' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Research');
    expect(await kiteCount()).toBe(0);
  });

  it('refuses a workspace that is not text', async () => {
    await makeWorkspace('Research', 'Papers');
    const result = await call('publish_artifact', { content: '# Hi', format: 'markdown', workspace: 3 });
    expect(result.isError).toBe(true);
    expect(await kiteCount()).toBe(0);
  });

  it('matches the name ignoring case, and places the kite there', async () => {
    await makeWorkspace('Research', 'Papers');
    const result = await call('publish_artifact', { content: '# Hi', format: 'markdown', workspace: 'rESEARCH' });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain('workspace: Research');

    const listed = await call('list_artifacts', {});
    expect(listed.text).toContain('workspace: Research');
  });

  it('accepts inbox explicitly when workspaces exist', async () => {
    await makeWorkspace('Research', 'Papers');
    const result = await call('publish_artifact', { content: '# Hi', format: 'markdown', workspace: 'inbox' });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('workspace: Inbox');
  });
});

describe('the workspace tools', () => {
  it('lists Inbox first with descriptions and counts', async () => {
    await makeWorkspace('Research', 'Papers');
    await call('publish_artifact', { content: '# Hi', format: 'markdown', workspace: 'Research' });
    const result = await call('list_workspaces', {});
    const inboxAt = result.text.indexOf('Inbox');
    const researchAt = result.text.indexOf('Research');
    expect(inboxAt).toBeGreaterThanOrEqual(0);
    expect(researchAt).toBeGreaterThan(inboxAt);
    expect(result.text).toContain('Papers');
    expect(result.text).toMatch(/Research[^\n]*1 kite/);
  });

  it('refuses a duplicate name, the reserved name, and a blank description', async () => {
    await makeWorkspace('Research', 'Papers');
    expect((await call('create_workspace', { name: 'research', description: 'x' })).isError).toBe(true);
    expect((await call('create_workspace', { name: 'Inbox', description: 'x' })).isError).toBe(true);
    expect((await call('create_workspace', { name: 'Other', description: '  ' })).isError).toBe(true);
  });
});
