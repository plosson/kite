/**
 * Who is behind a write, as the change feed tells it.
 *
 * A browser tab names itself with a random id in the X-Kite-Client header, and
 * the same id on the live stream it opens. When a change comes back down that
 * stream carrying its own id, the tab knows it is hearing its own write and
 * leaves it alone. Nothing is decided by the id beyond that: it is not a
 * credential, and a write without one is just as good.
 */

import type { Context } from 'hono';
import { ApiError } from '../errors.js';
import type { Actor, Origin } from '../live/feed.js';
import type { AppEnv } from './app.js';
import { currentUser } from './session.js';

export const CLIENT_ID_HEADER = 'X-Kite-Client';

const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The id as sent, or null when none was. Anything malformed is refused, not ignored. */
export function readClientId(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  if (!CLIENT_ID.test(raw)) {
    throw new ApiError(
      'validation_failed',
      `${CLIENT_ID_HEADER} must be 8 to 64 letters, digits, "-" or "_".`,
    );
  }
  return raw;
}

/** A token is an agent; a session is somebody in a browser. */
export function originOf(c: Context<AppEnv>): Origin {
  return {
    via: c.get('credential') === 'token' ? 'agent' : 'browser',
    clientId: readClientId(c.req.header(CLIENT_ID_HEADER)),
  };
}

/** For a route that has already been through requireUser. */
export function actorOf(c: Context<AppEnv>): Actor {
  return { userId: currentUser(c).id, ...originOf(c) };
}
