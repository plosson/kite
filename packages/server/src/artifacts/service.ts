/**
 * Artifact storage: create, read, update, delete.
 *
 * Two rules worth knowing before reading the code:
 *
 * 1. Every write also writes a version row. An accidental overwrite is
 *    recoverable, comment anchors have a previous text to re-match against, and
 *    the owner can read every past version back (listVersions, getVersion).
 *
 * 2. Updates carry the version they were based on. If it does not match what is
 *    stored, the update is rejected. Two agents publishing to the same artifact is
 *    a realistic accident, and silently keeping only the last one loses work.
 *
 * Every committed change is announced on the change feed, after the comments
 * anchored to it have been re-checked, so whoever hears about a new version and
 * reads it back finds the comments already where they now belong.
 */

import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import type { ArtifactType, TimelineEvent } from '@open-artifact/shared';
import {
  isArtifactType,
  CanvasError,
  CANVAS_LIMITS,
  parseCanvas,
  serialiseCanvas,
  ARTIFACT_DESCRIPTION_MAX_LENGTH,
  ARTIFACT_SUMMARY_MAX_LENGTH,
  ARTIFACT_SUMMARY_MAX_LINES,
} from '@open-artifact/shared';
import type { Db } from '../db/index.js';
import { artifacts, artifactVersions, artifactStars, type ArtifactRow } from '../db/schema.js';
import { newId, newSlug } from '../ids.js';
import { nowIso } from '../time.js';
import { ApiError, notFound } from '../errors.js';
import { deriveTitle } from './title.js';
import type { Actor, ChangePublisher } from '../live/feed.js';

export interface CreateArtifactInput {
  ownerId: string;
  type: string;
  content: string;
  /** Optional. When given it is kept as-is and never re-derived on later updates. */
  title?: string | undefined;
  /** Required: one line on what the document is. */
  description: string;
  /** Required: up to ten lines on what it says. */
  summary: string;
  /**
   * The MCP connection that published this, stamped so the connection can later
   * find and edit its own work. Null, or left out, for the CLI and the web.
   */
  connectionId?: string | null;
}

export interface UpdateArtifactInput {
  content: string;
  type?: string | undefined;
  title?: string | undefined;
  /** Left out, the current one is kept. */
  description?: string | undefined;
  /** Left out, the current one is kept and falls one more version behind. */
  summary?: string | undefined;
  /** The version the caller last saw. Anything else means someone got there first. */
  baseVersion: number;
}

/**
 * What can change about a document without changing the document. None of it
 * makes a version, because none of it is content: retitling a library should not
 * read as fifty edits to fifty documents.
 */
export interface DescribeArtifactInput {
  title?: string | undefined;
  description?: string | undefined;
  summary?: string | undefined;
}

export interface ArtifactSummary {
  id: string;
  slug: string;
  ownerId: string;
  /** 1 when anybody with the link can read it. Kept as the stored 0/1. */
  isPublic: number;
  /** When everybody but the owner loses access. Null means never. */
  expiresAt: string | null;
  type: ArtifactType;
  title: string;
  description: string | null;
  summary: string | null;
  /** The version the summary was written against. Null when there is none. */
  summaryVersion: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactDetail extends ArtifactSummary {
  content: string;
}

/** One stored version, without its content. */
export interface StoredVersionSummary {
  version: number;
  createdAt: string;
  kind: 'published' | 'edited';
  type: ArtifactType;
  title: string;
  bytes: number;
  isCurrent: boolean;
}

/**
 * Re-checks every comment anchored to an artifact against its new content.
 * The comment service, seen from here.
 */
export interface AnchorRelocator {
  relocateAll(artifactId: string, newContent: string, artifactType: string): void;
}

export interface ArtifactServiceOptions {
  db: Db;
  anchors: AnchorRelocator;
  changes: ChangePublisher;
  maxArtifactBytes: number;
  /** How much one person may keep. Checked before every create. */
  maxArtifactsPerUser?: number;
  maxStorageBytesPerUser?: number;
}

export class ArtifactService {
  private readonly db: Db;
  private readonly anchors: AnchorRelocator;
  private readonly changes: ChangePublisher;
  private readonly maxArtifactBytes: number;
  private readonly maxArtifactsPerUser: number;
  private readonly maxStorageBytesPerUser: number;

  constructor({
    db,
    anchors,
    changes,
    maxArtifactBytes,
    maxArtifactsPerUser = Number.MAX_SAFE_INTEGER,
    maxStorageBytesPerUser = Number.MAX_SAFE_INTEGER,
  }: ArtifactServiceOptions) {
    this.db = db;
    this.anchors = anchors;
    this.changes = changes;
    this.maxArtifactBytes = maxArtifactBytes;
    this.maxArtifactsPerUser = maxArtifactsPerUser;
    this.maxStorageBytesPerUser = maxStorageBytesPerUser;
  }

  /**
   * What one person is currently using.
   *
   * Counted over current content rather than every version, because version
   * history is ours for recovering from an accident, not something to bill
   * somebody's quota for.
   */
  usageOf(ownerId: string): { artifacts: number; bytes: number } {
    const rows = this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.ownerId, ownerId))
      .all();

    return {
      artifacts: rows.length,
      bytes: rows.reduce((total, row) => total + Buffer.byteLength(row.content, 'utf8'), 0),
    };
  }

  private requireRoom(ownerId: string, incomingBytes: number): void {
    const usage = this.usageOf(ownerId);

    if (usage.artifacts >= this.maxArtifactsPerUser) {
      throw new ApiError(
        'validation_failed',
        `You have ${usage.artifacts} artifacts, which is all this instance allows. Delete something first.`,
        { artifacts: usage.artifacts, limit: this.maxArtifactsPerUser },
      );
    }

    if (usage.bytes + incomingBytes > this.maxStorageBytesPerUser) {
      throw new ApiError(
        'validation_failed',
        `That would put you over the ${formatBytes(this.maxStorageBytesPerUser)} this instance allows per person. Delete something first.`,
        { usedBytes: usage.bytes, limit: this.maxStorageBytesPerUser },
      );
    }
  }

  /** Nothing is announced: nobody can be listening to an artifact that did not exist. */
  create(input: CreateArtifactInput): ArtifactDetail {
    const type = this.requireType(input.type);
    const content = this.normaliseContent(type, this.requireContent(input.content));
    const explicitTitle = normaliseGivenTitle(input.title);
    const description = requireDescription(input.description);
    const summary = requireSummary(input.summary);
    this.requireRoom(input.ownerId, Buffer.byteLength(content, 'utf8'));

    const timestamp = nowIso();
    const row = {
      id: newId('art'),
      slug: newSlug(),
      ownerId: input.ownerId,
      connectionId: input.connectionId ?? null,
      type,
      title: explicitTitle ?? deriveTitle(type, content),
      titleIsExplicit: explicitTitle === null ? 0 : 1,
      description,
      summary,
      summaryVersion: 1,
      content,
      currentVersion: 1,
      isPublic: 0,
      // Nobody else can reach it yet, so there is nothing to expire. The
      // deadline is stamped when it is first shared.
      expiresAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.db.transaction((tx) => {
      tx.insert(artifacts).values(row).run();
      tx.insert(artifactVersions)
        .values({
          id: newId('ver'),
          artifactId: row.id,
          version: 1,
          type: row.type,
          title: row.title,
          content: row.content,
          createdAt: timestamp,
        })
        .run();
    });

    return toDetail(row as ArtifactRow);
  }

  update(id: string, input: UpdateArtifactInput, actor: Actor): ArtifactDetail {
    const existing = this.requireRow(id);
    const type = input.type === undefined ? existing.type : this.requireType(input.type);
    // A canvas is a different kind of thing, not a different spelling of the
    // same text. Turning one into Markdown, or the reverse, would hand every
    // comment, version and reader a document they cannot make sense of.
    if (type !== existing.type && (type === 'canvas' || existing.type === 'canvas')) {
      throw new ApiError(
        'validation_failed',
        `A ${existing.type} document cannot become a ${type} one. Publish a new document instead.`,
      );
    }
    const content = this.normaliseContent(type as ArtifactType, this.requireContent(input.content));
    const explicitTitle = normaliseGivenTitle(input.title);
    const description =
      input.description === undefined ? undefined : requireDescription(input.description);
    const summary = input.summary === undefined ? undefined : requireSummary(input.summary);

    if (!Number.isInteger(input.baseVersion)) {
      throw new ApiError(
        'validation_failed',
        'baseVersion is required and must be the version number you last saw.',
      );
    }

    if (input.baseVersion !== existing.currentVersion) {
      throw new ApiError(
        'version_conflict',
        `This artifact has changed since you last read it. You based this update on version ${input.baseVersion}, but it is now at version ${existing.currentVersion}. Read it again and re-apply your change.`,
        { currentVersion: existing.currentVersion, baseVersion: input.baseVersion },
      );
    }

    const titleIsExplicit = explicitTitle !== null || existing.titleIsExplicit === 1;
    const title =
      explicitTitle ??
      // A title someone chose on purpose survives content updates; a derived one
      // follows the content.
      (existing.titleIsExplicit === 1 ? existing.title : deriveTitle(type as ArtifactType, content));

    const version = existing.currentVersion + 1;
    const timestamp = nowIso();

    this.db.transaction((tx) => {
      tx.update(artifacts)
        .set({
          type,
          content,
          title,
          titleIsExplicit: titleIsExplicit ? 1 : 0,
          // Left out means unchanged. A summary left out stays pinned to the
          // version it was written against, which is how drift shows.
          ...(description === undefined ? {} : { description }),
          ...(summary === undefined ? {} : { summary, summaryVersion: version }),
          currentVersion: version,
          updatedAt: timestamp,
        })
        // Guarding on the version here too closes the gap between the read above
        // and this write when two requests arrive at the same moment.
        .where(and(eq(artifacts.id, id), eq(artifacts.currentVersion, existing.currentVersion)))
        .run();

      tx.insert(artifactVersions)
        .values({
          id: newId('ver'),
          artifactId: id,
          version,
          type,
          title,
          content,
          createdAt: timestamp,
        })
        .run();
    });

    // Ones whose passage survived keep their place; ones whose passage is gone
    // become document-level and are marked, rather than being moved to whatever
    // text now sits where they used to point.
    this.anchors.relocateAll(id, content, type);
    this.changes.publish({ kind: 'content', artifactId: id, version, actor });

    return this.get(id);
  }

  /**
   * Change what is said about a document without touching the document.
   *
   * No version is written and updatedAt stays put: the content did not change,
   * so the list a person sorts by recent change should not reshuffle because
   * somebody tidied the titles. A summary written here is written against the
   * current version, so it catches up.
   */
  describe(id: string, input: DescribeArtifactInput, actor: Actor): ArtifactDetail {
    const existing = this.requireRow(id);
    const title = normaliseGivenTitle(input.title);
    const description =
      input.description === undefined ? undefined : requireDescription(input.description);
    const summary = input.summary === undefined ? undefined : requireSummary(input.summary);

    if (title === null && description === undefined && summary === undefined) {
      throw new ApiError(
        'validation_failed',
        'Send at least one of title, description or summary.',
      );
    }

    this.db
      .update(artifacts)
      .set({
        ...(title === null ? {} : { title, titleIsExplicit: 1 }),
        ...(description === undefined ? {} : { description }),
        ...(summary === undefined ? {} : { summary, summaryVersion: existing.currentVersion }),
      })
      .where(eq(artifacts.id, id))
      .run();

    this.changes.publish({ kind: 'details', artifactId: id, version: existing.currentVersion, actor });
    return this.get(id);
  }

  get(id: string): ArtifactDetail {
    return toDetail(this.requireRow(id));
  }

  /** Null when there is no such artifact, for callers that must not throw. */
  findBySlug(slug: string): ArtifactDetail | null {
    const row = this.db.select().from(artifacts).where(eq(artifacts.slug, slug)).get();
    return row ? toDetail(row) : null;
  }

  getBySlug(slug: string): ArtifactDetail {
    const row = this.db.select().from(artifacts).where(eq(artifacts.slug, slug)).get();
    if (!row) throw notFound();
    return toDetail(row);
  }

  /** Everything this person published, newest change first. */
  listOwnedBy(ownerId: string): ArtifactSummary[] {
    return this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.ownerId, ownerId))
      .orderBy(desc(artifacts.updatedAt))
      .all()
      .map(toSummary);
  }

  /**
   * Every version of these artifacts, newest first, as timeline events. Only the
   * columns a timeline shows: never content, which for a few hundred versions
   * would be megabytes nobody asked for. Which ids a person may see is the
   * caller's to decide.
   */
  timelineOf(ids: Set<string>, limit: number): TimelineEvent[] {
    if (ids.size === 0) return [];
    return this.db
      .select({
        artifactId: artifactVersions.artifactId,
        version: artifactVersions.version,
        at: artifactVersions.createdAt,
        slug: artifacts.slug,
        title: artifacts.title,
        type: artifacts.type,
      })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(inArray(artifactVersions.artifactId, [...ids]))
      .orderBy(desc(artifactVersions.createdAt), desc(artifactVersions.version))
      .limit(limit)
      .all()
      .map((row) => ({
        artifactId: row.artifactId,
        slug: row.slug,
        title: row.title,
        type: row.type as ArtifactType,
        kind: row.version === 1 ? 'published' : 'edited',
        version: row.version,
        at: row.at,
      }));
  }

  /** Everything one MCP connection published, newest change first. */
  listByConnection(connectionId: string, limit?: number): ArtifactSummary[] {
    const query = this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.connectionId, connectionId))
      .orderBy(desc(artifacts.updatedAt));
    const rows = limit === undefined ? query.all() : query.limit(limit).all();
    return rows.map(toSummary);
  }

  /**
   * The connection that created an artifact, for scoping the MCP tools. Returns
   * null for a CLI or web publish, and undefined when there is no such artifact —
   * so a caller can tell "not yours" apart from "does not exist" and word the two
   * differently.
   */
  connectionIdOf(id: string): string | null | undefined {
    const row = this.db
      .select({ connectionId: artifacts.connectionId })
      .from(artifacts)
      .where(eq(artifacts.id, id))
      .get();
    return row === undefined ? undefined : row.connectionId;
  }

  // -------------------------------------------------------------------------
  // Stars
  //
  // A star is one person's private bookmark. Access is checked by the route
  // before any of these run — you can only star what you can already see — so
  // these methods just record the fact.
  // -------------------------------------------------------------------------

  /**
   * Star or unstar an artifact for one person. Idempotent either way: starring
   * what is already starred, or unstarring what is not, both leave one honest
   * state and never throw. Returns whether it is starred afterwards.
   */
  setStar(userId: string, artifactId: string, starred: boolean): boolean {
    if (starred) {
      const existing = this.db
        .select({ id: artifactStars.id })
        .from(artifactStars)
        .where(and(eq(artifactStars.userId, userId), eq(artifactStars.artifactId, artifactId)))
        .get();
      if (!existing) {
        this.db
          .insert(artifactStars)
          .values({
            id: newId('star'),
            userId,
            artifactId,
            createdAt: nowIso(),
          })
          .run();
      }
    } else {
      this.db
        .delete(artifactStars)
        .where(and(eq(artifactStars.userId, userId), eq(artifactStars.artifactId, artifactId)))
        .run();
    }
    return starred;
  }

  /** Whether one person has starred one artifact. */
  isStarredBy(userId: string, artifactId: string): boolean {
    return (
      this.db
        .select({ id: artifactStars.id })
        .from(artifactStars)
        .where(and(eq(artifactStars.userId, userId), eq(artifactStars.artifactId, artifactId)))
        .get() !== undefined
    );
  }

  /**
   * The ids this person has starred, as a set for O(1) lookup while annotating a
   * list. One query rather than one per row.
   */
  starredArtifactIdsFor(userId: string): Set<string> {
    const rows = this.db
      .select({ artifactId: artifactStars.artifactId })
      .from(artifactStars)
      .where(eq(artifactStars.userId, userId))
      .all();
    return new Set(rows.map((row) => row.artifactId));
  }

  delete(id: string, actor: Actor): void {
    const existing = this.requireRow(id);
    // Version rows and any stars go with it: the foreign keys cascade.
    this.db.delete(artifacts).where(eq(artifacts.id, existing.id)).run();
    this.changes.publish({ kind: 'deleted', artifactId: existing.id, actor });
  }

  /**
   * Every version of one artifact, newest first, without content. The size is
   * measured by the database, so listing a long history never loads it. Who may
   * see this is the caller's to decide.
   */
  listVersions(id: string): StoredVersionSummary[] {
    const current = this.requireRow(id).currentVersion;
    return this.db
      .select({
        version: artifactVersions.version,
        createdAt: artifactVersions.createdAt,
        type: artifactVersions.type,
        title: artifactVersions.title,
        bytes: sql<number>`length(cast(${artifactVersions.content} as blob))`,
      })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, id))
      .orderBy(desc(artifactVersions.version))
      .all()
      .map((row) => ({
        version: row.version,
        createdAt: row.createdAt,
        kind: row.version === 1 ? ('published' as const) : ('edited' as const),
        type: row.type as ArtifactType,
        title: row.title,
        bytes: Number(row.bytes),
        isCurrent: row.version === current,
      }));
  }

  /**
   * One past (or the current) version, in the same shape as `get`: the type,
   * title and content as they were then, `updatedAt` when it was written. The
   * description and summary are not versioned, so they are the current ones.
   * A version that does not exist is not found, like an artifact that does not.
   */
  getVersion(id: string, version: number): ArtifactDetail & { currentVersion: number; isCurrent: boolean } {
    const artifact = this.get(id);
    const row = this.db
      .select()
      .from(artifactVersions)
      .where(and(eq(artifactVersions.artifactId, id), eq(artifactVersions.version, version)))
      .get();
    if (!row) {
      throw new ApiError(
        'not_found',
        `This document has no version ${version}. It is at version ${artifact.version}.`,
        { currentVersion: artifact.version },
      );
    }
    return {
      ...artifact,
      type: row.type as ArtifactType,
      title: row.title,
      content: row.content,
      version: row.version,
      updatedAt: row.createdAt,
      currentVersion: artifact.version,
      isCurrent: row.version === artifact.version,
    };
  }

  /** How many versions an artifact has. Internal; used by tests and by anchor re-matching. */
  versionCount(id: string): number {
    return this.db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, id))
      .all().length;
  }

  private requireRow(id: string): ArtifactRow {
    const row = this.db.select().from(artifacts).where(eq(artifacts.id, id)).get();
    if (!row) throw notFound();
    return row;
  }

  private requireType(type: string): ArtifactType {
    if (!isArtifactType(type)) {
      throw new ApiError(
        'unsupported_type',
        `Artifacts can be "markdown", "html" or "canvas". Got "${type}".`,
      );
    }
    return type;
  }

  /**
   * What is stored for this type. Markdown and HTML are kept byte for byte. A
   * canvas is checked against JSON Canvas 1.0 and Kite's rules, then stored in
   * one canonical layout (one node per line), so the version history's line
   * diff shows which nodes changed.
   */
  private normaliseContent(type: ArtifactType, content: string): string {
    switch (type) {
      case 'markdown':
      case 'html':
        return content;
      case 'canvas': {
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > CANVAS_LIMITS.maxBytes) {
          throw new ApiError(
            'payload_too_large',
            `This canvas is ${formatBytes(bytes)}. A canvas can be up to ${formatBytes(CANVAS_LIMITS.maxBytes)}.`,
            { bytes, maxBytes: CANVAS_LIMITS.maxBytes },
          );
        }
        try {
          return this.requireCanvasSize(serialiseCanvas(parseCanvas(content)));
        } catch (error) {
          if (error instanceof CanvasError) {
            throw new ApiError('validation_failed', error.message);
          }
          throw error;
        }
      }
      default: {
        const unknown: never = type;
        throw new ApiError('unsupported_type', `Unknown type ${String(unknown)}.`);
      }
    }
  }

  private requireCanvasSize(content: string): string {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > CANVAS_LIMITS.maxBytes) {
      throw new ApiError(
        'payload_too_large',
        `This canvas would be ${formatBytes(bytes)}. A canvas can be up to ${formatBytes(CANVAS_LIMITS.maxBytes)}.`,
        { bytes, maxBytes: CANVAS_LIMITS.maxBytes },
      );
    }
    return content;
  }

  private requireContent(content: string): string {
    if (typeof content !== 'string' || content.length === 0) {
      throw new ApiError('validation_failed', 'content is required and cannot be empty.');
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.maxArtifactBytes) {
      throw new ApiError(
        'payload_too_large',
        `This artifact is ${formatBytes(bytes)}. This instance accepts up to ${formatBytes(this.maxArtifactBytes)}.`,
        { bytes, maxBytes: this.maxArtifactBytes },
      );
    }
    return content;
  }
}

function normaliseGivenTitle(title: string | undefined): string | null {
  if (title === undefined) return null;
  const trimmed = title.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) {
    throw new ApiError('validation_failed', 'title cannot be blank. Leave it out to derive one.');
  }
  return trimmed.slice(0, 200);
}

/**
 * One line, refused rather than cut when it is too long, so whoever wrote it
 * writes a shorter one instead of publishing half a sentence.
 */
function requireDescription(description: unknown): string {
  if (typeof description !== 'string') {
    throw new ApiError(
      'validation_failed',
      'description is required: one line saying what the document is and what it is for.',
    );
  }
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    throw new ApiError('validation_failed', 'description cannot be blank.');
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new ApiError('validation_failed', 'description must be a single line.');
  }
  const normalised = trimmed.replace(/\s+/g, ' ');
  if (normalised.length > ARTIFACT_DESCRIPTION_MAX_LENGTH) {
    throw new ApiError(
      'validation_failed',
      `description is ${normalised.length} characters. Keep it to ${ARTIFACT_DESCRIPTION_MAX_LENGTH}.`,
      { length: normalised.length, maxLength: ARTIFACT_DESCRIPTION_MAX_LENGTH },
    );
  }
  return normalised;
}

/** Up to ten lines. Refused rather than cut, for the same reason. */
function requireSummary(summary: unknown): string {
  if (typeof summary !== 'string') {
    throw new ApiError(
      'validation_failed',
      `summary is required: at most ${ARTIFACT_SUMMARY_MAX_LINES} lines on what the document says.`,
    );
  }
  const trimmed = summary.replace(/\r\n?/g, '\n').trim();
  if (trimmed.length === 0) {
    throw new ApiError('validation_failed', 'summary cannot be blank.');
  }
  const lines = trimmed.split('\n').length;
  if (lines > ARTIFACT_SUMMARY_MAX_LINES) {
    throw new ApiError(
      'validation_failed',
      `summary is ${lines} lines. Keep it to ${ARTIFACT_SUMMARY_MAX_LINES}.`,
      { lines, maxLines: ARTIFACT_SUMMARY_MAX_LINES },
    );
  }
  if (trimmed.length > ARTIFACT_SUMMARY_MAX_LENGTH) {
    throw new ApiError(
      'validation_failed',
      `summary is ${trimmed.length} characters. Keep it to ${ARTIFACT_SUMMARY_MAX_LENGTH}.`,
      { length: trimmed.length, maxLength: ARTIFACT_SUMMARY_MAX_LENGTH },
    );
  }
  return trimmed;
}

function toSummary(row: ArtifactRow): ArtifactSummary {
  return {
    id: row.id,
    slug: row.slug,
    ownerId: row.ownerId,
    isPublic: row.isPublic,
    expiresAt: row.expiresAt,
    type: row.type as ArtifactType,
    title: row.title,
    description: row.description,
    summary: row.summary,
    summaryVersion: row.summaryVersion,
    version: row.currentVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDetail(row: ArtifactRow): ArtifactDetail {
  return { ...toSummary(row), content: row.content };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
