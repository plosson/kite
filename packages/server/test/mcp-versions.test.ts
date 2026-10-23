import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TEST_DESCRIBED,
  createTestServer,
  jsonBody,
  signIn,
  type TestServer,
  type SignedInUser,
} from './helpers/server.js';

/**
 * The two history tools: list_artifact_versions and get_artifact_version.
 *
 * Same scoping as get_artifact: a connection reads the history of what it
 * published and nothing else. Reading a version is an agent read of that
 * version, never a view.
 */

let server: TestServer;
let owner: SignedInUser;
/** The owner's first connection. */
let connectionA: { token: string; connectionId: string };

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  connectionA = await connect(owner);
});

afterEach(() => {
  server.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function connect(
  user: SignedInUser,
  label = 'Claude on the web',
): Promise<{ token: string; connectionId: string }> {
  const response = await user.as('/api/auth/mcp-tokens', jsonBody({ label }));
  if (response.status !== 201) throw new Error(`could not connect: ${await response.text()}`);
  const body = (await response.json()) as { token: string; connectionId: string };
  return { token: body.token, connectionId: body.connectionId };
}

interface ToolResult {
  text: string;
  isError: boolean;
}

async function call(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const response = await server.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = (await response.json()) as {
    result?: { content: { text: string }[]; isError?: boolean };
  };
  const result = body.result;
  if (!result) throw new Error(`tool call was not a result: ${JSON.stringify(body)}`);
  return { text: result.content.map((part) => part.text).join('\n'), isError: result.isError === true };
}

/** Publishes over MCP and returns the new artifact id. */
async function publish(
  token: string,
  content: string,
  format: 'markdown' | 'html' = 'markdown',
  title?: string,
): Promise<string> {
  const result = await call(token, 'publish_artifact', { ...TEST_DESCRIBED, content, format, ...(title ? { title } : {}) });
  const match = /artifact_id: (\S+)/.exec(result.text);
  if (!match) throw new Error(`no artifact id in publish result: ${result.text}`);
  return match[1] as string;
}

describe('version history over MCP', () => {
  it('lists and reads back the versions of its own artifact', async () => {
    const id = await publish(connectionA.token, '# First draft', 'markdown', 'Plan');
    await call(connectionA.token, 'update_artifact', { artifact_id: id, content: '# Second draft', base_version: 1 });

    const listed = await call(connectionA.token, 'list_artifact_versions', { artifact_id: id });
    expect(listed.isError).toBe(false);
    expect(listed.text).toContain('2 versions');
    expect(listed.text).toMatch(/v2 \(current\) — edited/);
    expect(listed.text).toMatch(/v1 — published/);
    expect(listed.text).not.toContain('First draft');

    const old = await call(connectionA.token, 'get_artifact_version', { artifact_id: id, version: 1 });
    expect(old.isError).toBe(false);
    expect(old.text).toContain('version: 1 of 2');
    expect(old.text).toContain('# First draft');
    expect(old.text).not.toContain('Second draft');

    const head = await call(connectionA.token, 'get_artifact_version', { artifact_id: id, version: 2, include_content: false });
    expect(head.text).toContain('version: 2 of 2 (current)');
    expect(head.text).not.toContain('# Second draft');
  });

  it('says plainly when a version does not exist', async () => {
    const id = await publish(connectionA.token, '# Only one');
    const missing = await call(connectionA.token, 'get_artifact_version', { artifact_id: id, version: 5 });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('no version 5');
  });

  it('cannot read the history of something published elsewhere', async () => {
    const web = await owner.publish({ type: 'markdown', content: '# From the web' });
    const connectionB = await connect(owner, 'ChatGPT');
    const other = await publish(connectionB.token, '# From B');

    for (const artifactId of [web.id, other]) {
      const listed = await call(connectionA.token, 'list_artifact_versions', { artifact_id: artifactId });
      expect(listed.isError).toBe(true);
      expect(listed.text).toContain('published outside this connection');
      const got = await call(connectionA.token, 'get_artifact_version', { artifact_id: artifactId, version: 1 });
      expect(got.isError).toBe(true);
    }
  });

  it('records reading a version as an agent read of it, never a view', async () => {
    const id = await publish(connectionA.token, '# Draft');
    await call(connectionA.token, 'get_artifact_version', { artifact_id: id, version: 1 });
    const views = (await (await owner.as(`/api/artifacts/${id}/views`)).json()) as {
      totals: { views: number; agentFetches: number };
      recent: { version: number; client: string }[];
    };
    expect(views.totals).toMatchObject({ views: 0, agentFetches: 1 });
    expect(views.recent[0]).toMatchObject({ version: 1, client: 'mcp' });
  });
});
