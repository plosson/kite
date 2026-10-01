/**
 * A person's workspaces, and moving a kite between them.
 *
 * Every route acts on the caller's own workspaces only. Moving a kite needs only
 * that the caller can see it, the same rule as starring: a placement is a private
 * sorting and grants nothing.
 */

import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { ApiError } from '../../errors.js';
import { requireUser, currentUser } from '../session.js';
import { readJsonObject, jsonBodyCap } from '../body.js';
import { requireAccess } from '../../artifacts/access.js';
import { visibleArtifactIds } from '../../workspaces/visible.js';

export function registerWorkspaceRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { artifacts, sharing, workspaces } = context;
  // Names and descriptions are short. Anything near this is not a workspace.
  const bodyCap = jsonBodyCap(16 * 1024);

  app.get('/api/workspaces', requireUser, (c) => {
    const user = currentUser(c);
    return c.json({ workspaces: workspaces.list(user.id, visibleArtifactIds(artifacts, sharing, user)) });
  });

  app.post('/api/workspaces', requireUser, async (c) => {
    const body = await readJsonObject(c.req.raw, bodyCap);
    const created = workspaces.create(currentUser(c).id, {
      name: body.name,
      description: body.description,
    });
    return c.json(created, 201);
  });

  app.patch('/api/workspaces/:id', requireUser, async (c) => {
    const body = await readJsonObject(c.req.raw, bodyCap);
    const updated = workspaces.update(currentUser(c).id, c.req.param('id'), {
      name: body.name,
      description: body.description,
    });
    return c.json(updated);
  });

  /** Its kites go back to Inbox. No kite is deleted. */
  app.delete('/api/workspaces/:id', requireUser, (c) => {
    workspaces.delete(currentUser(c).id, c.req.param('id'));
    return c.json({ ok: true });
  });

  app.put('/api/artifacts/:id/workspace', requireUser, async (c) => {
    const user = currentUser(c);
    const artifact = artifacts.get(c.req.param('id'));
    requireAccess(user, sharing.accessFactsFor(artifact), 'view');

    const body = await readJsonObject(c.req.raw, bodyCap);
    if (typeof body.workspaceId !== 'string' || body.workspaceId.length === 0) {
      throw new ApiError('validation_failed', 'workspaceId is required: a workspace id, or "inbox".');
    }
    return c.json({ workspaceId: workspaces.place(user.id, artifact.id, body.workspaceId) });
  });
}
