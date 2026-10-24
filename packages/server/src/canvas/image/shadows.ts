/**
 * CSS box-shadows for the PNG, without SVG filters.
 *
 * A box-shadow is the box's rounded rectangle, offset and blurred with a
 * Gaussian of half the blur radius. resvg blurs every filtered element in its
 * own layer, which on a canvas of thousands of cards takes minutes, so the
 * PNG draws each shadow from pieces that cost almost nothing:
 *
 * - away from the corners a blurred edge is the same across its whole length,
 *   the Gaussian's integral, drawn as a linear gradient;
 * - the corners are blurred here once, exactly, on the PNG's own pixels, and
 *   every card of the same radius and shadow reuses them, turned to its corner;
 * - a box too small for that has its whole shadow blurred here.
 *
 * This is how Skia draws box-shadows too (a blurred nine-patch). The pieces sit
 * on whole PNG pixels, so they meet without seams. The SVG keeps real blur
 * filters, which browsers draw natively.
 */

import { deflateSync, crc32 } from 'node:zlib';
import { num } from './fonts.js';

/** Where the Gaussian has fallen to nothing that a pixel can show. */
const REACH = 3;
/** Stops at least across a blurred edge's band: the integral's curve, closer than a pixel's value can tell. */
const EDGE_STOPS = 24;

/** The normal distribution's integral, to within 1.5e-7. */
function phi(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** How much of a pixel, a unit square centred at (px, py), lies inside a rounded rectangle at the origin. */
function coverage(px: number, py: number, w: number, h: number, r: number): number {
  const overlap = (c: number, size: number) => Math.max(0, Math.min(c + 0.5, size) - Math.max(c - 0.5, 0));
  const nearArcX = px - 0.5 < r || px + 0.5 > w - r;
  const nearArcY = py - 0.5 < r || py + 0.5 > h - r;
  // Away from the corners' curves a pixel is cut by straight sides only.
  if (!(nearArcX && nearArcY) || r === 0) return overlap(px, w) * overlap(py, h);
  const SAMPLES = 8;
  let inside = 0;
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      const x = px - 0.5 + (i + 0.5) / SAMPLES;
      const y = py - 0.5 + (j + 0.5) / SAMPLES;
      if (x < 0 || y < 0 || x > w || y > h) continue;
      const dx = Math.max(r - x, 0, x - (w - r));
      const dy = Math.max(r - y, 0, y - (h - r));
      if (dx * dx + dy * dy <= r * r) inside++;
    }
  }
  return inside / (SAMPLES * SAMPLES);
}

/** A Gaussian of `sigma` pixels, each tap the curve's share of its pixel. */
function kernel(sigma: number): Float64Array {
  const reach = Math.ceil(REACH * sigma);
  const taps = new Float64Array(reach * 2 + 1);
  let total = 0;
  for (let i = -reach; i <= reach; i++) {
    const v = phi((i + 0.5) / sigma) - phi((i - 0.5) / sigma);
    taps[i + reach] = v;
    total += v;
  }
  for (let i = 0; i < taps.length; i++) taps[i]! /= total;
  return taps;
}

/**
 * A rounded rectangle blurred, in device pixels: `cols` by `rows` pixels whose
 * first is at (`x0`, `y0`) relative to the rectangle's corner. Rectangle and
 * blur are in device pixels too; `w` or `h` may be Infinity for a rectangle
 * that goes on past the tile.
 */
function blurred(w: number, h: number, r: number, sigma: number, x0: number, y0: number, cols: number, rows: number): Float64Array {
  const taps = kernel(sigma);
  const reach = (taps.length - 1) / 2;
  const mw = cols + reach * 2;
  const mh = rows + reach * 2;
  const mask = new Float64Array(mw * mh);
  for (let j = 0; j < mh; j++) {
    for (let i = 0; i < mw; i++) mask[j * mw + i] = coverage(x0 - reach + i + 0.5, y0 - reach + j + 0.5, w, h, r);
  }
  // A Gaussian is separable: across, then down.
  const across = new Float64Array(cols * mh);
  for (let j = 0; j < mh; j++) {
    for (let i = 0; i < cols; i++) {
      let v = 0;
      for (let k = 0; k < taps.length; k++) v += taps[k]! * mask[j * mw + i + k]!;
      across[j * cols + i] = v;
    }
  }
  const out = new Float64Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let v = 0;
      for (let k = 0; k < taps.length; k++) v += taps[k]! * across[(j + k) * cols + i]!;
      out[j * cols + i] = v;
    }
  }
  return out;
}

/** A black PNG whose alpha is `opacity` times each value. */
function alphaPng(values: Float64Array, cols: number, rows: number, opacity: number): Buffer {
  // Grey and alpha, eight bits each; each row starts with filter 0.
  const raw = Buffer.alloc(rows * (cols * 2 + 1));
  for (let j = 0; j < rows; j++) {
    const row = j * (cols * 2 + 1);
    for (let i = 0; i < cols; i++) raw[row + 1 + i * 2 + 1] = Math.round(Math.min(1, Math.max(0, values[j * cols + i]!)) * opacity * 255);
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(cols, 0);
  header.writeUInt32BE(rows, 4);
  header[8] = 8;
  header[9] = 4;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface ShadowBox {
  /** The box's rounded rectangle, in canvas pixels, already offset by the shadow's x and y. */
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  /** Half the CSS blur radius. */
  sigma: number;
  opacity: number;
}

/** How far a shadow may sit from where it belongs, as the most it changes a pixel by, out of 255. */
const PLACEMENT_ERROR = 0.5;
const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** The normal distribution's density. */
function density(z: number): number {
  return Math.exp((-z * z) / 2) / SQRT_2PI;
}

/** The integral of phi, so a pixel's value can be phi averaged across it. */
function phiIntegral(z: number): number {
  return z * phi(z) + density(z);
}

/** A blurred straight edge's value on the pixel centred `u` pixels inside it. */
function edgeValue(u: number, sigma: number): number {
  return sigma * (phiIntegral((u + 0.5) / sigma) - phiIntegral((u - 0.5) / sigma));
}

/**
 * One side of a shadow on the PNG's pixels, from its outside edge inwards:
 * the first pixel, the pixel offset where the box's edge falls (within a
 * fraction of a pixel, `phases` to a pixel), and whether it runs the other way.
 */
interface Side {
  /** The outermost pixel column or row the shadow can reach. */
  pixel: number;
  /** From that pixel's outer edge to the box's edge, in pixels: `reach` and a fraction. */
  inset: number;
}

function nearSide(edge: number, reach: number, phases: number): Side {
  const start = edge - reach;
  let pixel = Math.floor(start);
  let fraction = Math.round((start - pixel) * phases) / phases;
  if (fraction === 1) {
    pixel += 1;
    fraction = 0;
  }
  return { pixel, inset: reach + fraction };
}

function farSide(edge: number, reach: number, phases: number): Side {
  const end = edge + reach;
  let pixel = Math.ceil(end);
  let fraction = Math.round((pixel - end) * phases) / phases;
  if (fraction === 1) {
    pixel -= 1;
    fraction = 0;
  }
  return { pixel, inset: reach + fraction };
}

/**
 * Draws box-shadows from shared pieces, for a PNG of `scale` pixels per canvas
 * pixel whose top left corner is at `origin` on the canvas.
 */
export class ShadowPainter {
  constructor(
    private readonly scale: number,
    private readonly origin: { x: number; y: number },
    /** Adds a definition once under `key` and returns its id. */
    private readonly def: (key: string, make: (id: string) => string) => string,
  ) {}

  draw(box: ShadowBox): string {
    // Everything here is in the PNG's pixels, from its top left.
    const s = this.scale;
    const x = (box.x - this.origin.x) * s;
    const y = (box.y - this.origin.y) * s;
    const w = box.width * s;
    const h = box.height * s;
    const r = Math.max(0, Math.min(box.radius * s, w / 2, h / 2));
    const sigma = box.sigma * s;
    const { opacity } = box;
    // Past `reach` outside the box the shadow is nothing; a corner's own shape stops mattering `reach` past its curve.
    const reach = Math.ceil(REACH * sigma);
    const tile = Math.ceil(r + 2 * reach);
    // A pixel's worth of offset changes a sharp shadow most; this many places in a pixel keep that under PLACEMENT_ERROR.
    const phases = Math.min(16, Math.max(1, Math.ceil((opacity * 255) / (2 * PLACEMENT_ERROR * SQRT_2PI * sigma))));
    const left = nearSide(x, reach, phases);
    const top = nearSide(y, reach, phases);
    const right = farSide(x + w, reach, phases);
    const bottom = farSide(y + h, reach, phases);
    const size = (side: Side) => tile - reach + Math.ceil(side.inset);
    const across = right.pixel - size(right) - (left.pixel + size(left));
    const down = bottom.pixel - size(bottom) - (top.pixel + size(top));
    // A corner is blurred as if the box went on for ever; true while the far side is `reach` past the corner's piece.
    if (w < tile || h < tile || across < 0 || down < 0) return this.whole(x, y, w, h, r, sigma, opacity, reach, phases);

    const at = (px: number, py: number) => `${num(px / s + this.origin.x)} ${num(py / s + this.origin.y)}`;
    const corner = (cx: Side, cy: Side) => {
      const cols = size(cx);
      const rows = size(cy);
      const key = `corner:${num(r)}:${num(sigma)}:${opacity}:${cx.inset}:${cy.inset}`;
      return this.def(`shadow-${key}`, (id) => {
        const url = piece(key, () => alphaPng(blurred(Infinity, Infinity, r, sigma, -cx.inset, -cy.inset, cols, rows), cols, rows, opacity));
        return image(id, url, cols / s, rows / s);
      });
    };
    // Across one side, from the outside in: the blurred edge's value on each pixel, as gradient stops.
    const edge = (dir: 'down' | 'up' | 'right' | 'left', side: Side) => {
      const length = size(side);
      return this.def(`shadow-edge:${dir}:${length}:${side.inset}:${num(sigma)}:${opacity}`, (id) => {
        const ends = { down: 'x1="0" y1="0" x2="0" y2="1"', up: 'x1="0" y1="1" x2="0" y2="0"', right: 'x1="0" y1="0" x2="1" y2="0"', left: 'x1="1" y1="0" x2="0" y2="0"' }[dir];
        let stops = '';
        // A gradient is read at pixel centres, so the stops are on them, every pixel of the blurred band and a few between.
        const step = Math.min(1, (2 * reach) / EDGE_STOPS);
        for (let centre = 0.5; centre < length; centre += step) {
          const u = centre - side.inset;
          stops += `<stop offset="${num4(centre / length)}" stop-opacity="${num4(edgeValue(u, sigma) * opacity)}"/>`;
          if (u > reach + 1) break;
        }
        stops += `<stop offset="1" stop-opacity="${num4(opacity)}"/>`;
        return `<linearGradient id="${id}" ${ends}>${stops}</linearGradient>`;
      });
    };
    const rect = (px: number, py: number, pw: number, ph: number, fill: string) =>
      `<rect x="${num(px / s + this.origin.x)}" y="${num(py / s + this.origin.y)}" width="${num(pw / s)}" height="${num(ph / s)}" ${fill} shape-rendering="crispEdges"/>`;

    let out = '';
    out += `<use href="#${corner(left, top)}" transform="translate(${at(left.pixel, top.pixel)})"/>`;
    out += `<use href="#${corner(right, top)}" transform="translate(${at(right.pixel, top.pixel)}) scale(-1 1)"/>`;
    out += `<use href="#${corner(left, bottom)}" transform="translate(${at(left.pixel, bottom.pixel)}) scale(1 -1)"/>`;
    out += `<use href="#${corner(right, bottom)}" transform="translate(${at(right.pixel, bottom.pixel)}) scale(-1 -1)"/>`;
    const x0 = left.pixel + size(left);
    const y0 = top.pixel + size(top);
    if (across > 0) {
      out += rect(x0, top.pixel, across, size(top), `fill="url(#${edge('down', top)})"`);
      out += rect(x0, bottom.pixel - size(bottom), across, size(bottom), `fill="url(#${edge('up', bottom)})"`);
    }
    if (down > 0) {
      out += rect(left.pixel, y0, size(left), down, `fill="url(#${edge('right', left)})"`);
      out += rect(right.pixel - size(right), y0, size(right), down, `fill="url(#${edge('left', right)})"`);
    }
    if (across > 0 && down > 0) out += rect(x0, y0, across, down, `fill="#000" fill-opacity="${num4(opacity)}"`);
    return out;
  }

  /** A box too small for corners and edges: its whole shadow, blurred here. */
  private whole(x: number, y: number, w: number, h: number, r: number, sigma: number, opacity: number, reach: number, phases: number): string {
    const s = this.scale;
    const left = nearSide(x, reach, phases);
    const top = nearSide(y, reach, phases);
    const cols = Math.ceil(left.inset + w + reach);
    const rows = Math.ceil(top.inset + h + reach);
    const key = `box:${num(w)}x${num(h)}:${num(r)}:${num(sigma)}:${opacity}:${left.inset}:${top.inset}`;
    const id = this.def(`shadow-${key}`, (id) => {
      const url = piece(key, () => alphaPng(blurred(w, h, r, sigma, -left.inset, -top.inset, cols, rows), cols, rows, opacity));
      return image(id, url, cols / s, rows / s);
    });
    return `<use href="#${id}" transform="translate(${num(left.pixel / s + this.origin.x)} ${num(top.pixel / s + this.origin.y)})"/>`;
  }
}

/** A number for an offset or opacity, where two decimals are not enough. */
function num4(value: number): string {
  return String(Math.round(value * 1e5) / 1e5);
}

/** Blurred pieces already made, by what they are, for the drawings after; the oldest go first. */
const made = new Map<string, string>();
const MADE_LIMIT = 256;

/** A piece's PNG as a data URL, made once. */
function piece(key: string, make: () => Buffer): string {
  let url = made.get(key);
  if (url === undefined) {
    url = `data:image/png;base64,${make().toString('base64')}`;
    if (made.size >= MADE_LIMIT) made.delete(made.keys().next().value!);
  } else made.delete(key);
  made.set(key, url);
  return url;
}

function image(id: string, url: string, width: number, height: number): string {
  return `<image id="${id}" width="${num(width)}" height="${num(height)}" preserveAspectRatio="none" href="${url}"/>`;
}
