/**
 * The operations the style panel sends, and what it shows for a selection.
 *
 * Every change to a selection is one batch, so restyling twenty nodes is one
 * version and one undo. Kept apart from the panel's React code so it is
 * tested directly.
 */

import type {
  CanvasEdge,
  CanvasEdgeStyle,
  CanvasIcon,
  CanvasNode,
  CanvasNodeStyle,
  CanvasOp,
  CanvasThemePatch,
} from '@open-artifact/shared';

/** A value to set, or null to go back to the default. */
export type Change<T> = { [K in keyof T]?: T[K] | null };

/** The ops that change the same style keys on every one of `nodes`. */
export function nodeStyleOps(nodes: CanvasNode[], change: Change<CanvasNodeStyle>): CanvasOp[] {
  return nodes.map((node) => ({ op: 'update', id: node.id, set: { kite: { style: change } } }));
}

/** Clears every style a node has of its own, and its JSON Canvas colour with it. */
export function resetNodeOps(nodes: CanvasNode[]): CanvasOp[] {
  return nodes
    .filter((node) => node.kite?.style || node.color)
    .map((node) => ({ op: 'update', id: node.id, ...(node.kite?.style ? { set: { kite: { style: null } } } : {}), ...(node.color ? { unset: ['color' as const] } : {}) }));
}

/** Sets (or, with null, removes) the icon of every one of `nodes`. */
export function iconOps(nodes: CanvasNode[], icon: CanvasIcon | null): CanvasOp[] {
  return nodes.map((node) => ({ op: 'update', id: node.id, set: { kite: { icon } } }));
}

/** What an edge's look is made of: its style, plus the two JSON Canvas fields the panel edits. */
export type EdgeChange = Change<CanvasEdgeStyle> & { color?: string | null; fromEnd?: 'none' | 'arrow'; toEnd?: 'none' | 'arrow' };

export function edgeStyleOps(edges: CanvasEdge[], change: EdgeChange): CanvasOp[] {
  const { color, fromEnd, toEnd, ...style } = change;
  return edges.map((edge) => {
    const set: Record<string, unknown> = {};
    if (typeof color === 'string') set.color = color;
    if (fromEnd) set.fromEnd = fromEnd;
    if (toEnd) set.toEnd = toEnd;
    if (Object.keys(style).length > 0) set.kite = { style };
    return {
      op: 'update',
      id: edge.id,
      ...(Object.keys(set).length > 0 ? { set } : {}),
      ...(color === null ? { unset: ['color' as const] } : {}),
    } as CanvasOp;
  });
}

export function resetEdgeOps(edges: CanvasEdge[]): CanvasOp[] {
  return edges
    .filter((edge) => edge.kite?.style || edge.color)
    .map((edge) => ({ op: 'update', id: edge.id, ...(edge.kite?.style ? { set: { kite: { style: null } } } : {}), ...(edge.color ? { unset: ['color' as const] } : {}) }) as CanvasOp);
}

export function themeOps(change: CanvasThemePatch): CanvasOp[] {
  return [{ op: 'theme', set: change }];
}

/**
 * What a control shows for a selection: the value when every item agrees, or
 * `mixed` when they do not. An item with no value counts as the default.
 */
export function common<T>(values: Array<T | undefined>): { value: T | undefined; mixed: boolean } {
  const first = values[0];
  const mixed = values.some((v) => v !== first);
  return { value: mixed ? undefined : first, mixed };
}
