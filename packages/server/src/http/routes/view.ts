/**
 * Serving an artifact's own bytes.
 *
 * The threat this file exists to close: an artifact is written by an AI and read
 * by a person who is signed in. If script inside an artifact could reach the
 * reader's session, publishing an artifact would mean handing over an account.
 *
 * The page a reader opens is a screen in the web app. This endpoint serves only
 * the artifact's content, which the app then treats differently by format:
 *
 * - Markdown is rendered and sanitised here. Every script, event handler and
 *   dangerous URL is gone before the HTML exists (see render/markdown.ts), which
 *   is what makes it safe for the app to place in the page. Being in the page
 *   rather than a frame is what lets a reader select a paragraph and comment on
 *   it (Sprint 6).
 *
 * - HTML is the publisher's own document, scripts and all, so it never touches
 *   the app's page. The app loads it in an iframe with `sandbox="allow-scripts"`,
 *   which gives it an opaque origin: no access to cookies, no same-origin API
 *   calls.
 *
 * This endpoint also sends `Content-Security-Policy: sandbox allow-scripts`
 * itself. That matters because somebody can paste the content URL straight into a
 * tab, where there is no iframe to sandbox it. The header makes that tab opaque
 * too. Removing it reopens the hole.
 */

import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { renderMarkdown } from '../../render/markdown.js';
import { requireAccess, canAccess } from '../../artifacts/access.js';
import { BRIDGE_SCRIPT } from '../../comments/bridge.js';
import { recordView } from './views.js';
import { versionNumber } from './versions.js';

/**
 * What artifact content is allowed to do.
 *
 * `connect-src 'none'` blocks fetch and XHR, so script in an artifact cannot call
 * this server's API or send anything anywhere. Images, fonts and media are limited
 * to data: and blob: URLs; an artifact cannot load a remote image, because a
 * remote image request is both a tracking beacon and a way to smuggle data out in
 * a URL. The practical rule for publishers: an artifact must be self-contained.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  'sandbox allow-scripts',
].join('; ');

export function registerViewRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { artifacts, sharing, config } = context;

  /**
   * The artifact's own bytes. HTML artifacts are loaded from here into a
   * sandboxed frame; Markdown is fetched from here already rendered.
   */
  app.get('/a/:slug/content', (c) => {
    const current = artifacts.getBySlug(c.req.param('slug'));
    const facts = sharing.accessFactsFor(current);
    requireAccess(c.get('user') ?? null, facts, 'view');

    // A past version, for the owner's history view. Past versions are the
    // owner's alone (see routes/versions.ts), so asking for one needs 'manage'.
    // It is served under exactly the same headers as the current one: an old
    // HTML version is still the publisher's script, and still sandboxed.
    const requested = c.req.query('version');
    let artifact = current;
    let pastVersion = false;
    if (requested !== undefined) {
      const version = versionNumber(requested);
      if (version !== current.version) {
        requireAccess(c.get('user') ?? null, facts, 'manage');
        artifact = artifacts.getVersion(current.id, version);
        pastVersion = true;
      }
    }

    // Somebody pasted this address straight into a tab, so the app's own page
    // never loaded and never counted the open. The app's own frame and fetch
    // send a different Sec-Fetch-Dest, and are counted by the page instead.
    if (c.req.header('sec-fetch-dest') === 'document') {
      recordView(c, context, artifact, facts, 'browser');
    }

    c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'private, no-store');
    // Belt and braces with the CSP sandbox directive above, for older browsers.
    c.header('X-Frame-Options', 'SAMEORIGIN');

    const isPublic = artifact.isPublic === 1;

    if (artifact.type === 'markdown') {
      /**
       * Which version these bytes were rendered from.
       *
       * The web editor reads the source offsets out of this HTML and the raw
       * source from the API. If the two came from different versions the
       * offsets point at the wrong text, so a save replaces a paragraph the
       * person never touched. The existing baseVersion check cannot catch that,
       * because the version being sent is genuinely the current one. The editor
       * compares this header against the source it holds and reloads both
       * rather than splicing against a range it cannot trust.
       */
      c.header('X-Artifact-Version', String(artifact.version));

      // A public Markdown artifact is read by strangers on this instance's own
      // domain, so its off-site links are rewritten to pass through the /leaving
      // interstitial (see render/markdown.ts). A private artifact renders exactly
      // as before, so this changes nothing for the common case. The render runs
      // per request and nothing caches its result by content, so a public render
      // and a private one can never be served from the same cached string.
      return c.body(
        renderMarkdown(artifact.content, {
          wrapExternalLinks: isPublic ? { baseUrl: config.baseUrl } : undefined,
        }),
        200,
        { 'Content-Type': 'text/html; charset=utf-8' },
      );
    }

    // A canvas is data, not a page. Served as JSON under the same sandbox, so a
    // canvas never reaches the HTML path below and is never framed as a page.
    if (artifact.type === 'canvas') {
      return c.body(artifact.content, 200, { 'Content-Type': 'application/json; charset=utf-8' });
    }

    // Known gap: HTML artifacts are served byte for byte and are NOT rewritten,
    // so a public HTML artifact can still carry off-site links straight out.
    // Rewriting them would mean parsing and editing the publisher's own document,
    // which is exactly the thing we deliberately never do to HTML. In the normal
    // path the sandboxed iframe blocks top-window navigation anyway; the residual
    // risk is only someone who pastes this content URL straight into a tab, where
    // there is no frame, and then clicks a link. That case is not covered here.

    // The framed copy carries the comment bridge. Everything else — a pasted
    // URL, an API read, a download — is the publisher's bytes and nothing else,
    // which is what keeps "we do not modify HTML" true everywhere it is checked.
    const mayComment = canAccess(c.get('user') ?? null, sharing.accessFactsFor(artifact), 'comment');

    // Comments belong to the current version, so a past one never carries the bridge.
    if (c.req.query('frame') === '1' && mayComment && !pastVersion) {
      // Appended, never inserted. Appending cannot move the doctype, cannot drop
      // the page into quirks mode, and cannot disturb a byte the publisher wrote.
      // A page whose last bytes sit inside an unterminated script or comment
      // swallows the bridge, and commenting on that page quietly does not work —
      // which is the right way for this to fail.
      return c.body(`${artifact.content}\n${BRIDGE_SCRIPT}\n`, 200, {
        'Content-Type': 'text/html; charset=utf-8',
      });
    }

    return c.body(artifact.content, 200, { 'Content-Type': 'text/html; charset=utf-8' });
  });
}
