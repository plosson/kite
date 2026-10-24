/**
 * A canvas drawn as SVG, the way the web app draws it.
 *
 * Every look comes from the shared look rules (canvas-look in the shared
 * package), and every measurement from the same stylesheet numbers, so this is
 * a second renderer of the same canvas rather than an approximation of it:
 *
 * - nodes: fill, border, radius, shadow, the card's padding, text set in the
 *   bundled fonts and wrapped as CSS wraps it, aligned and centred the same,
 *   clipped to the card; icons from the same Lucide set, custom SVGs as they are;
 * - groups: their dashed box and their name in its pill;
 * - links and Kite cards: as their cards read, with the referenced document's
 *   title when the reader may open it;
 * - edges: React Flow's own path functions, its arrowhead, connection points
 *   and label pill;
 * - the grid and background, stacked in React Flow's order.
 *
 * For a PNG (`target: 'png'`) text is drawn as glyph outlines and shadows from
 * shared pieces (see shadows.ts); for an SVG, text is SVG text with the fonts
 * embedded and shadows are blur filters, so the file stays editable.
 */

import {
  arrowSize,
  DEFAULT_EDGE_COLOUR,
  edgeSides,
  GRID,
  lineDashes,
  lucideName,
  assetId,
  NODE_LAYOUT,
  nodeNesting,
  resolvedBackdrop,
  resolvedEdgeStyle,
  resolvedNodeStyle,
  SHADOW_LAYERS,
  type CanvasDocument,
  type CanvasIcon,
  type CanvasNode,
  type CanvasSide,
  type CanvasTheme,
  type LookPaint,
  type ResolvedNodeStyle,
} from '@open-artifact/shared';
import { getBezierPath, getSmoothStepPath, getStraightPath, Position } from '@xyflow/system';
import { lucideShapes } from '../icons.js';
import { FontUse, num, svgFamily, TYPEFACE_OF, type FontEngine, type Typeface } from './fonts.js';
import { isOpaque, paintAttrs, svgPaint } from './paint.js';
import { ShadowPainter } from './shadows.js';
import { layoutText, type TextBlock, type TextStyle, type WrapMode } from './text.js';

/** Bumped whenever a drawing would change, so a cached image is not reused. */
export const RENDERER_VERSION = 1;

export interface KiteRef {
  title: string;
  type: string;
}

export interface RenderOptions {
  /** What the SVG is for: rasterising to a PNG, or as it is. */
  target: 'png' | 'svg';
  /** Only this node, and what is inside it when it is a group. */
  nodeId?: string;
  /** Around the drawing, in canvas pixels. */
  padding: number;
  /** The SVG's width and height are the drawing's times this. */
  scale: number;
  background: 'theme' | 'transparent';
  grid: boolean;
  /** The documents Kite cards point at, for the reader; a card whose id is missing is one they cannot open. */
  refs: Map<string, KiteRef>;
}

export interface RenderedCanvas {
  svg: string;
  /** The part of the canvas drawn, in canvas pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export class CanvasImageError extends Error {}

/** The stylesheet's body letter-spacing, -0.006em of 13px, which every canvas text inherits. */
const BODY_LETTER_SPACING = -0.078;
/** Skia's synthetic italic, for text set italic in a face that has none. */
const SYNTHETIC_ITALIC = 0.25;
const JUSTIFY_FACTOR = { top: 0, middle: 0.5, bottom: 1 } as const;
const ALIGN_FACTOR = { left: 0, center: 0.5, right: 1 } as const;

/** A number for a transform's scale, where two decimals are not enough. */
function num4(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A rectangle, as `x y width height`, for SVG attributes. */
function rectAttrs(x: number, y: number, w: number, h: number): string {
  return `x="${num(x)}" y="${num(y)}" width="${num(Math.max(0, w))}" height="${num(Math.max(0, h))}"`;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Something stacked in a column: how tall it is, and how to draw it at a place. */
interface Piece {
  height: number;
  marginBottom?: number;
  draw: (x: number, y: number, width: number) => string;
}

class Drawing {
  private readonly defs = new Map<string, string>();
  private nextId = 0;
  /** Set once the drawing's area is known, before any node is drawn. */
  shadows: ShadowPainter | null = null;
  private readonly glyphs = new Map<string, string | null>();
  /** What an SVG sets as text, for its embedded fonts. */
  readonly fontUse: FontUse | null;

  constructor(
    readonly engine: FontEngine,
    readonly doc: CanvasDocument,
    readonly options: RenderOptions,
  ) {
    this.fontUse = options.target === 'svg' ? new FontUse() : null;
  }

  get theme(): CanvasTheme | undefined {
    return this.doc.kite?.theme;
  }

  def(key: string, make: (id: string) => string): string {
    const existing = this.defs.get(key);
    if (existing !== undefined) return existing.slice(0, existing.indexOf('\u0000'));
    const id = `k${(this.nextId++).toString(36)}`;
    this.defs.set(key, `${id}\u0000${make(id)}`);
    return id;
  }

  defsMarkup(): string {
    return [...this.defs.values()].map((v) => v.slice(v.indexOf('\u0000') + 1)).join('');
  }

  // ---- text -------------------------------------------------------------

  textStyle(font: ResolvedNodeStyle['font'], weight: number, size: number, lineHeight: number, colour: LookPaint, extra: Partial<TextStyle> = {}): TextStyle {
    const paint = svgPaint(colour);
    return {
      typeface: TYPEFACE_OF[font],
      weight,
      size,
      lineHeight,
      letterSpacing: BODY_LETTER_SPACING,
      fill: paint.colour,
      fillOpacity: paint.opacity,
      ...extra,
    };
  }

  layout(text: string, style: TextStyle, width: number, mode: WrapMode): TextBlock {
    return layoutText(this.engine, text, style, width, mode, this.fontUse ?? undefined);
  }

  /** A block's lines, aligned in `width` from `x`, the first line's top at `top`. */
  drawText(block: TextBlock, x: number, top: number, width: number, align: keyof typeof ALIGN_FACTOR): string {
    const { style } = block;
    if (style.fill === 'none') return '';
    const fill = paintAttrs('fill', { colour: style.fill, opacity: style.fillOpacity ?? 1 });
    let out = '';
    block.lines.forEach((line, i) => {
      if (line.text === '') return;
      const lineX = x + (width - line.width) * ALIGN_FACTOR[align];
      const baseline = top + i * style.lineHeight + block.baseline;
      if (this.options.target === 'png') {
        // Each glyph is defined once, in its font's units, and placed wherever it is used.
        const skew = style.italic ? SYNTHETIC_ITALIC : 0;
        let uses = '';
        for (const glyph of line.glyphs) {
          const id = this.glyph(glyph, skew);
          if (!id) continue;
          const k = glyph.size / this.engine.unitsPerEm(glyph.part);
          uses += `<use href="#${id}" transform="matrix(${num4(k)} 0 0 ${num4(-k)} ${num(lineX + glyph.x)} ${num(baseline + glyph.y)})"/>`;
        }
        if (uses) out += `<g ${fill}>${uses}</g>`;
      } else {
        out +=
          `<text x="${num(lineX)}" y="${num(baseline)}" font-family="${escapeXml(svgFamily(style.typeface))}" ` +
          `font-size="${num(style.size)}" font-weight="${style.weight}"${style.italic ? ' font-style="italic"' : ''} ` +
          `letter-spacing="${num(style.letterSpacing)}" xml:space="preserve" style="white-space:pre" ${fill}>${escapeXml(line.text)}</text>`;
      }
      if (style.underline) {
        const y = baseline + block.metrics.underlineOffset;
        out += `<rect ${rectAttrs(lineX, y, line.width, block.metrics.underlineThickness)} ${fill}/>`;
      }
    });
    return out;
  }

  /** A glyph's definition, made the first time it is drawn; null for one with no outline, such as a space. */
  private glyph(glyph: TextBlock['lines'][number]['glyphs'][number], skew: number): string | null {
    const key = `glyph:${glyph.part}@${glyph.weight}#${glyph.id}/${skew}`;
    let id = this.glyphs.get(key);
    if (id === undefined) {
      const d = this.engine.glyphOutline(glyph, skew);
      id = d ? this.def(key, (gid) => `<path id="${gid}" d="${d}"/>`) : null;
      this.glyphs.set(key, id);
    }
    return id;
  }

  textPiece(block: TextBlock, align: keyof typeof ALIGN_FACTOR, marginBottom = 0): Piece {
    return {
      height: block.height,
      marginBottom,
      draw: (x, y, width) => this.drawText(block, x, y, width, align),
    };
  }

  // ---- icons ------------------------------------------------------------

  /** An icon's size, or null when nothing would be drawn or kept room for (an unknown custom SVG). */
  iconSize(icon: CanvasIcon): number | null {
    if (lucideName(icon) === null && !this.doc.kite?.assets?.[assetId(icon) ?? '']) return null;
    return icon.size ?? NODE_LAYOUT.iconSize[icon.position ?? 'left'];
  }

  drawIcon(icon: CanvasIcon, x: number, y: number, size: number, ink: LookPaint): string {
    const name = lucideName(icon);
    if (name !== null) {
      const shapes = lucideShapes(name);
      if (!shapes) return '';
      const colour = svgPaint(icon.color ?? ink);
      if (colour.colour === 'none') return '';
      // Lucide's own drawing, defined once, coloured where it is used.
      const id = this.def(`icon:${name}`, (sid) => {
        const inner = shapes
          .map(([tag, attrs]) => `<${tag}${Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`).join('')}/>`)
          .join('');
        return `<symbol id="${sid}" viewBox="0 0 24 24">${inner}</symbol>`;
      });
      return (
        `<use href="#${id}" ${rectAttrs(x, y, size, size)} fill="none" ${paintAttrs('stroke', colour)} ` +
        `stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    }
    const asset = this.doc.kite?.assets?.[assetId(icon) ?? ''];
    if (!asset) return '';
    // Already sanitised when it was saved; drawn as an image so it cannot reach the drawing around it.
    const href = `data:image/svg+xml;base64,${Buffer.from(asset.svg, 'utf8').toString('base64')}`;
    return `<image ${rectAttrs(x, y, size, size)} href="${href}" preserveAspectRatio="xMidYMid meet"/>`;
  }

  // ---- boxes ------------------------------------------------------------

  /** A node's box: shadow, fill and border, as `.kite-node` draws them. */
  drawBox(node: CanvasNode, s: ResolvedNodeStyle): string {
    const { x, y, width: w, height: h } = node;
    const r = Math.max(0, Math.min(s.radius, w / 2, h / 2));
    const bw = s.borderWidth;
    const fill = svgPaint(s.fill);
    let out = '';

    const layers = SHADOW_LAYERS[s.shadow];
    if (layers.length) {
      // box-shadow is drawn outside the box only: behind a see-through fill it is cut away.
      const clip = isOpaque(fill)
        ? ''
        : this.def(`outside:${w}x${h}r${r}`, (id) => {
            const m = 200;
            return (
              `<clipPath id="${id}"><path clip-rule="evenodd" d="M${-m} ${-m}H${w + m}V${h + m}H${-m}Z${roundedRectPath(0, 0, w, h, r)}"/></clipPath>`
            );
          });
      let shadows = '';
      // The first CSS layer is on top.
      for (const layer of [...layers].reverse()) {
        const sigma = layer.blur / 2;
        if (this.shadows) {
          shadows += this.shadows.draw({ x: x + layer.x, y: y + layer.y, width: w, height: h, radius: r, sigma, opacity: layer.opacity });
          continue;
        }
        // In the blurred rectangle's own units, so one filter serves every box of its size.
        const spread = Math.ceil(sigma * 3) + 2;
        const filter = this.def(`blur:${w}x${h}:${sigma}`, (id) => {
          const fx = -spread / w;
          const fy = -spread / h;
          return (
            `<filter id="${id}" x="${num(fx)}" y="${num(fy)}" width="${num(1 - 2 * fx)}" height="${num(1 - 2 * fy)}">` +
            `<feGaussianBlur stdDeviation="${num(sigma)}"/></filter>`
          );
        });
        shadows += `<rect ${rectAttrs(x + layer.x, y + layer.y, w, h)} rx="${num(r)}" fill="#000" fill-opacity="${layer.opacity}" filter="url(#${filter})"/>`;
      }
      // The cut-away is drawn at the box's corner, the shadows where they are.
      out += clip
        ? `<g transform="translate(${num(x)} ${num(y)})" clip-path="url(#${clip})"><g transform="translate(${num(-x)} ${num(-y)})">${shadows}</g></g>`
        : shadows;
    }

    if (fill.colour !== 'none') out += `<rect ${rectAttrs(x, y, w, h)} rx="${num(r)}" ${paintAttrs('fill', fill)}/>`;

    const border = svgPaint(s.borderColor);
    if (bw > 0 && border.colour !== 'none') {
      const dash = borderDashes(s.borderStyle, bw);
      out +=
        `<rect ${rectAttrs(x + bw / 2, y + bw / 2, w - bw, h - bw)} rx="${num(Math.max(0, r - bw / 2))}" fill="none" ` +
        `${paintAttrs('stroke', border)} stroke-width="${num(bw)}"${dash}/>`;
    }
    return out;
  }

  // ---- nodes ------------------------------------------------------------

  drawNode(node: CanvasNode): string {
    const s = resolvedNodeStyle(node, this.theme);
    return node.type === 'group' ? this.drawGroup(node, s) : this.drawCard(node, s);
  }

  private drawGroup(node: CanvasNode & { type: 'group' }, s: ResolvedNodeStyle): string {
    let out = this.drawBox(node, s);
    const icon = node.kite?.icon;
    const iconSize = icon ? this.iconSize(icon) : null;
    const label = (node.label ?? '').trim();
    if (!label && iconSize === null) return out;

    const L = NODE_LAYOUT.groupLabel;
    const bw = s.borderWidth;
    const available = node.width - bw * 2 - L.insetX * 2;
    const gap = iconSize !== null && label ? L.gap : 0;
    const style = this.textStyle(s.labelFont, s.labelWeight, s.labelSize, s.labelSize * L.lineHeight, s.labelColor);
    const block = label ? this.layout(label, style, available - L.padX * 2 - (iconSize ?? 0) - gap, 'normal') : null;
    const textW = block ? block.width : 0;
    const innerH = Math.max(iconSize ?? 0, block ? block.height : 0);
    const pillW = Math.min(available, L.padX * 2 + (iconSize ?? 0) + gap + textW);
    const pillH = innerH + L.padY * 2;
    const pillX = node.x + bw + L.insetX + (available - pillW) * ALIGN_FACTOR[s.textAlign];
    const pillY = node.y + bw + L.insetY;

    const background = svgPaint(s.labelBackground);
    if (background.colour !== 'none') out += `<rect ${rectAttrs(pillX, pillY, pillW, pillH)} rx="${L.radius}" ${paintAttrs('fill', background)}/>`;
    let cursor = pillX + L.padX;
    if (icon && iconSize !== null) {
      out += this.drawIcon(icon, cursor, pillY + L.padY + (innerH - iconSize) / 2, iconSize, s.labelColor);
      cursor += iconSize + gap;
    }
    if (block) out += this.drawText(block, cursor, pillY + L.padY + (innerH - block.height) / 2, textW, 'left');
    return out;
  }

  private drawCard(node: CanvasNode, s: ResolvedNodeStyle): string {
    const box = this.drawBox(node, s);
    const bw = s.borderWidth;
    const pad = NODE_LAYOUT.padding;
    const inner: Box = { x: node.x + bw, y: node.y + bw, width: node.width - bw * 2, height: node.height - bw * 2 };
    const cx = inner.x + pad;
    const cy = inner.y + pad;
    const cw = Math.max(0, inner.width - pad * 2);
    const ch = inner.height - pad * 2;
    const justify = JUSTIFY_FACTOR[s.verticalAlign];
    const icon = node.kite?.icon;
    const iconSize = icon ? this.iconSize(icon) : null;

    let content = '';
    let contentTop: number;
    let contentBottom: number;

    if (!icon || iconSize === null) {
      // The pieces are the column's own items: none shrinks, so tall text overflows the card.
      const pieces = this.cardPieces(node, s, cw);
      const total = stackHeight(pieces);
      contentTop = cy + (ch - total) * justify;
      content = drawStack(pieces, cx, contentTop, cw);
      contentBottom = contentTop + total;
    } else if (icon.position === 'top') {
      const pieces = this.cardPieces(node, s, cw);
      const textH = stackHeight(pieces);
      const natural = iconSize + NODE_LAYOUT.iconGapTop + textH;
      contentTop = cy + Math.max(0, ch - natural) * justify;
      const iconX = cx + (cw - iconSize) * ALIGN_FACTOR[s.textAlign];
      content = this.drawIcon(icon, iconX, contentTop, iconSize, s.textColor);
      content += drawStack(pieces, cx, contentTop + iconSize + NODE_LAYOUT.iconGapTop, cw);
      contentBottom = contentTop + natural;
    } else {
      const textW = Math.max(0, cw - iconSize - NODE_LAYOUT.iconGapLeft);
      const pieces = this.cardPieces(node, s, textW);
      const textH = stackHeight(pieces);
      // The row may shrink to the card (min-height: 0); its items stay centred in it.
      const rowH = Math.min(Math.max(iconSize, textH), Math.max(0, ch));
      const rowTop = cy + (Math.max(0, ch) - rowH) * justify;
      content = this.drawIcon(icon, cx, rowTop + (rowH - iconSize) / 2, iconSize, s.textColor);
      const textTop = rowTop + (rowH - textH) / 2;
      content += drawStack(pieces, cx + iconSize + NODE_LAYOUT.iconGapLeft, textTop, textW);
      contentTop = Math.min(rowTop + (rowH - iconSize) / 2, textTop);
      contentBottom = Math.max(rowTop + (rowH + iconSize) / 2, textTop + textH);
    }

    if (!content) return box;
    // The card's content is clipped to the inside of its border, as overflow: hidden does.
    const overflows = contentTop < inner.y || contentBottom > inner.y + inner.height || cw === 0;
    if (!overflows) return box + content;
    const clip = this.def(`clip:${inner.x},${inner.y},${inner.width},${inner.height}`, (id) => `<clipPath id="${id}"><rect ${rectAttrs(inner.x, inner.y, inner.width, inner.height)}/></clipPath>`);
    return `${box}<g clip-path="url(#${clip})">${content}</g>`;
  }

  /** What a card shows, as column pieces `width` wide. */
  private cardPieces(node: CanvasNode, s: ResolvedNodeStyle, width: number): Piece[] {
    const lineHeight = s.fontSize * NODE_LAYOUT.lineHeight;
    const text = (extra: Partial<TextStyle> = {}, colour: LookPaint = s.textColor) =>
      this.textStyle(s.font, s.fontWeight, s.fontSize, lineHeight, colour, extra);

    if (node.kite?.kind === 'kite') {
      const ref = node.kite.ref ? this.options.refs.get(node.kite.ref) : undefined;
      if (!ref) {
        return [this.textPiece(this.layout('A document you can’t open', text({ italic: true }), width, 'normal'), s.textAlign)];
      }
      const title = this.layout(ref.title, text({ weight: 600, underline: true }), width, 'ellipsis');
      const caption = ref.type === 'canvas' ? 'Canvas' : ref.type === 'html' ? 'HTML page' : 'Document';
      const small = this.textStyle(s.font, s.fontWeight, 12, 16, { token: 'ink-3' });
      return [this.textPiece(title, s.textAlign, 4), this.textPiece(this.layout(caption, small, width, 'pre-wrap'), s.textAlign)];
    }

    if (node.type === 'link') {
      const C = NODE_LAYOUT.linkCaption;
      const caption = this.layout(
        'Link',
        this.textStyle(s.font, s.fontWeight, C.size, C.size * NODE_LAYOUT.lineHeight, { token: 'ink-3' }, { uppercase: true, letterSpacing: C.letterSpacing * C.size }),
        width,
        'pre-wrap',
      );
      const url = this.layout(node.url, text({ underline: true }, { token: 'accent' }), width, 'break-all');
      // One item: a column of the caption and the address, four pixels apart.
      return [
        {
          height: caption.height + C.gap + url.height,
          draw: (x, y, w) => this.drawText(caption, x, y, w, s.textAlign) + this.drawText(url, x, y + caption.height + C.gap, w, s.textAlign),
        },
      ];
    }

    if (node.type === 'text' && node.text) return [this.textPiece(this.layout(node.text, text(), width, 'pre-wrap'), s.textAlign)];
    return [];
  }

  // ---- edges ------------------------------------------------------------

  drawEdge(edge: CanvasDocument['edges'][number], byId: Map<string, CanvasNode>): { svg: string; bounds: Box[] } | null {
    const from = byId.get(edge.fromNode);
    const to = byId.get(edge.toNode);
    if (!from || !to) return null;
    const sides = edgeSides(edge, byId);
    const source = this.handlePoint(from, sides.fromSide);
    const target = this.handlePoint(to, sides.toSide);
    const s = resolvedEdgeStyle(edge, this.theme);
    const params = {
      sourceX: source.x,
      sourceY: source.y,
      sourcePosition: POSITIONS[sides.fromSide],
      targetX: target.x,
      targetY: target.y,
      targetPosition: POSITIONS[sides.toSide],
    };
    const [path, labelX, labelY] =
      s.curve === 'straight' ? getStraightPath(params) : s.curve === 'step' ? getSmoothStepPath(params) : getBezierPath(params);

    const colour = s.colour ? svgPaint(s.colour) : svgPaint(DEFAULT_EDGE_COLOUR);
    let marker = '';
    if ((s.start || s.end) && colour.colour !== 'none') {
      const size = arrowSize(s.width);
      // React Flow's ArrowClosed, set with orient="auto-start-reverse"; drawn here as two markers,
      // the start one turned round, since resvg does not know that value.
      const arrow = (end: 'start' | 'end') =>
        this.def(`arrow:${end}:${colour.colour}:${colour.opacity}:${size}`, (mid) =>
          `<marker id="${mid}" viewBox="-10 -10 20 20" refX="0" refY="0" markerWidth="${num(size)}" markerHeight="${num(size)}" ` +
          `markerUnits="userSpaceOnUse" orient="auto"><polyline points="${end === 'end' ? '-5,-4 0,0 -5,4 -5,-4' : '5,-4 0,0 5,4 5,-4'}" ` +
          `stroke-linecap="round" stroke-linejoin="round" ${paintAttrs('stroke', colour)} ${paintAttrs('fill', colour)} stroke-width="1"/></marker>`,
        );
      marker = `${s.start ? ` marker-start="url(#${arrow('start')})"` : ''}${s.end ? ` marker-end="url(#${arrow('end')})"` : ''}`;
    }
    const dash = lineDashes(s.line, s.width);
    let svg =
      `<path d="${path}" fill="none" ${paintAttrs('stroke', colour)} stroke-width="${num(s.width)}"` +
      `${dash ? ` stroke-dasharray="${dash}"` : ''}${s.line === 'dotted' ? ' stroke-linecap="round"' : ''}${marker}/>`;
    const bounds: Box[] = [pathBounds(path)];

    const label = edge.label?.replace(/\s+/g, ' ').trim();
    if (label) {
      // React Flow's EdgeText: one line, its box padded 6 by 3, its baseline 0.3em below the label point.
      const style = this.textStyle(s.labelFont, s.labelWeight, s.labelSize, s.labelSize, s.labelColor);
      const block = this.layout(label, style, Number.POSITIVE_INFINITY, 'ellipsis');
      const w = block.width;
      const h = block.metrics.ascent + block.metrics.descent;
      const P = NODE_LAYOUT.edgeLabel;
      const pill: Box = { x: labelX - w / 2 - P.padX, y: labelY - h / 2 - P.padY, width: w + P.padX * 2, height: h + P.padY * 2 };
      const background = svgPaint(s.labelBackground);
      if (background.colour !== 'none') svg += `<rect ${rectAttrs(pill.x, pill.y, pill.width, pill.height)} rx="${P.radius}" ${paintAttrs('fill', background)}/>`;
      // Placed by its baseline: drawText adds the block's baseline to the top it is given.
      svg += this.drawText(block, labelX - w / 2, labelY + 0.3 * s.labelSize - block.baseline, w, 'left');
      bounds.push(pill);
    }
    return { svg, bounds };
  }

  /** Where an edge meets a node: the outer edge of React Flow's 10px handle, centred on the inside of the border. */
  private handlePoint(node: CanvasNode, side: CanvasSide): { x: number; y: number } {
    const bw = resolvedNodeStyle(node, this.theme).borderWidth;
    const out = NODE_LAYOUT.handleRadius - bw;
    switch (side) {
      case 'top':
        return { x: node.x + node.width / 2, y: node.y - out };
      case 'bottom':
        return { x: node.x + node.width / 2, y: node.y + node.height + out };
      case 'left':
        return { x: node.x - out, y: node.y + node.height / 2 };
      case 'right':
        return { x: node.x + node.width + out, y: node.y + node.height / 2 };
    }
  }

  // ---- backdrop ---------------------------------------------------------

  drawBackdrop(area: Box): string {
    if (this.options.background === 'transparent') return '';
    const b = resolvedBackdrop(this.theme);
    const background = svgPaint(b.background ?? { token: 'canvas' });
    let out = background.colour === 'none' ? '' : `<rect ${rectAttrs(area.x, area.y, area.width, area.height)} ${paintAttrs('fill', background)}/>`;
    if (!this.options.grid || b.grid === 'none') return out;
    const colour = svgPaint(b.gridColor ?? GRID.colours[b.grid]);
    if (colour.colour === 'none') return out;
    const g = GRID.gap;
    const half = g / 2;
    const arm = GRID.crossSize / 2;
    const tile =
      b.grid === 'dots'
        ? `<circle cx="${half}" cy="${half}" r="0.5" ${paintAttrs('fill', colour)}/>`
        : b.grid === 'lines'
          ? `<path d="M${half} 0V${g}M0 ${half}H${g}" fill="none" ${paintAttrs('stroke', colour)} stroke-width="1"/>`
          : `<path d="M${half} ${half - arm}V${half + arm}M${half - arm} ${half}H${half + arm}" fill="none" ${paintAttrs('stroke', colour)} stroke-width="1"/>`;
    // Tiles start half a gap back, so the grid's points fall on multiples of the gap, as React Flow's do.
    const id = this.def('grid', (pid) => `<pattern id="${pid}" patternUnits="userSpaceOnUse" x="${-half}" y="${-half}" width="${g}" height="${g}">${tile}</pattern>`);
    out += `<rect ${rectAttrs(area.x, area.y, area.width, area.height)} fill="url(#${id})"/>`;
    return out;
  }
}

const POSITIONS: Record<CanvasSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

/** CSS's dashed and dotted borders as Chrome strokes them. */
function borderDashes(style: ResolvedNodeStyle['borderStyle'], width: number): string {
  if (style === 'dashed') return width >= 3 ? ` stroke-dasharray="${num(width * 2)} ${num(width)}"` : ` stroke-dasharray="${num(width * 3)} ${num(width * 2)}"`;
  if (style === 'dotted') return ` stroke-dasharray="0 ${num(width * 2)}" stroke-linecap="round"`;
  return '';
}

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  if (r <= 0) return `M${num(x)} ${num(y)}H${num(x + w)}V${num(y + h)}H${num(x)}Z`;
  return (
    `M${num(x + r)} ${num(y)}H${num(x + w - r)}A${num(r)} ${num(r)} 0 0 1 ${num(x + w)} ${num(y + r)}` +
    `V${num(y + h - r)}A${num(r)} ${num(r)} 0 0 1 ${num(x + w - r)} ${num(y + h)}` +
    `H${num(x + r)}A${num(r)} ${num(r)} 0 0 1 ${num(x)} ${num(y + h - r)}` +
    `V${num(y + r)}A${num(r)} ${num(r)} 0 0 1 ${num(x + r)} ${num(y)}Z`
  );
}

function stackHeight(pieces: Piece[]): number {
  return pieces.reduce((h, p) => h + p.height + (p.marginBottom ?? 0), 0);
}

function drawStack(pieces: Piece[], x: number, top: number, width: number): string {
  let y = top;
  let out = '';
  for (const piece of pieces) {
    out += piece.draw(x, y, width);
    y += piece.height + (piece.marginBottom ?? 0);
  }
  return out;
}

/**
 * The box around one of React Flow's edge paths (M, L, Q and C commands with
 * absolute coordinates), found by walking its curves.
 */
export function pathBounds(d: string): Box {
  const tokens = d.match(/[MLQC]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  let command = 'M';
  let cur = { x: 0, y: 0 };
  let i = 0;
  const take = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/^[MLQC]$/i.test(tokens[i]!)) command = tokens[i++]!.toUpperCase();
    if (command === 'M' || command === 'L') {
      cur = { x: take(), y: take() };
      add(cur.x, cur.y);
    } else if (command === 'Q') {
      const c = { x: take(), y: take() };
      const end = { x: take(), y: take() };
      for (let t = 0; t <= 1; t += 1 / 16) {
        const u = 1 - t;
        add(u * u * cur.x + 2 * u * t * c.x + t * t * end.x, u * u * cur.y + 2 * u * t * c.y + t * t * end.y);
      }
      cur = end;
    } else if (command === 'C') {
      const c1 = { x: take(), y: take() };
      const c2 = { x: take(), y: take() };
      const end = { x: take(), y: take() };
      for (let t = 0; t <= 1; t += 1 / 32) {
        const u = 1 - t;
        add(
          u * u * u * cur.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
          u * u * u * cur.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y,
        );
      }
      add(end.x, end.y);
      cur = end;
    } else break;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Every text a drawing will shape, so the fonts it needs are loaded first. */
function textsToShape(doc: CanvasDocument, nodes: CanvasNode[], edges: CanvasDocument['edges'], refs: Map<string, KiteRef>): Array<{ typeface: Typeface; text: string }> {
  const theme = doc.kite?.theme;
  const out: Array<{ typeface: Typeface; text: string }> = [];
  for (const node of nodes) {
    const s = resolvedNodeStyle(node, theme);
    const typeface = TYPEFACE_OF[s.font];
    if (node.type === 'group') out.push({ typeface: TYPEFACE_OF[s.labelFont], text: node.label ?? '' });
    else if (node.kite?.kind === 'kite') {
      const ref = node.kite.ref ? refs.get(node.kite.ref) : undefined;
      out.push({ typeface, text: ref ? `${ref.title}…CanvasHTML pageDocument` : 'A document you can’t open' });
    } else if (node.type === 'link') out.push({ typeface, text: `LINK ${node.url}` });
    else out.push({ typeface, text: node.text });
  }
  for (const edge of edges) {
    if (edge.label) out.push({ typeface: TYPEFACE_OF[resolvedEdgeStyle(edge, theme).labelFont], text: `${edge.label}…` });
  }
  return out;
}

export async function renderCanvas(engine: FontEngine, doc: CanvasDocument, options: RenderOptions): Promise<RenderedCanvas> {
  const nesting = nodeNesting(doc);
  let nodes = doc.nodes;
  if (options.nodeId !== undefined) {
    const root = doc.nodes.find((n) => n.id === options.nodeId);
    if (!root) throw new CanvasImageError(`This canvas has no node "${options.nodeId}".`);
    const inside = (n: CanvasNode): boolean => {
      for (let p: CanvasNode | null = n; p; p = nesting.get(p.id)?.parent ?? null) if (p.id === root.id) return true;
      return false;
    };
    nodes = doc.nodes.filter(inside);
  }
  const kept = new Set(nodes.map((n) => n.id));
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const edges = doc.edges.filter((e) => kept.has(e.fromNode) && kept.has(e.toNode));

  await engine.prepare(textsToShape(doc, nodes, edges, options.refs));
  const drawing = new Drawing(engine, doc, options);

  // React Flow's stacking: a node at its group depth, an edge at the depth of
  // its deeper end that is in a group; at one depth, edges under nodes.
  const items: Array<{ z: number; layer: 0 | 1; order: number; svg: string }> = [];
  const boxes: Box[] = [...nodes];
  const depthOf = (id: string) => {
    const n = nesting.get(id);
    return n && n.parent ? n.depth : 0;
  };
  edges.forEach((edge, order) => {
    const drawn = drawing.drawEdge(edge, byId);
    if (!drawn) return;
    items.push({ z: Math.max(depthOf(edge.fromNode), depthOf(edge.toNode)), layer: 0, order, svg: drawn.svg });
    boxes.push(...drawn.bounds);
  });

  const pad = options.padding;
  let area: Box;
  if (boxes.length === 0) area = { x: -pad, y: -pad, width: pad * 2, height: pad * 2 };
  else {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const b of boxes) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    }
    // Whole canvas pixels, so the drawing starts on a pixel of the PNG.
    const x = Math.floor(minX - pad);
    const y = Math.floor(minY - pad);
    area = { x, y, width: Math.ceil(maxX + pad) - x, height: Math.ceil(maxY + pad) - y };
  }
  // Whole PNG pixels too: the drawing is widened to the next one, so it is drawn at exactly
  // `scale` and not stretched to fit a size that was rounded.
  const s = options.scale;
  area.width = Math.ceil(area.width * s - 1e-6) / s;
  area.height = Math.ceil(area.height * s - 1e-6) / s;

  if (options.target === 'png') drawing.shadows = new ShadowPainter(options.scale, area, (key, make) => drawing.def(key, make));
  nodes.forEach((node, order) => {
    items.push({ z: nesting.get(node.id)!.depth, layer: 1, order, svg: drawing.drawNode(node) });
  });
  items.sort((a, b) => a.z - b.z || a.layer - b.layer || a.order - b.order);

  const backdrop = drawing.drawBackdrop(area);
  const body = items.map((i) => i.svg).join('');
  const style = drawing.fontUse ? await engine.fontFaces(drawing.fontUse) : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(area.x)} ${num(area.y)} ${num4(area.width)} ${num4(area.height)}" ` +
    `width="${Math.round(area.width * s)}" height="${Math.round(area.height * s)}">` +
    `<defs>${style ? `<style>${style}</style>` : ''}${drawing.defsMarkup()}</defs>${backdrop}${body}</svg>`;
  return { svg, ...area };
}
