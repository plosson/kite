import { test, expect, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * Diagram blocks in Markdown kites, drawn in sandboxed frames.
 *
 * Most of what follows is about what a diagram must never do: run a script,
 * reach the reader's session, read the page around it, or blow its own box up.
 */

let server: RunningServer;
const SHOTS = process.env.KITE_SHOTS;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

async function open(page: Page, content: string): Promise<void> {
  const kite = await server.publish({ type: 'markdown', content });
  await server.signInBrowser(page.context());
  await page.goto(`${server.baseUrl}/a/${kite.slug}`);
  await expect(page.locator('article.prose')).toBeVisible();
}

const frames = (page: Page) => page.locator('article.prose iframe.kite-diagram-frame');

async function frameHeight(page: Page, index = 0): Promise<number> {
  return frames(page).nth(index).evaluate((frame) => frame.getBoundingClientRect().height);
}

test('a mermaid block is drawn as a diagram in a sandboxed frame', async ({ page }) => {
  await open(page, '# Plan\n\n```mermaid\ngraph TD\n  Publish --> Read\n  Read --> Comment\n```\n\nAfter the diagram.');

  const frame = frames(page).first();
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(page.frameLocator('iframe.kite-diagram-frame').locator('svg')).toBeVisible();
  await expect(page.frameLocator('iframe.kite-diagram-frame').getByText('Publish')).toBeVisible();
  // Sized to the diagram, not left at its placeholder height.
  await expect.poll(() => frameHeight(page)).toBeGreaterThan(60);
  // The source is not shown as code next to it.
  await expect(page.locator('article.prose code.language-mermaid')).toBeHidden();
  await expect(page.getByText('After the diagram.')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/mermaid.png` });
});

test('an svg block is drawn, without its scripts, event handlers or links', async ({ page }) => {
  await open(
    page,
    [
      '```svg',
      '<svg viewBox="0 0 200 60" xmlns="http://www.w3.org/2000/svg">',
      '<rect width="200" height="60" fill="#4f5bd5"/>',
      '<text x="20" y="35" fill="white">Hello</text>',
      '<circle r="5" onload="parent.postMessage({type:\'kite-diagram\',kind:\'size\',height:3999},\'*\')"/>',
      '<script>parent.postMessage({type:"kite-diagram",kind:"size",height:3998},"*")</script>',
      '<a href="https://example.com/phish"><text x="100" y="35">Click</text></a>',
      '</svg>',
      '```',
    ].join('\n'),
  );

  const inside = page.frameLocator('iframe.kite-diagram-frame');
  await expect(inside.locator('svg rect')).toBeVisible();
  await expect(inside.locator('svg script')).toHaveCount(0);
  await expect(inside.locator('svg a')).toHaveCount(0);
  expect(await inside.locator('svg circle').getAttribute('onload')).toBeNull();
  // Had either script run, the frame would have claimed a height near 4000.
  await page.waitForTimeout(500);
  expect(await frameHeight(page)).toBeLessThan(400);
});

test('a diagram cannot reach the reader\'s session or the page around it', async ({ page }) => {
  await open(page, '```svg\n<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n```');
  await expect(page.frameLocator('iframe.kite-diagram-frame').locator('svg rect')).toBeVisible();

  const frame = page.frames().find((candidate) => candidate.url().endsWith('/diagram-frame.html'));
  expect(frame).toBeDefined();
  const reach = await frame!.evaluate(() => {
    const attempt = (fn: () => unknown) => {
      try {
        fn();
        return 'reached';
      } catch {
        return 'blocked';
      }
    };
    return {
      cookie: attempt(() => document.cookie),
      storage: attempt(() => window.localStorage.length),
      parentDocument: attempt(() => window.parent.document.title),
      origin: window.origin,
    };
  });
  expect(reach).toEqual({ cookie: 'blocked', storage: 'blocked', parentDocument: 'blocked', origin: 'null' });
});

test('a diagram that cannot be drawn shows its source and says so', async ({ page }) => {
  await open(page, '```mermaid\nthis is not a diagram at all ->->\n```');
  await expect(page.getByText(/This diagram could not be drawn/)).toBeVisible();
  await expect(page.locator('article.prose code.language-mermaid')).toBeVisible();
  await expect(frames(page)).toHaveCount(0);
});

test('an svg block with no svg in it shows its source', async ({ page }) => {
  await open(page, '```svg\n<p>not an svg</p>\n```');
  await expect(page.getByText(/There is no SVG in this block/)).toBeVisible();
  await expect(page.locator('article.prose code.language-svg')).toBeVisible();
});

test('a frame cannot grow past its ceiling, however tall the diagram says it is', async ({ page }) => {
  await open(page, '```svg\n<svg viewBox="0 0 10 2000" width="10" height="20000"><rect width="10" height="2000"/></svg>\n```');
  await expect(page.frameLocator('iframe.kite-diagram-frame').locator('svg rect')).toBeAttached();
  await expect.poll(() => frameHeight(page)).toBeGreaterThan(100);
  expect(await frameHeight(page)).toBeLessThanOrEqual(4000);
});

test('several diagrams on one page are each drawn in their own frame', async ({ page }) => {
  const block = (label: string) => `\`\`\`mermaid\ngraph LR\n  ${label}A --> ${label}B\n\`\`\``;
  await open(page, [block('one'), block('two'), block('three')].join('\n\nText.\n\n'));
  await expect(frames(page)).toHaveCount(3);
  for (const label of ['oneA', 'twoA', 'threeA']) {
    await expect(page.frameLocator(`iframe.kite-diagram-frame >> nth=${['oneA', 'twoA', 'threeA'].indexOf(label)}`).getByText(label)).toBeVisible();
  }
});

test('while editing, a diagram block shows its source, and comes back drawn after', async ({ page }) => {
  await open(page, '# Doc\n\n```mermaid\ngraph TD\n  A --> B\n```\n');
  await expect(frames(page)).toHaveCount(1);

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(frames(page)).toHaveCount(0);
  await expect(page.locator('article.prose code.language-mermaid')).toBeVisible();

  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(frames(page)).toHaveCount(1);
});

test('an ordinary code block is still shown as code', async ({ page }) => {
  await open(page, '```js\nconst answer = 42;\n```');
  await expect(frames(page)).toHaveCount(0);
  await expect(page.locator('article.prose code.language-js')).toBeVisible();
});
