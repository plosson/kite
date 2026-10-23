import { test, expect, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * Editing a canvas in the browser, as its owner: every gesture below has to end
 * up on the server as canvas operations, and undo has to go back the same way.
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
    { id: 'n1', type: 'text', x: 40, y: 60, width: 220, height: 90, text: 'Ship the canvas' },
    { id: 'n2', type: 'text', x: 400, y: 60, width: 220, height: 90, text: 'Measure React Flow' },
    { id: 'n3', type: 'text', x: 900, y: 60, width: 220, height: 90, text: 'Loose card' },
  ],
  edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
};

type Doc = {
  nodes: { id: string; type: string; x: number; y: number; width: number; height: number; text?: string; url?: string; label?: string; kite?: Record<string, string> }[];
  edges: { id: string; fromNode: string; toNode: string; fromSide?: string; toSide?: string; label?: string }[];
  kite: { version: number };
};

async function readCanvas(id: string): Promise<Doc> {
  return (await (await server.as(`/api/artifacts/${id}/canvas`)).json()) as Doc;
}

async function open(page: Page, context: Parameters<RunningServer['signInBrowser']>[0], board: unknown = BOARD) {
  const artifact = await server.publish({ type: 'canvas', content: JSON.stringify(board) });
  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(page.getByTestId('canvas-view').getByText('Ship the canvas')).toBeVisible();
  return artifact;
}

/** Waits for the save to land. Batching decides how many versions that took, so no number is asked for. */
const saved = async (page: Page, atLeast: number) => {
  await expect(page.getByTestId('canvas-status')).toHaveText(/Saved · v\d+/);
  await expect
    .poll(async () => Number(/v(\d+)/.exec((await page.getByTestId('canvas-status').textContent()) ?? '')?.[1] ?? 0))
    .toBeGreaterThanOrEqual(atLeast);
};

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

test('adds text and a link from the toolbar, and undo and redo go through the server', async ({ page, context }) => {
  const artifact = await open(page, context);
  const toolbar = page.getByTestId('canvas-toolbar');

  await toolbar.getByRole('button', { name: '+ Text' }).click();
  const editor = page.getByTestId('canvas-view').locator('textarea');
  await expect(editor).toBeFocused();
  await editor.fill('Written in the browser');
  await editor.blur();
  await expect.poll(async () => (await readCanvas(artifact.id)).nodes.some((n) => n.text === 'Written in the browser')).toBe(true);
  await saved(page, 2);
  let doc = await readCanvas(artifact.id);
  const added = doc.nodes.find((n) => n.text === 'Written in the browser');
  expect(added).toBeTruthy();
  // On screen where the owner was looking, not stacked on anything.
  await expect(page.getByText('Written in the browser')).toBeInViewport();

  await toolbar.getByRole('button', { name: '+ Link' }).click();
  await page.getByLabel('Link address').fill('https://jsoncanvas.org/spec');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(async () => (await readCanvas(artifact.id)).nodes.some((n) => n.url === 'https://jsoncanvas.org/spec')).toBe(true);
  // A private canvas links straight out, as private Markdown does.
  await expect(page.getByRole('link', { name: 'https://jsoncanvas.org/spec' })).toHaveAttribute('href', 'https://jsoncanvas.org/spec');

  await saved(page, 3);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await readCanvas(artifact.id)).nodes.some((n) => n.url === 'https://jsoncanvas.org/spec')).toBe(false);
  // Undo took back the link only; the text is still there.
  doc = await readCanvas(artifact.id);
  expect(doc.nodes.some((n) => n.text === 'Written in the browser')).toBe(true);

  await saved(page, 4);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(async () => (await readCanvas(artifact.id)).nodes.some((n) => n.url === 'https://jsoncanvas.org/spec')).toBe(true);
});

test('a group is a real parent: its members follow while it is dragged', async ({ page, context }) => {
  const artifact = await open(page, context);
  const label = page.getByTestId('canvas-view').getByText('Launch plan', { exact: true });
  const before = (await node(page, 'n1').boundingBox())!;
  const start = (await label.boundingBox())!;
  await page.mouse.move(start.x + 5, start.y + 5);
  await page.mouse.down();
  await page.mouse.move(start.x + 85, start.y + 105, { steps: 10 });
  // Still dragging: the member has already moved with it.
  const during = (await node(page, 'n1').boundingBox())!;
  expect(during.x - before.x).toBeGreaterThan(40);
  expect(during.y - before.y).toBeGreaterThan(40);
  await page.mouse.up();
  await saved(page, 2);
  const doc = await readCanvas(artifact.id);
  const g1 = doc.nodes.find((n) => n.id === 'g1')!;
  const n1 = doc.nodes.find((n) => n.id === 'n1')!;
  expect(g1.x).toBeGreaterThan(0);
  // The member kept its place inside the group.
  expect({ dx: n1.x - g1.x, dy: n1.y - g1.y }).toEqual({ dx: 40, dy: 60 });
  // Something not in the group stayed put.
  expect(doc.nodes.find((n) => n.id === 'n3')).toMatchObject({ x: 900, y: 60 });
});

test('connects the sides the owner chose', async ({ page, context }) => {
  const artifact = await open(page, context);
  await node(page, 'n1').hover();
  const from = (await node(page, 'n1').getByTestId('handle-bottom').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await node(page, 'n3').hover({ force: true }).catch(() => undefined);
  const to = (await node(page, 'n3').getByTestId('handle-top').boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
  await saved(page, 2);
  const doc = await readCanvas(artifact.id);
  expect(doc.edges).toContainEqual(expect.objectContaining({ fromNode: 'n1', toNode: 'n3', fromSide: 'bottom', toSide: 'top' }));
});

test('deletes with the keyboard, and undo brings back the node and its edge', async ({ page, context }) => {
  const artifact = await open(page, context);
  await node(page, 'n2').click();
  await page.keyboard.press('Delete');
  await saved(page, 2);
  let doc = await readCanvas(artifact.id);
  expect(doc.nodes.map((n) => n.id)).not.toContain('n2');
  expect(doc.edges).toHaveLength(0);

  await page.keyboard.press('Control+z');
  await saved(page, 3);
  doc = await readCanvas(artifact.id);
  expect(doc.nodes.find((n) => n.id === 'n2')).toMatchObject({ text: 'Measure React Flow', x: 400, y: 60 });
  expect(doc.edges.map((e) => e.id)).toEqual(['e1']);
});

test('deleting a group leaves what was inside it', async ({ page, context }) => {
  const artifact = await open(page, context);
  await page.getByTestId('canvas-view').getByText('Launch plan', { exact: true }).click();
  await page.keyboard.press('Delete');
  await saved(page, 2);
  const doc = await readCanvas(artifact.id);
  expect(doc.nodes.map((n) => n.id).sort()).toEqual(['n1', 'n2', 'n3']);
});

test('resizes a node from its corner', async ({ page, context }) => {
  const artifact = await open(page, context);
  await node(page, 'n3').click();
  const corner = node(page, 'n3').locator('.react-flow__resize-control.bottom.right');
  const box = (await corner.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 60, { steps: 10 });
  await page.mouse.up();
  await saved(page, 2);
  const n3 = (await readCanvas(artifact.id)).nodes.find((n) => n.id === 'n3')!;
  expect(n3.width).toBeGreaterThan(220);
  expect(n3.height).toBeGreaterThan(90);
  expect(n3).toMatchObject({ x: 900, y: 60 });
});

test('wraps the selected node in a new group', async ({ page, context }) => {
  const artifact = await open(page, context);
  await node(page, 'n3').click();
  await page.getByTestId('canvas-toolbar').getByRole('button', { name: '+ Group' }).click();
  await page.getByLabel('Group name').fill('Later');
  await page.getByLabel('Group name').press('Enter');
  await expect.poll(async () => (await readCanvas(artifact.id)).nodes.some((n) => n.type === 'group' && n.label === 'Later')).toBe(true);
  const doc = await readCanvas(artifact.id);
  const group = doc.nodes.find((n) => n.type === 'group' && n.label === 'Later')!;
  const n3 = doc.nodes.find((n) => n.id === 'n3')!;
  expect(group.x).toBeLessThan(n3.x);
  expect(group.x + group.width).toBeGreaterThan(n3.x + n3.width);
});

test('adds a Kite document as a styled Markdown preview', async ({ page, context }) => {
  await server.publish({ type: 'markdown', content: '# Notes for the plan\n\nSome **bold** words.', title: 'Plan notes' });
  const artifact = await open(page, context);
  await page.getByTestId('canvas-toolbar').getByRole('button', { name: '+ Document' }).click();
  await page.getByLabel('Preview').check();
  await page.getByTestId('kite-picker-list').getByRole('button', { name: /Plan notes/ }).click();
  await saved(page, 2);
  const doc = await readCanvas(artifact.id);
  const kite = doc.nodes.find((n) => n.kite?.kind === 'kite')!;
  expect(kite.kite).toMatchObject({ view: 'preview' });
  const preview = page.getByTestId('canvas-markdown-preview');
  await expect(preview.locator('h1')).toHaveText('Notes for the plan');
  // Set in the app's own prose styles, not unstyled text.
  expect(await preview.locator('strong').evaluate((el) => getComputedStyle(el).fontWeight)).toMatch(/^(600|700|bold)$/);
  expect(await preview.locator('h1').evaluate((el) => getComputedStyle(el).fontWeight)).not.toBe('400');
});

test('comments on a node, marks it, and shows when the node changed or went', async ({ page, context }) => {
  const artifact = await open(page, context);
  await node(page, 'n3').click();
  await page.getByTestId('canvas-toolbar').getByRole('button', { name: 'Comment' }).click();
  await page.getByTestId('canvas-composer').locator('textarea').fill('Is this in scope?');
  await page.getByTestId('canvas-composer').getByRole('button', { name: 'Send' }).click();
  const marker = node(page, 'n3').getByTestId('canvas-comment-marker');
  await expect(marker).toHaveText('1');
  await expect(marker).toHaveAttribute('data-drifted', 'false');
  await expect(page.getByText('Is this in scope?')).toBeVisible();

  // The agent rewrites the node: the comment stays, flagged as drifted.
  let version = (await readCanvas(artifact.id)).kite.version;
  await server.as(`/api/artifacts/${artifact.id}/canvas/ops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: version, ops: [{ op: 'update', id: 'n3', set: { text: 'Rewritten' } }] }),
  });
  await page.reload();
  await expect(node(page, 'n3').getByTestId('canvas-comment-marker')).toHaveAttribute('data-drifted', 'true');

  // Then deletes it: the canvas says a comment lost its node.
  version = (await readCanvas(artifact.id)).kite.version;
  await server.as(`/api/artifacts/${artifact.id}/canvas/ops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: version, ops: [{ op: 'delete', id: 'n3' }] }),
  });
  await page.reload();
  await expect(page.getByTestId('canvas-lost-comments')).toHaveText('1 comment lost its node');
});
