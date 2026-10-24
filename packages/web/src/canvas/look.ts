/**
 * How a canvas node or edge looks, as CSS and React Flow props.
 *
 * Which style wins (Kite's own look, then the theme, then the JSON Canvas
 * colour, then the node's own style) is worked out in the shared package, so
 * the server's image export draws the same thing. This file only says it in
 * CSS: a token is a CSS variable, a wash is color-mix(), so the canvas follows
 * the app between light and dark.
 *
 * Pure, and kept apart from React Flow's components, so it is tested directly.
 */

import type { CSSProperties } from 'react';
import {
  arrowSize,
  lineDashes,
  presetColour,
  resolvedBackdrop,
  resolvedEdgeStyle,
  resolvedNodeStyle,
  SHADOW_LAYERS,
  type CanvasEdge,
  type CanvasFont,
  type CanvasNode,
  type CanvasPaint,
  type CanvasShadow,
  type CanvasTheme,
  type LookPaint,
} from '@open-artifact/shared';

export { PRESET_COLOURS, resolvedNodeStyle } from '@open-artifact/shared';

/** A paint as CSS: a preset number becomes its colour, anything else is CSS already. */
export function paint(value: CanvasPaint): string {
  return presetColour(value);
}

/** A resolved colour as CSS: tokens are the app's variables, so light and dark both work. */
export function cssPaint(value: LookPaint): string {
  if (typeof value === 'string') return paint(value);
  if ('token' in value) return `var(--color-${value.token})`;
  const over = value.over === 'transparent' ? 'transparent' : `var(--color-${value.over})`;
  return `color-mix(in srgb, ${paint(value.mix)} ${value.percent}%, ${over})`;
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

function boxShadow(shadow: CanvasShadow): string {
  const layers = SHADOW_LAYERS[shadow];
  if (layers.length === 0) return 'none';
  return layers.map((l) => `${l.x} ${l.y}px ${l.blur}px rgb(0 0 0 / ${l.opacity})`).join(', ');
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
      background: cssPaint(s.fill),
      borderColor: cssPaint(s.borderColor),
      borderWidth: s.borderWidth,
      borderStyle: s.borderWidth === 0 ? 'none' : s.borderStyle,
      borderRadius: s.radius,
      boxShadow: boxShadow(s.shadow),
    },
    text: {
      color: cssPaint(s.textColor),
      fontFamily: FONT_STACKS[s.font],
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      textAlign: s.textAlign,
      lineHeight: 1.4,
    },
    label: {
      color: cssPaint(s.labelColor),
      fontFamily: FONT_STACKS[s.labelFont],
      fontSize: s.labelSize,
      fontWeight: s.labelWeight,
      background: cssPaint(s.labelBackground),
    },
    justify: JUSTIFY[s.verticalAlign],
    ink: cssPaint(s.textColor),
  };
}

/** React Flow's names for the three curves. A step is right-angled, with softened corners. */
const CURVES = { bezier: 'default', straight: 'straight', step: 'smoothstep' } as const;

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
  const s = resolvedEdgeStyle(edge, theme);
  const colour = s.colour ? paint(s.colour) : undefined;
  const dash = lineDashes(s.line, s.width);
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
    arrow: arrowSize(s.width),
    start: s.start,
    end: s.end,
    labelStyle: {
      fill: cssPaint(s.labelColor),
      fontFamily: FONT_STACKS[s.labelFont],
      fontSize: s.labelSize,
      fontWeight: s.labelWeight,
    },
    labelBgStyle: { fill: cssPaint(s.labelBackground) },
  };
}

/** A node in the minimap: its fill, or a wash of its border when it has none (a group, usually). */
export function minimapLook(node: CanvasNode, theme: CanvasTheme | undefined): { fill: string; stroke: string } {
  const s = resolvedNodeStyle(node, theme);
  const stroke = cssPaint(s.borderColor);
  const fill = s.fill === 'transparent' ? `color-mix(in srgb, ${stroke} 18%, transparent)` : cssPaint(s.fill);
  return { fill, stroke };
}

/** The canvas behind the nodes. */
export interface BackdropLook {
  background: string | undefined;
  grid: NonNullable<CanvasTheme['grid']>;
  gridColor: string | undefined;
}

export function backdropLook(theme: CanvasTheme | undefined): BackdropLook {
  const b = resolvedBackdrop(theme);
  return {
    background: b.background ? paint(b.background) : undefined,
    grid: b.grid,
    gridColor: b.gridColor ? paint(b.gridColor) : undefined,
  };
}
