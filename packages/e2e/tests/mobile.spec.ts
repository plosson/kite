import { test, expect, devices, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * Kite on a phone, in a real browser at phone size with a touch screen.
 *
 * The sidebar and the comments panel each take the whole screen there instead of
 * a column beside the document, so most of what can go wrong is one of them
 * covering the page when it should not, or staying open when it should have
 * closed. The rest is touch: a long press never sends the mouseup a desk does.
 */

// Chromium standing in for Safari: the device's own browser type cannot be
// switched per file, and the layout and touch behaviour are what is under test.
const { defaultBrowserType, ...iPhone } = devices['iPhone 13'];
void defaultBrowserType;
test.use(iPhone);

let server: RunningServer;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

/** Nothing on the page is wider than the screen, so it never scrolls sideways. */
async function expectNoSidewaysScroll(page: Page) {
  const [scrollWidth, innerWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

test('the sidebar is a drawer that starts closed and closes once somewhere is chosen', async ({ page, context }) => {
  const kite = await server.publish({ type: 'markdown', content: '# Field notes\n\nText.' });
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);

  // The list is the page itself, not hidden behind a drawer nobody opened.
  await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toHaveCount(0);
  await expectNoSidewaysScroll(page);

  await page.getByRole('button', { name: 'Show sidebar' }).tap();
  const drawer = page.locator(`aside [data-artifact-id="${kite.id}"]`);
  await expect(drawer).toBeVisible();

  await drawer.tap();
  await expect(page).toHaveURL(`${server.baseUrl}/a/${kite.slug}`);
  // Arriving is the end of what the drawer was for.
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toHaveCount(0);
  await expect(page.locator('article').getByRole('heading', { name: 'Field notes' })).toBeVisible();
});

test('the drawer closes on the backdrop and on Escape, not only by its button', async ({ page, context }) => {
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);

  await page.getByRole('button', { name: 'Show sidebar' }).tap();
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toBeVisible();
  // Far right, which is backdrop and not drawer.
  await page.touchscreen.tap(380, 400);
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Show sidebar' }).tap();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toHaveCount(0);
});

test('opening comments on a phone does not change what a desk remembers', async ({ page, context }) => {
  const kite = await server.publish({ type: 'markdown', content: '# Plan\n\nWords.' });
  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${kite.slug}`);
  await expect(page.locator('article').getByRole('heading', { name: 'Plan' })).toBeVisible();

  // Closed to start with: open, it would cover the document entirely.
  await expect(page.getByRole('button', { name: 'Hide comments' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show comments' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Comments' }).tap();
  await expect(page.getByRole('button', { name: 'Hide comments' })).toBeVisible();
  await page.getByRole('button', { name: 'Hide comments' }).tap();

  const stored = await page.evaluate(() => [
    localStorage.getItem('oa.comments.collapsed'),
    localStorage.getItem('oa.sidebar.collapsed'),
  ]);
  expect(stored).toEqual([null, null]);

  // And a reload is closed again, rather than remembering the phone's choice.
  await page.getByRole('button', { name: 'Comments' }).tap();
  await page.reload();
  await expect(page.locator('article').getByRole('heading', { name: 'Plan' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide comments' })).toHaveCount(0);
});

test('selecting text by touch offers a comment, and the composer survives losing the selection', async ({ page, context }) => {
  const kite = await server.publish({
    type: 'markdown',
    content: '# Review\n\nThe budget doubles next quarter without explanation.',
  });
  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${kite.slug}`);
  await expect(page.getByText('The budget doubles')).toBeVisible();

  // What a long press and its handles leave behind: a selection, and no mouseup.
  await page.evaluate(() => {
    const text = document.querySelector('article p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 18);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });

  await page.getByRole('button', { name: 'Comment', exact: true }).tap();
  const box = page.getByPlaceholder('Comment on this');
  await expect(box).toBeFocused();

  // Focus moving into the box drops the selection. Wait out the settle delay,
  // so a composer that closed on it would be gone by now.
  await expect.poll(() => page.evaluate(() => getSelection()!.isCollapsed)).toBe(true);
  await page.waitForTimeout(600);
  await expect(box).toBeVisible();

  await box.fill('Why does it double?');
  await page.getByRole('button', { name: 'Send' }).tap();

  await page.getByRole('button', { name: /Comments/ }).tap();
  await expect(page.getByText('Why does it double?')).toBeVisible();
  await expect(page.getByRole('button', { name: /budget doubles/ })).toBeVisible();
});

test('pressing a quote in the comments sheet gets out of the way of its passage', async ({ page, context }) => {
  const kite = await server.publish({
    type: 'markdown',
    content: '# Memo\n\nShip on Friday after the review.',
  });
  await server.as(`/api/artifacts/${kite.id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      body: 'Which review?',
      position: { headingId: 'memo', snippet: 'after the review', occurrence: 0 },
    }),
  });
  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${kite.slug}`);

  await page.getByRole('button', { name: /Comments/ }).tap();
  await page.getByRole('button', { name: /after the review/ }).tap();

  await expect(page.getByRole('button', { name: 'Hide comments' })).toHaveCount(0);
  await expect(page.locator('mark[data-oa-anchor]')).toHaveText('after the review');
});

test('a public page read signed out keeps its title on screen and does not scroll sideways', async ({ browser }) => {
  const kite = await server.publish({
    type: 'markdown',
    title: 'Launch checklist',
    content: '# Launch checklist\n\n```\nconst aVeryLongLineOfCodeThatIsMuchWiderThanAnyPhoneScreenCouldEverShow = true;\n```\n\n| a | b | c | d | e | f | g | h |\n|---|---|---|---|---|---|---|---|\n| one | two | three | four | five | six | seven | eight |',
  });
  await server.as(`/api/artifacts/${kite.id}/sharing/public`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isPublic: true }),
  });

  const stranger = await browser.newContext(iPhone);
  const page = await stranger.newPage();
  await page.goto(`${server.baseUrl}/a/${kite.slug}`);

  const title = page.getByRole('banner').getByRole('heading', { name: 'Launch checklist' });
  await expect(title).toBeVisible();
  const box = await title.boundingBox();
  // Squeezed to a sliver by the controls beside it is not "visible" to a reader.
  expect(box?.width ?? 0).toBeGreaterThan(60);
  await expectNoSidewaysScroll(page);
  await stranger.close();
});
