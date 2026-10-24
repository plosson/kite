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
 * Scope, on purpose: `text`, `link` and `group` nodes, plus the Kite "kite"
 * kind (a `link` node pointing at another Kite document, shown as a card or a
 * sandboxed preview). `file` nodes are refused: Kite keeps no files for a
 * canvas, and the content policy blocks remote images anyway.
 *
 * How a canvas looks (styles, icons, theme defaults, custom SVG icons) is in
 * canvas-style.ts and canvas-svg.ts, and is stored under the same `kite` keys.
 */

import {
  assetId,
  checkAsset,
  checkAssets,
  checkEdgeStyle,
  checkIcon,
  checkNodeStyle,
  checkTheme,
  CanvasStyleError,
  mergeStyle,
  mergeTheme,
  stylePatch,
  themePatch,
  STYLE_LIMITS,
  type CanvasAsset,
  type CanvasEdgeStyle,
  type CanvasIcon,
  type CanvasNodeStyle,
  type CanvasTheme,
} from './canvas-style.js';

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
  /** How the node looks. Groups may also style their label. */
  style?: CanvasNodeStyle;
  /** A Lucide icon or one of this canvas's custom SVGs, drawn with the text. */
  icon?: CanvasIcon;
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
  kite?: CanvasEdgeKite;
}

/** What Kite adds to an edge. Arrow ends are the spec's own fromEnd and toEnd. */
export interface CanvasEdgeKite {
  style?: CanvasEdgeStyle;
  createdAt?: string;
}

/** What Kite adds at the top level of a canvas. */
export interface CanvasDocumentKite {
  format: 'kite-canvas';
  formatVersion: 1;
  /** Canvas-wide defaults: background, grid, and default node, group and edge styles. */
  theme?: CanvasTheme;
  /** Custom SVG icons, sanitised, by id. A node shows one with icon.name "asset:<id>". */
  assets?: Record<string, CanvasAsset>;
}

export interface CanvasDocument {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  kite?: CanvasDocumentKite;
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
const NODE_KITE_KEYS = new Set(['kind', 'ref', 'view', 'style', 'icon', 'createdAt', 'updatedAt']);
const EDGE_KITE_KEYS = new Set(['style', 'createdAt']);
const DOCUMENT_KITE_KEYS = new Set(['format', 'formatVersion', 'docId', 'version', 'theme', 'assets']);

/** Runs a style check, reporting its problem as a CanvasError like every other. */
function styled<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof CanvasStyleError) throw new CanvasError(error.message);
    throw error;
  }
}
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
  const style = styled(() => checkNodeStyle(raw.style, `${where}: kite.style`, type === 'group'));
  if (style) kite.style = style;
  const icon = styled(() => checkIcon(raw.icon, `${where}: kite.icon`));
  if (icon) kite.icon = icon;
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
    const given = raw.kite;
    const kite: CanvasEdgeKite = {};
    const style = styled(() => checkEdgeStyle(given.style, `${at}: kite.style`));
    if (style) kite.style = style;
    if (typeof given.createdAt === 'string') kite.createdAt = given.createdAt;
    if (Object.keys(kite).length > 0) edge.kite = kite;
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
  const kite = checkDocumentKite(raw.kite);

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
  const doc: CanvasDocument = { nodes, edges, kite };
  checkAssetRefs(doc);
  return doc;
}

/**
 * The top-level kite object holds only what is true of every version: the
 * format, the theme and the custom icons. The document id and version number
 * are the server's, injected on read and dropped here, never stored, so a
 * copied file can never claim to be a version it is not.
 */
function checkDocumentKite(raw: unknown): CanvasDocumentKite {
  const kite: CanvasDocumentKite = { format: 'kite-canvas', formatVersion: 1 };
  if (raw === undefined) return kite;
  if (!isObject(raw)) throw new CanvasError('The top-level "kite" must be an object.');
  for (const key of Object.keys(raw)) {
    if (!DOCUMENT_KITE_KEYS.has(key)) throw new CanvasError(`Unknown key "kite.${key}". The top-level kite holds theme and assets.`);
  }
  const theme = styled(() => checkTheme(raw.theme));
  if (theme) kite.theme = theme;
  const assets = styled(() => checkAssets(raw.assets));
  if (assets) kite.assets = assets;
  return kite;
}

/** Every custom icon a node shows is one this canvas holds. */
function checkAssetRefs(doc: CanvasDocument): void {
  const assets = doc.kite?.assets ?? {};
  for (const node of doc.nodes) {
    const id = node.kite?.icon ? assetId(node.kite.icon) : null;
    if (id !== null && !Object.hasOwn(assets, id)) {
      throw new CanvasError(`node "${node.id}": its icon is asset "${id}", which this canvas does not have. Add it with an addAsset operation first.`);
    }
  }
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
  const kite: CanvasDocumentKite = {
    format: 'kite-canvas',
    formatVersion: 1,
    ...(doc.kite?.theme ? { theme: doc.kite.theme } : {}),
    ...(doc.kite?.assets ? { assets: doc.kite.assets } : {}),
  };
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

/** A partial style for an update: keys given replace, keys set to null are removed. */
export type CanvasStylePatch<T> = { [K in keyof T]?: T[K] | null };

/**
 * The kite part of a node in an add or an update. In an update, `style` merges
 * into the node's style (null removes a key, or the whole style), and `icon`
 * replaces the icon (null removes it). Timestamps are the server's.
 */
export interface CanvasNodeKitePatch {
  kind?: 'kite';
  ref?: string;
  view?: 'card' | 'preview';
  style?: CanvasStylePatch<CanvasNodeStyle> | null;
  icon?: CanvasIcon | null;
}

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
  kite?: CanvasNodeKitePatch;
};

export type CanvasEdgeFields = {
  label?: string;
  color?: string;
  fromSide?: CanvasSide;
  toSide?: CanvasSide;
  fromEnd?: CanvasEnd;
  toEnd?: CanvasEnd;
  kite?: { style?: CanvasStylePatch<CanvasEdgeStyle> | null };
};

/** A theme patch: top-level keys replace (null removes); node, group and edge merge like a style. */
export type CanvasThemePatch = {
  background?: string | null;
  grid?: CanvasTheme['grid'] | null;
  gridColor?: string | null;
  node?: CanvasStylePatch<CanvasNodeStyle> | null;
  group?: CanvasStylePatch<CanvasNodeStyle> | null;
  edge?: CanvasStylePatch<NonNullable<CanvasTheme['edge']>> | null;
};

const EDGE_FIELDS = ['label', 'color', 'fromSide', 'toSide', 'fromEnd', 'toEnd'] as const;
type CanvasEdgeKey = (typeof EDGE_FIELDS)[number];

export type CanvasOp =
  | {
      op: 'add';
      tempId?: string;
      id?: string;
      node: CanvasNodeFields;
      /** A group to drop the node into. */
      in?: string;
      /** A node to sit next to, on `side` (default right). */
      near?: string;
      side?: CanvasSide;
    }
  | { op: 'update'; id: string; set?: CanvasNodeFields; unset?: Array<'color' | 'label'> }
  | { op: 'update'; id: string; set?: CanvasEdgeFields; unset?: CanvasEdgeKey[] }
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
      fromEnd?: CanvasEnd;
      toEnd?: CanvasEnd;
      color?: string;
      kite?: { style?: CanvasEdgeStyle };
    }
  | { op: 'disconnect'; id: string }
  /** Changes the canvas-wide theme. `set: null` removes it. */
  | { op: 'theme'; set: CanvasThemePatch | null }
  /** Adds a custom SVG icon to the canvas, sanitised. Nodes show it with icon.name "asset:<id>". */
  | { op: 'addAsset'; tempId?: string; id?: string; svg: string; name?: string }
  /** Removes a custom SVG icon no node uses any more. */
  | { op: 'deleteAsset'; id: string };

export interface ApplyContext {
  /** ISO timestamp stamped on what this batch creates or changes. */
  now: string;
  /** Makes a fresh id with the given prefix (node, edge, asset). Injected so tests are repeatable. */
  newId: (prefix: 'n' | 'e' | 'a') => string;
}

export interface ApplyResult {
  doc: CanvasDocument;
  /** tempId (or given id) → the id it got. */
  ids: Record<string, string>;
  /** Every node, edge or asset id this batch created, changed or removed. */
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

const GAP = 40;

function overlaps(a: Box, b: Box, gap = 0): boolean {
  return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * The first spot from `start` that overlaps nothing, stepping along `side`.
 * Groups only count when the spot would straddle their border, so a node can
 * still land inside an empty part of a frame it was aimed at.
 */
export function findFreeSlot(
  doc: Pick<CanvasDocument, 'nodes'>,
  start: { x: number; y: number },
  size: { width: number; height: number },
  side: CanvasSide = 'right',
): { x: number; y: number } {
  const step = {
    right: { dx: 1, dy: 0 },
    left: { dx: -1, dy: 0 },
    bottom: { dx: 0, dy: 1 },
    top: { dx: 0, dy: -1 },
  }[side];
  let x = Math.round(start.x);
  let y = Math.round(start.y);
  for (let attempt = 0; attempt < 400; attempt++) {
    const box = { x, y, ...size };
    const hit = doc.nodes.find((n) =>
      n.type === 'group'
        ? overlaps(box, n) && !(box.x >= n.x && box.y >= n.y && box.x + box.width <= n.x + n.width && box.y + box.height <= n.y + n.height)
        : overlaps(box, n, GAP / 2),
    );
    if (!hit) return { x, y };
    if (step.dx > 0) x = hit.x + hit.width + GAP;
    else if (step.dx < 0) x = hit.x - size.width - GAP;
    else if (step.dy > 0) y = hit.y + hit.height + GAP;
    else y = hit.y - size.height - GAP;
  }
  return { x, y };
}

/** Next to `anchor`, on `side`, nudged along until nothing is in the way. */
function placeNear(doc: CanvasDocument, anchor: CanvasNode, side: CanvasSide, size: { width: number; height: number }) {
  const start = {
    right: { x: anchor.x + anchor.width + GAP, y: anchor.y },
    left: { x: anchor.x - size.width - GAP, y: anchor.y },
    bottom: { x: anchor.x, y: anchor.y + anchor.height + GAP },
    top: { x: anchor.x, y: anchor.y - size.height - GAP },
  }[side];
  return findFreeSlot(doc, start, size, side);
}

/**
 * With no position given: beside the node changed most recently, so a run of
 * agent adds forms a readable row near where the work is, instead of
 * drifting off past the far edge of a big canvas.
 */
function placeFree(doc: CanvasDocument, size: { width: number; height: number }) {
  if (doc.nodes.length === 0) return { x: 0, y: 0 };
  const candidates = doc.nodes.filter((n) => n.type !== 'group');
  const pool = candidates.length > 0 ? candidates : doc.nodes;
  let latest = pool[pool.length - 1]!;
  for (const n of pool) {
    if ((n.kite?.updatedAt ?? '') > (latest.kite?.updatedAt ?? '')) latest = n;
  }
  if (latest.type === 'group') return findFreeSlot(doc, { x: latest.x + latest.width + GAP, y: latest.y }, size, 'right');
  return placeNear(doc, latest, 'right', size);
}

/** The smallest group a node sits entirely inside, or null. Ties go to the later (higher) group. */
export function parentGroupOf(doc: Pick<CanvasDocument, 'nodes'>, node: CanvasNode): CanvasGroupNode | null {
  let best: CanvasGroupNode | null = null;
  for (const g of doc.nodes) {
    if (g.type !== 'group' || g.id === node.id || !isInside(node, g)) continue;
    // A group never parents a group of the same box, or one containing it.
    if (node.type === 'group' && g.width * g.height <= node.width * node.height) continue;
    if (!best || g.width * g.height <= best.width * best.height) best = g;
  }
  return best;
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
  const assetTaken = (id: string) => Object.hasOwn(doc.kite?.assets ?? {}, id);
  const freshId = (given: unknown, prefix: 'n' | 'e' | 'a', index: number): string => {
    const used = prefix === 'a' ? assetTaken : taken;
    if (given !== undefined) {
      if (typeof given !== 'string' || !ID_PATTERN.test(given)) throw new CanvasError('id must be 1 to 64 letters, digits, "_" or "-".', index);
      if (used(given)) throw new CanvasError(`The id "${given}" is already used on this canvas.`, index);
      return given;
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = ctx.newId(prefix);
      if (!used(id)) return id;
    }
    throw new CanvasError('Could not make a new id.', index);
  };
  /** An icon naming an asset by the tempId an earlier addAsset in this batch gave it. */
  const resolveIcon = (icon: unknown): unknown => {
    if (!isObject(icon) || typeof icon.name !== 'string' || !icon.name.startsWith('asset:')) return icon;
    const ref = icon.name.slice(6);
    return ids[ref] ? { ...icon, name: `asset:${ids[ref]}` } : icon;
  };
  const withKite = (patch: Partial<CanvasDocumentKite>): CanvasDocumentKite => {
    const next: CanvasDocumentKite = { format: 'kite-canvas', formatVersion: 1, ...(doc.kite ?? {}), ...patch };
    if (next.theme === undefined) delete next.theme;
    if (next.assets === undefined) delete next.assets;
    return next;
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
          if (raw.side !== undefined && !SIDES.includes(raw.side as CanvasSide)) {
            throw new CanvasError('side must be top, right, bottom or left.');
          }
          if (raw.in !== undefined) {
            const group = doc.nodes[nodeAt(raw.in, index)];
            if (group?.type !== 'group') throw new CanvasError(`"${String(raw.in)}" is not a group.`);
            place = placeIn(doc, group, size);
          } else if (fields.x !== undefined && fields.y !== undefined) {
            place = { x: Math.round(fields.x), y: Math.round(fields.y) };
          } else if (raw.near !== undefined) {
            const anchor = doc.nodes[nodeAt(raw.near, index)]!;
            place = placeNear(doc, anchor, (raw.side as CanvasSide | undefined) ?? 'right', size);
          } else {
            place = placeFree(doc, size);
          }
          const id = freshId(raw.id, 'n', index);
          const givenKite = (isObject(fields.kite) ? fields.kite : {}) as Record<string, unknown>;
          if (fields.kite !== undefined && !isObject(fields.kite)) throw new CanvasError('"kite" must be an object.');
          const node = checkNode({
            ...fields,
            type,
            id,
            ...place,
            width: Math.round(size.width),
            height: Math.round(size.height),
            kite: {
              ...givenKite,
              ...(givenKite.icon === undefined ? {} : { icon: resolveIcon(givenKite.icon) }),
              createdAt: ctx.now,
              updatedAt: ctx.now,
            },
          });
          doc.nodes.push(node);
          remember(raw.tempId, id, index);
          touched.add(id);
          break;
        }
        case 'update': {
          const edgeIndex = doc.edges.findIndex((e) => e.id === resolve(raw.id));
          if (edgeIndex >= 0) {
            const current = doc.edges[edgeIndex]!;
            const set = raw.set === undefined ? {} : raw.set;
            if (!isObject(set)) throw new CanvasError('"set" must be an object.');
            for (const key of Object.keys(set)) {
              if (!(EDGE_FIELDS as readonly string[]).includes(key) && key !== 'kite') {
                throw new CanvasError(
                  `An edge can change its ${EDGE_FIELDS.join(', ')} and kite.style. Disconnect it and connect again to change the nodes it joins.`,
                );
              }
            }
            const next: Record<string, unknown> = { ...current, ...set };
            if (set.kite !== undefined) {
              if (!isObject(set.kite)) throw new CanvasError('"kite" must be an object.');
              for (const key of Object.keys(set.kite)) {
                if (key !== 'style') throw new CanvasError(`An edge's kite can only change "style", not "${key}".`);
              }
              const patch = set.kite;
              const kite: Record<string, unknown> = { ...(current.kite ?? {}) };
              if (patch.style !== undefined) {
                const style = styled(() => mergeStyle(current.kite?.style, patch.style, 'kite.style'));
                if (style) kite.style = style;
                else delete kite.style;
              }
              next.kite = kite;
            }
            const unset = raw.unset ?? [];
            if (!Array.isArray(unset)) throw new CanvasError('"unset" must be an array.');
            for (const key of unset) {
              if (!(EDGE_FIELDS as readonly string[]).includes(key)) {
                throw new CanvasError(`An edge can unset ${EDGE_FIELDS.join(', ')}.`);
              }
              delete next[key];
            }
            doc.edges[edgeIndex] = checkEdge(next, new Set(doc.nodes.map((n) => n.id)));
            touched.add(current.id);
            break;
          }
          const i = nodeAt(raw.id, index);
          const current = doc.nodes[i]!;
          const set = raw.set === undefined ? {} : raw.set;
          if (!isObject(set)) throw new CanvasError('"set" must be an object.');
          if ('id' in set || 'type' in set) throw new CanvasError('A node keeps its id and type. Delete it and add a new one instead.');
          const next: Record<string, unknown> = { ...current, ...set };
          if (set.kite !== undefined) {
            if (!isObject(set.kite)) throw new CanvasError('"kite" must be an object.');
            const { createdAt: _c, updatedAt: _u, style, icon, ...given } = set.kite;
            const kite: Record<string, unknown> = { ...(current.kite ?? {}), ...given };
            if (style !== undefined) {
              const merged = styled(() => mergeStyle(current.kite?.style, style, 'kite.style'));
              if (merged) kite.style = merged;
              else delete kite.style;
            }
            if (icon === null) delete kite.icon;
            else if (icon !== undefined) kite.icon = resolveIcon(icon);
            next.kite = kite;
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
              ...(raw.fromEnd === undefined ? {} : { fromEnd: raw.fromEnd }),
              ...(raw.toEnd === undefined ? {} : { toEnd: raw.toEnd }),
              ...(raw.color === undefined ? {} : { color: raw.color }),
              kite: { ...connectKite(raw.kite), createdAt: ctx.now },
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
        case 'theme': {
          if (raw.set === undefined) throw new CanvasError('"theme" needs "set": the theme keys to change, or null to remove the theme.');
          const merged = styled(() => mergeTheme(doc.kite?.theme, raw.set));
          const theme = styled(() => checkTheme(merged, 'theme'));
          doc.kite = withKite({ theme });
          break;
        }
        case 'addAsset': {
          const assets = doc.kite?.assets ?? {};
          if (Object.keys(assets).length >= STYLE_LIMITS.maxAssets) {
            throw new CanvasError(`A canvas can hold up to ${STYLE_LIMITS.maxAssets} custom SVG icons. Delete one it no longer uses first.`);
          }
          const id = freshId(raw.id, 'a', index);
          const asset = styled(() => checkAsset({ type: 'svg', svg: raw.svg, ...(raw.name === undefined ? {} : { name: raw.name }) }, 'addAsset'));
          doc.kite = withKite({ assets: { ...assets, [id]: asset } });
          remember(raw.tempId, id, index);
          touched.add(id);
          break;
        }
        case 'deleteAsset': {
          const id = resolve(raw.id);
          const assets = doc.kite?.assets ?? {};
          if (typeof id !== 'string' || !Object.hasOwn(assets, id)) throw new CanvasError(`There is no asset "${String(raw.id)}".`);
          const users = doc.nodes.filter((n) => n.kite?.icon?.name === `asset:${id}`).map((n) => n.id);
          if (users.length > 0) {
            throw new CanvasError(`Asset "${id}" is the icon of ${users.length === 1 ? `node "${users[0]}"` : `${users.length} nodes`}. Change or remove those icons first.`);
          }
          const { [id]: _gone, ...rest } = assets;
          doc.kite = withKite({ assets: Object.keys(rest).length > 0 ? rest : undefined });
          touched.add(id);
          break;
        }
        default:
          throw new CanvasError(
            'op must be one of add, update, move, resize, delete, connect, disconnect, theme, addAsset, deleteAsset.',
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
  checkAssetRefs(doc);
  return { doc, ids, touched: [...touched] };
}

/** The kite part a connect may carry: only a style. */
function connectKite(raw: unknown): CanvasEdgeKite {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new CanvasError('"kite" must be an object.');
  for (const key of Object.keys(raw)) {
    if (key !== 'style') throw new CanvasError(`A new edge's kite can only carry "style", not "${key}".`);
  }
  return raw.style === undefined ? {} : { style: raw.style as CanvasEdgeStyle };
}

// ---------------------------------------------------------------------------
// Differences between two versions
// ---------------------------------------------------------------------------

export interface CanvasNodeChange {
  id: string;
  kind: 'added' | 'removed' | 'changed';
  before?: CanvasNode;
  after?: CanvasNode;
  moved: boolean;
  resized: boolean;
  /** Text, url, label, colour or what a kite node points at changed. */
  edited: boolean;
  /** Its own style or its icon changed. */
  restyled: boolean;
}

export interface CanvasEdgeChange {
  id: string;
  kind: 'added' | 'removed' | 'changed';
  before?: CanvasEdge;
  after?: CanvasEdge;
}

export interface CanvasChanges {
  nodes: CanvasNodeChange[];
  edges: CanvasEdgeChange[];
  /** Whether the canvas-wide theme changed. */
  theme: boolean;
  /** Custom SVG icons added to or removed from the canvas. */
  assets: { added: string[]; removed: string[] };
}

function contentOf(node: CanvasNode): string {
  const { x: _x, y: _y, width: _w, height: _h, kite, ...rest } = node;
  const { createdAt: _c, updatedAt: _u, style: _s, icon: _i, ...k } = kite ?? {};
  return JSON.stringify({ ...rest, kite: k });
}

function lookOf(node: CanvasNode): string {
  return JSON.stringify({ style: node.kite?.style ?? null, icon: node.kite?.icon ?? null });
}

function edgeShape(edge: CanvasEdge): string {
  const { kite, ...rest } = edge;
  return JSON.stringify({ ...rest, style: kite?.style ?? null });
}

/** What changed from one version to the next, node by node. Unchanged things are left out. */
export function canvasChanges(from: CanvasDocument, to: CanvasDocument): CanvasChanges {
  const before = new Map(from.nodes.map((n) => [n.id, n]));
  const after = new Map(to.nodes.map((n) => [n.id, n]));
  const nodes: CanvasNodeChange[] = [];
  for (const n of to.nodes) {
    const old = before.get(n.id);
    if (!old || old.type !== n.type) {
      if (old) nodes.push({ id: n.id, kind: 'removed', before: old, moved: false, resized: false, edited: false, restyled: false });
      nodes.push({ id: n.id, kind: 'added', after: n, moved: false, resized: false, edited: false, restyled: false });
      continue;
    }
    const moved = old.x !== n.x || old.y !== n.y;
    const resized = old.width !== n.width || old.height !== n.height;
    const edited = contentOf(old) !== contentOf(n);
    const restyled = lookOf(old) !== lookOf(n);
    if (moved || resized || edited || restyled) nodes.push({ id: n.id, kind: 'changed', before: old, after: n, moved, resized, edited, restyled });
  }
  for (const n of from.nodes) {
    if (!after.has(n.id)) nodes.push({ id: n.id, kind: 'removed', before: n, moved: false, resized: false, edited: false, restyled: false });
  }
  const edgesBefore = new Map(from.edges.map((e) => [e.id, e]));
  const edgesAfter = new Map(to.edges.map((e) => [e.id, e]));
  const edges: CanvasEdgeChange[] = [];
  for (const e of to.edges) {
    const old = edgesBefore.get(e.id);
    if (!old) edges.push({ id: e.id, kind: 'added', after: e });
    else if (edgeShape(old) !== edgeShape(e)) edges.push({ id: e.id, kind: 'changed', before: old, after: e });
  }
  for (const e of from.edges) if (!edgesAfter.has(e.id)) edges.push({ id: e.id, kind: 'removed', before: e });
  const assetsBefore = from.kite?.assets ?? {};
  const assetsAfter = to.kite?.assets ?? {};
  return {
    nodes,
    edges,
    theme: themePatch(from.kite?.theme, to.kite?.theme) !== null,
    assets: {
      added: Object.keys(assetsAfter).filter((id) => !Object.hasOwn(assetsBefore, id)),
      removed: Object.keys(assetsBefore).filter((id) => !Object.hasOwn(assetsAfter, id)),
    },
  };
}

function fieldsOf(node: CanvasNode): CanvasNodeFields {
  const { id: _id, kite, ...rest } = node as CanvasNode & Record<string, unknown>;
  const { createdAt: _c, updatedAt: _u, ...k } = kite ?? {};
  return { ...(rest as CanvasNodeFields), ...(Object.keys(k).length > 0 ? { kite: k as CanvasNodeKite } : {}) };
}

/** The kite patch that turns one node's kite into another's: style as a key patch, icon replaced. */
function nodeKitePatch(before: CanvasNodeKite | undefined, after: CanvasNodeKite | undefined): CanvasNodeKitePatch | null {
  const b = before ?? {};
  const a = after ?? {};
  const patch: CanvasNodeKitePatch = {};
  if (a.kind !== b.kind && a.kind !== undefined) patch.kind = a.kind;
  if (a.ref !== b.ref && a.ref !== undefined) patch.ref = a.ref;
  if (a.view !== b.view && a.view !== undefined) patch.view = a.view;
  const style = stylePatch(b.style, a.style);
  if (style) patch.style = a.style === undefined ? null : (style as CanvasStylePatch<CanvasNodeStyle>);
  if (JSON.stringify(a.icon ?? null) !== JSON.stringify(b.icon ?? null)) patch.icon = a.icon ?? null;
  return Object.keys(patch).length === 0 ? null : patch;
}

const NODE_CONTENT_KEYS = ['text', 'url', 'label', 'color'] as const;

/**
 * Operations that turn `from` into `to`. Undo sends canvasDiffOps(after, before)
 * for one action; it only names what that action touched, so anything an agent
 * changed meanwhile stays as it is.
 */
export function canvasDiffOps(from: CanvasDocument, to: CanvasDocument): CanvasOp[] {
  const changes = canvasChanges(from, to);
  const ops: CanvasOp[] = [];
  const target = new Map(to.nodes.map((n) => [n.id, n]));
  // Icons first, so the nodes below can show them; removed ones last, once nothing shows them.
  for (const id of changes.assets.added) {
    const asset = to.kite!.assets![id]!;
    ops.push({ op: 'addAsset', id, svg: asset.svg, ...(asset.name === undefined ? {} : { name: asset.name }) });
  }
  const theme = themePatch(from.kite?.theme, to.kite?.theme);
  if (theme) ops.push({ op: 'theme', set: to.kite?.theme === undefined ? null : (theme as CanvasThemePatch) });
  const changedEnds = new Set<string>();
  for (const c of changes.edges) {
    if (c.kind === 'changed' && (c.before!.fromNode !== c.after!.fromNode || c.before!.toNode !== c.after!.toNode)) {
      changedEnds.add(c.id);
    }
  }
  for (const c of changes.edges) {
    if (c.kind === 'removed' || changedEnds.has(c.id)) ops.push({ op: 'disconnect', id: c.id });
  }
  for (const c of changes.nodes) if (c.kind === 'removed') ops.push({ op: 'delete', id: c.id });
  // Outer groups first, so a group carrying its members never undoes a later, exact move.
  const moves = changes.nodes
    .filter((c) => c.kind === 'changed' && c.moved)
    .sort((a, b) => {
      const ga = a.after!.type === 'group' ? a.after!.width * a.after!.height : -1;
      const gb = b.after!.type === 'group' ? b.after!.width * b.after!.height : -1;
      return gb - ga;
    });
  for (const c of moves) ops.push({ op: 'move', id: c.id, x: c.after!.x, y: c.after!.y });
  for (const c of changes.nodes) {
    if (c.kind === 'changed' && c.resized) ops.push({ op: 'resize', id: c.id, width: c.after!.width, height: c.after!.height });
  }
  for (const c of changes.nodes) {
    if (c.kind !== 'changed' || !(c.edited || c.restyled)) continue;
    const set: CanvasNodeFields = {};
    const unset: Array<'color' | 'label'> = [];
    const a = c.after as unknown as Record<string, unknown>;
    const b = c.before as unknown as Record<string, unknown>;
    for (const key of NODE_CONTENT_KEYS) {
      if (a[key] === b[key]) continue;
      if (a[key] === undefined) {
        if (key === 'color' || key === 'label') unset.push(key);
      } else (set as Record<string, unknown>)[key] = a[key];
    }
    const kite = nodeKitePatch(c.before!.kite, c.after!.kite);
    if (kite) set.kite = kite;
    ops.push({ op: 'update', id: c.id, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) });
  }
  // Adds keep their place in the order, which is the stacking order.
  for (const c of changes.nodes) if (c.kind === 'added') ops.push({ op: 'add', id: c.id, node: fieldsOf(c.after!) });
  for (const c of changes.edges) {
    if (c.kind === 'added' || changedEnds.has(c.id)) {
      const e = c.after!;
      ops.push({
        op: 'connect',
        id: e.id,
        from: e.fromNode,
        to: e.toNode,
        ...(e.label === undefined ? {} : { label: e.label }),
        ...(e.fromSide === undefined ? {} : { fromSide: e.fromSide }),
        ...(e.toSide === undefined ? {} : { toSide: e.toSide }),
        ...(e.fromEnd === undefined ? {} : { fromEnd: e.fromEnd }),
        ...(e.toEnd === undefined ? {} : { toEnd: e.toEnd }),
        ...(e.color === undefined ? {} : { color: e.color }),
        ...(e.kite?.style ? { kite: { style: e.kite.style } } : {}),
      });
    } else if (c.kind === 'changed') {
      const set: Record<string, unknown> = {};
      const unset: string[] = [];
      for (const key of EDGE_FIELDS) {
        if (c.after![key] === c.before![key]) continue;
        if (c.after![key] === undefined) unset.push(key);
        else set[key] = c.after![key];
      }
      const style = stylePatch(c.before!.kite?.style, c.after!.kite?.style);
      if (style) set.kite = { style: c.after!.kite?.style === undefined ? null : style };
      ops.push({ op: 'update', id: c.id, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) } as CanvasOp);
    }
  }
  for (const id of changes.assets.removed) ops.push({ op: 'deleteAsset', id });
  if (ops.length === 0) return ops;
  // A group move carries whatever sat inside it, including nodes that should
  // stay put. Replay and pin anything that ended up off target.
  try {
    let n = 0;
    const ctx = { now: '1970-01-01T00:00:00.000Z', newId: (p: 'n' | 'e' | 'a') => `${p}_diff${n++}` };
    for (let pass = 0; pass < 4; pass++) {
      const replay = applyCanvasOps(from, ops, ctx).doc;
      const off = replay.nodes.filter((node) => {
        const want = target.get(node.id);
        return want && (want.x !== node.x || want.y !== node.y);
      });
      if (off.length === 0) break;
      // Groups first: pinning a group carries its members, which are pinned after.
      off.sort((a, b) => Number(b.type === 'group') - Number(a.type === 'group'));
      for (const node of off) {
        const want = target.get(node.id)!;
        ops.push({ op: 'move', id: node.id, x: want.x, y: want.y });
      }
    }
  } catch {
    // The caller applies these against the live canvas and reports a failure there.
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Outline: a short map of a canvas for agents
// ---------------------------------------------------------------------------

export interface CanvasOutlineNode {
  id: string;
  type: CanvasNodeType;
  /** First line of text, the url, the group label, or the kite ref. */
  summary: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kite?: { kind: string; ref?: string; view?: string };
  /** The node's icon, "lucide:<name>" or "asset:<id>". */
  icon?: string;
  /** Only on groups: what sits directly inside (not inside a nested group). */
  children?: CanvasOutlineNode[];
}

export interface CanvasOutline {
  counts: { nodes: number; edges: number; groups: number };
  bounds: Box | null;
  /** Top-level things, with groups nested as a tree. */
  tree: CanvasOutlineNode[];
  /** A spot clear of everything, to the right of the content, for a new 260×140 node. */
  freeSlot: { x: number; y: number };
}

/** One line saying what a node is: its text, address, label or the document it shows. */
export function canvasNodeSummary(node: CanvasNode, max = 80): string {
  return summaryOf(node, max);
}

function summaryOf(node: CanvasNode, max = 80): string {
  let text: string;
  if (node.kite?.kind === 'kite' && node.kite.ref) text = `kite ${node.kite.ref}`;
  else text = nodeText(node).trim().split('\n')[0] ?? '';
  text = text.replace(/^#+\s*/, '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Bounds of a set of nodes, or null when there are none. */
export function canvasBounds(nodes: readonly Box[]): Box | null {
  if (nodes.length === 0) return null;
  const x = Math.min(...nodes.map((n) => n.x));
  const y = Math.min(...nodes.map((n) => n.y));
  const right = Math.max(...nodes.map((n) => n.x + n.width));
  const bottom = Math.max(...nodes.map((n) => n.y + n.height));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * The canvas as a tree of groups, each node one summary line. `frame` limits it
 * to one group's subtree; `depth` stops nesting after that many levels
 * (children past it are counted, not listed).
 */
export function canvasOutline(doc: CanvasDocument, options: { frame?: string; depth?: number } = {}): CanvasOutline {
  const parent = new Map<string, string | null>();
  for (const n of doc.nodes) parent.set(n.id, parentGroupOf(doc, n)?.id ?? null);
  const kids = new Map<string | null, CanvasNode[]>();
  for (const n of doc.nodes) {
    const p = parent.get(n.id) ?? null;
    kids.set(p, [...(kids.get(p) ?? []), n]);
  }
  const maxDepth = options.depth ?? Infinity;
  const build = (n: CanvasNode, level: number): CanvasOutlineNode => {
    const item: CanvasOutlineNode = {
      id: n.id,
      type: n.type,
      summary: summaryOf(n),
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
      ...(n.kite?.kind ? { kite: { kind: n.kite.kind, ...(n.kite.ref ? { ref: n.kite.ref } : {}), ...(n.kite.view ? { view: n.kite.view } : {}) } } : {}),
      ...(n.kite?.icon ? { icon: n.kite.icon.name } : {}),
    };
    if (n.type === 'group') {
      const inside = kids.get(n.id) ?? [];
      item.children = level >= maxDepth ? [] : inside.map((c) => build(c, level + 1));
      if (level >= maxDepth && inside.length > 0) item.summary += ` (${inside.length} inside)`;
    }
    return item;
  };
  let roots: CanvasNode[];
  if (options.frame !== undefined) {
    const frame = doc.nodes.find((n) => n.id === options.frame);
    if (!frame || frame.type !== 'group') throw new CanvasError(`There is no group "${options.frame}".`);
    roots = [frame];
  } else roots = kids.get(null) ?? [];
  const bounds = canvasBounds(doc.nodes);
  return {
    counts: { nodes: doc.nodes.length, edges: doc.edges.length, groups: doc.nodes.filter((n) => n.type === 'group').length },
    bounds,
    tree: roots.map((r) => build(r, 1)),
    freeSlot: bounds ? findFreeSlot(doc, { x: bounds.x + bounds.width + GAP, y: bounds.y }, DEFAULT_SIZE.text) : { x: 0, y: 0 },
  };
}
