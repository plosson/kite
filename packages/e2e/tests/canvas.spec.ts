import { test, expect } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * The canvas spike, end to end: a canvas published through the API is drawn
 * with React Flow, and the owner's drag and text edit come back as new versions
 * through POST /canvas/ops.
 */

let server: RunningServer;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

const BOARD = {
  nodes: [
    { id: 'g1', type: 'group', x: 0, y: 0, width: 700, height: 300, label: 'Launch plan' },
    { id: 'n1', type: 'text', x: 40, y: 60, width: 220, height: 90, text: 'Ship the canvas spike' },
    { id: 'n2', type: 'text', x: 400, y: 60, width: 220, height: 90, text: 'Measure React Flow' },
  ],
  edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
};

async function readCanvas(id: string) {
  const response = await server.as(`/api/artifacts/${id}/canvas`);
  return (await response.json()) as {
    nodes: { id: string; x: number; y: number; text?: string }[];
    kite: { version: number };
  };
}

test('the owner drags a node and edits text, and each saves as a version', async ({ page, context }) => {
  const artifact = await server.publish({ type: 'canvas', content: JSON.stringify(BOARD) });
  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);

  const view = page.getByTestId('canvas-view');
  await expect(view.getByText('Ship the canvas spike')).toBeVisible();
  await expect(view.getByText('Launch plan')).toBeVisible();
  await expect(view.locator('.react-flow__edge')).toHaveCount(1);

  const node = view.locator('.react-flow__node[data-id="n1"]');
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 80, { steps: 12 });
  await page.mouse.up();

  await expect(page.getByTestId('canvas-status')).toHaveText(/Saved · v2/);
  const afterDrag = await readCanvas(artifact.id);
  const moved = afterDrag.nodes.find((n) => n.id === 'n1')!;
  expect(moved.x).toBeGreaterThan(40);
  expect(moved.y).toBeGreaterThan(60);

  await view.getByText('Measure React Flow').dblclick();
  const editor = view.locator('textarea');
  await editor.fill('Measure React Flow at 2k nodes');
  await editor.blur();
  await expect(page.getByTestId('canvas-status')).toHaveText(/Saved · v3/);
  expect((await readCanvas(artifact.id)).nodes.find((n) => n.id === 'n2')?.text).toBe(
    'Measure React Flow at 2k nodes',
  );
});

test('a save that lost a race re-reads and lands on top', async ({ page, context }) => {
  const artifact = await server.publish({ type: 'canvas', content: JSON.stringify(BOARD) });
  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  const view = page.getByTestId('canvas-view');
  await expect(view.getByText('Ship the canvas spike')).toBeVisible();

  // The owner's agent writes while the page is open.
  const agent = await server.as(`/api/artifacts/${artifact.id}/canvas/ops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: 1, ops: [{ op: 'add', node: { type: 'text', text: 'From the agent' } }] }),
  });
  expect(agent.ok).toBe(true);

  await view.getByText('Measure React Flow').dblclick();
  await view.locator('textarea').fill('Edited in the browser');
  await view.locator('textarea').blur();

  await expect(page.getByTestId('canvas-status')).toHaveText(/Saved · v3/);
  const doc = await readCanvas(artifact.id);
  expect(doc.nodes.map((n) => n.text)).toContain('From the agent');
  expect(doc.nodes.map((n) => n.text)).toContain('Edited in the browser');
  // Placed to the right of everything, so outside the first fit.
  await view.getByRole('button', { name: /fit view/i }).click();
  await expect(view.getByText('From the agent')).toBeVisible();
});

test('2,000 nodes render and pan', async ({ page, context }) => {
  test.skip(!process.env.CANVAS_PERF, 'Measurement, not a check: CANVAS_PERF=1 to run.');
  const nodes = Array.from({ length: 2000 }, (_, i) => ({
    id: `n${i}`,
    type: 'text',
    x: (i % 50) * 260,
    y: Math.floor(i / 50) * 120,
    width: 220,
    height: 90,
    text: `Card ${i}\nSome words on it`,
  }));
  const edges = nodes.slice(1).map((n, i) => ({ id: `e${i}`, fromNode: `n${i}`, toNode: n.id }));
  const artifact = await server.publish({ type: 'canvas', content: JSON.stringify({ nodes, edges }) });
  await server.signInBrowser(context);

  const started = Date.now();
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  const firstPaint = Date.now() - started;

  const rendered = await page.locator('.react-flow__node').count();
  const view = (await page.getByTestId('canvas-view').boundingBox())!;
  const panStart = Date.now();
  await page.mouse.move(view.x + 200, view.y + 200);
  await page.mouse.down();
  await page.mouse.move(view.x + 600, view.y + 400, { steps: 40 });
  await page.mouse.up();
  const pan = Date.now() - panStart;

  const zoomStart = Date.now();
  for (let i = 0; i < 6; i += 1) await page.getByRole('button', { name: /zoom in/i }).click();
  const zoom = Date.now() - zoomStart;
  console.log(JSON.stringify({ firstPaint, renderedNodes: rendered, panMs: pan, zoom6Ms: zoom }));
});
