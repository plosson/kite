/**
 * How a canvas looks: node, group and edge styles, icons, and canvas-wide
 * theme defaults. All of it lives under `kite` keys (kite.style, kite.icon on
 * a node, kite.style on an edge, kite.theme and kite.assets at the top level),
 * so a strict JSON Canvas export, which drops every `kite` key, stays a valid
 * JSON Canvas 1.0 file. The spec's own `color` (a preset "1"…"6" or a hex
 * colour) is kept and still drawn; a style only refines it.
 *
 * Styles are flat objects of optional keys, so an update can change one key
 * and leave the rest, and `null` removes a key.
 *
 * Precedence when drawing a node: Kite's look, then the theme's default for
 * that kind of node, then what the spec `color` implies, then the node's own
 * style.
 */

import { sanitizeSvg, SvgError } from './canvas-svg.js';

/** The curated fonts. The web app bundles them; nothing is fetched from elsewhere. */
export const CANVAS_FONTS = ['sans', 'inter', 'grotesk', 'serif', 'mono', 'hand'] as const;
export type CanvasFont = (typeof CANVAS_FONTS)[number];

export const CANVAS_FONT_LABELS: Record<CanvasFont, string> = {
  sans: 'Kite (system sans)',
  inter: 'Inter',
  grotesk: 'Space Grotesk',
  serif: 'Source Serif',
  mono: 'JetBrains Mono',
  hand: 'Caveat (handwritten)',
};

export const CANVAS_WEIGHTS = [300, 400, 500, 600, 700, 800] as const;
export type CanvasWeight = (typeof CANVAS_WEIGHTS)[number];
export type CanvasAlign = 'left' | 'center' | 'right';
export type CanvasVerticalAlign = 'top' | 'middle' | 'bottom';
export type CanvasLineStyle = 'solid' | 'dashed' | 'dotted';
export type CanvasShadow = 'none' | 'sm' | 'md' | 'lg';
export type CanvasCurve = 'bezier' | 'straight' | 'step';
export type CanvasGrid = 'dots' | 'lines' | 'cross' | 'none';
export type CanvasIconPosition = 'left' | 'top';

/**
 * A colour in a style: a spec preset "1"…"6", a hex colour (#rgb, #rrggbb or
 * #rrggbbaa for transparency), or "transparent".
 */
export type CanvasPaint = string;

export function isCanvasPaint(value: unknown): value is CanvasPaint {
  return (
    typeof value === 'string' &&
    (/^[1-6]$/.test(value) || /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) || value === 'transparent')
  );
}

export interface CanvasNodeStyle {
  fill?: CanvasPaint;
  borderColor?: CanvasPaint;
  /** Pixels, 0 to 16. 0 draws no border. */
  borderWidth?: number;
  borderStyle?: CanvasLineStyle;
  /** Corner radius in pixels, 0 to 96. */
  radius?: number;
  textColor?: CanvasPaint;
  font?: CanvasFont;
  /** Pixels, 8 to 96. */
  fontSize?: number;
  fontWeight?: CanvasWeight;
  textAlign?: CanvasAlign;
  verticalAlign?: CanvasVerticalAlign;
  shadow?: CanvasShadow;
  /** Groups only: the group's name. */
  labelColor?: CanvasPaint;
  labelFont?: CanvasFont;
  labelSize?: number;
  labelWeight?: CanvasWeight;
  labelBackground?: CanvasPaint;
}

export interface CanvasEdgeStyle {
  /** Pixels, 1 to 12. */
  width?: number;
  line?: CanvasLineStyle;
  curve?: CanvasCurve;
  labelColor?: CanvasPaint;
  labelFont?: CanvasFont;
  labelSize?: number;
  labelWeight?: CanvasWeight;
  labelBackground?: CanvasPaint;
}

/** An edge default in a theme may also give the colour edges get when they name none. */
export interface CanvasEdgeTheme extends CanvasEdgeStyle {
  color?: CanvasPaint;
}

export interface CanvasTheme {
  background?: CanvasPaint;
  grid?: CanvasGrid;
  gridColor?: CanvasPaint;
  /** Defaults for text, link and Kite nodes. */
  node?: CanvasNodeStyle;
  /** Defaults for groups. */
  group?: CanvasNodeStyle;
  edge?: CanvasEdgeTheme;
}

/**
 * An icon on a node. `name` is `lucide:<icon>` for one of the bundled Lucide
 * icons, or `asset:<id>` for a custom SVG kept in this canvas's kite.assets.
 */
export interface CanvasIcon {
  name: string;
  /** Left of the text (default), or large above it. */
  position?: CanvasIconPosition;
  /** Pixels, 12 to 160. Default 20 on the left, 32 on top. */
  size?: number;
  /** Lucide icons only; a custom SVG keeps its own colours. */
  color?: CanvasPaint;
}

/** A custom SVG, sanitised, kept once per canvas and used by any number of nodes. */
export interface CanvasAsset {
  type: 'svg';
  svg: string;
  /** What the owner called it, for the picker. */
  name?: string;
}

export const STYLE_LIMITS = {
  maxAssets: 100,
  maxAssetName: 80,
} as const;

/** A problem with a style, an icon or an asset. canvas.ts turns it into a CanvasError. */
export class CanvasStyleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanvasStyleError';
  }
}

type Rule = (value: unknown, where: string) => unknown;

const paint: Rule = (value, where) => {
  if (!isCanvasPaint(value)) {
    throw new CanvasStyleError(`${where} must be a preset "1" to "6", a hex colour like "#ff8800" (or "#ff880080"), or "transparent".`);
  }
  return value;
};
const integer = (min: number, max: number): Rule => (value, where) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new CanvasStyleError(`${where} must be a whole number from ${min} to ${max}.`);
  }
  return value;
};
const oneOf = (choices: readonly (string | number)[]): Rule => (value, where) => {
  if (!choices.includes(value as string | number)) {
    throw new CanvasStyleError(`${where} must be one of ${choices.map((c) => (typeof c === 'string' ? `"${c}"` : String(c))).join(', ')}.`);
  }
  return value;
};

const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;
const font = oneOf(CANVAS_FONTS);
const weight = oneOf(CANVAS_WEIGHTS);

const BOX_RULES: Record<string, Rule> = {
  fill: paint,
  borderColor: paint,
  borderWidth: integer(0, 16),
  borderStyle: oneOf(LINE_STYLES),
  radius: integer(0, 96),
  textColor: paint,
  font,
  fontSize: integer(8, 96),
  fontWeight: weight,
  textAlign: oneOf(['left', 'center', 'right']),
  verticalAlign: oneOf(['top', 'middle', 'bottom']),
  shadow: oneOf(['none', 'sm', 'md', 'lg']),
};

const LABEL_RULES: Record<string, Rule> = {
  labelColor: paint,
  labelFont: font,
  labelSize: integer(8, 96),
  labelWeight: weight,
  labelBackground: paint,
};

const EDGE_RULES: Record<string, Rule> = {
  width: integer(1, 12),
  line: oneOf(LINE_STYLES),
  curve: oneOf(['bezier', 'straight', 'step']),
  ...LABEL_RULES,
};

export const NODE_STYLE_KEYS = Object.keys(BOX_RULES) as Array<keyof CanvasNodeStyle>;
export const GROUP_STYLE_KEYS = [...NODE_STYLE_KEYS, ...(Object.keys(LABEL_RULES) as Array<keyof CanvasNodeStyle>)];
export const EDGE_STYLE_KEYS = Object.keys(EDGE_RULES) as Array<keyof CanvasEdgeStyle>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkFlat<T>(raw: unknown, rules: Record<string, Rule>, where: string, hint: string): T | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new CanvasStyleError(`${where} must be an object.`);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const rule = rules[key];
    if (!rule) throw new CanvasStyleError(`${where}: unknown key "${key}". ${hint}`);
    out[key] = rule(value, `${where}.${key}`);
  }
  return Object.keys(out).length === 0 ? undefined : (out as T);
}

export function checkNodeStyle(raw: unknown, where: string, isGroup: boolean): CanvasNodeStyle | undefined {
  const rules = isGroup ? { ...BOX_RULES, ...LABEL_RULES } : BOX_RULES;
  return checkFlat<CanvasNodeStyle>(raw, rules, where, `A ${isGroup ? 'group' : 'node'} style can set ${Object.keys(rules).join(', ')}.`);
}

export function checkEdgeStyle(raw: unknown, where: string): CanvasEdgeStyle | undefined {
  return checkFlat<CanvasEdgeStyle>(raw, EDGE_RULES, where, `An edge style can set ${EDGE_STYLE_KEYS.join(', ')}. Its colour is the edge's own "color".`);
}

const LUCIDE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function checkIcon(raw: unknown, where: string): CanvasIcon | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new CanvasStyleError(`${where} must be an object with a "name".`);
  for (const key of Object.keys(raw)) {
    if (!['name', 'position', 'size', 'color'].includes(key)) {
      throw new CanvasStyleError(`${where}: unknown key "${key}". An icon has name, position, size and color.`);
    }
  }
  const name = raw.name;
  if (typeof name !== 'string' || name.length > 80) throw new CanvasStyleError(`${where}.name must be "lucide:<icon>" or "asset:<id>".`);
  const [kind, ref] = [name.slice(0, name.indexOf(':')), name.slice(name.indexOf(':') + 1)];
  if (kind === 'lucide') {
    if (!LUCIDE_NAME.test(ref)) throw new CanvasStyleError(`${where}.name: "${ref}" is not a Lucide icon name (lowercase words joined by "-", like "server").`);
  } else if (kind === 'asset') {
    if (!ASSET_ID.test(ref)) throw new CanvasStyleError(`${where}.name: "${ref}" is not an asset id.`);
    if (raw.color !== undefined) throw new CanvasStyleError(`${where}.color only applies to Lucide icons. A custom SVG keeps its own colours.`);
  } else {
    throw new CanvasStyleError(`${where}.name must be "lucide:<icon>" or "asset:<id>".`);
  }
  const icon: CanvasIcon = { name };
  if (raw.position !== undefined) icon.position = oneOf(['left', 'top'])(raw.position, `${where}.position`) as CanvasIconPosition;
  if (raw.size !== undefined) icon.size = integer(12, 160)(raw.size, `${where}.size`) as number;
  if (raw.color !== undefined) icon.color = paint(raw.color, `${where}.color`) as string;
  return icon;
}

/** The Lucide icon an icon names, or null for a custom SVG. */
export function lucideName(icon: CanvasIcon): string | null {
  return icon.name.startsWith('lucide:') ? icon.name.slice(7) : null;
}

/** The asset an icon names, or null for a Lucide icon. */
export function assetId(icon: CanvasIcon): string | null {
  return icon.name.startsWith('asset:') ? icon.name.slice(6) : null;
}

export function checkTheme(raw: unknown, where = 'kite.theme'): CanvasTheme | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new CanvasStyleError(`${where} must be an object.`);
  const theme: CanvasTheme = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case 'background':
      case 'gridColor':
        theme[key] = paint(value, `${where}.${key}`) as string;
        break;
      case 'grid':
        theme.grid = oneOf(['dots', 'lines', 'cross', 'none'])(value, `${where}.grid`) as CanvasGrid;
        break;
      case 'node': {
        const style = checkNodeStyle(value, `${where}.node`, false);
        if (style) theme.node = style;
        break;
      }
      case 'group': {
        const style = checkNodeStyle(value, `${where}.group`, true);
        if (style) theme.group = style;
        break;
      }
      case 'edge': {
        const style = checkFlat<CanvasEdgeTheme>(value, { ...EDGE_RULES, color: paint }, `${where}.edge`, `An edge default can set color, ${EDGE_STYLE_KEYS.join(', ')}.`);
        if (style) theme.edge = style;
        break;
      }
      default:
        throw new CanvasStyleError(`${where}: unknown key "${key}". A theme has background, grid, gridColor, node, group and edge.`);
    }
  }
  return Object.keys(theme).length === 0 ? undefined : theme;
}

export function checkAsset(raw: unknown, where: string): CanvasAsset {
  if (!isObject(raw)) throw new CanvasStyleError(`${where} must be an object with "type": "svg" and "svg".`);
  for (const key of Object.keys(raw)) {
    if (!['type', 'svg', 'name'].includes(key)) throw new CanvasStyleError(`${where}: unknown key "${key}". An asset has type, svg and name.`);
  }
  if (raw.type !== 'svg') throw new CanvasStyleError(`${where}.type must be "svg".`);
  let svg: string;
  try {
    svg = sanitizeSvg(raw.svg);
  } catch (error) {
    if (error instanceof SvgError) throw new CanvasStyleError(`${where}: ${error.message}`);
    throw error;
  }
  const asset: CanvasAsset = { type: 'svg', svg };
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || raw.name.length > STYLE_LIMITS.maxAssetName) {
      throw new CanvasStyleError(`${where}.name must be text of at most ${STYLE_LIMITS.maxAssetName} characters.`);
    }
    if (raw.name.trim() !== '') asset.name = raw.name.trim();
  }
  return asset;
}

export function checkAssets(raw: unknown, where = 'kite.assets'): Record<string, CanvasAsset> | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new CanvasStyleError(`${where} must be an object of id → asset.`);
  const entries = Object.entries(raw);
  if (entries.length > STYLE_LIMITS.maxAssets) throw new CanvasStyleError(`A canvas can hold up to ${STYLE_LIMITS.maxAssets} custom SVG icons.`);
  const out: Record<string, CanvasAsset> = {};
  for (const [id, value] of entries) {
    if (!ASSET_ID.test(id)) throw new CanvasStyleError(`${where}: "${id}" is not a valid asset id (1 to 64 letters, digits, "_" or "-").`);
    out[id] = checkAsset(value, `${where}.${id}`);
  }
  return entries.length === 0 ? undefined : out;
}

/**
 * A partial style applied over a current one: keys given replace, keys given
 * as `null` are removed. `patch === null` removes the whole style.
 */
export function mergeStyle<T extends object>(current: T | undefined, patch: unknown, where: string): Record<string, unknown> | undefined {
  if (patch === null) return undefined;
  if (!isObject(patch)) throw new CanvasStyleError(`${where} must be an object, or null to remove it.`);
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

/** A theme patch: top-level keys replace or (null) remove; node, group and edge merge like styles. */
export function mergeTheme(current: CanvasTheme | undefined, patch: unknown): Record<string, unknown> | undefined {
  if (patch === null) return undefined;
  if (!isObject(patch)) throw new CanvasStyleError('"set" must be an object, or null to remove the theme.');
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'node' || key === 'group' || key === 'edge') {
      const merged = mergeStyle(current?.[key], value, `set.${key}`);
      if (merged === undefined) delete next[key];
      else next[key] = merged;
    } else if (value === null) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

/** The patch that turns style `from` into style `to`: changed keys, and null for removed ones. */
export function stylePatch(from: object | undefined, to: object | undefined): Record<string, unknown> | null {
  const a = (from ?? {}) as Record<string, unknown>;
  const b = (to ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] === b[key]) continue;
    patch[key] = b[key] === undefined ? null : b[key];
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/** The patch that turns theme `from` into theme `to`, for undo and restore. */
export function themePatch(from: CanvasTheme | undefined, to: CanvasTheme | undefined): Record<string, unknown> | null {
  const a = (from ?? {}) as Record<string, unknown>;
  const b = (to ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'node' || key === 'group' || key === 'edge') {
      const inner = stylePatch(a[key] as object | undefined, b[key] as object | undefined);
      if (inner) patch[key] = b[key] === undefined ? null : inner;
    } else if (a[key] !== b[key]) patch[key] = b[key] === undefined ? null : b[key];
  }
  return Object.keys(patch).length === 0 ? null : patch;
}
