/**
 * What changed, as it happens, for one browser tab: GET /api/events.
 *
 * One stream per tab, carrying two things a tab may follow:
 *
 *   the person's own notifications, whenever somebody is signed in
 *   one document, when the tab names it: ?artifact=<id> or ?slug=<slug>
 *
 * One stream rather than one per thing, because a browser talking HTTP/1.1
 * gives a whole site six connections, and every stream holds one for as long
 * as the tab is open. A tab moving to another document opens a new stream for
 * the new set; that is the only time a tab reconnects on purpose.
 *
 * Events:
 *   ready          {version?, unread?}               first, on every (re)connection
 *   change         {kind, version?, via, self}       the document; kind: content | details | comments
 *   notifications  {unread, self}                    the person's bell
 *   gone           {reason}                          the document, for good; reason: deleted | expired | no-access
 *   signed-out     {}                                the person, for good: the credential stopped working
 *   replaced       {}                                last: the person opened one stream too many (live/streams.ts)
 *
 * `version` in ready is there when the document is followed and readable;
 * `unread` when somebody is signed in. A document that cannot be read — never
 * existed, not theirs, expired — is answered in the stream, with ready then
 * gone, so the person's notifications are not lost with it; and "not yours"
 * and "no such thing" stay the same answer. The stream ends when nothing is
 * left to follow.
 *
 * Events say what kind of thing changed, never the content; the tab reads that
 * through the ordinary routes, which check access as they always do.
 *
 * Who may follow the document is decided by the same rule as who may read it,
 * and it is not decided once. It is asked again on every change and every
 * heartbeat, against the document's current sharing and the listener's
 * current credential, so removing somebody's share, signing them out or
 * letting the link expire ends their following too, unless what is left still
 * lets them read it (signed out of a public document, they are simply
 * anybody). A person's topic is only ever theirs, and only while the
 * credential that opened the stream still says it is them.
 *
 * `self` is true when the listener's own tab made the change: the tab sends
 * the same X-Kite-Client id here as on its writes.
 */

import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppContext, AppEnv } from '../app.js';
import type { UserRow } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { accessReason, canAccess, type ArtifactAccessFacts } from '../../artifacts/access.js';
import { topics, type ArtifactChange, type LiveChange, type NotificationChange } from '../../live/feed.js';
import { CLIENT_ID_HEADER, readClientId } from '../origin.js';

/** Changes a listener hears about. Access changes are acted on, not passed on. */
type VisibleChange = Extract<ArtifactChange, { kind: 'content' | 'details' | 'comments' }>;

type GoneReason = 'deleted' | 'expired' | 'no-access';

/** How long a browser waits before reconnecting after the stream drops. */
const RECONNECT_MS = 2_000;

/** How long a refused stream is asked to wait. Streams end when tabs close, so room comes back. */
const FULL_RETRY_AFTER_SECONDS = 30;

export function registerEventRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { artifacts, sharing, notifications, changes, streams } = context;

  app.get('/api/events', (c) => {
    const clientId = readClientId(c.req.header(CLIENT_ID_HEADER));
    const opener = c.get('user') ?? null;
    const named = documentNamed(c.req.query('artifact'), c.req.query('slug'));
    if (opener === null && named === null) {
      throw new ApiError('unauthenticated', 'Sign in to follow your notifications, or name a document to follow.');
    }

    // Read now, before the stream subscribes below, so no change can land
    // between the version ready reports and the first change passed on.
    const artifact = named === null ? null : 'id' in named ? artifacts.find(named.id) : artifacts.findBySlug(named.slug);
    const facts = artifact ? sharing.accessFactsFor(artifact) : null;
    const readable = artifact !== null && facts !== null && canAccess(opener, facts, 'view');
    const refusedAtStart: GoneReason | null =
      named === null || readable ? null : facts && accessReason(opener, facts) === 'expired' ? 'expired' : 'no-access';

    // Room is made, or refused, before anything is streamed (see live/streams.ts).
    let replaceStream: (() => void) | null = null;
    let replacedEarly = false;
    const admission = streams.admit({
      userId: opener?.id ?? null,
      artifactId: readable ? artifact.id : null,
      replace: () => {
        if (replaceStream) replaceStream();
        else replacedEarly = true;
      },
    });
    if (!admission.admitted) {
      c.header('Retry-After', String(FULL_RETRY_AFTER_SECONDS));
      throw new ApiError(
        'rate_limited',
        admission.full === 'artifact'
          ? 'Too many people are following this document live. Try again shortly.'
          : 'This instance is following as many live streams as it allows. Try again shortly.',
        { retryAfterSeconds: FULL_RETRY_AFTER_SECONDS },
      );
    }

    const reauthenticate = c.get('reauthenticate') ?? (() => null);
    const logger = c.get('logger');

    const response = streamSSE(c, async (stream) => {
      /** Who is followed, while they still are. */
      let person: UserRow | null = opener;
      let document: { id: string; facts: ArtifactAccessFacts } | null = readable ? { id: artifact.id, facts: facts! } : null;
      let ended = false;
      let release!: () => void;
      const finished = new Promise<void>((resolve) => {
        release = resolve;
      });

      // Writes go out one after another, in the order they were decided on.
      let writing: Promise<unknown> = Promise.resolve();
      const send = (event: string, data: Record<string, unknown>, retry?: number): void => {
        writing = writing.then(() => stream.writeSSE({ event, data: JSON.stringify(data), retry }));
      };

      const unsubscribers: { person?: () => void; document?: () => void } = {};

      const end = (): void => {
        if (ended) return;
        ended = true;
        unsubscribers.person?.();
        unsubscribers.document?.();
        void writing.then(release);
      };

      /** Nothing left to follow is the end of the stream. */
      const endIfEmpty = (): void => {
        if (person === null && document === null) end();
      };

      const stopFollowingDocument = (reason: GoneReason): void => {
        document = null;
        unsubscribers.document?.();
        send('gone', { reason });
      };

      /**
       * Asks again whether each thing followed still may be, and lets go of
       * whatever may not. Who is listening now, or null once nothing is left.
       */
      const check = (): { listener: UserRow | null } | null => {
        if (ended) return null;
        let now: UserRow | null;
        try {
          now = reauthenticate();
          if (person !== null && now?.id !== person.id) {
            person = null;
            unsubscribers.person?.();
            send('signed-out', {});
          }
          if (document !== null) {
            const current = sharing.accessFactsById(document.id);
            // Kept from the last check when the artifact is gone, so that being
            // told it was deleted is still only for somebody who could read it.
            if (current) document.facts = current;
            if (!canAccess(now, document.facts, 'view')) {
              stopFollowingDocument(accessReason(now, document.facts) === 'expired' ? 'expired' : 'no-access');
            } else if (!current) {
              stopFollowingDocument('deleted');
            }
          }
        } catch (error) {
          // Failing closed: a stream that cannot tell who is listening stops.
          // The browser reconnects, and is checked from scratch.
          logger.error('live stream check failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          end();
          return null;
        }
        endIfEmpty();
        return ended ? null : { listener: now };
      };

      const onChange = (change: LiveChange): void => {
        const checked = check();
        if (!checked) return;
        if (change.kind === 'notifications') {
          if (person === null) return;
          send('notifications', {
            unread: notifications.unreadCount(person.id),
            self: clientId !== null && change.clientId === clientId,
          });
        } else if (document !== null && isVisible(change)) {
          send('change', eventFor(change, checked.listener, clientId));
        }
      };

      // Subscribed before anything is awaited: see the read above.
      if (person !== null) {
        unsubscribers.person = changes.subscribe(topics.user(person.id), { change: onChange, close: end });
      }
      if (document !== null) {
        unsubscribers.document = changes.subscribe(topics.artifact(document.id), { change: onChange, close: end });
      }

      replaceStream = () => {
        if (ended) return;
        send('replaced', {});
        end();
      };

      // Something on the wire well inside every proxy's idle timeout, and a
      // chance to notice access that ran out with nobody writing anything.
      const heartbeat = setInterval(() => {
        if (check()) writing = writing.then(() => stream.write(': ping\n\n'));
      }, changes.heartbeatMs);

      stream.onAbort(end);

      send(
        'ready',
        {
          ...(document !== null ? { version: artifact!.version } : {}),
          ...(person !== null ? { unread: notifications.unreadCount(person.id) } : {}),
        },
        RECONNECT_MS,
      );
      if (refusedAtStart) send('gone', { reason: refusedAtStart });
      if (replacedEarly) replaceStream();
      endIfEmpty();
      logger.debug('live stream opened', { artifactId: document?.id ?? null, signedIn: person !== null });

      await finished;
      clearInterval(heartbeat);
      admission.release();
      logger.debug('live stream closed');
    });

    // Every proxy in the way must pass events through as they are written:
    // nothing cached, nothing compressed or held back to fill a buffer.
    response.headers.set('Cache-Control', 'no-store, no-transform');
    response.headers.set('X-Accel-Buffering', 'no');
    return response;
  });
}

/** The document the tab asked to follow, by id or by slug; not both. */
function documentNamed(id: string | undefined, slug: string | undefined): { id: string } | { slug: string } | null {
  if (id && slug) throw new ApiError('validation_failed', 'Name the document by artifact or by slug, not both.');
  if (id) return { id };
  if (slug) return { slug };
  return null;
}

function isVisible(change: ArtifactChange | NotificationChange): change is VisibleChange {
  return change.kind === 'content' || change.kind === 'details' || change.kind === 'comments';
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
