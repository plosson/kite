/**
 * Canvases: JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/), extended by Kite.
 *
 * A canvas is stored as an ordinary artifact whose content is a JSON Canvas
 * document. Everything Kite adds lives under one `kite` key, on a node, an edge
 * or the top level, so a strict export only has to delete those keys and any
 * JSON Canvas reader still gets a valid file.
 *
 * This module is pure: no I/O, no clock, no randomness of its own. The server
 * validates and applies operations with it, and the web app uses the same code
 * for the optimistic view, so the two can never disagree about what an
 * operation means.
 *
 * Scope of this first version, on purpose: `text`, `link` and `group` nodes,
 * plus the Kite "kite" kind (a `link` node pointing at another Kite document,
 * shown as a card or a sandboxed preview). `file` nodes are refused: Kite has
 * no asset store, and the content policy blocks remote images anyway.
 */

export const CANVAS_LIMITS = {
  /** A canvas is smaller than other documents: every version is a full copy. */
  maxBytes: 2 * 1024 * 1024,
  maxNodes: 5000,
  maxEdges: 10000,
  maxOpsPerBatch: 500,
  maxTextLength: 20000,
  maxCoordinate: 1_000_000,
} as const;

export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';
export type CanvasEnd = 'none' | 'arrow';

/** What Kite adds to a node. Never trusted from a client for the timestamps. */
export interface CanvasNodeKite {
  /** 'kite': a link node that embeds another Kite document. */
  kind?: 'kite';
  /** The embedded document's id, when kind is 'kite'. */
  ref?: string;
  /** How a 'kite' node is drawn. */
  view?: 'card' | 'preview';
  createdAt?: string;
  updatedAt?: string;
}

interface CanvasNodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  kite?: CanvasNodeKite;
}

export interface CanvasTextNode extends CanvasNodeBase {
  type: 'text';
  text: string;
}

export interface CanvasLinkNode extends CanvasNodeBase {
  type: 'link';
  url: string;
}

export interface CanvasGroupNode extends CanvasNodeBase {
  type: 'group';
  label?: string;
}

export type CanvasNode = CanvasTextNode | CanvasLinkNode | CanvasGroupNode;
export type CanvasNodeType = CanvasNode['type'];

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: CanvasSide;
  toSide?: CanvasSide;
  fromEnd?: CanvasEnd;
  toEnd?: CanvasEnd;
  color?: string;
  label?: string;
  kite?: { createdAt?: string };
}

export interface CanvasDocument {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  kite?: { format: 'kite-canvas'; formatVersion: 1 };
}

/** A problem with a document or an operation, phrased for whoever sent it. */
export class CanvasError extends Error {
  constructor(
    message: string,
    /** Which operation in a batch, counting from zero, when it came from one. */
    readonly opIndex?: number,
  ) {
    super(message);
    this.name = 'CanvasError';
  }
}

const SIDES: readonly string[] = ['top', 'right', 'bottom', 'left'];
const ENDS: readonly string[] = ['none', 'arrow'];
const NODE_KITE_KEYS = new Set(['kind', 'ref', 'view', 'createdAt', 'updatedAt']);
const EDGE_KITE_KEYS = new Set(['createdAt']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ARTIFACT_ID_PATTERN = /^art_[A-Za-z0-9_-]{4,64}$/;

/** A preset "1"…"6" or a #RRGGBB / #RGB hex colour, as the spec allows. */
export function isCanvasColor(value: unknown): value is string {
  return typeof value === 'string' && (/^[1-6]$/.test(value) || /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(value));
}

/** Only web links. `javascript:`, `data:` and friends never reach a reader. */
export function isSafeCanvasUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireInteger(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new CanvasError(`${what} must be a whole number between ${min} and ${max}.`);
  }
  return value;
}

function optionalString(value: unknown, what: string, max: number = CANVAS_LIMITS.maxTextLength): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new CanvasError(`${what} must be text of at most ${max} characters.`);
  }
  return value;
}

function checkNodeKite(raw: unknown, where: string, type: CanvasNodeType): CanvasNodeKite | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new CanvasError(`${where}: "kite" must be an object.`);
  for (const key of Object.keys(raw)) {
    if (!NODE_KITE_KEYS.has(key)) throw new CanvasError(`${where}: unknown key "kite.${key}".`);
  }
  const kite: CanvasNodeKite = {};
  if (raw.kind !== undefined) {
    if (raw.kind !== 'kite') throw new CanvasError(`${where}: kite.kind can only be "kite" for now.`);
    if (type !== 'link') throw new CanvasError(`${where}: a "kite" node must be a link node.`);
    if (typeof raw.ref !== 'string' || !ARTIFACT_ID_PATTERN.test(raw.ref)) {
      throw new CanvasError(`${where}: a "kite" node needs kite.ref, the id of the document it shows (art_…).`);
    }
    kite.kind = 'kite';
    kite.ref = raw.ref;
    if (raw.view !== undefined) {
      if (raw.view !== 'card' && raw.view !== 'preview') {
        throw new CanvasError(`${where}: kite.view must be "card" or "preview".`);
      }
      kite.view = raw.view;
    }
  } else if (raw.ref !== undefined || raw.view !== undefined) {
    throw new CanvasError(`${where}: kite.ref and kite.view only go on a node with kite.kind "kite".`);
  }
  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'string' || (raw[key] as string).length > 40) {
        throw new CanvasError(`${where}: kite.${key} must be a timestamp.`);
      }
      kite[key] = raw[key] as string;
    }
  }
  return Object.keys(kite).length === 0 ? undefined : kite;
}

/** Checks one node and returns a clean copy holding only the keys Kite knows. */
export function checkNode(raw: unknown, where = 'node'): CanvasNode {
  if (!isObject(raw)) throw new CanvasError(`${where} must be an object.`);
  const id = raw.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new CanvasError(`${where}: id must be 1 to 64 letters, digits, "_" or "-".`);
  }
  const at = `node "${id}"`;
  const max = CANVAS_LIMITS.maxCoordinate;
  const base = {
    id,
    x: requireInteger(raw.x, `${at}: x`, -max, max),
    y: requireInteger(raw.y, `${at}: y`, -max, max),
    width: requireInteger(raw.width, `${at}: width`, 1, max),
    height: requireInteger(raw.height, `${at}: height`, 1, max),
  };
  const color = raw.color;
  if (color !== undefined && !isCanvasColor(color)) {
    throw new CanvasError(`${at}: color must be a preset "1" to "6" or a hex colour like "#ff8800".`);
  }

  let node: CanvasNode;
  switch (raw.type) {
    case 'text': {
      const text = optionalString(raw.text, `${at}: text`);
      if (text === undefined) throw new CanvasError(`${at}: a text node needs "text".`);
      node = { ...base, type: 'text', text };
      break;
    }
    case 'link': {
      if (!isSafeCanvasUrl(raw.url)) {
        throw new CanvasError(`${at}: url must be an http or https address.`);
      }
      node = { ...base, type: 'link', url: raw.url };
      break;
    }
    case 'group': {
      const label = optionalString(raw.label, `${at}: label`, 500);
      node = { ...base, type: 'group', ...(label === undefined ? {} : { label }) };
      break;
    }
    case 'file':
      throw new CanvasError(`${at}: file nodes are not supported yet. Kite has no file storage for canvases.`);
    default:
      throw new CanvasError(`${at}: type must be "text", "link" or "group".`);
  }
  if (color !== undefined) node.color = color as string;
  const kite = checkNodeKite(raw.kite, at, node.type);
  if (kite) node.kite = kite;
  return node;
}

export function checkEdge(raw: unknown, nodeIds: Set<string>, where = 'edge'): CanvasEdge {
  if (!isObject(raw)) throw new CanvasError(`${where} must be an object.`);
  const id = raw.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new CanvasError(`${where}: id must be 1 to 64 letters, digits, "_" or "-".`);
  }
  const at = `edge "${id}"`;
  for (const end of ['fromNode', 'toNode'] as const) {
    const ref = raw[end];
    if (typeof ref !== 'string' || !nodeIds.has(ref)) {
      throw new CanvasError(`${at}: ${end} must be the id of a node on this canvas.`);
    }
  }
  const edge: CanvasEdge = { id, fromNode: raw.fromNode as string, toNode: raw.toNode as string };
  for (const key of ['fromSide', 'toSide'] as const) {
    if (raw[key] !== undefined) {
      if (!SIDES.includes(raw[key] as string)) throw new CanvasError(`${at}: ${key} must be top, right, bottom or left.`);
      edge[key] = raw[key] as CanvasSide;
    }
  }
  for (const key of ['fromEnd', 'toEnd'] as const) {
    if (raw[key] !== undefined) {
      if (!ENDS.includes(raw[key] as string)) throw new CanvasError(`${at}: ${key} must be none or arrow.`);
      edge[key] = raw[key] as CanvasEnd;
    }
  }
  if (raw.color !== undefined) {
    if (!isCanvasColor(raw.color)) throw new CanvasError(`${at}: color must be a preset "1" to "6" or a hex colour.`);
    edge.color = raw.color;
  }
  const label = optionalString(raw.label, `${at}: label`, 500);
  if (label !== undefined) edge.label = label;
  if (raw.kite !== undefined) {
    if (!isObject(raw.kite)) throw new CanvasError(`${at}: "kite" must be an object.`);
    for (const key of Object.keys(raw.kite)) {
      if (!EDGE_KITE_KEYS.has(key)) throw new CanvasError(`${at}: unknown key "kite.${key}".`);
    }
    if (typeof raw.kite.createdAt === 'string') edge.kite = { createdAt: raw.kite.createdAt };
  }
  return edge;
}

/** Checks a whole document. Ids are unique across nodes and edges together. */
export function checkCanvas(raw: unknown): CanvasDocument {
  if (!isObject(raw)) throw new CanvasError('A canvas must be a JSON object with "nodes" and "edges".');
  const rawNodes = raw.nodes ?? [];
  const rawEdges = raw.edges ?? [];
  if (!Array.isArray(rawNodes)) throw new CanvasError('"nodes" must be an array.');
  if (!Array.isArray(rawEdges)) throw new CanvasError('"edges" must be an array.');
  if (rawNodes.length > CANVAS_LIMITS.maxNodes) {
    throw new CanvasError(`A canvas can hold up to ${CANVAS_LIMITS.maxNodes} nodes. This one has ${rawNodes.length}.`);
  }
  if (rawEdges.length > CANVAS_LIMITS.maxEdges) {
    throw new CanvasError(`A canvas can hold up to ${CANVAS_LIMITS.maxEdges} edges. This one has ${rawEdges.length}.`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'nodes' && key !== 'edges' && key !== 'kite') {
      throw new CanvasError(`Unknown top-level key "${key}". Kite extras go under "kite".`);
    }
  }

  const seen = new Set<string>();
  const nodes = rawNodes.map((n, i) => {
    const node = checkNode(n, `nodes[${i}]`);
    if (seen.has(node.id)) throw new CanvasError(`Two things on this canvas have the id "${node.id}".`);
    seen.add(node.id);
    return node;
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = rawEdges.map((e, i) => {
    const edge = checkEdge(e, nodeIds, `edges[${i}]`);
    if (seen.has(edge.id)) throw new CanvasError(`Two things on this canvas have the id "${edge.id}".`);
    seen.add(edge.id);
    return edge;
  });
  // The top-level kite object holds only what is true of every version. The
  // document id and version number are the server's, injected on read, never
  // stored, so a copied file can never claim to be a version it is not.
  return { nodes, edges, kite: { format: 'kite-canvas', formatVersion: 1 } };
}

/** Parses and checks stored or uploaded text. */
export function parseCanvas(content: string): CanvasDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new CanvasError('A canvas must be valid JSON (a JSON Canvas 1.0 file).');
  }
  return checkCanvas(raw);
}

/**
 * The stored form. One node or edge per line, so the version history's line
 * diff reads as "this node changed" rather than one enormous changed line.
 */
export function serialiseCanvas(doc: CanvasDocument): string {
  const lines = (items: unknown[]) => (items.length === 0 ? '[]' : `[\n${items.map((i) => `    ${JSON.stringify(i)}`).join(',\n')}\n  ]`);
  const kite = doc.kite ?? { format: 'kite-canvas', formatVersion: 1 };
  return `{\n  "nodes": ${lines(doc.nodes)},\n  "edges": ${lines(doc.edges)},\n  "kite": ${JSON.stringify(kite)}\n}\n`;
}

/** Spec fields only: every `kite` key removed. */
export function strictCanvas(doc: CanvasDocument): { nodes: unknown[]; edges: unknown[] } {
  const drop = <T extends { kite?: unknown }>(item: T) => {
    const { kite: _kite, ...rest } = item;
    return rest;
  };
  return { nodes: doc.nodes.map(drop), edges: doc.edges.map(drop) };
}

/** The first frame label, else the first line of the first text node. */
export function canvasTitle(doc: CanvasDocument): string | null {
  const group = doc.nodes.find((n): n is CanvasGroupNode => n.type === 'group' && !!n.label?.trim());
  if (group?.label) return group.label.trim();
  const text = doc.nodes.find((n): n is CanvasTextNode => n.type === 'text' && n.text.trim() !== '');
  if (!text) return null;
  const first = text.text.trim().split('\n')[0] ?? '';
  return first.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim() || null;
}

/** What a node says, for comment anchors and outlines. */
export function nodeText(node: CanvasNode): string {
  switch (node.type) {
    case 'text':
      return node.text;
    case 'link':
      return node.url;
    case 'group':
      return node.label ?? '';
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type CanvasNodeFields = {
  type?: CanvasNodeType;
  text?: string;
  url?: string;
  label?: string;
  color?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  kite?: CanvasNodeKite;
};

export type CanvasOp =
  | { op: 'add'; tempId?: string; id?: string; node: CanvasNodeFields; in?: string }
  | { op: 'update'; id: string; set?: CanvasNodeFields; unset?: Array<'color' | 'label'> }
  | { op: 'move'; id: string; x: number; y: number }
  | { op: 'resize'; id: string; width: number; height: number }
  | { op: 'delete'; id: string }
  | {
      op: 'connect';
      tempId?: string;
      id?: string;
      from: string;
      to: string;
      label?: string;
      fromSide?: CanvasSide;
      toSide?: CanvasSide;
      color?: string;
    }
  | { op: 'disconnect'; id: string };

export interface ApplyContext {
  /** ISO timestamp stamped on what this batch creates or changes. */
  now: string;
  /** Makes a fresh id with the given prefix. Injected so tests are repeatable. */
  newId: (prefix: 'n' | 'e') => string;
}

export interface ApplyResult {
  doc: CanvasDocument;
  /** tempId (or given id) → the id it got. */
  ids: Record<string, string>;
  /** Every node or edge id this batch created, changed or removed. */
  touched: string[];
}

const DEFAULT_SIZE: Record<CanvasNodeType, { width: number; height: number }> = {
  text: { width: 260, height: 140 },
  link: { width: 320, height: 160 },
  group: { width: 600, height: 400 },
};

/** Whether a node sits entirely inside a group, which is how the spec defines membership. */
export function isInside(node: CanvasNode, group: CanvasGroupNode): boolean {
  return (
    node.id !== group.id &&
    node.x >= group.x &&
    node.y >= group.y &&
    node.x + node.width <= group.x + group.width &&
    node.y + node.height <= group.y + group.height
  );
}

/** Below the lowest thing already in the group, or at its top-left corner. */
function placeIn(doc: CanvasDocument, group: CanvasGroupNode, size: { width: number; height: number }) {
  const members = doc.nodes.filter((n) => isInside(n, group));
  const bottom = members.reduce((y, n) => Math.max(y, n.y + n.height), group.y + 40);
  return { x: group.x + 20, y: bottom + 20, ...size };
}

/** To the right of everything, so a new node never lands on top of an old one. */
function placeFree(doc: CanvasDocument) {
  if (doc.nodes.length === 0) return { x: 0, y: 0 };
  const right = Math.max(...doc.nodes.map((n) => n.x + n.width));
  const top = Math.min(...doc.nodes.map((n) => n.y));
  return { x: right + 40, y: top };
}

/**
 * Applies a batch, all or nothing. Never mutates the input. Throws a
 * CanvasError naming the operation at fault; the caller writes nothing then.
 */
export function applyCanvasOps(input: CanvasDocument, ops: unknown, ctx: ApplyContext): ApplyResult {
  if (!Array.isArray(ops) || ops.length === 0) throw new CanvasError('"ops" must be a non-empty array.');
  if (ops.length > CANVAS_LIMITS.maxOpsPerBatch) {
    throw new CanvasError(`Send at most ${CANVAS_LIMITS.maxOpsPerBatch} operations at a time.`);
  }

  const doc: CanvasDocument = {
    nodes: input.nodes.map((n) => ({ ...n, ...(n.kite ? { kite: { ...n.kite } } : {}) })),
    edges: input.edges.map((e) => ({ ...e })),
    kite: input.kite,
  };
  const ids: Record<string, string> = {};
  const touched = new Set<string>();
  const resolve = (ref: unknown): string => (typeof ref === 'string' && ids[ref] ? ids[ref] : (ref as string));
  const nodeAt = (ref: unknown, index: number) => {
    const id = resolve(ref);
    const i = doc.nodes.findIndex((n) => n.id === id);
    if (i < 0) throw new CanvasError(`There is no node "${String(ref)}".`, index);
    return i;
  };
  const taken = (id: string) => doc.nodes.some((n) => n.id === id) || doc.edges.some((e) => e.id === id);
  const freshId = (given: unknown, prefix: 'n' | 'e', index: number): string => {
    if (given !== undefined) {
      if (typeof given !== 'string' || !ID_PATTERN.test(given)) throw new CanvasError('id must be 1 to 64 letters, digits, "_" or "-".', index);
      if (taken(given)) throw new CanvasError(`The id "${given}" is already used on this canvas.`, index);
      return given;
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = ctx.newId(prefix);
      if (!taken(id)) return id;
    }
    throw new CanvasError('Could not make a new id.', index);
  };
  const remember = (tempId: unknown, id: string, index: number) => {
    if (tempId === undefined) return;
    if (typeof tempId !== 'string' || tempId.length === 0 || tempId.length > 64) {
      throw new CanvasError('tempId must be a short name.', index);
    }
    if (ids[tempId]) throw new CanvasError(`tempId "${tempId}" is used twice in this batch.`, index);
    ids[tempId] = id;
  };

  ops.forEach((raw, index) => {
    if (!isObject(raw)) throw new CanvasError('Each operation must be an object.', index);
    try {
      switch (raw.op) {
        case 'add': {
          if (!isObject(raw.node)) throw new CanvasError('"add" needs a "node" object.');
          const fields = raw.node as CanvasNodeFields;
          const type = fields.type ?? 'text';
          const size = {
            width: fields.width ?? DEFAULT_SIZE[type]?.width ?? 260,
            height: fields.height ?? DEFAULT_SIZE[type]?.height ?? 140,
          };
          let place: { x: number; y: number };
          if (raw.in !== undefined) {
            const group = doc.nodes[nodeAt(raw.in, index)];
            if (group?.type !== 'group') throw new CanvasError(`"${String(raw.in)}" is not a group.`);
            place = placeIn(doc, group, size);
          } else if (fields.x !== undefined && fields.y !== undefined) {
            place = { x: Math.round(fields.x), y: Math.round(fields.y) };
          } else {
            place = placeFree(doc);
          }
          const id = freshId(raw.id, 'n', index);
          const node = checkNode({
            ...fields,
            type,
            id,
            ...place,
            width: Math.round(size.width),
            height: Math.round(size.height),
            kite: { ...(fields.kite ?? {}), createdAt: ctx.now, updatedAt: ctx.now },
          });
          doc.nodes.push(node);
          remember(raw.tempId, id, index);
          touched.add(id);
          break;
        }
        case 'update': {
          const i = nodeAt(raw.id, index);
          const current = doc.nodes[i]!;
          const set = raw.set === undefined ? {} : raw.set;
          if (!isObject(set)) throw new CanvasError('"set" must be an object.');
          if ('id' in set || 'type' in set) throw new CanvasError('A node keeps its id and type. Delete it and add a new one instead.');
          const next: Record<string, unknown> = { ...current, ...set };
          if (set.kite !== undefined) {
            if (!isObject(set.kite)) throw new CanvasError('"kite" must be an object.');
            const { createdAt: _c, updatedAt: _u, ...given } = set.kite;
            next.kite = { ...(current.kite ?? {}), ...given };
          }
          const unset = raw.unset ?? [];
          if (!Array.isArray(unset)) throw new CanvasError('"unset" must be an array.');
          for (const key of unset) {
            if (key !== 'color' && key !== 'label') throw new CanvasError('Only color and label can be unset.');
            delete next[key];
          }
          next.kite = { ...((next.kite as object) ?? {}), updatedAt: ctx.now };
          doc.nodes[i] = checkNode(next);
          touched.add(current.id);
          break;
        }
        case 'move': {
          const i = nodeAt(raw.id, index);
          const node = doc.nodes[i]!;
          const x = Math.round(Number(raw.x));
          const y = Math.round(Number(raw.y));
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new CanvasError('"move" needs numbers x and y.');
          const dx = x - node.x;
          const dy = y - node.y;
          // A group carries what is inside it, worked out before it moves.
          const members = node.type === 'group' ? doc.nodes.filter((n) => isInside(n, node)) : [];
          for (const target of [node, ...members]) {
            const j = doc.nodes.indexOf(target);
            doc.nodes[j] = checkNode({ ...target, x: target.x + dx, y: target.y + dy });
            touched.add(target.id);
          }
          break;
        }
        case 'resize': {
          const i = nodeAt(raw.id, index);
          const node = doc.nodes[i]!;
          doc.nodes[i] = checkNode({ ...node, width: Math.round(Number(raw.width)), height: Math.round(Number(raw.height)) });
          touched.add(node.id);
          break;
        }
        case 'delete': {
          const id = resolve(raw.id);
          const ni = doc.nodes.findIndex((n) => n.id === id);
          if (ni >= 0) {
            doc.nodes.splice(ni, 1);
            touched.add(id);
            doc.edges = doc.edges.filter((e) => {
              const attached = e.fromNode === id || e.toNode === id;
              if (attached) touched.add(e.id);
              return !attached;
            });
            break;
          }
          const ei = doc.edges.findIndex((e) => e.id === id);
          if (ei < 0) throw new CanvasError(`There is no node or edge "${String(raw.id)}".`);
          doc.edges.splice(ei, 1);
          touched.add(id);
          break;
        }
        case 'connect': {
          const from = doc.nodes[nodeAt(raw.from, index)]!.id;
          const to = doc.nodes[nodeAt(raw.to, index)]!.id;
          const id = freshId(raw.id, 'e', index);
          const edge = checkEdge(
            {
              id,
              fromNode: from,
              toNode: to,
              ...(raw.label === undefined ? {} : { label: raw.label }),
              ...(raw.fromSide === undefined ? {} : { fromSide: raw.fromSide }),
              ...(raw.toSide === undefined ? {} : { toSide: raw.toSide }),
              ...(raw.color === undefined ? {} : { color: raw.color }),
              kite: { createdAt: ctx.now },
            },
            new Set(doc.nodes.map((n) => n.id)),
          );
          doc.edges.push(edge);
          remember(raw.tempId, id, index);
          touched.add(id);
          break;
        }
        case 'disconnect': {
          const id = resolve(raw.id);
          const ei = doc.edges.findIndex((e) => e.id === id);
          if (ei < 0) throw new CanvasError(`There is no edge "${String(raw.id)}".`);
          doc.edges.splice(ei, 1);
          touched.add(id);
          break;
        }
        default:
          throw new CanvasError(
            'op must be one of add, update, move, resize, delete, connect, disconnect.',
          );
      }
    } catch (error) {
      if (error instanceof CanvasError && error.opIndex === undefined) {
        throw new CanvasError(error.message, index);
      }
      throw error;
    }
  });

  if (doc.nodes.length > CANVAS_LIMITS.maxNodes) throw new CanvasError(`A canvas can hold up to ${CANVAS_LIMITS.maxNodes} nodes.`);
  if (doc.edges.length > CANVAS_LIMITS.maxEdges) throw new CanvasError(`A canvas can hold up to ${CANVAS_LIMITS.maxEdges} edges.`);
  return { doc, ids, touched: [...touched] };
}
