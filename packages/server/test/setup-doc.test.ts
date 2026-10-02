import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, TEST_BASE_URL, type TestServer } from './helpers/server.js';

/**
 * The hosted setup instructions at /setup.md.
 *
 * This is the first thing an assistant fetches, before it has any session, so it
 * has to be public and it has to point at this instance rather than at
 * open-artifact.com. Both are properties a self-hoster depends on.
 */

let server: TestServer;

beforeEach(() => {
  server = createTestServer();
});

afterEach(() => {
  server.close();
});

describe('/setup.md', () => {
  it('is served publicly, as markdown', async () => {
    const response = await server.request('/setup.md');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
  });

  it('points at this instance, not a hardcoded one', async () => {
    const body = await (await server.request('/setup.md')).text();
    // The instance URL is woven through the connector and sign-in steps.
    expect(body).toContain(`${TEST_BASE_URL}/mcp`);
    expect(body).toContain(`agentio kite profile add --url ${TEST_BASE_URL}`);
    expect(body).not.toContain('open-artifact.com');
  });

  it('carries the steps an assistant needs to set itself up with agentio', async () => {
    const body = await (await server.request('/setup.md')).text();
    expect(body).toContain('curl -LsSf https://agentio.houlahop.com/install | sh');
    expect(body).toContain('iwr -useb https://agentio.houlahop.com/install.ps1 | iex');
    expect(body).toContain('agentio skill kite');
    expect(body).toContain('agentio kite list --json');
  });

  it('never sends an assistant to the command line Kite no longer has', async () => {
    const body = await (await server.request('/setup.md')).text();
    expect(body).not.toMatch(/npm install -g open-artifact/);
    expect(body).not.toMatch(/open-artifact (login|whoami)/);
    expect(body).not.toContain('raw.githubusercontent.com');
  });

  it('signs in without a browser on the assistant\'s side, so it works over SSH', async () => {
    const body = await (await server.request('/setup.md')).text();
    expect(body).toContain('--no-browser');
  });

  it('leaves the vault passphrase to the user, never to the assistant', async () => {
    const body = await (await server.request('/setup.md')).text();
    expect(body).toContain('agentio vault init');
    expect(body).toContain('Never choose or type one for them');
  });

  it('tells the assistant where global instructions live, per harness', async () => {
    const body = await (await server.request('/setup.md')).text();
    // Making Kite the default writes to global instructions, and the
    // right place differs by harness — so the real paths are named.
    expect(body).toContain('~/.claude/CLAUDE.md');
    expect(body).toContain('~/.codex/AGENTS.md');
    expect(body).toContain('~/.gemini/GEMINI.md');
    // Web and desktop apps keep instructions in a settings screen the assistant
    // cannot edit, so it hands the user the line and where to paste it.
    expect(body).toContain('Custom Instructions');
    // And it never writes to a person's global instructions without a yes.
    expect(body).toContain('only after they say yes');
  });

  it('answers /setup as an alias', async () => {
    const response = await server.request('/setup');
    expect(response.status).toBe(200);
  });
});

describe('/llms.txt', () => {
  it('is served publicly, as plain text', async () => {
    const response = await server.request('/llms.txt');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
  });

  it('describes the project and points at this instance', async () => {
    const body = await (await server.request('/llms.txt')).text();
    expect(body).toContain('# Open Artifact');
    expect(body).toContain(`${TEST_BASE_URL}/setup.md`);
    expect(body).toContain('github.com/iBala/open-artifact');
    // Instance URLs are dynamic; the hardcoded prod address must not leak in.
    // (The hello@open-artifact.com support address is a fixed contact, not an
    // instance URL, so it is allowed.)
    expect(body).not.toContain('https://open-artifact.com');
  });

  it('answers /llm.txt as an alias', async () => {
    const response = await server.request('/llm.txt');
    expect(response.status).toBe(200);
  });
});
