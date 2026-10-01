/**
 * Workspaces: one level of folders a person sorts their own view into.
 *
 * Everything here is scoped to one person. A workspace somebody else owns is
 * answered exactly like one that does not exist, so ids cannot be probed.
 *
 * Inbox is not stored. A kite with no placement row is in Inbox, which is why
 * moving a kite to Inbox deletes its placement rather than writing one.
 */

import { and, eq } from 'drizzle-orm';
import { INBOX_ID, INBOX_NAME, INBOX_DESCRIPTION, type WorkspaceSummary } from '@open-artifact/shared';
import type { Db } from '../db/index.js';
import { workspaces, workspacePlacements, type WorkspaceRow } from '../db/schema.js';
import { newId } from '../ids.js';
import { nowIso } from '../time.js';
import { ApiError, notFound } from '../errors.js';

// Re-exported so existing imports of these from this module keep working.
export { INBOX_ID, INBOX_NAME, INBOX_DESCRIPTION };

const MAX_NAME = 60;
const MAX_DESCRIPTION = 500;

export class WorkspaceService {
  constructor(private readonly db: Db) {}

  /** Inbox first, then the person's workspaces by name. Counts only what `visible` holds. */
  list(userId: string, visible: ReadonlySet<string>): WorkspaceSummary[] {
    const rows = this.rowsFor(userId);
    const placements = this.placementsFor(userId);

    const counts = new Map<string, number>([[INBOX_ID, 0]]);
    for (const artifactId of visible) {
      const workspaceId = placements.get(artifactId) ?? INBOX_ID;
      counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
    }

    const sorted = [...rows].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
    return [
      { id: INBOX_ID, name: INBOX_NAME, description: INBOX_DESCRIPTION, count: counts.get(INBOX_ID) ?? 0 },
      ...sorted.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        count: counts.get(row.id) ?? 0,
      })),
    ];
  }

  create(userId: string, input: { name: unknown; description: unknown }): WorkspaceSummary {
    const name = requireText(input.name, 'name', MAX_NAME);
    const description = requireText(input.description, 'description', MAX_DESCRIPTION);
    this.requireFreeName(userId, name, null);

    const timestamp = nowIso();
    const row = { id: newId('ws'), userId, name, description, createdAt: timestamp, updatedAt: timestamp };
    try {
      this.db.insert(workspaces).values(row).run();
    } catch (error) {
      if (isUniqueNameViolation(error)) throw duplicateName(name);
      throw error;
    }
    return { id: row.id, name, description, count: 0 };
  }

  update(
    userId: string,
    workspaceId: string,
    input: { name?: unknown; description?: unknown },
  ): WorkspaceSummary {
    const existing = this.requireOwned(userId, workspaceId);
    const name = input.name === undefined ? existing.name : requireText(input.name, 'name', MAX_NAME);
    const description =
      input.description === undefined
        ? existing.description
        : requireText(input.description, 'description', MAX_DESCRIPTION);
    this.requireFreeName(userId, name, existing.id);

    try {
      this.db
        .update(workspaces)
        .set({ name, description, updatedAt: nowIso() })
        .where(eq(workspaces.id, existing.id))
        .run();
    } catch (error) {
      if (isUniqueNameViolation(error)) throw duplicateName(name);
      throw error;
    }
    return { id: existing.id, name, description, count: 0 };
  }

  /** Its placements go with it, through the foreign key, so its kites are back in Inbox. */
  delete(userId: string, workspaceId: string): void {
    const existing = this.requireOwned(userId, workspaceId);
    this.db.delete(workspaces).where(eq(workspaces.id, existing.id)).run();
  }

  /**
   * Put one kite in one of this person's workspaces, or back in Inbox. The
   * caller has already checked that the person can see the kite.
   */
  place(userId: string, artifactId: string, workspaceId: string): string {
    const target = workspaceId === INBOX_ID ? null : this.requireOwned(userId, workspaceId);

    this.db.transaction((tx) => {
      tx.delete(workspacePlacements)
        .where(and(eq(workspacePlacements.userId, userId), eq(workspacePlacements.artifactId, artifactId)))
        .run();
      if (target) {
        tx.insert(workspacePlacements)
          .values({
            id: newId('wsp'),
            userId,
            artifactId,
            workspaceId: target.id,
            createdAt: nowIso(),
          })
          .run();
      }
    });
    return target ? target.id : INBOX_ID;
  }

  /** By id, or by name with case and surrounding spaces ignored. "inbox" is always Inbox. */
  resolve(userId: string, idOrName: string): { id: string; name: string } {
    const wanted = idOrName.trim();
    if (normaliseName(wanted) === INBOX_ID) return { id: INBOX_ID, name: INBOX_NAME };

    const rows = this.rowsFor(userId);
    const match =
      rows.find((row) => row.id === wanted) ??
      rows.find((row) => normaliseName(row.name) === normaliseName(wanted));
    if (!match) throw notFound('workspace');
    return { id: match.id, name: match.name };
  }

  /** Artifact id to workspace id. A kite in Inbox has no entry. */
  placementsFor(userId: string): Map<string, string> {
    const rows = this.db
      .select({ artifactId: workspacePlacements.artifactId, workspaceId: workspacePlacements.workspaceId })
      .from(workspacePlacements)
      .where(eq(workspacePlacements.userId, userId))
      .all();
    return new Map(rows.map((row) => [row.artifactId, row.workspaceId]));
  }

  private rowsFor(userId: string): WorkspaceRow[] {
    return this.db.select().from(workspaces).where(eq(workspaces.userId, userId)).all();
  }

  private requireOwned(userId: string, workspaceId: string): WorkspaceRow {
    if (workspaceId === INBOX_ID) {
      throw new ApiError('validation_failed', 'Inbox is built in and cannot be changed.');
    }
    const row = this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.userId, userId)))
      .get();
    if (!row) throw notFound('workspace');
    return row;
  }

  /**
   * Compared in JS, over this person's own (small) set of rows, rather than
   * with SQLite's `lower()` in the query: `lower()` is ASCII-only, so it would
   * wave "Études" through as different from itself were it ever given a
   * different-case match to find, and miss "études" beside "Études" too.
   */
  private requireFreeName(userId: string, name: string, exceptId: string | null): void {
    if (normaliseName(name) === INBOX_ID) {
      throw new ApiError('name_taken', '"Inbox" is built in. Choose another name.');
    }
    const clash = this.rowsFor(userId).find((row) => normaliseName(row.name) === normaliseName(name));
    if (clash && clash.id !== exceptId) {
      throw duplicateName(name);
    }
  }
}

/**
 * The same name, as far as a duplicate check cares: composed (not decomposed)
 * and case-folded. Used for the reserved name, the duplicate check and
 * resolving by name, so all three agree on what counts as "the same".
 */
function normaliseName(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

function duplicateName(name: string): ApiError {
  return new ApiError('name_taken', `You already have a workspace called "${name}".`);
}

/**
 * The JS-side check above is the real guard; this is a backstop for the rare
 * race the JS check cannot see (two requests from the same person at once).
 * The unique index stays `lower()`-based, an ASCII backstop of its own, so a
 * violation here is reported the same way the JS check would have.
 */
function isUniqueNameViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

function requireText(value: unknown, field: 'name' | 'description', max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError('validation_failed', `A workspace needs a ${field}.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ApiError('validation_failed', `A workspace ${field} can be at most ${max} characters.`);
  }
  return trimmed;
}
