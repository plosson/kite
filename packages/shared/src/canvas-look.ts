/**
 * How a canvas node or edge looks, worked out from what the document says.
 *
 * Shared by the web app, which turns it into CSS, and by the server's image
 * export, which turns it into SVG, so a canvas looks the same in both.
 *
 * Four layers, each over the one before: Kite's own look, the canvas theme's
 * defaults, the JSON Canvas `color` a node or edge may carry (any JSON Canvas
 * app understands that one), and finally the node's or edge's own style.
 *
 * Kite's own look is written in the app's colour tokens (surface, line, ink…)
 * rather than in colours, because the app draws them in light or dark. A wash
 * of a JSON Canvas colour is a mix over a token for the same reason. Each side
 * says what a token and a mix are: CSS variables and color-mix() in the
 * browser, plain colours of the light theme in an exported image.
 */

import { parentGroupOf, type CanvasDocument, type CanvasEdge, type CanvasNode, type CanvasSide } from './canvas.js';
import type {
  CanvasCurve,
  CanvasEdgeTheme,
  CanvasFont,
  CanvasLineStyle,
  CanvasNodeStyle,
  CanvasPaint,
  CanvasShadow,
  CanvasTheme,
  CanvasWeight,
} from './canvas-style.js';

/** JSON Canvas's six preset colours, as Obsidian draws them. */
export const PRESET_COLOURS: Record<string, string> = {
  '1': '#e5484d',
  '2': '#f76b15',
  '3': '#ffc53d',
  '4': '#30a46c',
  '5': '#0090ff',
  '6': '#8e4ec6',
};

/** A paint as a colour: a preset number becomes its colour; a hex colour or `transparent` is one already. */
export function presetColour(value: CanvasPaint): string {
  return PRESET_COLOURS[value] ?? value;
}

/** The app's colour tokens a canvas's default look is drawn in. */
export type LookToken = 'canvas' | 'surface' | 'line' | 'ink' | 'ink-2' | 'ink-3' | 'accent';

/**
 * The light theme's tokens as plain colours, for drawing outside the app.
 * The app's own are oklch() values in styles.css; these are the same colours
 * in sRGB, and canvas-look.test.ts holds them to it.
 */
export const LIGHT_TOKENS: Record<LookToken, string> = {
  canvas: '#fbfaf9',
  surface: '#ffffff',
  line: '#e5e2e0',
  ink: '#211f1c',
  'ink-2': '#615d59',
  'ink-3': '#8f8b89',
  accent: '#5763b7',
};

/**
 * A colour in a resolved look: what the document says, one of the app's
 * tokens, or `percent` of a colour over a token or over nothing.
 */
export type LookPaint =
  | CanvasPaint
  | { token: LookToken }
  | { mix: CanvasPaint; percent: number; over: LookToken | 'transparent' };

/** A node style with every colour as a LookPaint, so the defaults can be tokens. */
export type ResolvedNodeStyle = Required<{
  [K in keyof CanvasNodeStyle]-?: K extends 'fill' | 'borderColor' | 'textColor' | 'labelColor' | 'labelBackground'
    ? LookPaint
    : NonNullable<CanvasNodeStyle[K]>;
}>;

/** Kite's own look for a card and for a group, before any theme or style. */
const CARD_BASE: ResolvedNodeStyle = {
  fill: { token: 'surface' },
  borderColor: { token: 'line' },
  borderWidth: 1,
  borderStyle: 'solid',
  radius: 6,
  textColor: { token: 'ink' },
  font: 'sans',
  fontSize: 14,
  fontWeight: 400,
  textAlign: 'left',
  verticalAlign: 'top',
  shadow: 'sm',
  labelColor: { token: 'ink-2' },
  labelFont: 'sans',
  labelSize: 12,
  labelWeight: 600,
  labelBackground: 'transparent',
};

const GROUP_BASE: ResolvedNodeStyle = {
  ...CARD_BASE,
  fill: 'transparent',
  borderWidth: 2,
  borderStyle: 'dashed',
  radius: 8,
  shadow: 'none',
};

/** What the JSON Canvas `color` means: the border, and a wash of it behind. */
function fromSpecColour(color: string | undefined, isGroup: boolean): Partial<ResolvedNodeStyle> {
  if (!color) return {};
  return {
    borderColor: color,
    fill: isGroup ? { mix: color, percent: 6, over: 'transparent' } : { mix: color, percent: 8, over: 'surface' },
  };
}

/** The style a node is drawn with: every key filled in. */
export function resolvedNodeStyle(node: CanvasNode, theme: CanvasTheme | undefined): ResolvedNodeStyle {
  const isGroup = node.type === 'group';
  return {
    ...(isGroup ? GROUP_BASE : CARD_BASE),
    ...(isGroup ? theme?.group : theme?.node),
    ...fromSpecColour(node.color, isGroup),
    ...node.kite?.style,
  } as ResolvedNodeStyle;
}

/** One layer of a shadow, as CSS box-shadow means it: offset, blur radius, black at this opacity. */
export interface ShadowLayer {
  x: number;
  y: number;
  blur: number;
  opacity: number;
}

export const SHADOW_LAYERS: Record<CanvasShadow, readonly ShadowLayer[]> = {
  none: [],
  sm: [{ x: 0, y: 1, blur: 2, opacity: 0.08 }],
  md: [
    { x: 0, y: 4, blur: 12, opacity: 0.1 },
    { x: 0, y: 1, blur: 2, opacity: 0.06 },
  ],
  lg: [
    { x: 0, y: 14, blur: 36, opacity: 0.14 },
    { x: 0, y: 2, blur: 6, opacity: 0.08 },
  ],
};

/** An edge's style with every key filled in, and its colour when it has one. */
export interface ResolvedEdgeStyle {
  width: number;
  line: CanvasLineStyle;
  curve: CanvasCurve;
  /** Undefined when neither the edge nor the theme names one: the line's default grey. */
  colour: CanvasPaint | undefined;
  labelColor: LookPaint;
  labelFont: CanvasFont;
  labelSize: number;
  labelWeight: CanvasWeight;
  labelBackground: LookPaint;
  start: boolean;
  end: boolean;
}

export function resolvedEdgeStyle(edge: CanvasEdge, theme: CanvasTheme | undefined): ResolvedEdgeStyle {
  const defaults: CanvasEdgeTheme = theme?.edge ?? {};
  const s = { width: 1, line: 'solid' as CanvasLineStyle, curve: 'bezier' as CanvasCurve, ...defaults, ...edge.kite?.style };
  return {
    width: s.width,
    line: s.line,
    curve: s.curve,
    colour: edge.color ?? defaults.color,
    labelColor: s.labelColor ?? { token: 'ink-2' },
    labelFont: s.labelFont ?? 'sans',
    labelSize: s.labelSize ?? 12,
    labelWeight: s.labelWeight ?? 500,
    labelBackground: s.labelBackground ?? { token: 'surface' },
    start: edge.fromEnd === 'arrow',
    end: edge.toEnd !== 'none',
  };
}

/** The grey a line is drawn in when nothing names a colour (React Flow's own). */
export const DEFAULT_EDGE_COLOUR = '#b1b1b7';

/** The dash pattern of a line, or undefined for a solid one. */
export function lineDashes(line: CanvasLineStyle, width: number): string | undefined {
  if (line === 'dashed') return `${width * 4} ${width * 3}`;
  if (line === 'dotted') return `0 ${width * 2.5}`;
  return undefined;
}

/** Arrowhead size in pixels: it grows with the line, but slower. */
export function arrowSize(width: number): number {
  return 12 + width * 3;
}

/** The canvas behind the nodes. */
export interface ResolvedBackdrop {
  /** Undefined means the page's own colour shows through. */
  background: CanvasPaint | undefined;
  grid: NonNullable<CanvasTheme['grid']>;
  gridColor: CanvasPaint | undefined;
}

export function resolvedBackdrop(theme: CanvasTheme | undefined): ResolvedBackdrop {
  return {
    background: theme?.background,
    grid: theme?.grid ?? 'dots',
    gridColor: theme?.gridColor,
  };
}

/** The grid's spacing, and its default colour per kind (React Flow's own). */
export const GRID = {
  gap: 20,
  crossSize: 6,
  colours: { dots: '#91919a', lines: '#eeeeee', cross: '#e2e2e2' },
} as const;

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

/**
 * The measurements of a node's insides, in pixels, as the web app lays them
 * out with its stylesheet. The export lays a node out with the same numbers.
 */
export const NODE_LAYOUT = {
  /** Between a card's border and its content. */
  padding: 8,
  /** Text line height, as a multiple of the font size. */
  lineHeight: 1.4,
  /** Between an icon on the left and the text. */
  iconGapLeft: 8,
  /** Between an icon on top and the text. */
  iconGapTop: 6,
  /** The default icon size beside text, and above it. */
  iconSize: { left: 20, top: 32 },
  /** A link card's "Link" caption. */
  linkCaption: { size: 11, letterSpacing: 0.025, gap: 4 },
  /** A group's name: inset from the border, the pill's padding and corners, and its line height. */
  groupLabel: { insetX: 8, insetY: 6, padX: 4, padY: 2, radius: 4, gap: 6, lineHeight: 1.5 },
  /** An edge label's pill: padding and corners. */
  edgeLabel: { padX: 6, padY: 3, radius: 4 },
  /** A connection point sits on the border, this far out from its centre. */
  handleRadius: 5,
} as const;

/**
 * Each node's group and how deep it is nested: a node's group is the smallest
 * group it sits entirely inside. The app draws a deeper node over a shallower
 * one, and an edge at the depth of the deeper of its two ends that is inside a
 * group; the export stacks them the same way.
 */
export function nodeNesting(doc: Pick<CanvasDocument, 'nodes'>): Map<string, { parent: CanvasNode | null; depth: number }> {
  const groups = doc.nodes.filter((n) => n.type === 'group');
  const parentOf = new Map<string, CanvasNode | null>();
  for (const n of doc.nodes) parentOf.set(n.id, groups.length ? parentGroupOf({ nodes: groups }, n) : null);
  const result = new Map<string, { parent: CanvasNode | null; depth: number }>();
  for (const n of doc.nodes) {
    let depth = 0;
    let p = parentOf.get(n.id);
    const seen = new Set<string>();
    while (p && !seen.has(p.id)) {
      seen.add(p.id);
      depth++;
      p = parentOf.get(p.id) ?? null;
    }
    result.set(n.id, { parent: parentOf.get(n.id) ?? null, depth });
  }
  return result;
}
