/**
 * What changed, as it happens: an in-process feed of changes, keyed by artifact.
 *
 * Every write that a reader could see announces itself here once it has been
 * committed. The services do the announcing, not the routes, so a new route or
 * a new MCP tool cannot forget to: there is no way to write an artifact or a
 * comment that does not go through a service.
 *
 * A change says what kind of thing changed, the version it is now at, and who
 * changed it. Never the content. Whoever hears about a change and wants to see
 * it asks for it through the ordinary routes, which check access as they always
 * do. Deciding who may hear about a change at all is the subscriber's job (see
 * routes/events.ts), because that is where the person listening is known.
 *
 * In-process means one server. Kite runs as one process against one SQLite
 * file, so that is the whole deployment; a second process would need this to
 * be backed by something shared.
 */

import { type Logger, silentLogger } from '../logging.js';

/** Where a write came from. A browser tab, or an agent using a token. */
export type Via = 'browser' | 'agent';

export interface Origin {
  via: Via;
  /**
   * The browser tab that made the write, when it said. A tab uses this to
   * recognise its own writes coming back and leave them alone.
   */
  clientId: string | null;
}

export interface Actor extends Origin {
  userId: string;
}

export type ArtifactChange =
  /** New content: a publish, an update, a batch of canvas operations, a restore. */
  | { kind: 'content'; artifactId: string; version: number; actor: Actor }
  /** The title, description or summary. No new version. */
  | { kind: 'details'; artifactId: string; version: number; actor: Actor }
  /** A thread was started, replied to, edited, settled or deleted. */
  | { kind: 'comments'; artifactId: string; actor: Actor }
  | { kind: 'deleted'; artifactId: string; actor: Actor }
  /**
   * Who may read it may have narrowed: a share removed, the link turned off or
   * cut short. Nobody is told; everybody listening is checked again.
   */
  | { kind: 'access'; artifactId: string };

/** The one thing a service needs: somewhere to announce a committed write. */
export interface ChangePublisher {
  publish(change: ArtifactChange): void;
}

export interface ChangeListener {
  change(change: ArtifactChange): void;
  /** The feed is shutting down. Finish up; there will be nothing more. */
  close(): void;
}

export interface ChangeFeedOptions {
  /**
   * How often an open stream proves it is alive and re-checks who is
   * listening. Well under the 100 seconds after which Cloudflare drops a
   * connection that has said nothing.
   */
  heartbeatMs?: number;
  /** Where a listener that throws is reported. It must not fail the write being announced. */
  logger?: Logger;
}

export const DEFAULT_HEARTBEAT_MS = 25_000;

export class ChangeFeed implements ChangePublisher {
  readonly heartbeatMs: number;
  private readonly logger: Logger;
  private readonly listeners = new Map<string, Set<ChangeListener>>();

  constructor({ heartbeatMs = DEFAULT_HEARTBEAT_MS, logger = silentLogger() }: ChangeFeedOptions = {}) {
    this.heartbeatMs = heartbeatMs;
    this.logger = logger;
  }

  /** Starts listening to one artifact. Call what it returns to stop. */
  subscribe(artifactId: string, listener: ChangeListener): () => void {
    let set = this.listeners.get(artifactId);
    if (!set) {
      set = new Set();
      this.listeners.set(artifactId, set);
    }
    set.add(listener);

    return () => {
      const current = this.listeners.get(artifactId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(artifactId);
    };
  }

  publish(change: ArtifactChange): void {
    const set = this.listeners.get(change.artifactId);
    if (!set) return;
    // A copy: a listener may unsubscribe while it is being told.
    for (const listener of [...set]) {
      try {
        listener.change(change);
      } catch (error) {
        this.reportListenerError(error);
      }
    }
  }

  /** How many are listening, to one artifact or to all of them. */
  listenerCount(artifactId?: string): number {
    if (artifactId !== undefined) return this.listeners.get(artifactId)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  /**
   * Ends every subscription, for a server that is stopping. Open streams close
   * cleanly and their browsers reconnect to whatever replaces this process.
   */
  close(): void {
    const all = [...this.listeners.values()].flatMap((set) => [...set]);
    this.listeners.clear();
    for (const listener of all) {
      try {
        listener.close();
      } catch (error) {
        this.reportListenerError(error);
      }
    }
  }

  private reportListenerError(error: unknown): void {
    this.logger.error('change listener failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
