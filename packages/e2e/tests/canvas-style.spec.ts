import { test, expect, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * Styling a canvas in the browser: the style panel, the icon picker and the
 * theme each end up on the server as canvas operations, and what is drawn
 * follows what was stored.
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
    { id: 'n1', type: 'text', x: 0, y: 0, width: 220, height: 90, text: 'API server' },
    { id: 'n2', type: 'text', x: 400, y: 0, width: 220, height: 90, text: 'Database' },
    { id: 'n3', type: 'text', x: 0, y: 300, width: 220, height: 90, text: 'Left alone' },
  ],
  edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2', label: 'reads' }],
};

interface Doc {
  nodes: Array<{ id: string; color?: string; kite?: { style?: Record<string, unknown>; icon?: { name: string; position?: string; size?: number } } }>;
  edges: Array<{ id: string; color?: string; toEnd?: string; kite?: { style?: Record<string, unknown> } }>;
  kite: { version: number; theme?: Record<string, unknown>; assets?: Record<string, { svg: string; name?: string }> };
}

async function readCanvas(id: string): Promise<Doc> {
  return (await (await server.as(`/api/artifacts/${id}/canvas`)).json()) as Doc;
}

async function open(page: Page, context: Parameters<RunningServer['signInBrowser']>[0], board: unknown = BOARD) {
  const artifact = await server.publish({ type: 'canvas', content: JSON.stringify(board) });
  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(page.getByTestId('canvas-view').getByText('API server')).toBeVisible();
  return artifact;
}

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

async function selectBoth(page: Page) {
  await node(page, 'n1').click();
  await page.keyboard.down(modifier);
  await node(page, 'n2').click();
  await page.keyboard.up(modifier);
}

test('restyles several nodes at once from the style panel, in one version', async ({ page, context }) => {
  const artifact = await open(page, context);
  await page.getByTestId('canvas-style-toggle').click();
  const panel = page.getByTestId('canvas-style-panel');
  await expect(panel).toContainText('Nothing is selected');

  await selectBoth(page);
  await expect(panel).toContainText('Style · 2 nodes');
  const fill = panel.getByTestId('style-fill').getByLabel('Colour', { exact: true });
  await fill.fill('#e6f4ff');
  await fill.press('Enter');
  await expect.poll(async () => (await readCanvas(artifact.id)).nodes.filter((n) => n.kite?.style?.fill === '#e6f4ff').map((n) => n.id)).toEqual(['n1', 'n2']);
  expect((await readCanvas(artifact.id)).kite.version).toBe(2);
  await expect(node(page, 'n1').locator('.kite-node')).toHaveCSS('background-color', 'rgb(230, 244, 255)');
  await expect(node(page, 'n3').locator('.kite-node')).not.toHaveCSS('background-color', 'rgb(230, 244, 255)');

  await panel.getByTestId('style-font').selectOption('mono');
  await panel.getByTestId('style-radius').fill('16');
  await panel.getByTestId('style-radius').press('Enter');
  await panel.getByTestId('style-textAlign').getByRole('button', { name: 'Centre' }).click();
  await expect
    .poll(async () => (await readCanvas(artifact.id)).nodes.find((n) => n.id === 'n2')?.kite?.style)
    .toEqual({ fill: '#e6f4ff', font: 'mono', radius: 16, textAlign: 'center' });
  await expect(node(page, 'n2').locator('.kite-node')).toHaveCSS('border-radius', '16px');
  await expect(node(page, 'n2').getByText('Database')).toHaveCSS('font-family', /JetBrains Mono Variable/);

  // And back to the theme, also for both at once.
  await panel.getByTestId('style-reset').click();
  await expect.poll(async () => (await readCanvas(artifact.id)).nodes.some((n) => n.kite?.style)).toBe(false);
});

test('puts a Lucide icon on the selection, found by searching', async ({ page, context }) => {
  const artifact = await open(page, context);
  await page.getByTestId('canvas-style-toggle').click();
  await selectBoth(page);
  await page.getByTestId('style-icon-choose').click();
  const picker = page.getByTestId('icon-picker');
  await picker.getByLabel('Search icons').fill('database');
  await picker.locator('[data-icon-name="database"]').click();
  await picker.getByRole('button', { name: 'Above text' }).click();
  await page.getByTestId('icon-apply').click();
  await expect
    .poll(async () => (await readCanvas(artifact.id)).nodes.filter((n) => n.kite?.icon).map((n) => [n.id, n.kite!.icon]))
    .toEqual([
      ['n1', { name: 'lucide:database', position: 'top' }],
      ['n2', { name: 'lucide:database', position: 'top' }],
    ]);
  await expect(node(page, 'n1').locator('[data-icon="lucide:database"] svg')).toBeVisible();

  // A reader sees it too, after a fresh load.
  await page.reload();
  await expect(node(page, 'n2').locator('[data-icon="lucide:database"] svg path').first()).toBeAttached();
});

test('adds a pasted SVG as a sanitised icon, shown as an image', async ({ page, context }) => {
  const artifact = await open(page, context);
  await page.getByTestId('canvas-style-toggle').click();
  await node(page, 'n1').click();
  await page.getByTestId('style-icon-choose').click();
  await page.getByRole('tab', { name: 'Custom SVG' }).click();

  await page.getByTestId('icon-svg-paste').fill('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await expect(page.getByTestId('icon-svg-problem')).toContainText('Nothing is left to draw');
  await expect(page.getByTestId('icon-apply')).toBeDisabled();

  let alerted = false;
  page.on('dialog', async (dialog) => {
    alerted = true;
    await dialog.dismiss();
  });
  await page
    .getByTestId('icon-svg-paste')
    .fill('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="alert(1)"><script>alert(2)</script><circle cx="12" cy="12" r="10" fill="#30a46c"/><image href="https://example.com/x.png"/></svg>');
  await expect(page.getByTestId('icon-svg-preview').locator('img')).toBeVisible();
  await page.getByTestId('icon-apply').click();

  await expect.poll(async () => Object.values((await readCanvas(artifact.id)).kite.assets ?? {}).length).toBe(1);
  const doc = await readCanvas(artifact.id);
  const [id, asset] = Object.entries(doc.kite.assets!)[0]!;
  expect(asset.svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#30a46c"/></svg>');
  expect(doc.nodes.find((n) => n.id === 'n1')?.kite?.icon?.name).toBe(`asset:${id}`);
  const image = node(page, 'n1').locator(`[data-icon="asset:${id}"] img`);
  await expect(image).toHaveAttribute('src', /^data:image\/svg\+xml/);
  // Never markup in the page: no svg element inside the node from the custom icon.
  await expect(node(page, 'n1').locator(`[data-icon="asset:${id}"] svg`)).toHaveCount(0);
  expect(alerted).toBe(false);

  // The next node can reuse it without adding it again.
  await node(page, 'n2').click();
  await page.getByTestId('style-icon-choose').click();
  await page.getByRole('tab', { name: 'Custom SVG' }).click();
  await page.getByTestId('icon-assets').getByRole('button').first().click();
  await page.getByTestId('icon-apply').click();
  await expect.poll(async () => (await readCanvas(artifact.id)).nodes.find((n) => n.id === 'n2')?.kite?.icon?.name).toBe(`asset:${id}`);
  expect(Object.keys((await readCanvas(artifact.id)).kite.assets ?? {})).toEqual([id]);
});

test('styles an edge and sets the canvas theme', async ({ page, context }) => {
  const artifact = await open(page, context);
  await page.getByTestId('canvas-style-toggle').click();
  const panel = page.getByTestId('canvas-style-panel');

  // The middle of the line, which runs straight across between the two cards.
  const line = (await page.locator('.react-flow__edge[data-id="e1"] path.react-flow__edge-path').boundingBox())!;
  await page.mouse.click(line.x + line.width / 4, line.y + line.height / 2);
  await expect(panel).toContainText('Style · 1 edge');
  await panel.getByTestId('style-edge-curve').getByRole('button', { name: 'Step' }).click();
  await panel.getByTestId('style-edge-line').selectOption('dashed');
  await panel.getByTestId('style-edge-end').click();
  const colour = panel.getByTestId('style-edge-color').getByLabel('Colour', { exact: true });
  await colour.fill('5');
  await colour.press('Enter');
  await expect
    .poll(async () => {
      const edge = (await readCanvas(artifact.id)).edges[0]!;
      return { color: edge.color, toEnd: edge.toEnd, style: edge.kite?.style };
    })
    .toEqual({ color: '5', toEnd: 'none', style: { curve: 'step', line: 'dashed' } });
  await expect(page.locator('.react-flow__edge[data-id="e1"] path.react-flow__edge-path')).toHaveCSS('stroke', 'rgb(0, 144, 255)');

  // Nothing selected: the panel is the theme.
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 300 } });
  await expect(panel).toContainText('Nothing is selected');
  await panel.getByTestId('theme-grid').selectOption('lines');
  const background = panel.getByTestId('theme-background').getByLabel('Colour', { exact: true });
  await background.fill('#fafaf7');
  await background.press('Enter');
  await panel.getByTestId('theme-node-font').selectOption('grotesk');
  await expect
    .poll(async () => (await readCanvas(artifact.id)).kite.theme)
    .toEqual({ grid: 'lines', background: '#fafaf7', node: { font: 'grotesk' } });
  await expect(page.getByTestId('canvas-flow')).toHaveCSS('background-color', 'rgb(250, 250, 247)');
  await expect(node(page, 'n3').getByText('Left alone')).toHaveCSS('font-family', /Space Grotesk Variable/);

  // The strict export is plain JSON Canvas: none of this is in it.
  const strict = await (await server.as(`/api/artifacts/${artifact.id}/canvas?format=jsoncanvas-strict`)).json();
  expect(JSON.stringify(strict)).not.toContain('kite');
});
