/**
 * A document's version history: what the owner can read back.
 *
 * Owner only, through the same 'manage' check as editing and sharing. A past
 * version may hold exactly what the owner took out on purpose — a name, a
 * number, a paragraph that should not have gone out — so somebody the document
 * is shared with sees the current version and nothing before it. To them these
 * endpoints answer what they answer a stranger: not found.
 *
 * A Bearer token acts as its owner, so an agent with the owner's token reads
 * history like the owner does. Its reads are recorded as agent reads.
 */

import type { Hono } from 'hono';
import type { ArtifactVersionDetail, ArtifactVersionsResponse } from '@open-artifact/shared';
import type { AppContext, AppEnv } from '../app.js';
import { ApiError } from '../../errors.js';
import { requireUser, currentUser } from '../session.js';
import { requireAccess } from '../../artifacts/access.js';
import { recordView } from './views.js';

const NO_VIEWS = { views: 0, ownerViews: 0, otherViews: 0 };

export function registerVersionRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { artifacts, sharing, views, config } = context;

  /** Every version, newest first, without content. */
  app.get('/api/artifacts/:id/versions', requireUser, (c) => {
    const artifact = artifacts.get(c.req.param('id'));
    requireAccess(currentUser(c), sharing.accessFactsFor(artifact), 'manage');

    const owner = context.auth.findUserById(artifact.ownerId);
    const perVersion = views.perVersion(artifact.id);
    const body: ArtifactVersionsResponse = {
      artifactId: artifact.id,
      slug: artifact.slug,
      url: `${config.baseUrl}/a/${artifact.slug}`,
      currentVersion: artifact.version,
      publishedBy: { email: owner?.email ?? null, displayName: owner?.displayName ?? null },
      retentionDays: views.retentionDays,
      versions: artifacts.listVersions(artifact.id).map((version) => ({
        ...version,
        views: perVersion.get(version.version) ?? NO_VIEWS,
      })),
    };
    c.header('Cache-Control', 'private, no-store');
    return c.json(body);
  });

  /**
   * One version, with its content, shaped like GET /api/artifacts/:id.
   *
   * Opening a version is reading it, so it is recorded like any other open,
   * against that version: a browser open is a view (the owner's, per the
   * views rules), a token read is an agent read. `record=false` is for a
   * client fetching a version only to compare against, such as the web app's
   * diff, which must not count as having read it.
   */
  app.get('/api/artifacts/:id/versions/:version', requireUser, (c) => {
    const artifact = artifacts.get(c.req.param('id'));
    const facts = sharing.accessFactsFor(artifact);
    requireAccess(currentUser(c), facts, 'manage');

    const version = versionNumber(c.req.param('version'));
    const detail = artifacts.getVersion(artifact.id, version);

    if (c.req.query('record') !== 'false') {
      recordView(c, context, { id: artifact.id, version }, facts, 'browser');
    }

    const body: ArtifactVersionDetail = { ...detail, url: `${config.baseUrl}/a/${artifact.slug}` };
    c.header('Cache-Control', 'private, no-store');
    return c.json(body);
  });
}

/** A whole number from 1 up, or a plain refusal. */
export function versionNumber(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw))) {
    throw new ApiError('validation_failed', 'version must be a whole number from 1 up.');
  }
  return Number(raw);
}
