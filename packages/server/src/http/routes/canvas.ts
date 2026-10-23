/**
 * The canvas API: reading a canvas as JSON Canvas, and changing it with a batch
 * of operations.
 *
 * A canvas is an ordinary artifact (type "canvas"), so publishing, sharing,
 * versions, views and comments all go through the routes every other document
 * uses. These two routes add only what a whole-document PUT cannot do well:
 *
 * - GET  /api/artifacts/:id/canvas      the document as a JSON object, with
 *   the version it is, or with every Kite extra removed (`format=jsoncanvas-strict`).
 * - GET  /api/artifacts/:id/canvas/outline  a short tree of groups and one
 *   line per node, for an agent to find its way before reading everything.
 * - POST /api/artifacts/:id/canvas/ops  a batch of operations, applied all or
 *   nothing against the version the caller read, written as ONE new version.
 *
 * Conflicts are strict on purpose (Pierre's call for the first version): a batch
 * based on an older version is refused with 409 and nothing is applied. The
 * caller re-reads and sends its batch again. Operations name ids and absolute
 * positions, so re-sending after a re-read is safe.
 */

import type { Hono } from 'hono';
import { newId } from '../../ids.js';
import {
  applyCanvasOps,
  canvasOutline,
  CanvasError,
  parseCanvas,
  serialiseCanvas,
  strictCanvas,
  CANVAS_LIMITS,
} from '@open-artifact/shared';
import type { AppContext, AppEnv } from '../app.js';
import { ApiError } from '../../errors.js';
import { requireUser, currentUser } from '../session.js';
import { actorOf } from '../origin.js';
import { readJsonObject, jsonBodyCap } from '../body.js';
import { requireAccess } from '../../artifacts/access.js';
import type { ArtifactDetail } from '../../artifacts/service.js';
import { nowIso } from '../../time.js';
import { recordView } from './views.js';

export function registerCanvasRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { artifacts, sharing, config, rateLimiter } = context;
  const bodyCap = jsonBodyCap(CANVAS_LIMITS.maxBytes);

  // Its own bucket. One drag or one agent step is one batch, and sharing the
  // publish budget would stop a canvas session long before anything is wrong.
  const opsLimit = rateLimiter.middleware({
    by: 'user',
    bucket: 'canvas-ops',
    limit: config.limits.canvasOpsPerHour,
    windowSeconds: 3600,
  });

  app.get('/api/artifacts/:id/canvas', (c) => {
    const artifact = requireCanvas(artifacts.get(c.req.param('id')));
    const facts = sharing.accessFactsFor(artifact);
    requireAccess(c.get('user') ?? null, facts, 'view');

    const format = c.req.query('format') ?? 'jsoncanvas';
    if (format !== 'jsoncanvas' && format !== 'jsoncanvas-strict') {
      throw new ApiError('validation_failed', 'format must be "jsoncanvas" or "jsoncanvas-strict".');
    }
    // Same rule as GET /api/artifacts/:id: only a command-line read is counted.
    // The web app's canvas screen has already counted the open by slug.
    if (c.get('credential') === 'token') recordView(c, context, artifact, facts, 'api');

    const doc = parseCanvas(artifact.content);
    c.header('X-Artifact-Version', String(artifact.version));
    if (format === 'jsoncanvas-strict') return c.json(strictCanvas(doc));
    return c.json({
      ...doc,
      // Injected on every read and never stored, so a saved copy always says
      // which document and version it came from, and the store cannot drift.
      kite: { format: 'kite-canvas', formatVersion: 1, docId: artifact.id, version: artifact.version },
    });
  });

  app.get('/api/artifacts/:id/canvas/outline', (c) => {
    const artifact = requireCanvas(artifacts.get(c.req.param('id')));
    const facts = sharing.accessFactsFor(artifact);
    requireAccess(c.get('user') ?? null, facts, 'view');
    const frame = c.req.query('frame') || undefined;
    const depthRaw = c.req.query('depth');
    let depth: number | undefined;
    if (depthRaw !== undefined && depthRaw !== '') {
      depth = Number(depthRaw);
      if (!Number.isInteger(depth) || depth < 1) throw new ApiError('validation_failed', 'depth must be a whole number of 1 or more.');
    }
    if (c.get('credential') === 'token') recordView(c, context, artifact, facts, 'api');
    let outline;
    try {
      outline = canvasOutline(parseCanvas(artifact.content), { frame, depth });
    } catch (error) {
      if (error instanceof CanvasError) throw new ApiError('validation_failed', error.message);
      throw error;
    }
    c.header('X-Artifact-Version', String(artifact.version));
    return c.json({ docId: artifact.id, version: artifact.version, ...outline });
  });

  app.post('/api/artifacts/:id/canvas/ops', requireUser, opsLimit, async (c) => {
    const artifact = requireCanvas(artifacts.get(c.req.param('id')));
    requireAccess(currentUser(c), sharing.accessFactsFor(artifact), 'manage');

    const body = await readJsonObject(c.req.raw, bodyCap);
    const baseVersion = body.baseVersion;
    if (typeof baseVersion !== 'number' || !Number.isInteger(baseVersion)) {
      throw new ApiError('validation_failed', 'baseVersion is required and must be the version number you last read.');
    }
    // Refused before anything is worked out. Operations were chosen by looking
    // at baseVersion; applying them to anything else is guessing.
    if (baseVersion !== artifact.version) {
      throw new ApiError(
        'version_conflict',
        `This canvas has changed since you last read it. You based these operations on version ${baseVersion}, but it is now at version ${artifact.version}. Read it again and send them again.`,
        { currentVersion: artifact.version, baseVersion },
      );
    }
    const dryRun = body.dryRun === true;

    let result;
    try {
      result = applyCanvasOps(parseCanvas(artifact.content), body.ops, {
        now: nowIso(),
        newId: (prefix) => newId(prefix),
      });
    } catch (error) {
      if (error instanceof CanvasError) {
        throw new ApiError(
          'validation_failed',
          error.opIndex === undefined ? error.message : `ops[${error.opIndex}]: ${error.message}`,
          error.opIndex === undefined ? undefined : { opIndex: error.opIndex },
        );
      }
      throw error;
    }

    const applied = Array.isArray(body.ops) ? body.ops.length : 0;
    if (dryRun) {
      return c.json({ id: artifact.id, version: artifact.version, dryRun: true, applied, ids: result.ids, touched: result.touched });
    }

    // The service checks baseVersion again inside its write, which closes the
    // gap between the check above and this write when two batches race.
    const updated = artifacts.update(
      artifact.id,
      { content: serialiseCanvas(result.doc), baseVersion },
      actorOf(c),
    );

    return c.json({
      id: updated.id,
      version: updated.version,
      dryRun: false,
      applied,
      ids: result.ids,
      touched: result.touched,
    });
  });
}

function requireCanvas(artifact: ArtifactDetail): ArtifactDetail {
  if (artifact.type !== 'canvas') {
    throw new ApiError(
      'validation_failed',
      `This is a ${artifact.type} document, not a canvas. Read it with GET /api/artifacts/:id instead.`,
    );
  }
  return artifact;
}
