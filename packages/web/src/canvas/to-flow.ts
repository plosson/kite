/**
 * JSON Canvas → React Flow, kept pure so it can be tested without a DOM.
 *
 * Groups become real React Flow parents: a node's parent is the smallest group
 * it sits entirely inside, which is the same geometric rule the server uses
 * when a moved group carries its members. So what follows a group live while
 * it is dragged is exactly what the server moves when the drag is saved.
 */
import { parentGroupOf, type CanvasDocument, type CanvasEdge, type CanvasNode, type CanvasSide } from '@open-artifact/shared';

export interface FlowNodeShape {
  id: string;
  parentId?: string;
  /** Relative to the parent, when there is one, as React Flow wants it. */
  position: { x: number; y: number };
  /** Where the parent's corner is, for turning React Flow's relative boxes back into canvas ones. */
  parentOrigin: { x: number; y: number };
  depth: number;
  node: CanvasNode;
}

export function flowNodes(doc: CanvasDocument): FlowNodeShape[] {
  const groups = doc.nodes.filter((n) => n.type === 'group');
  const parentOf = new Map<string, CanvasNode | null>();
  for (const n of doc.nodes) parentOf.set(n.id, groups.length ? parentGroupOf({ nodes: groups }, n) : null);
  const depthOf = (n: CanvasNode): number => {
    let d = 0;
    let p = parentOf.get(n.id);
    const seen = new Set<string>();
    while (p && !seen.has(p.id)) {
      seen.add(p.id);
      d++;
      p = parentOf.get(p.id) ?? null;
    }
    return d;
  };
  const shapes = doc.nodes.map((node, index) => {
    const parent = parentOf.get(node.id) ?? null;
    const origin = parent ? { x: parent.x, y: parent.y } : { x: 0, y: 0 };
    return {
      index,
      shape: {
        id: node.id,
        ...(parent ? { parentId: parent.id } : {}),
        position: { x: node.x - origin.x, y: node.y - origin.y },
        parentOrigin: origin,
        depth: depthOf(node),
        node,
      } satisfies FlowNodeShape,
    };
  });
  // React Flow needs a parent before its children; otherwise keep the document's order.
  shapes.sort((a, b) => a.shape.depth - b.shape.depth || a.index - b.index);
  return shapes.map((s) => s.shape);
}

/** The side of `from` facing `to`, for an edge that does not name one. */
export function facingSides(from: CanvasNode, to: CanvasNode): { fromSide: CanvasSide; toSide: CanvasSide } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? { fromSide: 'right', toSide: 'left' } : { fromSide: 'left', toSide: 'right' };
  return dy >= 0 ? { fromSide: 'bottom', toSide: 'top' } : { fromSide: 'top', toSide: 'bottom' };
}

export function edgeSides(edge: CanvasEdge, byId: Map<string, CanvasNode>): { fromSide: CanvasSide; toSide: CanvasSide } {
  const from = byId.get(edge.fromNode);
  const to = byId.get(edge.toNode);
  const auto = from && to ? facingSides(from, to) : { fromSide: 'right' as const, toSide: 'left' as const };
  return { fromSide: edge.fromSide ?? auto.fromSide, toSide: edge.toSide ?? auto.toSide };
}

/** Zoom levels where detail drops away. */
export const LOD = {
  /** Below this, a card is a coloured box. */
  far: 0.35,
  /** Below this, edge labels go. */
  labels: 0.6,
  /** On a canvas with more than this many nodes or edges, edges go too when far. */
  bigCanvas: 300,
  /** The furthest out a big canvas opens. */
  bigOpenZoom: 0.5,
};

export function isBigCanvas(doc: CanvasDocument): boolean {
  return doc.nodes.length > LOD.bigCanvas || doc.edges.length > LOD.bigCanvas;
}

/** Off-site links on a public canvas go through /leaving, exactly as in public Markdown. */
export function linkHref(url: string, isPublic: boolean, origin: string = window.location.origin): string {
  if (!isPublic) return url;
  try {
    const resolved = new URL(url, origin);
    if (resolved.origin === origin || (resolved.protocol !== 'http:' && resolved.protocol !== 'https:')) return url;
    return `/leaving?to=${encodeURIComponent(resolved.href)}`;
  } catch {
    return url;
  }
}

