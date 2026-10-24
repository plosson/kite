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
 * - GET  /api/artifacts/:id/canvas/image  the canvas drawn as a PNG or SVG,
 *   as the web app shows it, for an agent or a person to look at or pass on.
 * - POST /api/artifacts/:id/canvas/ops  a batch of operations, applied all or
 *   nothing against the version the caller read, written as ONE new version.
 *
 * Conflicts are strict on purpose (Pierre's call for the first version): a batch
 * based on an older version is refused with 409 and nothing is applied. The
 * caller re-reads and sends its batch again. Operations name ids and absolute
 * positions, so re-sending after a re-read is safe.
 */

import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
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
import { canAccess, requireAccess } from '../../artifacts/access.js';
import type { ArtifactDetail } from '../../artifacts/service.js';
import { nowIso } from '../../time.js';
import { recordView } from './views.js';
import { requireKnownIcons } from '../../canvas/icons.js';
import {
  CANVAS_IMAGE_LIMITS,
  CanvasImageError,
  canvasImage,
  RENDERER_VERSION,
  type CanvasImageOptions,
  type KiteRef,
} from '../../canvas/image/index.js';
import { addressOf, refusal } from '../rate-limit.js';
import { versionNumber } from './versions.js';

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
      kite: { ...doc.kite, format: 'kite-canvas', formatVersion: 1, docId: artifact.id, version: artifact.version },
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

  /**
   * The canvas drawn as an image, by the server, the way the web app draws it.
   *
   * Read like the canvas itself: whoever may open it may have its picture. A
   * past version (`version`) is the owner's only, as with the versions routes.
   * A token read is recorded as an agent read, unless `record=false`.
   *
   * Drawing is real work, so it has its own hourly budget, and the answer
   * carries an ETag: asking again with If-None-Match for an image that would
   * come out the same is a 304 and costs nothing from that budget.
   */
  app.get('/api/artifacts/:id/canvas/image', async (c) => {
    const artifact = requireCanvas(artifacts.get(c.req.param('id')));
    const facts = sharing.accessFactsFor(artifact);
    const user = c.get('user') ?? null;
    requireAccess(user, facts, 'view');

    const options = imageOptions(c);
    const versionRaw = c.req.query('version');
    let version = artifact.version;
    let content = artifact.content;
    if (versionRaw !== undefined) {
      requireAccess(user, facts, 'manage');
      version = versionNumber(versionRaw);
      content = artifacts.getVersion(artifact.id, version).content;
    }
    if (c.get('credential') === 'token' && c.req.query('record') !== 'false') {
      recordView(c, context, { id: artifact.id, version }, facts, 'api');
    }

    const doc = parseCanvas(content);
    if (options.node !== undefined && !doc.nodes.some((n) => n.id === options.node)) {
      throw new ApiError('validation_failed', `This canvas has no node "${options.node}" at version ${version}.`);
    }
    // What Kite cards show depends on who is reading: a title they may see, or that they cannot open it.
    const refs = new Map<string, KiteRef>();
    for (const node of doc.nodes) {
      const ref = node.kite?.kind === 'kite' ? node.kite.ref : undefined;
      if (!ref || refs.has(ref)) continue;
      const target = artifacts.find(ref);
      if (target && canAccess(user, sharing.accessFactsFor(target), 'view')) refs.set(ref, { title: target.title, type: target.type });
    }

    const etag = `"${createHash('sha256')
      .update(JSON.stringify([RENDERER_VERSION, artifact.id, version, options, [...refs].sort(([a], [b]) => (a < b ? -1 : 1))]))
      .digest('base64url')
      .slice(0, 32)}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'private, no-cache');
    c.header('X-Artifact-Version', String(version));
    if (matches(c.req.header('if-none-match'), etag)) return c.body(null, 304);

    const retryAfter = rateLimiter.check('canvas-image', user?.id ?? addressOf(c), {
      limit: config.limits.canvasImagesPerHour,
      windowSeconds: 3600,
    });
    if (retryAfter !== null) throw refusal(c, retryAfter);

    let image;
    try {
      image = await canvasImage(doc, options, refs);
    } catch (error) {
      if (error instanceof CanvasImageError) throw new ApiError('validation_failed', error.message);
      throw error;
    }
    c.header('Content-Type', image.contentType);
    c.header('Content-Disposition', disposition(artifact.title, options.format));
    c.header('X-Canvas-Origin', `${image.origin.x},${image.origin.y}`);
    return c.body(image.body);
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
    requireKnownIcons(result.doc);

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

/** The image's options from the query, each checked, with its default when left out. */
function imageOptions(c: Context<AppEnv>): CanvasImageOptions {
  const q = (name: string) => {
    const value = c.req.query(name);
    return value === undefined || value === '' ? undefined : value;
  };
  const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const value = q(name) ?? fallback;
    if (!(allowed as readonly string[]).includes(value)) {
      throw new ApiError('validation_failed', `${name} must be ${allowed.map((a) => `"${a}"`).join(' or ')}.`);
    }
    return value as T;
  };
  const { minScale, maxScale, defaultScale, maxPadding, defaultPadding } = CANVAS_IMAGE_LIMITS;

  const scaleRaw = q('scale');
  const scale = scaleRaw === undefined ? defaultScale : Number(scaleRaw);
  if (scaleRaw !== undefined && (!/^\d+(\.\d+)?$/.test(scaleRaw) || scale < minScale || scale > maxScale)) {
    throw new ApiError('validation_failed', `scale must be a number from ${minScale} to ${maxScale}.`);
  }
  const paddingRaw = q('padding');
  const padding = paddingRaw === undefined ? defaultPadding : Number(paddingRaw);
  if (paddingRaw !== undefined && (!/^\d+$/.test(paddingRaw) || padding > maxPadding)) {
    throw new ApiError('validation_failed', `padding must be a whole number of canvas pixels from 0 to ${maxPadding}.`);
  }
  return {
    format: oneOf('format', ['png', 'svg'] as const, 'png'),
    node: q('node'),
    scale,
    padding,
    background: oneOf('background', ['theme', 'transparent'] as const, 'theme'),
    grid: oneOf('grid', ['true', 'false'] as const, 'true') === 'true',
  };
}

/** Whether an If-None-Match header names this ETag. */
function matches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((tag) => {
    const t = tag.trim();
    return t === '*' || t === etag || t === `W/${etag}`;
  });
}

/** Shown in place, saved under the document's title. */
function disposition(title: string, format: 'png' | 'svg'): string {
  // Control characters and what file systems refuse in a name become spaces.
  const cleaned = [...title].map((ch) => (ch < ' ' || ch === '\u007f' || '/\\:*?"<>|'.includes(ch) ? ' ' : ch)).join('');
  const name = `${cleaned.replace(/\s+/g, ' ').trim().slice(0, 120) || 'canvas'}.${format}`;
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
