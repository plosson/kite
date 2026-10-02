import { test, expect, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * The dashboard's list and timeline: descriptions in the list, and a timeline
 * that keeps its scale inside a burst of work and cuts the quiet between them.
 */

let server: RunningServer;
const SHOTS = process.env.KITE_SHOTS;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

const HOUR = 3_600_000;
const base = Date.parse('2026-09-28T09:00:00.000Z');
const hoursAfter = (hours: number) => new Date(base + hours * HOUR).toISOString();

/** Two bursts of work three days apart: publish and two edits, then a publish and an edit. */
async function seed() {
  const plan = await server.publish({
    type: 'markdown',
    content: '# Launch plan\n\nDraft.',
    description: 'How and when we launch in March.',
  });
  await server.update({ id: plan.id, content: '# Launch plan\n\nSecond draft.', baseVersion: 1 });
  await server.update({ id: plan.id, content: '# Launch plan\n\nThird draft.', baseVersion: 2 });
  const notes = await server.publish({ type: 'html', content: '<h1>Board notes</h1>', description: 'What the board asked.' });
  await server.update({ id: notes.id, content: '<h1>Board notes</h1><p>More.</p>', baseVersion: 1 });

  server.stampVersion(plan.id, 1, hoursAfter(0));
  server.stampVersion(plan.id, 2, hoursAfter(0.5));
  server.stampVersion(plan.id, 3, hoursAfter(2));
  server.stampVersion(notes.id, 1, hoursAfter(74));
  server.stampVersion(notes.id, 2, hoursAfter(75));
  return { plan, notes };
}

async function open(page: Page, context: Parameters<RunningServer['signInBrowser']>[0]) {
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);
}

test('the list shows each document\'s description under its title', async ({ page, context }) => {
  await seed();
  await open(page, context);
  await expect(page.getByText('How and when we launch in March.')).toBeVisible();
  await expect(page.getByText('What the board asked.')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/list.png` });
});

test('the timeline cuts the quiet between bursts and keeps the scale inside one', async ({ page, context }) => {
  await seed();
  await open(page, context);
  await page.getByRole('button', { name: 'timeline' }).click();

  const timeline = page.getByRole('list', { name: 'Timeline' });
  const rows = timeline.getByRole('listitem');
  // Newest first: the board notes burst, a gap, then the launch plan burst.
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(0)).toContainText('Board notes');
  await expect(rows.nth(0)).toContainText('Edited · version 2');
  await expect(rows.nth(2)).toHaveAttribute('aria-label', '3 days with nothing');
  await expect(rows.nth(5)).toContainText('Published');

  // Inside the first burst, 1.5 hours apart sits further than half an hour apart.
  const top = async (index: number) => (await rows.nth(index).boundingBox())!.y;
  const longer = (await top(4)) - (await top(3));
  const shorter = (await top(5)) - (await top(4));
  expect(longer).toBeGreaterThan(shorter);

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/timeline.png` });
});

test('the chosen view survives a reload', async ({ page, context }) => {
  await seed();
  await open(page, context);
  await page.getByRole('button', { name: 'timeline' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'timeline' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('list', { name: 'Timeline' })).toBeVisible();
});

test('an event opens its document', async ({ page, context }) => {
  const { notes } = await seed();
  await open(page, context);
  await page.getByRole('button', { name: 'timeline' }).click();
  await page.getByRole('list', { name: 'Timeline' }).getByRole('link', { name: /Board notes/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/a/${notes.slug}$`));
});

test('the timeline fits a phone without scrolling sideways', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed();
  await open(page, context);
  await page.getByRole('button', { name: 'timeline' }).click();
  await expect(page.getByRole('list', { name: 'Timeline' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/timeline-phone.png` });
});
