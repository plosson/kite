/**
 * Live changes to the open document, over one server-sent event stream.
 *
 * GET /api/artifacts/:id/events says, as it happens, that the document changed
 * and what kind of change it was: a new version, new details, or comments. It
 * never carries the content; the page fetches what it shows through the
 * ordinary routes. One stream per open document, shared by everything on the
 * page that cares (see LiveContext).
 *
 * Read with fetch rather than EventSource, because the two ways a stream can
 * stop need telling apart. EventSource gives up for good on any refusal,
 * including a 502 from a proxy while the server restarts, and cannot say a 404
 * from a 503. Here a refusal that will not change on its own (no access, gone,
 * expired) ends the stream and says so, and anything else — the network, the
 * server restarting, a connection that went quiet — is retried, a little later
 * each time, until it is back.
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

export type LiveEvent =
  /** Connected, at this version. `reconnected`: anything may have happened meanwhile. */
  | { type: 'ready'; version: number; reconnected: boolean }
  /** Somebody else's change; this tab's own are never passed on. */
  | { type: 'change'; kind: ChangeKind; version: number | null; via: 'browser' | 'agent' }
  /** The last event: this reader may not follow the document any more. */
  | { type: 'gone'; reason: GoneReason };

/**
 * `connecting` until the first ready, `live` while connected, `reconnecting`
 * after a drop until the next ready, `closed` after gone or close().
 */
export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'closed';

export interface LiveConnection {
  readonly state: LiveState;
  /** The newest version the stream has reported, this tab's own writes included; 0 before ready. */
  readonly version: number;
  /** Hears every event from now on. Returns the way to stop. */
  listen(listener: (event: LiveEvent) => void): () => void;
  /** Hears every change of state. Returns the way to stop. */
  watch(listener: () => void): () => void;
  close(): void;
}

export interface LiveOptions {
  fetch?: typeof fetch;
  /** Waits before each retry after a drop, the last one repeated. */
  backoffMs?: readonly number[];
  /** Silence this long means the connection is dead, whether or not anybody said so. */
  staleMs?: number;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
/** The server sends something every 25 seconds, so a minute of nothing is two missed. */
const STALE_MS = 60_000;

export function connectLive(artifactId: string, options: LiveOptions = {}): LiveConnection {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const backoff = options.backoffMs ?? BACKOFF_MS;
  const staleMs = options.staleMs ?? STALE_MS;

  const listeners = new Set<(event: LiveEvent) => void>();
  const watchers = new Set<() => void>();
  let state: LiveState = 'connecting';
  let version = 0;
  let everReady = false;
  let drops = 0;
  let closed = false;
  /** The connection being made or read. Anything else still running is stale and stops. */
  let attempt: AbortController | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stale: ReturnType<typeof setTimeout> | undefined;

  const setState = (next: LiveState) => {
    if (state === next) return;
    state = next;
    for (const watcher of [...watchers]) watcher();
  };

  const emit = (event: LiveEvent) => {
    for (const listener of [...listeners]) listener(event);
  };

  const teardown = () => {
    closed = true;
    clearTimeout(retry);
    clearTimeout(stale);
    attempt?.abort();
    attempt = null;
    if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
  };

  const finish = (reason: GoneReason) => {
    teardown();
    setState('closed');
    emit({ type: 'gone', reason });
  };

  /** The connection dropped for a reason that may pass: try again, a little later each time. */
  const dropped = (current: AbortController) => {
    if (closed || current !== attempt) return;
    attempt = null;
    current.abort();
    clearTimeout(stale);
    setState('reconnecting');
    retry = setTimeout(connect, backoff[Math.min(drops, backoff.length - 1)]);
    drops += 1;
  };

  /** Anything arriving proves the connection alive for another while. */
  const awake = (current: AbortController) => {
    clearTimeout(stale);
    stale = setTimeout(() => dropped(current), staleMs);
  };

  const handle = (event: string, data: Record<string, unknown> | null) => {
    if (event === 'ready' && typeof data?.version === 'number') {
      version = data.version;
      drops = 0;
      setState('live');
      emit({ type: 'ready', version: data.version, reconnected: everReady });
      everReady = true;
    } else if (event === 'change' && data && isChangeKind(data.kind)) {
      const changed = typeof data.version === 'number' ? data.version : null;
      if (changed !== null) version = Math.max(version, changed);
      if (data.self === true) return;
      emit({ type: 'change', kind: data.kind, version: changed, via: data.via === 'agent' ? 'agent' : 'browser' });
    } else if (event === 'gone') {
      finish(isGoneReason(data?.reason) ? data.reason : 'no-access');
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

    let response: Response;
    try {
      response = await send(`/api/artifacts/${encodeURIComponent(artifactId)}/events`, {
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
      // A server error or a proxy in the way says nothing about this reader:
      // it passes. Every other refusal is the server's answer about them.
      if (response.status >= 500 || response.status === 429) dropped(current);
      else finish(response.status === 410 ? 'expired' : 'no-access');
      return;
    }

    try {
      if (response.body) await read(response.body, current);
    } catch {
      // Aborted or cut off; either way, what follows is the same.
    }
    // A stream that ends without saying gone was cut, not finished.
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

/** The open document's stream, for anything on the page below it. Null when there is none. */
export const LiveContext = createContext<LiveConnection | null>(null);

/** Opens the stream for this document while it is on screen, and closes it after. */
export function useLiveConnection(artifactId: string | null): LiveConnection | null {
  const [connection, setConnection] = useState<LiveConnection | null>(null);

  useEffect(() => {
    if (artifactId === null) return undefined;
    const opened = connectLive(artifactId);
    setConnection(opened);
    return () => {
      opened.close();
      setConnection(null);
    };
  }, [artifactId]);

  return connection;
}

export function useLiveState(connection: LiveConnection | null): LiveState | null {
  const subscribe = useCallback(
    (onChange: () => void) => (connection ? connection.watch(onChange) : () => undefined),
    [connection],
  );
  return useSyncExternalStore(subscribe, () => connection?.state ?? null);
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
