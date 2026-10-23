/**
 * Who opened a document: what the owner can read back.
 *
 * Both endpoints answer only about the caller's own documents. The per-document
 * one goes through the same 'manage' check as editing and sharing, so somebody
 * a document is shared with is told exactly what a stranger is: not found.
 *
 * Recording lives in `recordView`, called by the routes that serve a document.
 */

import type { Context, Hono } from 'hono';
import { VIEWS_RECENT_DEFAULT_LIMIT, VIEWS_RECENT_MAX_LIMIT, type ViewClient } from '@open-artifact/shared';
import type { AppContext, AppEnv } from '../app.js';
import { ApiError } from '../../errors.js';
import { requireUser, currentUser } from '../session.js';
import { requireAccess, accessReason, type ArtifactAccessFacts } from '../../artifacts/access.js';
import { addressOf } from '../rate-limit.js';

export function registerViewsRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { artifacts, sharing, views, config } = context;

  /** How one document has been read. Owner only. */
  app.get('/api/artifacts/:id/views', requireUser, (c) => {
    const artifact = artifacts.get(c.req.param('id'));
    requireAccess(currentUser(c), sharing.accessFactsFor(artifact), 'manage');
    c.header('Cache-Control', 'private, no-store');
    return c.json(views.forArtifact(artifact, recentLimit(c.req.query('limit'))));
  });

  /** Every document I own, with how each has been read. */
  app.get('/api/views', requireUser, (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(views.summaryFor(currentUser(c).id, config.baseUrl));
  });
}

/**
 * Records that whoever is asking just opened this document. Call it only after
 * the access check has passed, with the facts that check used.
 *
 * `client` is what the route knows about who is reading. A route that a
 * browser reaches says 'browser', and a command-line token turns that into
 * 'api' here, because a token is an agent whatever route it calls.
 */
export function recordView(
  c: Context<AppEnv>,
  context: AppContext,
  artifact: { id: string; version: number },
  facts: ArtifactAccessFacts,
  client: ViewClient,
): void {
  const principal = c.get('user') ?? null;
  context.views.recordSafely(
    {
      artifact,
      principal,
      access: accessReason(principal, facts),
      client: c.get('credential') === 'token' ? 'api' : client,
      address: addressOf(c),
      userAgent: c.req.header('user-agent') ?? '',
    },
    c.get('logger'),
  );
}

/** The default when left out; refused when not a whole number from 1 up; capped at the most. */
function recentLimit(raw: string | undefined): number {
  if (raw === undefined) return VIEWS_RECENT_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new ApiError('validation_failed', 'limit must be a whole number from 1 up.');
  }
  return Math.min(Number(raw), VIEWS_RECENT_MAX_LIMIT);
}
