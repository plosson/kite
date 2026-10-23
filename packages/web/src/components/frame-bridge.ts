/**
 * Reading what the artifact's frame says.
 *
 * An HTML artifact is a stranger's page running at an opaque origin. A small
 * bridge script inside it reports which element the reader selected. Everything
 * in this file exists because that report cannot be trusted:
 *
 * - The artifact's own script can delete the bridge, replace `postMessage`, or
 *   send messages shaped like the bridge's own.
 * - `event.origin` is the string `"null"` for an opaque origin and identifies
 *   nothing. The window handle is the only identity available, which is why the
 *   app document sends `frame-src 'self'` — without it the artifact could
 *   navigate its frame to a page it controls and keep that same handle.
 *
 * So the frame may *propose* an element. It may never say what the element
 * contains: the app asks the server and shows the server's answer. A page given
 * a text channel into the app's own chrome could write "your session has
 * expired, sign in again at…" in the app's own voice, and no amount of escaping
 * would help, because the problem is not script.
 */

/** How the two sides address each other. Mirrors `comments/bridge.ts`. */
export const BRIDGE_CHANNEL = 'open-artifact.bridge.v1';

/** All a frame is allowed to tell us. */
export interface BridgeSelection {
  elementId: string | null;
  path: string;
  tag: string;
}

/**
 * A selection message, or null if it is anything else.
 *
 * Strict on purpose, field by field, with lengths capped. A path is a handful of
 * digits and slashes; an id that runs to kilobytes is not an id. Nothing here
 * tries to repair a malformed message — a frame that cannot follow the shape has
 * nothing to say.
 */
export function readSelectionMessage(value: unknown): BridgeSelection | null {
  if (!value || typeof value !== 'object') return null;
  const target = value as Record<string, unknown>;

  const elementId = target.elementId;
  if (elementId !== null && elementId !== undefined) {
    if (typeof elementId !== 'string' || elementId.length === 0 || elementId.length > 200) {
      return null;
    }
  }

  const path = target.path;
  if (typeof path !== 'string' || path.length === 0 || path.length > 200) return null;
  if (!/^[0-9]+(\/[0-9]+)*$/.test(path)) return null;

  const tag = target.tag;
  if (typeof tag !== 'string' || !/^[a-z0-9-]{1,30}$/.test(tag)) return null;

  return { elementId: typeof elementId === 'string' ? elementId : null, path, tag };
}

/**
 * Whether a message came from the frame we put on the page.
 *
 * Compares window handles, because that is all there is. See the note above on
 * why this only means something alongside `frame-src 'self'`.
 */
export function isFromFrame(event: MessageEvent, frame: HTMLIFrameElement | null): boolean {
  return Boolean(frame?.contentWindow) && event.source === frame?.contentWindow;
}

/** Whether the payload is one of ours at all. */
export function bridgeMessageType(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (data.channel !== BRIDGE_CHANNEL) return null;
  return typeof data.type === 'string' ? data.type : null;
}

// ---------------------------------------------------------------------------
// Keeping the reader's place
// ---------------------------------------------------------------------------

/** The place-keeping script's channel. Mirrors `render/frame-position.ts`. */
export const POSITION_CHANNEL = 'open-artifact.position.v1';

/** Where a frame's document is scrolled to. */
export interface FramePosition {
  x: number;
  y: number;
}

/** Further than any page scrolls; a number past it is not a position. */
const FURTHEST = 10_000_000;

/**
 * A frame saying where it is scrolled to, or null if it is anything else.
 *
 * The frame's own script can send this too, and that is fine: all it can do is
 * say where its own page should be put back to next time, which only that page
 * is ever told. It is still read strictly, so nothing but two plain numbers in
 * range is ever stored or sent back.
 */
export function readPositionMessage(value: unknown): FramePosition | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (data.channel !== POSITION_CHANNEL || data.type !== 'scrolled') return null;
  const { x, y } = data;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x > FURTHEST || y > FURTHEST) return null;
  return { x, y };
}

/** What asks a freshly loaded frame to scroll back to where the reader was. */
export function restoreMessage(position: FramePosition) {
  return { channel: POSITION_CHANNEL, type: 'restore', x: position.x, y: position.y };
}
