/**
 * Sorting what a person can see into their workspaces.
 *
 * Done here, from the two listings, rather than asked of the server, so a move
 * shows the instant it is made: the row's workspaceId changes and the groups
 * follow. Counts are worked out here for the same reason.
 *
 * A kite whose workspace is not in the list — deleted in another tab a moment
 * ago — is shown in Inbox, which is where the server now has it too.
 */

import type { ArtifactSummary, SharedArtifact, WorkspaceSummary } from './api.js';

export const INBOX_ID = 'inbox';
const INBOX_DESCRIPTION = 'Kites that are not sorted into a workspace yet.';

export type ListedArtifact = ArtifactSummary & { ownerName?: string | null; ownerEmail?: string | null };

export interface WorkspaceGroup {
  workspace: WorkspaceSummary;
  artifacts: ListedArtifact[];
}

export function groupByWorkspace(
  workspaces: WorkspaceSummary[],
  mine: ArtifactSummary[],
  shared: SharedArtifact[],
): WorkspaceGroup[] {
  const known = new Set(workspaces.map((workspace) => workspace.id));
  const byId = new Map<string, ListedArtifact[]>(workspaces.map((workspace) => [workspace.id, []]));
  if (!byId.has(INBOX_ID)) byId.set(INBOX_ID, []);

  for (const artifact of [...mine, ...shared] as ListedArtifact[]) {
    const id = artifact.workspaceId && known.has(artifact.workspaceId) ? artifact.workspaceId : INBOX_ID;
    byId.get(id)?.push(artifact);
  }

  // Before the first load the list is empty, but Inbox still has to exist.
  const ordered = known.has(INBOX_ID)
    ? workspaces
    : [{ id: INBOX_ID, name: 'Inbox', description: INBOX_DESCRIPTION, count: 0 }, ...workspaces];

  return ordered.map((workspace) => {
    const artifacts = byId.get(workspace.id) ?? [];
    return { workspace: { ...workspace, count: artifacts.length }, artifacts };
  });
}
