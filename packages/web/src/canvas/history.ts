/**
 * Canvas versions in History: reading a stored version, laying out what changed
 * between two of them, and the ops that bring the current canvas back to one.
 *
 * Kept apart from the React code, and from React Flow, so History only loads
 * the canvas viewer when somebody opens a canvas version.
 */

import {
  canvasChanges,
  canvasDiffOps,
  canvasNodeSummary,
  type CanvasDocument,
  type CanvasDocumentKite,
  type CanvasEdge,
  type CanvasNode,
  type CanvasOp,
} from '@open-artifact/shared';

export type CanvasMark = 'added' | 'removed' | 'changed';

/** A version's stored content as a canvas. Anything unreadable is an empty one, never a crash. */
export function parseCanvasContent(content: string): CanvasDocument {
  try {
    const parsed = JSON.parse(content) as Partial<CanvasDocument>;
    const kite = documentKite(parsed.kite);
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      ...(kite ? { kite } : {}),
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

/** The theme and custom icons a stored version has, which is all of its kite block a viewer needs. */
function documentKite(raw: unknown): CanvasDocumentKite | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { theme, assets } = raw as CanvasDocumentKite;
  if (!theme && !assets) return undefined;
  return { format: 'kite-canvas', formatVersion: 1, ...(theme ? { theme } : {}), ...(assets ? { assets } : {}) };
}

export interface CanvasChangeRow {
  id: string;
  kind: CanvasMark;
  what: 'node' | 'edge' | 'theme' | 'icon';
  summary: string;
  /** For a changed node: moved, resized, edited. */
  details: string[];
}

export interface CanvasChangesView {
  /** The newer version, with what was removed drawn back in as ghosts. */
  doc: CanvasDocument;
  marks: Record<string, CanvasMark>;
  rows: CanvasChangeRow[];
  counts: { added: number; removed: number; moved: number; resized: number; edited: number; restyled: number; edgesAdded: number; edgesRemoved: number; edgesChanged: number };
}

export function canvasChangesView(before: CanvasDocument, after: CanvasDocument): CanvasChangesView {
  const changes = canvasChanges(before, after);
  const marks: Record<string, CanvasMark> = {};
  const rows: CanvasChangeRow[] = [];
  const counts = { added: 0, removed: 0, moved: 0, resized: 0, edited: 0, restyled: 0, edgesAdded: 0, edgesRemoved: 0, edgesChanged: 0 };
  const ghosts: CanvasNode[] = [];
  const present = new Set(after.nodes.map((n) => n.id));
  const existed = new Set(before.nodes.map((n) => n.id));
  for (const c of changes.nodes) {
    const node = (c.after ?? c.before)!;
    // A node whose type changed comes as removed plus added under one id: one changed row.
    if (c.kind === 'removed' && present.has(c.id)) continue;
    const retyped = c.kind === 'added' && existed.has(c.id);
    const kind: CanvasMark = retyped ? 'changed' : c.kind;
    const details: string[] = [];
    if (retyped) details.push('type changed');
    if (c.moved) details.push('moved');
    if (c.resized) details.push('resized');
    if (c.edited) details.push('edited');
    if (c.restyled) details.push('restyled');
    if (kind === 'added') counts.added += 1;
    if (retyped) counts.edited += 1;
    if (c.kind === 'removed') {
      counts.removed += 1;
      ghosts.push(c.before!);
    }
    if (c.moved) counts.moved += 1;
    if (c.resized) counts.resized += 1;
    if (c.edited) counts.edited += 1;
    if (c.restyled) counts.restyled += 1;
    marks[c.id] = kind;
    rows.push({ id: c.id, kind, what: 'node', summary: canvasNodeSummary(node, 70), details });
  }
  const ids = new Set([...after.nodes.map((n) => n.id), ...ghosts.map((n) => n.id)]);
  const ghostEdges: CanvasEdge[] = [];
  for (const c of changes.edges) {
    const edge = (c.after ?? c.before)!;
    marks[c.id] = c.kind;
    if (c.kind === 'added') counts.edgesAdded += 1;
    if (c.kind === 'changed') counts.edgesChanged += 1;
    if (c.kind === 'removed') {
      counts.edgesRemoved += 1;
      if (ids.has(edge.fromNode) && ids.has(edge.toNode)) ghostEdges.push(edge);
    }
    rows.push({ id: c.id, kind: c.kind, what: 'edge', summary: edge.label ? `“${edge.label}”` : `${edge.fromNode} → ${edge.toNode}`, details: [] });
  }
  if (changes.theme) rows.push({ id: 'theme', kind: 'changed', what: 'theme', summary: 'Canvas theme', details: [] });
  for (const id of changes.assets.added) {
    rows.push({ id, kind: 'added', what: 'icon', summary: after.kite?.assets?.[id]?.name ?? id, details: [] });
  }
  for (const id of changes.assets.removed) {
    rows.push({ id, kind: 'removed', what: 'icon', summary: before.kite?.assets?.[id]?.name ?? id, details: [] });
  }
  // Removed nodes come back as ghosts, still wearing the icons they had.
  const assets = { ...before.kite?.assets, ...after.kite?.assets };
  const kite: CanvasDocumentKite | undefined =
    after.kite || Object.keys(assets).length > 0
      ? { format: 'kite-canvas', formatVersion: 1, ...(after.kite?.theme ? { theme: after.kite.theme } : {}), ...(Object.keys(assets).length > 0 ? { assets } : {}) }
      : undefined;
  return { doc: { nodes: [...after.nodes, ...ghosts], edges: [...after.edges, ...ghostEdges], ...(kite ? { kite } : {}) }, marks, rows, counts };
}

/** The ops that make the current canvas look like an old version again. One batch, so one new version. */
export function restoreOps(current: CanvasDocument, old: CanvasDocument): CanvasOp[] {
  return canvasDiffOps(current, old);
}
