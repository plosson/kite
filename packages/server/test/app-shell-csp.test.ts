import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { inlineScriptHashes } from '../src/http/routes/web-app.js';
import { createTestServer, type TestServer } from './helpers/server.js';

/**
 * The policy on the app's own document.
 *
 * Why it exists: the artifact frame is sandboxed without `allow-same-origin`, so
 * script inside cannot reach the reader's session. But a sandboxed frame may
 * still navigate *itself*, and the page it lands on inherits the sandbox flags,
 * the opaque origin and the same `contentWindow`. A publisher could point their
 * artifact at a page they control and change later, and the app would see the
 * same frame identity it saw before. `frame-src 'self'` is what stops that, and
 * it has to be there before the comment bridge trusts a message from the frame.
 */

const SHELL = [
  '<!doctype html>',
  '<html><head>',
  '<script>document.documentElement.dataset.theme = "dark";</script>',
  '<script type="module" src="/assets/main.js"></script>',
  '</head><body><div id="root"></div></body></html>',
].join('\n');

describe('hashing the shell’s inline scripts', () => {
  it('hashes an inline script exactly as it appears', () => {
    const body = 'document.documentElement.dataset.theme = "dark";';
    const expected = createHash('sha256').update(body, 'utf8').digest('base64');

    expect(inlineScriptHashes(SHELL)).toEqual([`'sha256-${expected}'`]);
  });

  it('ignores a script that only points at a file', () => {
    // Those are covered by 'self'. Hashing them would be meaningless.
    expect(inlineScriptHashes('<script src="/assets/main.js"></script>')).toEqual([]);
  });

  it('ignores an empty script', () => {
    expect(inlineScriptHashes('<script></script>')).toEqual([]);
  });

  it('hashes every inline script, not only the first', () => {
    const two = '<script>one()</script><script>two()</script>';

    expect(inlineScriptHashes(two)).toHaveLength(2);
  });

  it('changes when the script changes, so a stale hash cannot pass unnoticed', () => {
    const before = inlineScriptHashes('<script>one()</script>');
    const after = inlineScriptHashes('<script>one();</script>');

    expect(before).not.toEqual(after);
  });

  it('does not mistake a src attribute mentioned inside the script for a real one', () => {
    const tricky = '<script>var html = \'<img src="x">\';</script>';

    expect(inlineScriptHashes(tricky)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The header as a browser receives it
// ---------------------------------------------------------------------------

const shellPath = resolve(__dirname, '../public/index.html');
// The app is not built in every checkout, which is normal in development where
// Vite serves it and proxies here. These tests only mean something when it is.
const built = existsSync(shellPath);

describe.runIf(built)('the policy a browser is given', () => {
  let server: TestServer;

  beforeEach(() => {
    server = createTestServer({ SIGNUP_MODE: 'open' }, { serveWebApp: true });
  });

  afterEach(() => {
    server.close();
  });

  async function policy(path = '/'): Promise<string> {
    const response = await server.request(path);
    return response.headers.get('content-security-policy') ?? '';
  }

  it('stops an artifact navigating its own frame off this instance', async () => {
    // The finding this whole file exists for. Without it, a page the publisher
    // controls can replace the artifact in the frame, inherit the sandbox flags
    // and the opaque origin, and keep the same contentWindow the app trusts.
    expect(await policy()).toContain("frame-src 'self'");
  });

  it('serves the policy on every screen, not only the front page', async () => {
    expect(await policy('/a/some-slug')).toContain("frame-src 'self'");
  });

  it('allows the shell’s own blocking theme script by hash', async () => {
    const { readFileSync } = await import('node:fs');
    const [themeHash] = inlineScriptHashes(readFileSync(shellPath, 'utf8'));

    expect(themeHash).toBeDefined();
    expect(await policy()).toContain(themeHash!);
  });

  it('does not fall back to unsafe-inline for scripts', async () => {
    // A hash that stopped matching would break the theme loudly. 'unsafe-inline'
    // would hide that, and hand any injected script the run of this origin.
    const header = await policy();
    const scriptSrc = header.split('; ').find((part) => part.startsWith('script-src'));

    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('keeps the app talking only to its own API', async () => {
    expect(await policy()).toContain("connect-src 'self'");
  });

  it('closes the ordinary ways an injected tag reaches out', async () => {
    const header = await policy();

    expect(header).toContain("object-src 'none'");
    expect(header).toContain("base-uri 'self'");
    expect(header).toContain("form-action 'self'");
  });

  it('leaves the artifact’s own content route to its own stricter policy', async () => {
    // /a/:slug/content sends `sandbox allow-scripts` and default-src 'none'.
    // The app policy must not be what governs a stranger's page.
    const response = await server.request('/a/does-not-exist/content');
    const header = response.headers.get('content-security-policy') ?? '';

    expect(header).not.toContain("frame-src 'self'");
  });
});

describe.runIf(existsSync(resolve(process.cwd(), 'public/diagram-frame.html')))(
  'the page that draws a diagram',
  () => {
    let server: TestServer;

    beforeEach(() => {
      server = createTestServer({ SIGNUP_MODE: 'open' }, { serveWebApp: true });
    });

    afterEach(() => {
      server.close();
    });

    async function policyOf(path: string): Promise<string> {
      const response = await server.request(path);
      expect(response.status).toBe(200);
      return response.headers.get('content-security-policy') ?? '';
    }

    it('is always sandboxed, even opened on its own, so it can never run as this origin', async () => {
      const policy = await policyOf('/diagram-frame.html');
      expect(policy).toContain('sandbox allow-scripts');
      expect(policy).not.toContain('allow-same-origin');
    });

    it('reaches no network and loads nothing but this instance\'s own scripts', async () => {
      const policy = await policyOf('/diagram-frame.html');
      expect(policy).toContain("connect-src 'none'");
      expect(policy).toContain("script-src 'self'");
      expect(policy).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
      expect(policy).toContain("form-action 'none'");
      expect(policy).toContain("frame-ancestors 'self'");
    });

    it('is the diagram page, not the app shell with the app\'s policy', async () => {
      const response = await server.request('/diagram-frame.html');
      const body = await response.text();
      expect(body).toContain('id="diagram"');
      expect(body).not.toContain('id="root"');
    });

    it('lets the sandboxed frame load built scripts, and only those', async () => {
      const page = await (await server.request('/diagram-frame.html')).text();
      const script = /src="(\/assets\/[^"]+\.js)"/.exec(page)?.[1];
      expect(script).toBeDefined();
      const asset = await server.request(script!);
      expect(asset.headers.get('access-control-allow-origin')).toBe('*');

      // Nothing outside the hashed build gets it: not the app shell, not the API.
      const shell = await server.request('/');
      expect(shell.headers.get('access-control-allow-origin')).toBeNull();
      const api = await server.request('/api/auth/methods');
      expect(api.headers.get('access-control-allow-origin')).toBeNull();
    });
  },
);
