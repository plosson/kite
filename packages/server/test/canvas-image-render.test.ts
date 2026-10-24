import { describe, it, expect, beforeAll } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { parseCanvas, type CanvasDocument } from '@open-artifact/shared';
import { fontEngine, type FontEngine } from '../src/canvas/image/fonts.js';
import { renderCanvas, type RenderOptions } from '../src/canvas/image/render.js';
import { ShadowPainter } from '../src/canvas/image/shadows.js';
import { layoutText, type TextStyle } from '../src/canvas/image/text.js';

/**
 * How the server draws a canvas, below the HTTP route: the SVG it builds, how
 * text is laid out, shadows, arrows, and which part of the canvas is drawn.
 * That it looks like the browser is the e2e comparison in canvas-image.spec.ts.
 */

let engine: FontEngine;

beforeAll(async () => {
  engine = await fontEngine();
});

const OPTIONS: RenderOptions = { target: 'svg', padding: 32, scale: 1, background: 'theme', grid: false, refs: new Map() };

function canvas(value: unknown): CanvasDocument {
  return parseCanvas(JSON.stringify(value));
}

const BOARD = {
  nodes: [
    { id: 'g1', type: 'group', x: 0, y: 0, width: 560, height: 260, label: 'Launch', kite: { icon: { name: 'lucide:rocket' } } },
    { id: 'n1', type: 'text', x: 30, y: 60, width: 200, height: 80, text: 'Ship it', kite: { style: { shadow: 'md', fill: '#fff7e6' } } },
    { id: 'n2', type: 'text', x: 330, y: 60, width: 200, height: 80, text: 'Measure', color: '4' },
    { id: 'n3', type: 'text', x: 700, y: 60, width: 200, height: 80, text: 'Outside the group' },
  ],
  edges: [
    { id: 'e1', fromNode: 'n1', fromSide: 'right', toNode: 'n2', toSide: 'left', label: 'then', fromEnd: 'arrow' },
    { id: 'e2', fromNode: 'n2', fromSide: 'right', toNode: 'n3', toSide: 'left', toEnd: 'none', kite: { style: { line: 'dashed', curve: 'step' } } },
  ],
};

/** The SVG with embedded font data cut out, which is long and changes when a font package does. */
function structure(svg: string): string {
  return svg
    .replace(/url\(data:font\/woff2;base64,[^)]+\)/g, 'url(data:font/woff2;…)')
    .replace(/></g, '>\n<');
}

describe('the SVG of a canvas', () => {
  it('has the same structure for the same canvas', async () => {
    const drawn = await renderCanvas(engine, canvas(BOARD), OPTIONS);
    expect({ x: drawn.x, y: drawn.y, width: drawn.width, height: drawn.height }).toEqual({ x: -32, y: -32, width: 964, height: 324 });
    expect(structure(drawn.svg)).toMatchSnapshot();
  });

  it('writes text as text with the fonts it needs, and a PNG drawing as glyph outlines', async () => {
    const svg = (await renderCanvas(engine, canvas(BOARD), OPTIONS)).svg;
    expect(svg).toContain('>Ship it</text>');
    expect(svg).toMatch(/@font-face\{font-family:'Kite Inter'/);
    const png = (await renderCanvas(engine, canvas(BOARD), { ...OPTIONS, target: 'png' })).svg;
    expect(png).not.toContain('<text');
    expect(png).not.toContain('@font-face');
    // Each glyph once, used wherever it appears: "Measure" has two e's.
    const uses = png.match(/<use href="#k[0-9a-z]+" transform="matrix/g) ?? [];
    const glyphs = new Set(png.match(/<path id="k[0-9a-z]+" d="/g));
    expect(uses.length).toBeGreaterThan(glyphs.size);
  });

  it('draws a start arrow and an end arrow each with its own marker, and none where the end is "none"', async () => {
    const svg = (await renderCanvas(engine, canvas(BOARD), OPTIONS)).svg;
    const e1 = svg.match(/<path [^>]*marker-start="url\(#(k[0-9a-z]+)\)"[^>]*marker-end="url\(#(k[0-9a-z]+)\)"/);
    expect(e1).not.toBeNull();
    expect(e1![1]).not.toBe(e1![2]);
    // The dashed step edge has no arrow at all.
    expect(svg).toMatch(/<path [^>]*stroke-dasharray="[^"]+"(?![^>]*marker-)[^>]*\/>/);
  });

  it('draws one group and what is inside it, and the edges between them', async () => {
    const drawn = await renderCanvas(engine, canvas(BOARD), { ...OPTIONS, nodeId: 'g1', padding: 0 });
    expect({ x: drawn.x, y: drawn.y, width: drawn.width, height: drawn.height }).toEqual({ x: 0, y: 0, width: 560, height: 260 });
    expect(drawn.svg).toContain('>Ship it</text>');
    expect(drawn.svg).not.toContain('Outside the group');
    // The group's own border is dashed; the dashed edge out of it is not drawn.
    expect(drawn.svg).not.toContain('stroke-dasharray="4 3"');
  });

  it('leaves out the background when transparent, and draws the grid when asked', async () => {
    const plain = (await renderCanvas(engine, canvas(BOARD), OPTIONS)).svg;
    const clear = (await renderCanvas(engine, canvas(BOARD), { ...OPTIONS, background: 'transparent' })).svg;
    const grid = (await renderCanvas(engine, canvas({ ...BOARD, kite: { version: 1, theme: { grid: 'dots' } } }), { ...OPTIONS, grid: true })).svg;
    const backdrop = '<rect x="-32" y="-32" width="964" height="324" fill="#fbfaf9"/>';
    expect(plain).toContain(backdrop);
    expect(clear).not.toContain(backdrop);
    expect(grid).toContain('<pattern');
  });

  it('draws a custom SVG as an image, so it cannot style or reach the drawing around it', async () => {
    const svg = (
      await renderCanvas(
        engine,
        canvas({
          nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'Mark', kite: { icon: { name: 'asset:mark' } } }],
          edges: [],
          kite: { version: 1, assets: { mark: { type: 'svg', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><style>rect{fill:red}</style><circle cx="12" cy="12" r="10"/></svg>' } } },
        }),
        OPTIONS,
      )
    ).svg;
    expect(svg).toMatch(/<image [^>]*href="data:image\/svg\+xml;base64,/);
    expect(svg).not.toContain('<circle');
    expect(svg).not.toContain('rect{fill:red}');
  });

  it('shows a Kite card by its title for this reader, and as one they cannot open otherwise', async () => {
    const doc = canvas({
      nodes: [{ id: 'k1', type: 'link', x: 0, y: 0, width: 240, height: 80, url: 'https://kite.example/a/x', kite: { kind: 'kite', ref: 'art_aaaaaaaaaaaaaaaa' } }],
      edges: [],
    });
    const seen = (await renderCanvas(engine, doc, { ...OPTIONS, refs: new Map([['art_aaaaaaaaaaaaaaaa', { title: 'Plan & budget', type: 'markdown' }]]) })).svg;
    expect(seen).toContain('>Plan &amp; budget</text>');
    expect(seen).toContain('>Document</text>');
    const hidden = (await renderCanvas(engine, doc, OPTIONS)).svg;
    expect(hidden).toContain('A document you can’t open');
    expect(hidden).not.toContain('Plan');
  });
});

describe('text layout', () => {
  const style: TextStyle = { typeface: 'inter', weight: 400, size: 16, lineHeight: 22, letterSpacing: 0, fill: '#000' };

  beforeAll(async () => {
    await engine.prepare([{ typeface: 'inter', text: 'First line A second line that is long enough to wrap https://example.com/a/very/long/address/without/spaces …AV' }]);
  });

  it('keeps line breaks and wraps at spaces in pre-wrap', () => {
    const block = layoutText(engine, 'First line\nA second line that is long enough to wrap', style, 200, 'pre-wrap');
    expect(block.lines.map((l) => l.text.trim())).toEqual(['First line', 'A second line that is long', 'enough to wrap']);
    expect(block.height).toBe(66);
    for (const line of block.lines) expect(line.width).toBeLessThanOrEqual(200);
  });

  it('breaks an address anywhere in break-all', () => {
    const block = layoutText(engine, 'https://example.com/a/very/long/address/without/spaces', style, 150, 'break-all');
    expect(block.lines.length).toBeGreaterThan(2);
    expect(block.lines.map((l) => l.text).join('')).toBe('https://example.com/a/very/long/address/without/spaces');
    for (const line of block.lines) expect(line.width).toBeLessThanOrEqual(150);
  });

  it('ends a line that does not fit with an ellipsis', () => {
    const block = layoutText(engine, 'A title far too long for the card it is on', style, 120, 'ellipsis');
    expect(block.lines).toHaveLength(1);
    expect(block.lines[0]!.text.endsWith('…')).toBe(true);
    expect(block.lines[0]!.width).toBeLessThanOrEqual(120);
  });

  it('measures what HarfBuzz measures, kerning included', () => {
    const width = (text: string) => layoutText(engine, text, style, 1000, 'pre-wrap').width;
    expect(width('AV')).toBeLessThan(width('A') + width('V'));
  });
});

/** erf, to within 1.2e-7 (Numerical Recipes' erfc), for a reference independent of the code under test. */
function erf(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + z / 2);
  const tau =
    t *
    Math.exp(
      -z * z - 1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? 1 - tau : tau - 1;
}
const Phi = (z: number) => (1 + erf(z / Math.SQRT2)) / 2;
const psi = (z: number) => z * Phi(z) + Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);

/**
 * A shadow's exact value on one PNG pixel: the rounded box, blurred, averaged
 * over the pixel. The box without its corners' curves is exact in closed form;
 * the bits the curves cut off are integrated column by column, exactly down each.
 */
function exactShadow(box: { x: number; y: number; w: number; h: number; r: number }, sigma: number, px: number, py: number): number {
  // How much of a pixel [p, p+1] a unit of box at q reaches, and its integral over [a, b].
  const weight = (q: number, p: number) => Phi((p + 1 - q) / sigma) - Phi((p - q) / sigma);
  const span = (a: number, b: number, p: number) =>
    sigma * (psi((p + 1 - a) / sigma) - psi((p + 1 - b) / sigma) - psi((p - a) / sigma) + psi((p - b) / sigma));
  let value = span(box.x, box.x + box.w, px) * span(box.y, box.y + box.h, py);
  const { r } = box;
  if (r === 0) return value;
  const step = 1 / 32;
  const corners = [
    [box.x, box.y, 1, 1],
    [box.x + box.w, box.y, -1, 1],
    [box.x, box.y + box.h, 1, -1],
    [box.x + box.w, box.y + box.h, -1, -1],
  ] as const;
  for (const [cx, cy, sx, sy] of corners) {
    // Too far from this pixel to reach it.
    if (Math.abs(cx - px) > r + 6 * sigma + 2 || Math.abs(cy - py) > r + 6 * sigma + 2) continue;
    // Column by column, the strip the curve cuts off, whose reach down is exact.
    for (let i = step / 2; i < r; i += step) {
      const dx = r - i;
      const cut = r - Math.sqrt(r * r - dx * dx);
      if (cut <= 0) continue;
      const [a, b] = sy > 0 ? [cy, cy + cut] : [cy - cut, cy];
      value -= weight(cx + sx * i, px) * span(a, b, py) * step;
    }
  }
  return value;
}

describe('shadows in a PNG', () => {
  // The pieces a PNG's shadows are made of, against the exact blur of the same box, for each
  // layer of the shadow styles (SHADOW_LAYERS) on cards and groups, at whole and fractional scales.
  const cases = [
    { scale: 1, w: 320, h: 100, r: 16, sigma: 18, opacity: 0.14, x: 100, y: 114 },
    { scale: 2, w: 320, h: 100, r: 16, sigma: 3, opacity: 0.08, x: 100, y: 102 },
    { scale: 2, w: 320, h: 100, r: 16, sigma: 6, opacity: 0.1, x: 100.25, y: 104 },
    { scale: 2, w: 60, h: 40, r: 8, sigma: 18, opacity: 0.14, x: 100, y: 114 },
    { scale: 1.5, w: 400, h: 870, r: 28, sigma: 1, opacity: 0.08, x: 100, y: 101 },
    { scale: 1.855, w: 320, h: 100, r: 16, sigma: 1, opacity: 0.06, x: 100.3, y: 100.7 },
    { scale: 3, w: 200, h: 60, r: 0, sigma: 6, opacity: 0.1, x: 100, y: 104 },
    // Far darker than any style, to show the placement within a pixel holds where a shadow is sharp.
    { scale: 1.855, w: 320, h: 100, r: 16, sigma: 1, opacity: 0.4, x: 100.3, y: 100.7 },
  ];

  it.each(cases)('are within 2/255 of the exact blur at scale $scale for $w×$h, radius $r, sigma $sigma, opacity $opacity', (c) => {
    const W = c.w + 200;
    const H = c.h + 200;
    const defs = new Map<string, { id: string; svg: string }>();
    const painter = new ShadowPainter(c.scale, { x: 0, y: 0 }, (key, make) => {
      let found = defs.get(key);
      if (!found) {
        const id = `d${defs.size}`;
        found = { id, svg: make(id) };
        defs.set(key, found);
      }
      return found.id;
    });
    const body = painter.draw({ x: c.x, y: c.y, width: c.w, height: c.h, radius: c.r, sigma: c.sigma, opacity: c.opacity });
    // Whole pixels, so the drawing is at exactly this scale.
    const [pw, ph] = [Math.ceil(W * c.scale), Math.ceil(H * c.scale)];
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pw / c.scale} ${ph / c.scale}" width="${pw}" height="${ph}">` +
      `<defs>${[...defs.values()].map((d) => d.svg).join('')}</defs>${body}</svg>`;
    const image = new Resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: false } }).render();
    const s = c.scale;
    const box = { x: c.x * s, y: c.y * s, w: c.w * s, h: c.h * s, r: c.r * s };
    const sigma = c.sigma * s;
    // Every pixel around the top left corner, and lines across the box through the others.
    const reach = Math.ceil(box.r + 4 * sigma + 2);
    const pixels: Array<[number, number]> = [];
    const stride = Math.max(1, Math.floor(reach / 40));
    for (let py = Math.floor(box.y) - reach; py <= Math.ceil(box.y) + reach; py += stride) {
      for (let px = Math.floor(box.x) - reach; px <= Math.ceil(box.x) + reach; px += stride) pixels.push([px, py]);
    }
    const middleY = Math.floor(box.y + box.h / 2);
    const middleX = Math.floor(box.x + box.w / 2);
    for (let px = Math.floor(box.x) - reach; px <= Math.ceil(box.x + box.w) + reach; px++) pixels.push([px, middleY], [px, Math.floor(box.y + box.h) - 2]);
    for (let py = Math.floor(box.y) - reach; py <= Math.ceil(box.y + box.h) + reach; py++) pixels.push([middleX, py], [Math.floor(box.x + box.w) - 2, py]);
    const rgba = image.pixels;
    let worst = 0;
    for (const [px, py] of pixels) {
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
      const drawn = rgba[(py * image.width + px) * 4 + 3]!;
      const d = Math.abs(drawn - exactShadow(box, sigma, px, py) * c.opacity * 255);
      worst = Math.max(worst, d);
    }
    expect(worst).toBeLessThanOrEqual(2);
  });
});
