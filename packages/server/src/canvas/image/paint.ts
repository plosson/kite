/**
 * A resolved canvas colour as an SVG colour and opacity, in the app's light
 * theme. A wash (`color-mix(in srgb, c p%, over)`) is worked out here the way
 * the browser mixes it.
 */

import { LIGHT_TOKENS, presetColour, type LookPaint } from '@open-artifact/shared';

export interface SvgPaint {
  /** `#rrggbb`, or `none`. */
  colour: string;
  opacity: number;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parse(value: string): Rgba {
  const colour = presetColour(value);
  if (colour === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let hex = colour.slice(1);
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a };
}

function rgbaOf(value: LookPaint): Rgba {
  if (typeof value === 'string') return parse(value);
  if ('token' in value) return parse(LIGHT_TOKENS[value.token]);
  const top = parse(value.mix);
  const under = value.over === 'transparent' ? parse('transparent') : parse(LIGHT_TOKENS[value.over]);
  const p = value.percent / 100;
  // Mixed with premultiplied alpha, as CSS Color 5 says.
  const a = top.a * p + under.a * (1 - p);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, u: number) => (t * top.a * p + u * under.a * (1 - p)) / a;
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a };
}

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

export function svgPaint(value: LookPaint): SvgPaint {
  const c = rgbaOf(value);
  if (c.a === 0) return { colour: 'none', opacity: 0 };
  return { colour: `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`, opacity: Math.round(c.a * 1000) / 1000 };
}

/** `fill="…"` (or another attribute) with its opacity when it has one. */
export function paintAttrs(attribute: 'fill' | 'stroke', paint: SvgPaint): string {
  if (paint.colour === 'none') return `${attribute}="none"`;
  return `${attribute}="${paint.colour}"${paint.opacity < 1 ? ` ${attribute}-opacity="${paint.opacity}"` : ''}`;
}

export function isOpaque(paint: SvgPaint): boolean {
  return paint.colour !== 'none' && paint.opacity >= 1;
}
