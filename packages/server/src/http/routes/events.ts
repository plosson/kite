/**
 * Live changes to one artifact, as server-sent events.
 *
 * An open document listens here instead of asking over and over whether
 * anything changed. The stream says what kind of thing changed and the version
 * it is now at; never the content. The page fetches what it needs through the
 * ordinary routes, which check access as they always do.
 *
 * Who may listen is decided by the same rule as who may read, and it is not
 * decided once. It is asked again on every change and every heartbeat, against
 * the artifact's current sharing and the listener's current credential, so
 * removing somebody's share, signing them out or letting the link expire ends
 * their stream too, unless what is left still lets them read it (signed out of
 * a public document, they are simply anybody). The stream says why it ended,
 * and closes.
 *
 * Events:
 *   ready   {version}                      first, on every (re)connection
 *   change  {kind, version?, via, self}    kind: content | details | comments
 *   gone    {reason}                       last; reason: deleted | expired | no-access
 *
 * `self` is true when the listener's own tab made the change: the tab sends
 * the same X-Kite-Client id here as on its writes.
 */

import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppContext, AppEnv } from '../app.js';
import type { UserRow } from '../../db/schema.js';
import { accessReason, canAccess, requireAccess } from '../../artifacts/access.js';
import type { ArtifactChange } from '../../live/feed.js';
import { CLIENT_ID_HEADER, readClientId } from '../origin.js';

/** Changes a listener hears about. Access changes are acted on, not passed on. */
type VisibleChange = Extract<ArtifactChange, { kind: 'content' | 'details' | 'comments' }>;

type GoneReason = 'deleted' | 'expired' | 'no-access';

/** How long a browser waits before reconnecting after the stream drops. */
const RECONNECT_MS = 2_000;

export function registerEventRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { artifacts, sharing, changes } = context;

  app.get('/api/artifacts/:id/events', (c) => {
    const artifact = artifacts.get(c.req.param('id'));
    let facts = sharing.accessFactsFor(artifact);
    requireAccess(c.get('user') ?? null, facts, 'view');

    const clientId = readClientId(c.req.header(CLIENT_ID_HEADER));
    const reauthenticate = c.get('reauthenticate') ?? (() => null);
    const logger = c.get('logger');

    const response = streamSSE(c, async (stream) => {
      let ended = false;
      let release!: () => void;
      const finished = new Promise<void>((resolve) => {
        release = resolve;
      });

      // Writes go out one after another, in the order they were decided on.
      let writing: Promise<unknown> = Promise.resolve();
      const send = (write: () => Promise<unknown>): void => {
        writing = writing.then(write);
      };

      const end = (gone?: GoneReason): void => {
        if (ended) return;
        ended = true;
        if (gone) send(() => stream.writeSSE({ event: 'gone', data: JSON.stringify({ reason: gone }) }));
        void writing.then(release);
      };

      /** Whether whoever is listening may still. Ends the stream when not. */
      const listenerNow = (): { listener: UserRow | null } | null => {
        try {
          return checkListener();
        } catch (error) {
          // Failing closed: a stream that cannot tell who is listening stops.
          // The browser reconnects, and is checked from scratch.
          logger.error('live stream check failed', {
            artifactId: artifact.id,
            error: error instanceof Error ? error.message : String(error),
          });
          end();
          return null;
        }
      };

      const checkListener = (): { listener: UserRow | null } | null => {
        const listener = reauthenticate();
        const current = sharing.accessFactsById(artifact.id);
        // Kept from the last check when the artifact is gone, so that being
        // told it was deleted is still only for somebody who could read it.
        if (current) facts = current;
        if (!canAccess(listener, facts, 'view')) {
          end(accessReason(listener, facts) === 'expired' ? 'expired' : 'no-access');
          return null;
        }
        if (!current) {
          end('deleted');
          return null;
        }
        return { listener };
      };

      // Subscribed before anything is awaited, and the version read above, so
      // no change can land between the version this stream reports and the
      // first change it passes on.
      const unsubscribe = changes.subscribe(artifact.id, {
        change: (change) => {
          if (ended) return;
          const allowed = listenerNow();
          if (!allowed || change.kind === 'access' || change.kind === 'deleted') return;
          const data = JSON.stringify(eventFor(change, allowed.listener, clientId));
          send(() => stream.writeSSE({ event: 'change', data }));
        },
        close: () => end(),
      });

      // Something on the wire well inside every proxy's idle timeout, and a
      // chance to notice access that ran out with nobody writing anything.
      const heartbeat = setInterval(() => {
        if (listenerNow()) send(() => stream.write(': ping\n\n'));
      }, changes.heartbeatMs);

      stream.onAbort(() => end());

      send(() =>
        stream.writeSSE({
          event: 'ready',
          data: JSON.stringify({ version: artifact.version }),
          retry: RECONNECT_MS,
        }),
      );
      logger.debug('live stream opened', { artifactId: artifact.id });

      await finished;
      clearInterval(heartbeat);
      unsubscribe();
      logger.debug('live stream closed', { artifactId: artifact.id });
    });

    // Every proxy in the way must pass events through as they are written:
    // nothing cached, nothing compressed or held back to fill a buffer.
    response.headers.set('Cache-Control', 'no-store, no-transform');
    response.headers.set('X-Accel-Buffering', 'no');
    return response;
  });
}

function eventFor(change: VisibleChange, listener: UserRow | null, clientId: string | null) {
  return {
    kind: change.kind,
    ...('version' in change ? { version: change.version } : {}),
    via: change.actor.via,
    self:
      clientId !== null &&
      listener !== null &&
      listener.id === change.actor.userId &&
      change.actor.clientId === clientId,
  };
}
