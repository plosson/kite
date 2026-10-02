/**
 * Grouping a person's kites into their workspaces, done client-side.
 *
 * The interesting behaviour is the ordering within a group: it used to put
 * every own kite before every shared one, regardless of how old either was.
 * It should instead read newest-first across both, so a shared kite someone
 * just commented on does not get buried under own kites nobody has touched
 * in months.
 */

import { describe, expect, it } from 'vitest';
import { groupByWorkspace, INBOX_ID, type ListedArtifact } from '../src/workspaces.js';
import type { ArtifactSummary, SharedArtifact, WorkspaceSummary } from '../src/api.js';

function artifact(id: string, updatedAt: string, extra: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    id,
    slug: `slug-${id}`,
    ownerId: 'usr_me',
    isPublic: 0,
    expiresAt: null,
    type: 'markdown',
    title: id,
    description: null,
    summary: null,
    summaryVersion: null,
    version: 1,
    url: `https://example.test/a/${id}`,
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  };
}

function shared(id: string, updatedAt: string, extra: Partial<SharedArtifact> = {}): SharedArtifact {
  return {
    ...artifact(id, updatedAt, { ownerId: 'usr_them' }),
    ownerName: 'Them',
    ownerEmail: 'them@example.test',
    ...extra,
  };
}

const RESEARCH: WorkspaceSummary = { id: 'ws_research', name: 'Research', description: 'Papers', count: 0 };

function artifactsIn(groups: ReturnType<typeof groupByWorkspace>, workspaceId: string): ListedArtifact[] {
  return groups.find((group) => group.workspace.id === workspaceId)?.artifacts ?? [];
}

describe('groupByWorkspace', () => {
  it('sorts a workspace’s kites newest first, mixing own and shared by date rather than by who owns them', () => {
    const mine = [artifact('old_mine', '2026-01-01T00:00:00.000Z', { workspaceId: 'ws_research' })];
    const theirs = [
      shared('new_shared', '2026-01-03T00:00:00.000Z', { workspaceId: 'ws_research' }),
      shared('mid_shared', '2026-01-02T00:00:00.000Z', { workspaceId: 'ws_research' }),
    ];
    const groups = groupByWorkspace([RESEARCH], mine, theirs);
    expect(artifactsIn(groups, 'ws_research').map((a) => a.id)).toEqual(['new_shared', 'mid_shared', 'old_mine']);
  });

  it('keeps kites with the same updatedAt in their original (own-before-shared) order', () => {
    const tie = '2026-01-01T00:00:00.000Z';
    const mine = [artifact('mine', tie, { workspaceId: 'ws_research' })];
    const theirs = [shared('theirs', tie, { workspaceId: 'ws_research' })];
    const groups = groupByWorkspace([RESEARCH], mine, theirs);
    expect(artifactsIn(groups, 'ws_research').map((a) => a.id)).toEqual(['mine', 'theirs']);
  });

  it('sorts Inbox the same way', () => {
    const mine = [artifact('old', '2026-01-01T00:00:00.000Z'), artifact('new', '2026-01-05T00:00:00.000Z')];
    const groups = groupByWorkspace([], mine, []);
    expect(artifactsIn(groups, INBOX_ID).map((a) => a.id)).toEqual(['new', 'old']);
  });
});
