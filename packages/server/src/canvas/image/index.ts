/**
 * A canvas as an image: what GET /api/artifacts/:id/canvas/image answers.
 *
 * The canvas is drawn as SVG (render.ts); a PNG is that SVG rasterised by
 * resvg, off the main thread. No browser is involved.
 */

import { renderAsync } from '@resvg/resvg-js';
import type { CanvasDocument } from '@open-artifact/shared';
import { fontEngine } from './fonts.js';
import { CanvasImageError, renderCanvas, type KiteRef } from './render.js';

export { CanvasImageError, RENDERER_VERSION, type KiteRef } from './render.js';

export interface CanvasImageOptions {
  format: 'png' | 'svg';
  /** Only this node, and what is inside it when it is a group. */
  node?: string;
  /** Image pixels per canvas pixel. */
  scale: number;
  /** Around the drawing, in canvas pixels. */
  padding: number;
  background: 'theme' | 'transparent';
  grid: boolean;
}

export const CANVAS_IMAGE_LIMITS = {
  minScale: 1,
  maxScale: 3,
  defaultScale: 2,
  maxPadding: 400,
  defaultPadding: 32,
  /** A PNG's widest side, in pixels. */
  maxSide: 8192,
  /** A PNG's pixels in all: 4096 by 4096. */
  maxPixels: 4096 * 4096,
} as const;

export interface CanvasImage {
  body: Uint8Array<ArrayBuffer>;
  contentType: 'image/png' | 'image/svg+xml';
  /** In image pixels. */
  width: number;
  height: number;
  /** The canvas point at the image's top left corner, in canvas pixels. */
  origin: { x: number; y: number };
}

/**
 * Images drawn at once, across the server. A PNG at the largest size is 64 MB
 * of pixels while it is drawn; the rest wait their turn.
 */
const AT_ONCE = 2;
let drawing = 0;
const waiting: Array<() => void> = [];

async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  if (drawing >= AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
  drawing++;
  try {
    return await work();
  } finally {
    drawing--;
    waiting.shift()?.();
  }
}

export function canvasImage(doc: CanvasDocument, options: CanvasImageOptions, refs: Map<string, KiteRef>): Promise<CanvasImage> {
  return inTurn(() => draw(doc, options, refs));
}

async function draw(doc: CanvasDocument, options: CanvasImageOptions, refs: Map<string, KiteRef>): Promise<CanvasImage> {
  const engine = await fontEngine();
  const drawn = await renderCanvas(engine, doc, {
    target: options.format,
    nodeId: options.node,
    padding: options.padding,
    scale: options.scale,
    background: options.background,
    grid: options.grid && options.background !== 'transparent',
    refs,
  });
  const width = Math.round(drawn.width * options.scale);
  const height = Math.round(drawn.height * options.scale);
  const origin = { x: drawn.x, y: drawn.y };
  if (options.format === 'svg') {
    return { body: new TextEncoder().encode(drawn.svg), contentType: 'image/svg+xml', width, height, origin };
  }

  const { maxSide, maxPixels } = CANVAS_IMAGE_LIMITS;
  if (width > maxSide || height > maxSide || width * height > maxPixels) {
    throw new CanvasImageError(
      `At scale ${options.scale} this image would be ${width} by ${height} pixels, more than the ${maxSide} on a side and ` +
        `${maxPixels.toLocaleString('en')} in all that a PNG may have. Ask for a smaller scale, one group with node, or format=svg.`,
    );
  }
  const image = await renderAsync(drawn.svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: false } });
  return { body: new Uint8Array(image.asPng()), contentType: 'image/png', width: image.width, height: image.height, origin };
}
