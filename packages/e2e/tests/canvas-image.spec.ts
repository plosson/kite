import { test, expect } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * The image the server draws of a canvas has to look like the canvas in the
 * browser. This draws a board with most of what a canvas can carry, takes a
 * screenshot of it, asks for the PNG at the same zoom and position, and
 * compares the two pixel by pixel.
 */

let server: RunningServer;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

/** Measured on Chromium: 0.8% of pixels and a mean of 1.7 out of 255. */
const TOLERANCE = { different: 0.015, mean: 2.5 };

test.use({ viewport: { width: 2200, height: 1300 }, deviceScaleFactor: 2 });

const card = (id: string, x: number, y: number, text: string, kite: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'text',
  x,
  y,
  width: 320,
  height: 100,
  text,
  ...extra,
  kite,
});

const indigo = (icon: string, style: Record<string, unknown> = {}) => ({
  style: { borderColor: '#c9ccfb', textColor: '#1e1b4b', ...style },
  icon: { name: icon, size: 30, color: '#4f46e5' },
});

function board(documentId: string, baseUrl: string) {
  return {
    nodes: [
      {
        id: 'ga', type: 'group', x: 0, y: 0, width: 400, height: 870, label: 'Clients', color: '5',
        kite: { style: { fill: '#eef0ff', borderColor: '#4f46e5', labelColor: '#ffffff', labelBackground: '#4f46e5' }, icon: { name: 'lucide:bot', size: 26, color: '#ffffff' } },
      },
      {
        id: 'gs', type: 'group', x: 1400, y: 0, width: 400, height: 870, label: 'Servers', color: '4',
        kite: { style: { fill: '#e5f6f3', borderColor: '#0d9488', labelColor: '#ffffff', labelBackground: '#0d9488' }, icon: { name: 'lucide:cloud-upload', size: 26, color: '#ffffff' } },
      },
      card('a1', 40, 70, 'Command line\nOne command per service, for agents', indigo('lucide:terminal', { borderColor: '#4f46e5', borderWidth: 2, shadow: 'lg' })),
      card('a2', 40, 290, 'Plugins\nMail, chat, tickets, code, memory…', indigo('lucide:puzzle')),
      card('a3', 40, 510, 'Profiles & vault\nCredentials in one encrypted file', { ...indigo(''), icon: { name: 'asset:kite-mark', size: 30 } }),
      card('a4', 40, 730, 'Daemon / hub\nServes credentials to remote agents', indigo('lucide:server-cog', { font: 'mono', fontSize: 14, textAlign: 'center' })),
      card('m1', 740, 70, 'Source control\nCode and releases', { style: { fill: '#fff7e6', borderColor: '#f59e0b', textColor: '#5b3a06', borderWidth: 2 }, icon: { name: 'lucide:git-branch', size: 30, color: '#d97706' } }),
      card('m2', 740, 290, 'Serif, on the right, wrapped across several lines of text', { style: { font: 'serif', textAlign: 'right', verticalAlign: 'top', borderStyle: 'dashed', radius: 4, shadow: 'none' } }),
      { id: 'm3', type: 'link', x: 740, y: 510, width: 320, height: 100, url: 'https://example.com/a/very/long/address/that/breaks/anywhere' },
      { id: 'm4', type: 'link', x: 740, y: 730, width: 320, height: 100, url: `${baseUrl}/a/${documentId}`, kite: { kind: 'kite', ref: documentId, style: { fill: '#fdf2f8', borderColor: '#db2777' } } },
      card('s1', 1440, 70, 'Deploy tool\nDeploys from your machine', { style: { borderColor: '#0d9488', textColor: '#134e4a', fontWeight: 700, fontSize: 18, verticalAlign: 'bottom' }, icon: { name: 'lucide:rocket', size: 30, color: '#0d9488', position: 'left' } }),
      card('s2', 1440, 290, 'Hand-written note', { style: { font: 'hand', fontSize: 24, fill: '#fef9c3', borderColor: '#ca8a04', textAlign: 'center', shadow: 'sm' } }),
      card('s3', 1440, 510, 'Apps & sites\nDocker containers', { style: { borderColor: '#0d9488', textColor: '#134e4a' }, icon: { name: 'lucide:boxes', size: 30, color: '#0d9488', position: 'top' } }),
      card('s4', 1440, 730, 'Pill', { style: { radius: 96, fill: '#0d9488', textColor: '#ffffff', textAlign: 'center', borderWidth: 0 } }),
    ],
    edges: [
      { id: 'f1', fromNode: 'a1', fromSide: 'bottom', toNode: 'a2', toSide: 'top', label: 'runs', kite: { style: { labelColor: '#3730a3', width: 3, curve: 'straight' } } },
      { id: 'f2', fromNode: 'a2', fromSide: 'bottom', toNode: 'a3', toSide: 'top', label: 'credentials', fromEnd: 'arrow', kite: { style: { width: 3, curve: 'straight' } } },
      { id: 'f3', fromNode: 'a4', fromSide: 'top', toNode: 'a3', toSide: 'bottom', toEnd: 'none' },
      { id: 'f4', fromNode: 'a1', fromSide: 'right', toNode: 'm1', toSide: 'left', label: 'updates from', color: '#4f46e5', kite: { style: { line: 'dashed' } } },
      { id: 'f5', fromNode: 'a2', fromSide: 'right', toNode: 'm2', toSide: 'left', label: 'step', kite: { style: { curve: 'step' } } },
      { id: 'f6', fromNode: 'a2', fromSide: 'right', toNode: 'm3', toSide: 'left', color: '1', kite: { style: { width: 3 } } },
      { id: 'f7', fromNode: 'a3', fromSide: 'right', toNode: 'm4', toSide: 'left', label: 'REST', kite: { style: { line: 'dotted', labelBackground: '#fde68a' } } },
      { id: 'f8', fromNode: 's1', fromSide: 'bottom', toNode: 's2', toSide: 'top', label: 'HTTPS API', kite: { style: { labelColor: '#0f766e', width: 3, curve: 'straight' } } },
      { id: 'f9', fromNode: 's2', fromSide: 'left', toNode: 'm1', toSide: 'right', label: 'git deploys', kite: { style: { labelColor: '#0f766e', width: 3 } } },
      { id: 'f10', fromNode: 'm2', fromSide: 'top', toNode: 'm1', toSide: 'bottom', kite: { style: { curve: 'step', width: 2, line: 'dotted' } } },
      { id: 'f11', fromNode: 's4', fromSide: 'top', toNode: 's3', toSide: 'bottom', label: 'routes' },
    ],
    kite: {
      version: 1,
      assets: {
        'kite-mark': {
          type: 'svg',
          name: 'Kite',
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2 20 10 12 22 4 10Z" fill="#4f46e5"/><path d="M4 10h16M12 2v20" stroke="#ffffff" stroke-width="1.5" fill="none"/></svg>',
        },
      },
      theme: {
        background: '#f5f6fa',
        grid: 'dots',
        gridColor: '#d9dce8',
        node: { fill: '#ffffff', font: 'inter', fontSize: 16, fontWeight: 500, radius: 16, borderWidth: 1, shadow: 'md', verticalAlign: 'middle' },
        group: { radius: 28, borderWidth: 2, borderStyle: 'solid', shadow: 'none', labelFont: 'grotesk', labelWeight: 700, labelSize: 26 },
        edge: { width: 2, curve: 'bezier', labelFont: 'inter', labelSize: 14, labelWeight: 600, labelBackground: '#ffffff', color: '#9096ab' },
      },
    },
  };
}

test('the PNG of a canvas matches what the browser draws', async ({ page, context }) => {
  const document = await server.publish({ type: 'markdown', content: '# Design notes\n\nWhat the board is about.', title: 'Design notes' });
  const canvas = await server.publish({ type: 'canvas', content: JSON.stringify(board(document.id, server.baseUrl)), title: 'Board' });
  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${canvas.slug}`);
  const view = page.getByTestId('canvas-view');
  await expect(view.getByText('Design notes')).toBeVisible();
  await expect(view.getByText('git deploys')).toBeVisible();
  // What is not the drawing: the controls, the map, the handles for drawing an edge.
  await page.addStyleTag({
    content: '.react-flow__panel, .react-flow__handle { display: none !important; } * { transition: none !important; caret-color: transparent !important; }',
  });
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });

  // The viewport element is scaled from its top left, so its box starts where canvas point 0,0 is drawn.
  const { zoom, x0, y0 } = await view.locator('.react-flow__viewport').evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { zoom: new DOMMatrix(getComputedStyle(element).transform).a, x0: box.left, y0: box.top };
  });
  // Close enough that the browser draws edge labels and card details.
  expect(zoom).toBeGreaterThan(0.6);
  const shot = await page.screenshot({ animations: 'disabled' });

  const scale = zoom * 2;
  const response = await server.as(`/api/artifacts/${canvas.id}/canvas/image?scale=${scale}&padding=0`);
  expect(response.status).toBe(200);
  const [originX, originY] = (response.headers.get('x-canvas-origin') ?? '').split(',').map(Number);
  const png = Buffer.from(await response.arrayBuffer());

  // Where the image's top left falls in the screenshot, in device pixels.
  const left = (x0 + originX * zoom) * 2;
  const top = (y0 + originY * zoom) * 2;

  const result = await page.evaluate(
    async ({ shot, png, left, top }) => {
      const load = async (base64: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height);
      };
      const screen = await load(shot);
      const drawn = await load(png);
      const compare = (dx: number, dy: number, step: number) => {
        let compared = 0;
        let different = 0;
        let total = 0;
        for (let y = 0; y < drawn.height; y += step) {
          const sy = y + dy;
          if (sy < 0 || sy >= screen.height) continue;
          for (let x = 0; x < drawn.width; x += step) {
            const sx = x + dx;
            if (sx < 0 || sx >= screen.width) continue;
            const a = (y * drawn.width + x) * 4;
            const b = (sy * screen.width + sx) * 4;
            const diff = Math.max(
              Math.abs(drawn.data[a] - screen.data[b]),
              Math.abs(drawn.data[a + 1] - screen.data[b + 1]),
              Math.abs(drawn.data[a + 2] - screen.data[b + 2]),
            );
            compared++;
            total += diff;
            if (diff > 64) different++;
          }
        }
        return { compared, different: different / compared, mean: total / compared };
      };
      // The browser puts the zoomed layer on whole device pixels, so the
      // image is compared where it fits best within a pixel or two.
      let best = { dx: 0, dy: 0, mean: Infinity };
      for (let oy = -2; oy <= 2; oy++) {
        for (let ox = -2; ox <= 2; ox++) {
          const dx = Math.round(left) + ox;
          const dy = Math.round(top) + oy;
          const { mean } = compare(dx, dy, 3);
          if (mean < best.mean) best = { dx, dy, mean };
        }
      }
      return {
        ...compare(best.dx, best.dy, 1),
        shift: [best.dx - Math.round(left), best.dy - Math.round(top)],
        // The same comparison ten pixels off, to show it would notice a drawing in the wrong place.
        misplaced: compare(best.dx + 10, best.dy + 10, 1),
        image: [drawn.width, drawn.height],
      };
    },
    { shot: shot.toString('base64'), png: png.toString('base64'), left, top },
  );
  // Most of the board is on screen, so most of the image is compared.
  expect(result.compared).toBeGreaterThan(result.image[0] * result.image[1] * 0.9);
  // Anti-aliased edges and glyph hinting differ by a pixel here and there.
  expect(result.different).toBeLessThan(TOLERANCE.different);
  expect(result.mean).toBeLessThan(TOLERANCE.mean);
  expect(result.misplaced.mean).toBeGreaterThan(TOLERANCE.mean * 2);
});

test('the SVG of a canvas, drawn by the browser, matches the PNG', async ({ page }) => {
  const document = await server.publish({ type: 'markdown', content: '# Design notes\n\nWhat the board is about.', title: 'Design notes' });
  const canvas = await server.publish({ type: 'canvas', content: JSON.stringify(board(document.id, server.baseUrl)), title: 'Board' });
  const png = Buffer.from(await (await server.as(`/api/artifacts/${canvas.id}/canvas/image?scale=2`)).arrayBuffer());
  const svgResponse = await server.as(`/api/artifacts/${canvas.id}/canvas/image?format=svg&scale=2`);
  expect(svgResponse.headers.get('content-type')).toContain('image/svg+xml');
  const svg = Buffer.from(await svgResponse.arrayBuffer());

  await page.goto('about:blank');
  const result = await page.evaluate(
    async ({ png, svg }) => {
      const load = async (src: string) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        return image;
      };
      const raster = await load(`data:image/png;base64,${png}`);
      const vector = await load(`data:image/svg+xml;base64,${svg}`);
      const pixels = (image: HTMLImageElement) => {
        const canvas = new OffscreenCanvas(raster.naturalWidth, raster.naturalHeight);
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      // Fonts inside an SVG image load before decode() resolves in Chromium, but give layout a frame.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const a = pixels(raster);
      const b = pixels(vector);
      let different = 0;
      let total = 0;
      for (let i = 0; i < a.length; i += 4) {
        const diff = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        total += diff;
        if (diff > 64) different++;
      }
      return { size: [vector.naturalWidth, vector.naturalHeight, raster.naturalWidth, raster.naturalHeight], different: different / (a.length / 4), mean: total / (a.length / 4) };
    },
    { png: png.toString('base64'), svg: svg.toString('base64') },
  );
  expect(result.size.slice(0, 2)).toEqual(result.size.slice(2));
  expect(result.different).toBeLessThan(TOLERANCE.different);
  expect(result.mean).toBeLessThan(TOLERANCE.mean);
});
