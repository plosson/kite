/**
 * How a canvas node or edge looks, worked out from what the document says.
 *
 * Four layers, each over the one before: Kite's own look, the canvas theme's
 * defaults, the JSON Canvas `color` a node or edge may carry (any JSON Canvas
 * app understands that one), and finally the node's or edge's own style. The
 * result is plain CSS and React Flow props, so the components only draw it.
 *
 * Pure, and kept apart from React Flow's components, so it is tested directly.
 */

import type { CSSProperties } from 'react';
import type {
  CanvasEdge,
  CanvasEdgeTheme,
  CanvasFont,
  CanvasLineStyle,
  CanvasNode,
  CanvasNodeStyle,
  CanvasPaint,
  CanvasShadow,
  CanvasTheme,
} from '@open-artifact/shared';

/** JSON Canvas's six preset colours, as Obsidian draws them. */
export const PRESET_COLOURS: Record<string, string> = {
  '1': '#e5484d',
  '2': '#f76b15',
  '3': '#ffc53d',
  '4': '#30a46c',
  '5': '#0090ff',
  '6': '#8e4ec6',
};

/** A paint as CSS: a preset number becomes its colour, anything else is CSS already. */
export function paint(value: CanvasPaint): string {
  return PRESET_COLOURS[value] ?? value;
}

/** Every font a canvas may name, as a CSS stack. The faces are bundled with the app (see fonts.ts). */
export const FONT_STACKS: Record<CanvasFont, string> = {
  sans: 'var(--font-sans)',
  inter: "'Inter Variable', var(--font-sans)",
  grotesk: "'Space Grotesk Variable', var(--font-sans)",
  serif: "'Source Serif 4 Variable', Georgia, serif",
  mono: "'JetBrains Mono Variable', var(--font-mono)",
  hand: "'Caveat Variable', cursive",
};

const SHADOWS: Record<CanvasShadow, string> = {
  none: 'none',
  sm: '0 1px 2px rgb(0 0 0 / 0.08)',
  md: '0 4px 12px rgb(0 0 0 / 0.1), 0 1px 2px rgb(0 0 0 / 0.06)',
  lg: '0 14px 36px rgb(0 0 0 / 0.14), 0 2px 6px rgb(0 0 0 / 0.08)',
};

/** Kite's own look for a card and for a group, before any theme or style. */
const CARD_BASE: CanvasNodeStyle = {
  fill: 'var(--color-surface)',
  borderColor: 'var(--color-line)',
  borderWidth: 1,
  borderStyle: 'solid',
  radius: 6,
  textColor: 'var(--color-ink)',
  font: 'sans',
  fontSize: 14,
  fontWeight: 400,
  textAlign: 'left',
  verticalAlign: 'top',
  shadow: 'sm',
};

const GROUP_BASE: CanvasNodeStyle = {
  fill: 'transparent',
  borderColor: 'var(--color-line)',
  borderWidth: 2,
  borderStyle: 'dashed',
  radius: 8,
  textColor: 'var(--color-ink)',
  font: 'sans',
  fontSize: 14,
  fontWeight: 400,
  textAlign: 'left',
  verticalAlign: 'top',
  shadow: 'none',
  labelColor: 'var(--color-ink-2)',
  labelFont: 'sans',
  labelSize: 12,
  labelWeight: 600,
  labelBackground: 'transparent',
};

/** What the JSON Canvas `color` means: the border, and a wash of it behind. */
function fromSpecColour(color: string | undefined, isGroup: boolean): CanvasNodeStyle {
  if (!color) return {};
  const colour = paint(color);
  return {
    borderColor: color,
    fill: isGroup ? `color-mix(in srgb, ${colour} 6%, transparent)` : `color-mix(in srgb, ${colour} 8%, var(--color-surface))`,
  };
}

/** The style a node is drawn with: every key filled in. */
export function resolvedNodeStyle(node: CanvasNode, theme: CanvasTheme | undefined): Required<CanvasNodeStyle> {
  const isGroup = node.type === 'group';
  return {
    ...(isGroup ? GROUP_BASE : CARD_BASE),
    ...(isGroup ? theme?.group : theme?.node),
    ...fromSpecColour(node.color, isGroup),
    ...node.kite?.style,
  } as Required<CanvasNodeStyle>;
}

const JUSTIFY = { top: 'flex-start', middle: 'center', bottom: 'flex-end' } as const;

export interface NodeLook {
  /** The node's box. */
  box: CSSProperties;
  /** Its text: colour, type, alignment. */
  text: CSSProperties;
  /** A group's name. */
  label: CSSProperties;
  /** Where the content sits vertically. */
  justify: CSSProperties['justifyContent'];
  /** What an icon is painted in when it names no colour of its own. */
  ink: string;
}

export function nodeLook(node: CanvasNode, theme: CanvasTheme | undefined): NodeLook {
  const s = resolvedNodeStyle(node, theme);
  return {
    box: {
      background: paint(s.fill),
      borderColor: paint(s.borderColor),
      borderWidth: s.borderWidth,
      borderStyle: s.borderWidth === 0 ? 'none' : s.borderStyle,
      borderRadius: s.radius,
      boxShadow: SHADOWS[s.shadow],
    },
    text: {
      color: paint(s.textColor),
      fontFamily: FONT_STACKS[s.font],
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      textAlign: s.textAlign,
      lineHeight: 1.4,
    },
    label: {
      color: paint(s.labelColor),
      fontFamily: FONT_STACKS[s.labelFont],
      fontSize: s.labelSize,
      fontWeight: s.labelWeight,
      background: paint(s.labelBackground),
    },
    justify: JUSTIFY[s.verticalAlign],
    ink: paint(s.textColor),
  };
}

/** React Flow's names for the three curves. A step is right-angled, with softened corners. */
const CURVES = { bezier: 'default', straight: 'straight', step: 'smoothstep' } as const;

function dashes(line: CanvasLineStyle, width: number): string | undefined {
  if (line === 'dashed') return `${width * 4} ${width * 3}`;
  if (line === 'dotted') return `0 ${width * 2.5}`;
  return undefined;
}

export interface EdgeLook {
  type: (typeof CURVES)[keyof typeof CURVES];
  style: CSSProperties;
  /** The line's colour, or undefined for React Flow's own. */
  colour: string | undefined;
  width: number;
  /** Arrowhead size in pixels: it grows with the line, but slower. */
  arrow: number;
  start: boolean;
  end: boolean;
  labelStyle: CSSProperties;
  labelBgStyle: CSSProperties;
}

export function edgeLook(edge: CanvasEdge, theme: CanvasTheme | undefined): EdgeLook {
  const defaults: CanvasEdgeTheme = theme?.edge ?? {};
  const s = { width: 1, line: 'solid' as CanvasLineStyle, curve: 'bezier' as const, ...defaults, ...edge.kite?.style };
  const color = edge.color ?? defaults.color;
  const colour = color ? paint(color) : undefined;
  const dash = dashes(s.line, s.width);
  return {
    type: CURVES[s.curve],
    style: {
      ...(colour ? { stroke: colour } : {}),
      strokeWidth: s.width,
      ...(dash ? { strokeDasharray: dash } : {}),
      ...(s.line === 'dotted' ? { strokeLinecap: 'round' as const } : {}),
    },
    colour,
    width: s.width,
    arrow: 12 + s.width * 3,
    start: edge.fromEnd === 'arrow',
    end: edge.toEnd !== 'none',
    labelStyle: {
      fill: s.labelColor ? paint(s.labelColor) : 'var(--color-ink-2)',
      fontFamily: FONT_STACKS[s.labelFont ?? 'sans'],
      fontSize: s.labelSize ?? 12,
      fontWeight: s.labelWeight ?? 500,
    },
    labelBgStyle: { fill: s.labelBackground ? paint(s.labelBackground) : 'var(--color-surface)' },
  };
}

/** A node in the minimap: its fill, or a wash of its border when it has none (a group, usually). */
export function minimapLook(node: CanvasNode, theme: CanvasTheme | undefined): { fill: string; stroke: string } {
  const s = resolvedNodeStyle(node, theme);
  const stroke = paint(s.borderColor);
  const fill = s.fill === 'transparent' ? `color-mix(in srgb, ${stroke} 18%, transparent)` : paint(s.fill);
  return { fill, stroke };
}

/** The canvas behind the nodes. */
export interface BackdropLook {
  background: string | undefined;
  grid: NonNullable<CanvasTheme['grid']>;
  gridColor: string | undefined;
}

export function backdropLook(theme: CanvasTheme | undefined): BackdropLook {
  return {
    background: theme?.background ? paint(theme.background) : undefined,
    grid: theme?.grid ?? 'dots',
    gridColor: theme?.gridColor ? paint(theme.gridColor) : undefined,
  };
}
