/**
 * This tab's live connection: one server-sent event stream, GET /api/events,
 * carrying the signed-in person's notifications and the open document's
 * changes.
 *
 * One stream rather than one per thing followed, because a browser speaking
 * HTTP/1.1 keeps at most six connections to a server across every tab, and
 * each stream holds one for as long as the tab is open. Two per tab would run
 * out at three tabs. One per tab also makes the server's per-person limit mean
 * what it says: how many tabs somebody may have following at once.
 *
 * It says, as it happens, that something changed and what kind of change it
 * was: a new version, new details or comments on the document; a new unread
 * count for the bell. It never carries the content; the page fetches what it
 * shows through the ordinary routes. The tab opens it once, at the top, and
 * everything below that cares shares it (see LiveContext). Moving to another
 * document opens a new one following that document instead.
 *
 * Read with fetch rather than EventSource, because the ways a stream can stop
 * need telling apart. EventSource gives up for good on any refusal, including
 * a 502 from a proxy while the server restarts, and cannot say a 401 from a
 * 503. Here a refusal that will not change on its own ends the stream and says
 * so; the server being too busy is retried when it says to (Retry-After); and
 * anything else — the network, the server restarting, a connection that went
 * quiet — is retried, a little later each time, until it is back.
 *
 * Losing one of the two things followed does not lose the other. A document
 * the reader may no longer see is `gone`, and the stream carries on for their
 * notifications; somebody whose sign-in stopped working is `signed-out`, and
 * the stream carries on for a public document. It ends when nothing is left.
 *
 * A person may keep only so many streams open. Opening one more closes their
 * oldest, which is told it was `replaced` and waits, rather than knocking the
 * newer one off in turn, until its tab is looked at again.
 *
 * Each tab has an id, sent as X-Kite-Client on its writes and on this stream,
 * so the server can mark the tab's own changes and they are not played back to
 * it as if somebody else had made them.
 */

import { createContext, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

export const CLIENT_ID_HEADER = 'X-Kite-Client';

/** This tab's id: fresh on every load, never stored, meaningless anywhere else. */
export const CLIENT_ID = newClientId();

function newClientId(): string {
  // getRandomValues, not randomUUID: the latter only exists on https and
  // localhost, and an instance on a LAN address is still an instance.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type ChangeKind = 'content' | 'details' | 'comments';
export type GoneReason = 'deleted' | 'expired' | 'no-access';

/** The document a tab follows, by whichever name it has to hand. Null follows only the person. */
export type LiveFollow = { slug: string } | { artifactId: string } | null;

export type LiveEvent =
  /**
   * Connected. `version` when following a document, `unread` when following a
   * person: both as they are now. `reconnected`: anything may have happened
   * since the last connection, so whatever is shown should be read again.
   */
  | { type: 'ready'; version: number | null; unread: number | null; reconnected: boolean }
  /** Somebody else's change to the document; this tab's own are never passed on. */
  | { type: 'change'; kind: ChangeKind; version: number | null; via: 'browser' | 'agent' }
  /** The bell's count moved. `self`: this tab's own doing, such as marking one read. */
  | { type: 'notifications'; unread: number; self: boolean }
  /** This reader may not follow the document any more. The person, if any, is still followed. */
  | { type: 'gone'; reason: GoneReason }
  /** The sign-in this tab had stopped working. A public document, if any, is still followed. */
  | { type: 'signed-out' }
  /** Closed to make room for a newer tab of the same person; back when this tab is looked at. */
  | { type: 'replaced' };

/**
 * `connecting` until the first ready, `live` while connected, `reconnecting`
 * after a drop until the next ready, `paused` after being replaced until the
 * tab is looked at again, `closed` once nothing is left to follow or after
 * close().
 */
export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'paused' | 'closed';

export interface LiveConnection {
  readonly state: LiveState;
  /** The newest version of the document the stream has reported, this tab's own writes included; 0 before ready. */
  readonly version: number;
  /** The person's unread notifications, as last reported; null when no person is followed. */
  readonly unread: number | null;
  /** Hears every event from now on. Returns the way to stop. */
  listen(listener: (event: LiveEvent) => void): () => void;
  /** Hears every change of state or of the unread count. Returns the way to stop. */
  watch(listener: () => void): () => void;
  close(): void;
}

/** Says when the tab is looked at again. Returns the way to stop. */
export type OnVisible = (resume: () => void) => () => void;

export interface LiveOptions {
  fetch?: typeof fetch;
  /** Waits before each retry after a drop, the last one repeated. */
  backoffMs?: readonly number[];
  /** Silence this long means the connection is dead, whether or not anybody said so. */
  staleMs?: number;
  /** How a replaced stream learns its tab is in view again; the page's visibility by default. */
  onVisible?: OnVisible;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
/** The server sends something every 25 seconds, so a minute of nothing is two missed. */
const STALE_MS = 60_000;

/** The tab coming to the front, or its window being clicked into beside another. */
const onPageVisible: OnVisible = (resume) => {
  if (typeof document === 'undefined') return () => undefined;
  const check = () => {
    if (document.visibilityState === 'visible') resume();
  };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  return () => {
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('focus', check);
  };
};

export function connectLive(follow: LiveFollow, options: LiveOptions = {}): LiveConnection {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const backoff = options.backoffMs ?? BACKOFF_MS;
  const staleMs = options.staleMs ?? STALE_MS;
  const onVisible = options.onVisible ?? onPageVisible;

  const listeners = new Set<(event: LiveEvent) => void>();
  const watchers = new Set<() => void>();
  let state: LiveState = 'connecting';
  let version = 0;
  let unread: number | null = null;
  /** The document still asked for: none once the server says this reader may not follow it. */
  let followed: LiveFollow = follow;
  /**
   * Whether a person is followed, as the server last said (ready carries their
   * count). Until the first ready nobody knows, and a stream that may follow
   * nobody but its person is opened in case it does.
   */
  let person: boolean | null = null;
  let everReady = false;
  let drops = 0;
  let closed = false;
  /** The connection being made or read. Anything else still running is stale and stops. */
  let attempt: AbortController | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stale: ReturnType<typeof setTimeout> | undefined;
  let stopWaitingForVisible: (() => void) | null = null;

  const changed = () => {
    for (const watcher of [...watchers]) watcher();
  };

  const setState = (next: LiveState) => {
    if (state === next) return;
    state = next;
    changed();
  };

  const setUnread = (next: number | null) => {
    if (unread === next) return;
    unread = next;
    changed();
  };

  const emit = (event: LiveEvent) => {
    for (const listener of [...listeners]) listener(event);
  };

  /** Stops whatever is under way: the connection, a wait to retry, the watchdog. */
  const halt = () => {
    clearTimeout(retry);
    clearTimeout(stale);
    attempt?.abort();
    attempt = null;
    stopWaitingForVisible?.();
    stopWaitingForVisible = null;
  };

  const teardown = () => {
    closed = true;
    halt();
    if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
  };

  /** Nothing left to follow. */
  const finish = () => {
    teardown();
    setState('closed');
  };

  const nothingLeft = () => followed === null && person === false;

  /** The connection dropped for a reason that may pass: try again, a little later each time, or when told. */
  const dropped = (current: AbortController, notBeforeMs = 0) => {
    if (closed || current !== attempt) return;
    attempt = null;
    current.abort();
    clearTimeout(stale);
    if (nothingLeft()) {
      finish();
      return;
    }
    setState('reconnecting');
    retry = setTimeout(connect, Math.max(notBeforeMs, backoff[Math.min(drops, backoff.length - 1)]!));
    drops += 1;
  };

  /** Anything arriving proves the connection alive for another while. */
  const awake = (current: AbortController) => {
    clearTimeout(stale);
    stale = setTimeout(() => dropped(current), staleMs);
  };

  const signedOut = () => {
    person = false;
    setUnread(null);
    emit({ type: 'signed-out' });
  };

  /** Closed by the server for a newer tab: wait until this one is in view, then come back. */
  const replaced = () => {
    halt();
    setState('paused');
    emit({ type: 'replaced' });
    stopWaitingForVisible = onVisible(() => {
      stopWaitingForVisible?.();
      stopWaitingForVisible = null;
      if (!closed && state === 'paused') void connect();
    });
  };

  const handle = (event: string, data: Record<string, unknown> | null) => {
    if (event === 'ready' && data) {
      const readyVersion = typeof data.version === 'number' ? data.version : null;
      const readyUnread = typeof data.unread === 'number' ? data.unread : null;
      if (readyVersion !== null) version = readyVersion;
      person = readyUnread !== null;
      setUnread(readyUnread);
      drops = 0;
      setState('live');
      emit({ type: 'ready', version: readyVersion, unread: readyUnread, reconnected: everReady });
      everReady = true;
    } else if (event === 'change' && data && isChangeKind(data.kind)) {
      const changedTo = typeof data.version === 'number' ? data.version : null;
      if (changedTo !== null) version = Math.max(version, changedTo);
      if (data.self === true) return;
      emit({ type: 'change', kind: data.kind, version: changedTo, via: data.via === 'agent' ? 'agent' : 'browser' });
    } else if (event === 'notifications' && typeof data?.unread === 'number') {
      setUnread(data.unread);
      emit({ type: 'notifications', unread: data.unread, self: data.self === true });
    } else if (event === 'gone') {
      followed = null;
      emit({ type: 'gone', reason: isGoneReason(data?.reason) ? data.reason : 'no-access' });
      if (nothingLeft()) finish();
    } else if (event === 'signed-out') {
      signedOut();
      if (nothingLeft()) finish();
    } else if (event === 'replaced') {
      replaced();
    }
  };

  async function read(body: ReadableStream<Uint8Array>, current: AbortController) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    awake(current);
    for (;;) {
      const { done, value } = await reader.read();
      if (done || current !== attempt) return;
      awake(current);
      buffer += decoder.decode(value, { stream: true });
      for (let boundary = buffer.indexOf('\n\n'); boundary !== -1; boundary = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseBlock(block);
        if (parsed) handle(parsed.event, parsed.data);
        if (current !== attempt) return;
      }
    }
  }

  async function connect() {
    clearTimeout(retry);
    if (closed) return;
    attempt?.abort();
    const current = new AbortController();
    attempt = current;
    if (state === 'paused') setState('reconnecting');

    let response: Response;
    try {
      response = await send(eventsUrl(followed), {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'text/event-stream', [CLIENT_ID_HEADER]: CLIENT_ID },
        signal: current.signal,
      });
    } catch {
      dropped(current);
      return;
    }
    if (current !== attempt) return;

    if (!response.ok) {
      if (response.status === 429) {
        // Too many open at once, on this document or on the server: come back
        // when the server says, and no sooner.
        dropped(current, retryAfterMs(response.headers.get('Retry-After')));
      } else if (response.status >= 500) {
        // A server error or a proxy in the way says nothing about this reader: it passes.
        dropped(current);
      } else if (response.status === 401) {
        // Followed nothing but a person, and there is no person.
        if (person !== false) signedOut();
        finish();
      } else {
        // The server's answer about this request (a malformed one): asking again changes nothing.
        finish();
      }
      return;
    }

    try {
      if (response.body) await read(response.body, current);
    } catch {
      // Aborted or cut off; either way, what follows is the same.
    }
    // A stream that ends with something still followed was cut, not finished.
    dropped(current);
  }

  /** Back on the network: no reason to sit out the rest of a wait. */
  function onOnline() {
    if (state === 'reconnecting' && attempt === null) void connect();
  }

  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
  void connect();

  return {
    get state() {
      return state;
    },
    get version() {
      return version;
    },
    get unread() {
      return unread;
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    watch(watcher) {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
    close() {
      teardown();
      setState('closed');
      listeners.clear();
      watchers.clear();
    },
  };
}

function eventsUrl(follow: LiveFollow): string {
  if (follow === null) return '/api/events';
  if ('slug' in follow) return `/api/events?slug=${encodeURIComponent(follow.slug)}`;
  return `/api/events?artifact=${encodeURIComponent(follow.artifactId)}`;
}

/** Retry-After in seconds, the only form this server sends; nothing usable waits as for any drop. */
function retryAfterMs(header: string | null): number {
  const seconds = header === null ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 0;
}

function isChangeKind(kind: unknown): kind is ChangeKind {
  return kind === 'content' || kind === 'details' || kind === 'comments';
}

function isGoneReason(reason: unknown): reason is GoneReason {
  return reason === 'deleted' || reason === 'expired' || reason === 'no-access';
}

/** One event block. Comments (the heartbeat) and anything unreadable come back as null. */
function parseBlock(block: string): { event: string; data: Record<string, unknown> | null } | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(data.join('\n'));
    return { event, data: typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In React
// ---------------------------------------------------------------------------

/** The tab's connection, for anything on the page below it. Null when there is none. */
export const LiveContext = createContext<LiveConnection | null>(null);

/**
 * Opens the tab's connection, following `follow`, and closes it when that
 * changes or the screen goes. `enabled` false opens nothing.
 */
export function useLiveConnection(follow: LiveFollow, enabled = true): LiveConnection | null {
  const [connection, setConnection] = useState<LiveConnection | null>(null);
  const key = !enabled ? null : follow === null ? 'person' : 'slug' in follow ? `slug:${follow.slug}` : `artifact:${follow.artifactId}`;
  const latest = useRef(follow);
  latest.current = follow;

  useEffect(() => {
    if (key === null) return undefined;
    const opened = connectLive(latest.current);
    setConnection(opened);
    return () => {
      opened.close();
      setConnection(null);
    };
  }, [key]);

  return connection;
}

export function useLiveState(connection: LiveConnection | null): LiveState | null {
  const subscribe = useCallback(
    (onChange: () => void) => (connection ? connection.watch(onChange) : () => undefined),
    [connection],
  );
  return useSyncExternalStore(subscribe, () => connection?.state ?? null);
}

/** The person's unread count as the connection last heard it; null until it has. */
export function useLiveUnread(connection: LiveConnection | null): number | null {
  const subscribe = useCallback(
    (onChange: () => void) => (connection ? connection.watch(onChange) : () => undefined),
    [connection],
  );
  return useSyncExternalStore(subscribe, () => connection?.unread ?? null);
}

/**
 * Calls `listener` for every event on the stream.
 *
 * Always the newest `listener`, so it may read the render's own state without
 * re-subscribing each time that changes.
 */
export function useLiveEvents(connection: LiveConnection | null, listener: (event: LiveEvent) => void): void {
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  });
  useEffect(() => connection?.listen((event) => latest.current(event)), [connection]);
}
