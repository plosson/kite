/**
 * The messages between a Markdown kite and the sandboxed frames that draw its
 * diagrams. Kept in one place so both sides read the same shapes.
 */

import { DIAGRAM_LANGUAGES, type DiagramLanguage } from '@open-artifact/shared';

export { DIAGRAM_LANGUAGES, type DiagramLanguage };

export const DIAGRAM_MESSAGE = 'kite-diagram';

/** Page to frame: draw this, once. */
export interface DiagramRequest {
  type: typeof DIAGRAM_MESSAGE;
  language: DiagramLanguage;
  source: string;
  dark: boolean;
}

/** Frame to page. */
export type DiagramReply =
  | { type: typeof DIAGRAM_MESSAGE; kind: 'ready' }
  | { type: typeof DIAGRAM_MESSAGE; kind: 'size'; height: number }
  | { type: typeof DIAGRAM_MESSAGE; kind: 'error'; message: string };

/** A reply without its `type`, each shape kept apart. */
export type DiagramReplyBody = DiagramReply extends infer Reply
  ? Reply extends DiagramReply
    ? Omit<Reply, 'type'>
    : never
  : never;

export function isDiagramRequest(value: unknown): value is DiagramRequest {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === DIAGRAM_MESSAGE &&
    (DIAGRAM_LANGUAGES as readonly unknown[]).includes(message.language) &&
    typeof message.source === 'string' &&
    typeof message.dark === 'boolean'
  );
}

/** A reply the page can trust the shape of; anything else is ignored. */
export function isDiagramReply(value: unknown): value is DiagramReply {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.type !== DIAGRAM_MESSAGE) return false;
  if (message.kind === 'ready') return true;
  if (message.kind === 'size') return typeof message.height === 'number' && Number.isFinite(message.height) && message.height >= 0;
  if (message.kind === 'error') return typeof message.message === 'string';
  return false;
}

/** The tallest a diagram frame may grow, so a hostile one cannot push the page into kilometres of nothing. */
export const MAX_DIAGRAM_HEIGHT = 4000;
