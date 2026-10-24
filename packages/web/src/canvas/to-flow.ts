/**
 * JSON Canvas → React Flow, kept pure so it can be tested without a DOM.
 *
 * Groups become real React Flow parents: a node's parent is the smallest group
 * it sits entirely inside, which is the same geometric rule the server uses
 * when a moved group carries its members. So what follows a group live while
 * it is dragged is exactly what the server moves when the drag is saved.
 */
import { nodeNesting, type CanvasDocument, type CanvasNode } from '@open-artifact/shared';

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
  const nesting = nodeNesting(doc);
  const shapes = doc.nodes.map((node, index) => {
    const { parent, depth } = nesting.get(node.id)!;
    const origin = parent ? { x: parent.x, y: parent.y } : { x: 0, y: 0 };
    return {
      index,
      shape: {
        id: node.id,
        ...(parent ? { parentId: parent.id } : {}),
        position: { x: node.x - origin.x, y: node.y - origin.y },
        parentOrigin: origin,
        depth,
        node,
      } satisfies FlowNodeShape,
    };
  });
  // React Flow needs a parent before its children; otherwise keep the document's order.
  shapes.sort((a, b) => a.shape.depth - b.shape.depth || a.index - b.index);
  return shapes.map((s) => s.shape);
}

export { edgeSides, facingSides } from '@open-artifact/shared';

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

