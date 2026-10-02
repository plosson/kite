import { test, expect } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * What a document says about itself, above the document: the description
 * always, the summary on request, and nothing at all for a document that has
 * neither.
 */

let server: RunningServer;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

const about = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'About this document' });

test('shows the description, and the summary only when asked, keeping its lines', async ({ page, context }) => {
  const kite = await server.publish({
    type: 'markdown',
    content: '# Launch plan\n\nBody text.',
    description: 'How and when we launch in March.',
    summary: 'Launch on the 12th.\nMarketing starts a week before.',
  });
  await server.signInBrowser(context);
  await page.goto(kite.url);

  await expect(about(page)).toContainText('How and when we launch in March.');
  await expect(page.getByText('Launch on the 12th.')).toHaveCount(0);

  const toggle = about(page).getByRole('button', { name: 'Summary' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();

  const summary = page.locator('#document-summary');
  await expect(summary).toBeVisible();
  // Two lines stay two lines, not one run-on sentence.
  const height = await summary.evaluate((el) => el.getBoundingClientRect().height);
  const line = await summary.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  expect(height).toBeGreaterThan(line * 1.5);

  await about(page).getByRole('button', { name: 'Hide summary' }).click();
  await expect(summary).toHaveCount(0);
});

test('shows nothing for a document published before descriptions existed', async ({ page, context }) => {
  const kite = await server.publish({ type: 'markdown', content: '# Old note\n\nBody text.' });
  server.forgetDescription(kite.id);
  await server.signInBrowser(context);
  await page.goto(kite.url);

  await expect(page.getByText('Body text.')).toBeVisible();
  await expect(about(page)).toHaveCount(0);
});

test('renders a description as text, never as markup', async ({ page, context }) => {
  const kite = await server.publish({
    type: 'html',
    content: '<h1>Page</h1>',
    description: '<img src=x onerror="window.__pwned=1"> literally',
    summary: '<b>not bold</b>',
  });
  await server.signInBrowser(context);
  await page.goto(kite.url);

  await expect(about(page)).toContainText('<img src=x onerror="window.__pwned=1"> literally');
  await about(page).getByRole('button', { name: 'Summary' }).click();
  await expect(page.locator('#document-summary')).toHaveText('<b>not bold</b>');
  expect(await about(page).locator('img, b').count()).toBe(0);
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
});

test('a reader with no account sees it on a public document', async ({ page }) => {
  const kite = await server.publish({
    type: 'markdown',
    content: '# Open\n\nBody.',
    description: 'Shared with the world on purpose.',
  });
  await server.as(`/api/artifacts/${kite.id}/sharing/public`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isPublic: true }),
  });
  await page.goto(kite.url);

  await expect(about(page)).toContainText('Shared with the world on purpose.');
});
