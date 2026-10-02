import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  TEST_DESCRIBED,
  createTestServer,
  jsonBody,
  signIn,
  type PublishedArtifact,
  type SignedInUser,
  type TestServer,
} from './helpers/server.js';
import { artifacts } from '../src/db/schema.js';

/**
 * Describing and organizing a library through MCP.
 *
 * Publishing over MCP must say what the document is. The organizing tools are
 * the one place a connection reaches past its own work, so the cases here are
 * mostly about where that reach stops: another person's documents, another
 * person's workspaces, and anything beyond title, description, summary and
 * placement.
 */

let server: TestServer;
let owner: SignedInUser;
let token: string;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  token = await mcpTokenFor(owner);
});

afterEach(() => server.close());

async function mcpTokenFor(person: SignedInUser): Promise<string> {
  const response = await person.as('/api/auth/mcp-tokens', jsonBody({ label: 'Claude' }));
  return ((await response.json()) as { token: string }).token;
}

async function call(name: string, args: Record<string, unknown>, as = token) {
  const response = await server.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${as}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: body.result.content.map((p) => p.text).join('\n'), isError: body.result.isError === true };
}

async function stored(id: string) {
  const response = await owner.as(`/api/artifacts/${id}`);
  return (await response.json()) as {
    title: string;
    content: string;
    description: string | null;
    summary: string | null;
    summaryVersion: number | null;
    version: number;
  };
}

async function workspaceOf(person: SignedInUser, id: string): Promise<string | undefined> {
  const listing = (await (await person.as('/api/artifacts')).json()) as {
    artifacts: { id: string; workspaceId: string }[];
  };
  return listing.artifacts.find((artifact) => artifact.id === id)?.workspaceId;
}

async function kiteCount(): Promise<number> {
  const listing = (await (await owner.as('/api/artifacts')).json()) as { artifacts: unknown[] };
  return listing.artifacts.length;
}

// ---------------------------------------------------------------------------
// Publishing and updating
// ---------------------------------------------------------------------------

describe('publish_artifact', () => {
  it('refuses to publish without a summary, and publishes nothing', async () => {
    const result = await call('publish_artifact', { content: '# Hi', format: 'markdown', description: 'D.' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('summary');
    expect(await kiteCount()).toBe(0);
  });

  it('refuses to publish without a description, and publishes nothing', async () => {
    const result = await call('publish_artifact', { content: '# Hi', format: 'markdown', summary: 'S.' });
    expect(result.isError).toBe(true);
    expect(await kiteCount()).toBe(0);
  });

  it('refuses a summary over ten lines, and publishes nothing', async () => {
    const result = await call('publish_artifact', {
      ...TEST_DESCRIBED,
      content: '# Hi',
      format: 'markdown',
      summary: Array.from({ length: 11 }, (_, index) => `${index}`).join('\n'),
    });
    expect(result.isError).toBe(true);
    expect(await kiteCount()).toBe(0);
  });

  it('does not spend the publish budget on a refused publish', async () => {
    const tight = createTestServer({ SIGNUP_MODE: 'open', MAX_PUBLISHES_PER_HOUR: '1' });
    try {
      const person = await signIn(tight, 'tight@example.com');
      const response = await person.as('/api/auth/mcp-tokens', jsonBody({ label: 'Claude' }));
      const tightToken = ((await response.json()) as { token: string }).token;
      const send = async (args: Record<string, unknown>) => {
        const reply = await tight.request('/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tightToken}` },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'publish_artifact', arguments: args },
          }),
        });
        return ((await reply.json()) as { result: { isError?: boolean } }).result.isError === true;
      };

      expect(await send({ content: '# Hi', format: 'markdown' })).toBe(true);
      expect(await send({ ...TEST_DESCRIBED, content: '# Hi', format: 'markdown' })).toBe(false);
    } finally {
      tight.close();
    }
  });

  it('tells the publisher, in the tool listing, that both are required and how they behave', async () => {
    const response = await server.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const tools = ((await response.json()) as {
      result: { tools: { name: string; description: string; inputSchema: { required?: string[] } }[] };
    }).result.tools;
    const publish = tools.find((tool) => tool.name === 'publish_artifact')!;
    const update = tools.find((tool) => tool.name === 'update_artifact')!;

    expect(publish.inputSchema.required).toEqual(expect.arrayContaining(['description', 'summary']));
    expect(update.inputSchema.required).not.toContain('summary');
    expect(update.description).toContain('leave a field out to keep it');
  });
});

describe('update_artifact', () => {
  it('keeps the summary when it is left out, and get_artifact says it fell behind', async () => {
    const published = await call('publish_artifact', {
      content: '# Plan',
      format: 'markdown',
      description: 'The plan.',
      summary: 'Do it.',
    });
    const id = /artifact_id: (\S+)/.exec(published.text)![1]!;

    const updated = await call('update_artifact', { artifact_id: id, content: '# Plan, typo fixed', base_version: 1 });
    expect(updated.isError, updated.text).toBe(false);

    const read = await call('get_artifact', { artifact_id: id, include_content: false });
    expect(read.text).toContain('description: The plan.');
    expect(read.text).toContain('Do it.');
    expect(read.text).toContain('written for version 1, 1 version behind');
  });

  it('still refuses a document this connection did not publish', async () => {
    const doc = await owner.publish({ type: 'markdown', content: '# From the CLI' });
    const result = await call('update_artifact', { artifact_id: doc.id, content: '# Hijacked', base_version: 1 });
    expect(result.isError).toBe(true);
    expect((await stored(doc.id)).content).toBe('# From the CLI');
  });
});

// ---------------------------------------------------------------------------
// Organizing
// ---------------------------------------------------------------------------

describe('organize_library', () => {
  it('lists documents published anywhere by this person, not only through this connection', async () => {
    const fromCli = await owner.publish({ type: 'markdown', content: '# From the CLI', description: 'Came from the CLI.' });
    const otherToken = await mcpTokenFor(owner);
    await call('publish_artifact', { ...TEST_DESCRIBED, content: '# Elsewhere', format: 'markdown' }, otherToken);

    const result = await call('organize_library', {});
    expect(result.isError).toBe(false);
    expect(result.text).toContain(fromCli.id);
    expect(result.text).toContain('Came from the CLI.');
    expect(result.text).toContain('Elsewhere');
    expect(result.text).toContain('Documents (2)');
  });

  it('never lists another person\'s documents, even ones shared with this person', async () => {
    const neighbour = await signIn(server, 'neighbour@example.com');
    const theirs = await neighbour.publish({ type: 'markdown', content: '# Their secret plan' });
    await neighbour.as(`/api/artifacts/${theirs.id}/sharing/people`, jsonBody({ email: owner.email }));

    const result = await call('organize_library', {});
    expect(result.text).not.toContain(theirs.id);
    expect(result.text).not.toContain('Their secret plan');
  });

  it('flags a summary that is missing or behind, so the assistant knows what to rewrite', async () => {
    const legacy = await owner.publish({ type: 'markdown', content: '# Legacy' });
    server.database.db
      .update(artifacts)
      .set({ description: null, summary: null, summaryVersion: null })
      .where(eq(artifacts.id, legacy.id))
      .run();
    const drifted = await owner.publish({ type: 'markdown', content: '# Drifted' });
    for (const version of [1, 2]) {
      await owner.as(`/api/artifacts/${drifted.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `# Drifted ${version}`, baseVersion: version }),
      });
    }

    const result = await call('organize_library', {});
    expect(result.text).toContain('summary (missing)');
    expect(result.text).toContain('written for version 1, 2 versions behind');
  });

  it('says so plainly when there is nothing to organize', async () => {
    const result = await call('organize_library', {});
    expect(result.isError).toBe(false);
    expect(result.text).toContain('not published anything');
  });

  it('changes nothing', async () => {
    const doc = await owner.publish({ type: 'markdown', content: '# Still' });
    const before = await stored(doc.id);
    await call('organize_library', {});
    expect(await stored(doc.id)).toEqual(before);
  });
});

describe('get_library_document', () => {
  it('reads a document this person published from somewhere else', async () => {
    const doc = await owner.publish({ type: 'markdown', content: '# From the CLI\n\nBody text.' });
    const result = await call('get_library_document', { artifact_id: doc.id });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('Body text.');
  });

  it('refuses another person\'s document even when it is shared with this person, without leaking it', async () => {
    const neighbour = await signIn(server, 'neighbour@example.com');
    const theirs = await neighbour.publish({ type: 'markdown', content: '# Theirs\n\nConfidential.' });
    await neighbour.as(`/api/artifacts/${theirs.id}/sharing/people`, jsonBody({ email: owner.email }));

    const result = await call('get_library_document', { artifact_id: theirs.id });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('Confidential');
    expect(result.text).not.toContain('Theirs');
  });

  it('answers a made-up id the same way as somebody else\'s', async () => {
    const neighbour = await signIn(server, 'neighbour@example.com');
    const theirs = await neighbour.publish({ type: 'markdown', content: '# Theirs' });

    const missing = await call('get_library_document', { artifact_id: 'art_doesnotexist' });
    const foreign = await call('get_library_document', { artifact_id: theirs.id });
    expect(missing.text).toBe(foreign.text);
  });
});

describe('describe_artifact', () => {
  let doc: PublishedArtifact;

  beforeEach(async () => {
    doc = await owner.publish({ type: 'markdown', content: '# Untitled', description: 'Old.', summary: 'Old summary.' });
  });

  it('retitles a document published outside this connection, without a new version', async () => {
    const result = await call('describe_artifact', { artifact_id: doc.id, title: 'Q3 plan' });
    expect(result.isError, result.text).toBe(false);
    expect(await stored(doc.id)).toMatchObject({ title: 'Q3 plan', version: 1, content: '# Untitled' });
  });

  it('refuses another person\'s document, and leaves it as it was', async () => {
    const neighbour = await signIn(server, 'neighbour@example.com');
    const theirs = await neighbour.publish({ type: 'markdown', content: '# Theirs' });

    const result = await call('describe_artifact', { artifact_id: theirs.id, title: 'Renamed by a stranger' });
    expect(result.isError).toBe(true);
    const after = (await (await neighbour.as(`/api/artifacts/${theirs.id}`)).json()) as { title: string };
    expect(after.title).toBe('Theirs');
  });

  it('refuses a call with nothing to change', async () => {
    const result = await call('describe_artifact', { artifact_id: doc.id });
    expect(result.isError).toBe(true);
  });

  it('refuses a description over one line, changing nothing else it was sent', async () => {
    const result = await call('describe_artifact', {
      artifact_id: doc.id,
      title: 'New title',
      description: 'one\ntwo',
    });
    expect(result.isError).toBe(true);
    expect(await stored(doc.id)).toMatchObject({ title: 'Untitled', description: 'Old.' });
  });

  it('refuses a title that is not text', async () => {
    const result = await call('describe_artifact', { artifact_id: doc.id, title: 7 });
    expect(result.isError).toBe(true);
  });

  it('ignores content it is handed', async () => {
    await call('describe_artifact', { artifact_id: doc.id, summary: 'New summary.', content: '# Overwritten' });
    expect(await stored(doc.id)).toMatchObject({ summary: 'New summary.', content: '# Untitled' });
  });
});

describe('move_artifact', () => {
  let doc: PublishedArtifact;

  beforeEach(async () => {
    doc = await owner.publish({ type: 'markdown', content: '# Notes' });
    await call('create_workspace', { name: 'Research', description: 'Papers and notes.' });
  });

  it('moves a document published outside this connection, by workspace name', async () => {
    const result = await call('move_artifact', { artifact_id: doc.id, workspace: 'research' });
    expect(result.isError, result.text).toBe(false);
    expect(await workspaceOf(owner, doc.id)).not.toBe('inbox');
  });

  it('moves it back to the inbox', async () => {
    await call('move_artifact', { artifact_id: doc.id, workspace: 'Research' });
    await call('move_artifact', { artifact_id: doc.id, workspace: 'inbox' });
    expect(await workspaceOf(owner, doc.id)).toBe('inbox');
  });

  it('refuses a workspace that does not exist, and leaves the document where it was', async () => {
    const result = await call('move_artifact', { artifact_id: doc.id, workspace: 'Reserch' });
    expect(result.isError).toBe(true);
    expect(await workspaceOf(owner, doc.id)).toBe('inbox');
  });

  it('refuses another person\'s workspace, even by its exact id', async () => {
    const neighbour = await signIn(server, 'neighbour@example.com');
    const created = await neighbour.as('/api/workspaces', jsonBody({ name: 'Theirs', description: 'Not yours.' }));
    const theirWorkspace = ((await created.json()) as { id: string }).id;

    const result = await call('move_artifact', { artifact_id: doc.id, workspace: theirWorkspace });
    expect(result.isError).toBe(true);
    expect(await workspaceOf(owner, doc.id)).toBe('inbox');
  });

  it('refuses to sort another person\'s document, even one shared with this person', async () => {
    const neighbour = await signIn(server, 'neighbour@example.com');
    const theirs = await neighbour.publish({ type: 'markdown', content: '# Theirs' });
    await neighbour.as(`/api/artifacts/${theirs.id}/sharing/people`, jsonBody({ email: owner.email }));

    const result = await call('move_artifact', { artifact_id: theirs.id, workspace: 'Research' });
    expect(result.isError).toBe(true);
    const shared = (await (await owner.as('/api/shared-with-me')).json()) as {
      artifacts: { id: string; workspaceId: string }[];
    };
    expect(shared.artifacts.find((artifact) => artifact.id === theirs.id)?.workspaceId).toBe('inbox');
  });

  it('does not move the document for anybody else it is shared with', async () => {
    const reader = await signIn(server, 'reader@example.com');
    await owner.as(`/api/artifacts/${doc.id}/sharing/people`, jsonBody({ email: reader.email }));

    await call('move_artifact', { artifact_id: doc.id, workspace: 'Research' });
    const shared = (await (await reader.as('/api/shared-with-me')).json()) as {
      artifacts: { id: string; workspaceId: string }[];
    };
    expect(shared.artifacts.find((artifact) => artifact.id === doc.id)?.workspaceId).toBe('inbox');
  });
});
