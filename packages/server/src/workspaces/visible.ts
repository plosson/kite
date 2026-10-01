/**
 * Which kites a person can see right now: what they own, and what is shared with
 * them and not expired. The same rule the two listings use, so a workspace count
 * never counts a kite the sidebar would not show.
 */

import { isExpired } from '@open-artifact/shared';
import type { ArtifactService } from '../artifacts/service.js';
import type { SharingService } from '../artifacts/sharing.js';
import type { UserRow } from '../db/schema.js';
import { nowIso } from '../time.js';

export function visibleArtifactIds(
  artifacts: ArtifactService,
  sharing: SharingService,
  user: UserRow,
): Set<string> {
  const now = nowIso();
  const ids = new Set(artifacts.listOwnedBy(user.id).map((artifact) => artifact.id));
  for (const shared of sharing.sharedWith(user)) {
    if (!isExpired(shared.expiresAt, now)) ids.add(shared.id);
  }
  return ids;
}
