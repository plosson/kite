/**
 * Who opened a document, for the person who published it.
 *
 * The question this answers is the publisher's: "did anybody read what I sent?"
 * Agents republish often, and without this there is no way to tell a document
 * that is being read from one that was glanced at once, or never opened.
 *
 * What is counted, and how, is decided here rather than in each route:
 *
 * - A **view** is anybody opening the document in a browser, the owner
 *   included: an author re-reading what an agent produced for them is reading
 *   it. `ownerViews` and `otherViews` split the count, by you and by others.
 * - "Opened since the latest version" means anybody, the owner included,
 *   opened the current version in a browser.
 * - A command-line client (agentio) or a connected assistant reading it is
 *   recorded, but as `agentFetches`. An agent checking its own work is not a
 *   reader.
 * - The same reader opening the same version again within
 *   VIEW_DEDUPE_MINUTES is one view, not several: a reload, a second tab or the
 *   page asking again after an edit is not renewed interest.
 *
 * What is kept about a reader is the least that still lets readers be counted.
 * A signed-in reader is their account. A signed-out reader of a public link is a
 * keyed hash of their address and browser: stable enough to count them once,
 * useless without this instance's secret, and never the address itself.
 *
 * Recording must never stand between somebody and the document. Callers go
 * through `recordSafely`, which logs and swallows a failure.
 */

import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  VIEW_ACCESS_PATHS,
  VIEW_DEDUPE_MINUTES,
  VIEWS_RECENT_DEFAULT_LIMIT,
  type ArtifactViewCounts,
  type ArtifactViewEvent,
  type ArtifactViewer,
  type ArtifactViewsResponse,
  type ArtifactViewSummary,
  type ViewAccessPath,
  type ViewClient,
  type ViewViewer,
  type ViewsSummaryResponse,
} from '@open-artifact/shared';
import type { Db } from '../db/index.js';
import { artifactViews, type UserRow } from '../db/schema.js';
import type { AccessReason } from '../artifacts/access.js';
import { newId } from '../ids.js';
import { nowIso } from '../time.js';
import type { Logger } from '../logging.js';

/** How often old rows are swept out, at most. Sweeping on every open would be waste. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Characters of the anonymous hash kept. 64 bits: no collisions at any realistic audience. */
const ANONYMOUS_KEY_LENGTH = 16;
/** Characters of it shown to the owner, which is enough to tell readers apart. */
const ANONYMOUS_ID_LENGTH = 8;

export interface ViewServiceOptions {
  db: Db;
  /** The instance secret. The anonymous-reader key is derived from it. */
  secret: string;
  retentionDays: number;
  /** Overridden in tests so time can move. */
  now?: () => string;
}

/** What a route knows about one open. */
export interface ViewInput {
  artifact: { id: string; version: number };
  principal: UserRow | null;
  /** Why the access check let them in. Anything else is not a view and is ignored. */
  access: AccessReason;
  client: ViewClient;
  /** Only used for a signed-out reader, and only ever hashed. */
  address: string;
  userAgent: string;
}

interface Aggregate {
  views: number;
  unique_viewers: number;
  anonymous_viewers: number;
  owner_views: number;
  other_viewers: number;
  agent_fetches: number;
  last_viewed_at: string | null;
  last_viewed_version: number | null;
  opened_latest: number;
}

export class ViewService {
  private readonly db: Db;
  private readonly anonymousKey: Buffer;
  readonly retentionDays: number;
  private readonly now: () => string;
  private lastPrunedAt = 0;

  constructor({ db, secret, retentionDays, now = nowIso }: ViewServiceOptions) {
    this.db = db;
    this.retentionDays = retentionDays;
    this.now = now;
    // A key of its own, derived rather than the secret itself, so this hash can
    // never be confused with, or help forge, anything else signed with it.
    this.anonymousKey = createHmac('sha256', secret).update('kite:artifact-views:v1').digest();
  }

  /**
   * Records one open. Returns whether a row was written: false when it folded
   * into a recent open by the same reader, or was not a view at all.
   */
  record(input: ViewInput): boolean {
    if (!isViewAccessPath(input.access)) return false;

    const viewedAt = this.now();
    const viewerKey = input.principal
      ? `u:${input.principal.id}`
      : `a:${this.anonymousKeyFor(input.address, input.userAgent)}`;
    const since = minus(viewedAt, VIEW_DEDUPE_MINUTES * 60 * 1000);

    const recent = this.db.get<{ id: string } | undefined>(sql`
      select id from artifact_views
      where artifact_id = ${input.artifact.id}
        and viewer_key = ${viewerKey}
        and version = ${input.artifact.version}
        and client = ${input.client}
        and viewed_at > ${since}
      limit 1
    `);
    if (recent) return false;

    this.db
      .insert(artifactViews)
      .values({
        id: newId('view'),
        artifactId: input.artifact.id,
        version: input.artifact.version,
        viewedAt,
        viewerUserId: input.principal?.id ?? null,
        viewerKey,
        access: input.access,
        client: input.client,
      })
      .run();

    this.pruneIfDue(viewedAt);
    return true;
  }

  /**
   * `record`, for a route serving the document. A failure here is logged and
   * the document is served anyway: a broken counter must never be a broken page.
   */
  recordSafely(input: ViewInput, logger: Logger | undefined): void {
    try {
      this.record(input);
    } catch (error) {
      logger?.warn('could not record a view', {
        artifactId: input.artifact.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Deletes everything older than the retention window. Returns how many rows went. */
  prune(): number {
    const cutoff = this.cutoff();
    return this.db.run(sql`delete from artifact_views where viewed_at < ${cutoff}`).changes;
  }

  /** Everything about how one document has been read. The caller checks it is the owner asking. */
  forArtifact(
    artifact: { id: string; version: number },
    recentLimit: number = VIEWS_RECENT_DEFAULT_LIMIT,
  ): ArtifactViewsResponse {
    const cutoff = this.cutoff();
    const aggregate = this.db.get<Aggregate>(sql`
      select
        coalesce(sum(case when ${HUMAN} then 1 else 0 end), 0) as views,
        count(distinct case when ${HUMAN} then viewer_key end) as unique_viewers,
        count(distinct case when ${HUMAN} and viewer_user_id is null then viewer_key end) as anonymous_viewers,
        count(distinct case when ${OTHER} then viewer_key end) as other_viewers,
        coalesce(sum(case when ${OWNER} then 1 else 0 end), 0) as owner_views,
        coalesce(sum(case when ${AGENT} then 1 else 0 end), 0) as agent_fetches,
        max(case when ${HUMAN} then viewed_at end) as last_viewed_at,
        (select v.version from artifact_views v
          where v.artifact_id = ${artifact.id} and v.viewed_at >= ${cutoff}
            and v.client = 'browser'
          order by v.viewed_at desc limit 1) as last_viewed_version,
        max(case when ${HUMAN} and version = ${artifact.version} then 1 else 0 end) as opened_latest
      from artifact_views
      where artifact_id = ${artifact.id} and viewed_at >= ${cutoff}
    `);

    // The access each reader last came in by is a correlated lookup rather than
    // a bare column: with both min() and max() in the query, SQLite does not say
    // which row a bare column comes from.
    const viewers = this.db
      .all<ViewerRow>(sql`
        select
          viewer_key, viewer_user_id, u.email as email, u.display_name as display_name,
          (select l.access from artifact_views l
            where l.artifact_id = artifact_views.artifact_id and l.viewer_key = artifact_views.viewer_key
              and l.client = 'browser' and l.viewed_at >= ${cutoff}
            order by l.viewed_at desc, l.id desc limit 1) as access,
          max(case when access = 'owner' then 1 else 0 end) as is_owner,
          max(viewed_at) as last_viewed_at, min(viewed_at) as first_viewed_at,
          count(*) as views, max(version) as last_version
        from artifact_views
        left join users u on u.id = artifact_views.viewer_user_id
        where artifact_id = ${artifact.id} and viewed_at >= ${cutoff} and ${HUMAN}
        group by viewer_key
        order by last_viewed_at desc
      `)
      .map((row): ArtifactViewer => ({
        viewer: this.viewerOf(row),
        isOwner: row.is_owner === 1,
        access: row.access as ViewAccessPath,
        views: row.views,
        firstViewedAt: row.first_viewed_at,
        lastViewedAt: row.last_viewed_at,
        lastVersion: row.last_version,
      }));

    const recent = this.db
      .all<EventRow>(sql`
        select viewer_key, viewer_user_id, u.email as email, u.display_name as display_name,
          access, client, viewed_at, version
        from artifact_views
        left join users u on u.id = artifact_views.viewer_user_id
        where artifact_id = ${artifact.id} and viewed_at >= ${cutoff}
        order by viewed_at desc, artifact_views.id desc
        limit ${recentLimit}
      `)
      .map((row): ArtifactViewEvent => ({
        viewedAt: row.viewed_at,
        version: row.version,
        viewer: this.viewerOf(row),
        access: row.access as ViewAccessPath,
        client: row.client as ViewClient,
      }));

    return {
      artifactId: artifact.id,
      version: artifact.version,
      latestVersionAt: this.latestVersionAt(artifact.id, artifact.version),
      retentionDays: this.retentionDays,
      totals: {
        views: aggregate?.views ?? 0,
        uniqueViewers: aggregate?.unique_viewers ?? 0,
        anonymousViewers: aggregate?.anonymous_viewers ?? 0,
        ownerViews: aggregate?.owner_views ?? 0,
        otherViews: (aggregate?.views ?? 0) - (aggregate?.owner_views ?? 0),
        otherViewers: aggregate?.other_viewers ?? 0,
        agentFetches: aggregate?.agent_fetches ?? 0,
      },
      lastViewedAt: aggregate?.last_viewed_at ?? null,
      lastViewedVersion: aggregate?.last_viewed_version ?? null,
      openedSinceLatestVersion: (aggregate?.opened_latest ?? 0) === 1,
      viewers,
      recent,
    };
  }

  /** Every document this person owns, newest change first, with how it has been read. */
  summaryFor(ownerId: string, baseUrl: string): ViewsSummaryResponse {
    const artifacts = this.perArtifact(ownerId).map(
      (row): ArtifactViewSummary => ({
        artifactId: row.id,
        slug: row.slug,
        title: row.title,
        url: `${baseUrl}/a/${row.slug}`,
        version: row.version,
        latestVersionAt: row.latest_version_at ?? row.updated_at,
        views: row.views,
        uniqueViewers: row.unique_viewers,
        lastViewedAt: row.last_viewed_at,
        lastViewedVersion: row.last_viewed_version,
        openedSinceLatestVersion: row.opened_latest === 1,
        ownerViews: row.owner_views,
        otherViews: row.views - row.owner_views,
        agentFetches: row.agent_fetches,
      }),
    );

    const opened = artifacts.filter((artifact) => artifact.views > 0).length;
    return {
      retentionDays: this.retentionDays,
      totals: {
        documents: artifacts.length,
        opened,
        neverOpened: artifacts.length - opened,
        notOpenedSinceLatestVersion: artifacts.filter((artifact) => !artifact.openedSinceLatestVersion).length,
        views: artifacts.reduce((total, artifact) => total + artifact.views, 0),
      },
      artifacts,
    };
  }

  /** The few numbers the owner's list shows, keyed by artifact id. */
  countsFor(ownerId: string): Map<string, ArtifactViewCounts> {
    return new Map(
      this.perArtifact(ownerId).map((row) => [
        row.id,
        {
          views: row.views,
          uniqueViewers: row.unique_viewers,
          lastViewedAt: row.last_viewed_at,
          openedSinceLatestVersion: row.opened_latest === 1,
          ownerViews: row.owner_views,
          otherViews: row.views - row.owner_views,
        },
      ]),
    );
  }

  // -------------------------------------------------------------------------

  /** One grouped query over everything a person owns. No row per document per request. */
  private perArtifact(ownerId: string): PerArtifactRow[] {
    const cutoff = this.cutoff();
    return this.db.all<PerArtifactRow>(sql`
      select
        a.id as id, a.slug as slug, a.title as title, a.current_version as version, a.updated_at as updated_at,
        (select av.created_at from artifact_versions av
          where av.artifact_id = a.id and av.version = a.current_version) as latest_version_at,
        coalesce(sum(case when ${HUMAN_V} then 1 else 0 end), 0) as views,
        count(distinct case when ${HUMAN_V} then v.viewer_key end) as unique_viewers,
        coalesce(sum(case when v.client = 'browser' and v.access = 'owner' then 1 else 0 end), 0) as owner_views,
        coalesce(sum(case when v.client != 'browser' then 1 else 0 end), 0) as agent_fetches,
        max(case when ${HUMAN_V} then v.viewed_at end) as last_viewed_at,
        (select lv.version from artifact_views lv
          where lv.artifact_id = a.id and lv.viewed_at >= ${cutoff}
            and lv.client = 'browser'
          order by lv.viewed_at desc limit 1) as last_viewed_version,
        max(case when ${HUMAN_V} and v.version = a.current_version then 1 else 0 end) as opened_latest
      from artifacts a
      left join artifact_views v on v.artifact_id = a.id and v.viewed_at >= ${cutoff}
      where a.owner_id = ${ownerId}
      group by a.id
      order by a.updated_at desc
    `);
  }

  private latestVersionAt(artifactId: string, version: number): string {
    const row = this.db.get<{ created_at: string } | undefined>(sql`
      select created_at from artifact_versions where artifact_id = ${artifactId} and version = ${version}
    `);
    return row?.created_at ?? this.now();
  }

  private viewerOf(row: { viewer_key: string; viewer_user_id: string | null; email: string | null; display_name: string | null }): ViewViewer {
    if (row.viewer_user_id && row.email) {
      return { kind: 'user', email: row.email, displayName: row.display_name };
    }
    return { kind: 'anonymous', id: row.viewer_key.slice(2, 2 + ANONYMOUS_ID_LENGTH) };
  }

  private anonymousKeyFor(address: string, userAgent: string): string {
    return createHmac('sha256', this.anonymousKey)
      .update(`${address}\n${userAgent}`)
      .digest('hex')
      .slice(0, ANONYMOUS_KEY_LENGTH);
  }

  private cutoff(): string {
    return minus(this.now(), this.retentionDays * 24 * 60 * 60 * 1000);
  }

  private pruneIfDue(at: string): void {
    const now = new Date(at).getTime();
    if (now - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    this.lastPrunedAt = now;
    this.prune();
  }
}

/** A person other than the owner, in a browser. The only thing counted as reading. */
/** A view: anybody in a browser, the owner included. */
const HUMAN = sql.raw(`(client = 'browser')`);
/** A view by somebody other than the owner. */
const OTHER = sql.raw(`(client = 'browser' and access != 'owner')`);
const OWNER = sql.raw(`(client = 'browser' and access = 'owner')`);
const AGENT = sql.raw(`(client != 'browser')`);
const HUMAN_V = sql.raw(`(v.client = 'browser')`);

interface ViewerRow {
  viewer_key: string;
  viewer_user_id: string | null;
  email: string | null;
  display_name: string | null;
  access: string;
  is_owner: number;
  last_viewed_at: string;
  first_viewed_at: string;
  views: number;
  last_version: number;
}

interface EventRow {
  viewer_key: string;
  viewer_user_id: string | null;
  email: string | null;
  display_name: string | null;
  access: string;
  client: string;
  viewed_at: string;
  version: number;
}

interface PerArtifactRow {
  id: string;
  slug: string;
  title: string;
  version: number;
  updated_at: string;
  latest_version_at: string | null;
  views: number;
  unique_viewers: number;
  owner_views: number;
  agent_fetches: number;
  last_viewed_at: string | null;
  last_viewed_version: number | null;
  opened_latest: number;
}

function isViewAccessPath(value: string): value is ViewAccessPath {
  return (VIEW_ACCESS_PATHS as readonly string[]).includes(value);
}

function minus(iso: string, milliseconds: number): string {
  return new Date(new Date(iso).getTime() - milliseconds).toISOString();
}
