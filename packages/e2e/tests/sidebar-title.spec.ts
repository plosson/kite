import { test, expect, type Locator, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * A sidebar title too long for its row slides into view on hover, and one that
 * fits stays put.
 */

let server: RunningServer;
const SHOTS = process.env.KITE_SHOTS;
const LONG = 'IDA Pro Headless, part 2: installer, release and distribution';

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

function row(page: Page, id: string): Locator {
  return page.locator(`[data-artifact-id="${id}"]`).first();
}

/**
 * How far the end of the text sits past the right edge of the box that clips
 * it. Zero or less means it is all in view. Measured from where the text
 * starts on screen plus its full width, because while the ellipsis shows, the
 * line's own box is only as wide as the space it is cut to.
 */
async function overhang(title: Locator): Promise<number> {
  return title.evaluate((line) => {
    const box = line.parentElement!.getBoundingClientRect();
    return line.getBoundingClientRect().left + line.scrollWidth - box.right;
  });
}

/** How far the text has moved left of where it starts at rest. */
async function shift(title: Locator): Promise<number> {
  return title.evaluate(
    (line) => Math.round(line.getBoundingClientRect().left - line.parentElement!.getBoundingClientRect().left),
  );
}

test('a long title slides until its end is in view, and slides back when the pointer leaves', async ({ page, context }) => {
  const doc = await server.publish({ type: 'markdown', content: `# ${LONG}` });
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);

  const title = row(page, doc.id).locator('[data-slides="true"]');
  await expect(title).toHaveCount(1);
  expect(await shift(title)).toBe(0);
  expect(await overhang(title)).toBeGreaterThan(20);

  await row(page, doc.id).hover();
  // A pointer passing over does not set it moving straight away.
  await page.waitForTimeout(150);
  expect(await shift(title)).toBe(0);

  await expect.poll(() => overhang(title), { timeout: 8000 }).toBeLessThanOrEqual(1);
  expect(await shift(title)).toBeLessThan(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/slid.png`, clip: { x: 0, y: 0, width: 300, height: 260 } });

  await page.mouse.move(900, 500);
  await expect.poll(() => shift(title)).toBe(0);
});

test('a title that fits never moves', async ({ page, context }) => {
  const doc = await server.publish({ type: 'markdown', content: '# Short' });
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);

  await expect(row(page, doc.id).locator('[data-slides]')).toHaveCount(0);
  await row(page, doc.id).hover();
  await page.waitForTimeout(800);
  expect(await shift(row(page, doc.id).getByText('Short'))).toBe(0);
});

test('with reduced motion the end of the title still comes into view, without sliding', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const doc = await server.publish({ type: 'markdown', content: `# ${LONG}` });
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);

  const title = row(page, doc.id).locator('[data-slides="true"]');
  expect(await overhang(title)).toBeGreaterThan(20);
  await row(page, doc.id).hover();
  await expect.poll(() => overhang(title), { timeout: 1500 }).toBeLessThanOrEqual(1);
  await context.close();
});
