import { test, expect, type Browser, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * A document's history, as its owner reads it: the list of versions, an old
 * version read-only under a banner that says so, what changed, and the way
 * back. A reader it is shared with is never offered any of it.
 */

let server: RunningServer;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

async function browserFor(browser: Browser, email: string): Promise<Page> {
  const cookie = await server.signInAs(email);
  const context = await browser.newContext();
  await context.addCookies([
    { name: 'oa_session', value: cookie.split('=').slice(1).join('='), url: server.baseUrl },
  ]);
  return context.newPage();
}

async function update(id: string, content: string, baseVersion: number): Promise<void> {
  const response = await server.as(`/api/artifacts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, baseVersion }),
  });
  expect(response.ok).toBe(true);
}

test('the owner opens an old version, sees what changed, and goes back', async ({ page, context }) => {
  const artifact = await server.publish({
    type: 'markdown',
    content: '# Launch plan\n\nShip on Monday.\n',
    title: 'Launch plan',
  });
  await update(artifact.id, '# Launch plan\n\nShip on Friday.\n\nTell support first.\n', 1);

  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(page.getByText('Ship on Friday.')).toBeVisible();

  await page.getByRole('button', { name: 'History', exact: true }).click();
  const panel = page.getByTestId('history-panel');
  await expect(panel).toContainText('v2');
  await expect(panel).toContainText('Current');
  await expect(panel).toContainText('v1');
  // Opening the page just now was a view of version 2.
  await expect(panel.getByRole('button', { name: /v2/ })).toContainText('1 view');

  await panel.getByRole('button', { name: /v1/ }).click();
  const banner = page.getByTestId('version-banner');
  await expect(banner).toContainText('You’re viewing version 1 of 2');
  await expect(page.getByTestId('version-document')).toContainText('Ship on Monday.');
  // Read-only: no editing while an old version is on screen.
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);

  await page.reload();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByTestId('history-panel').getByRole('button', { name: /v2/ }).click();
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  const changes = page.getByTestId('version-changes');
  await expect(changes).toContainText('Changes from version 1 to version 2');
  await expect(changes.locator('[data-diff="removed"]')).toContainText('Ship on Monday.');
  await expect(changes.locator('[data-diff="added"]').first()).toContainText('Ship on Friday.');

  await page.getByRole('button', { name: 'Back to latest', exact: true }).click();
  await expect(page.getByTestId('version-banner')).toHaveCount(0);
  await expect(page.getByText('Ship on Friday.')).toBeVisible();

  // The old version's open was counted against version 1, the owner's own.
  const views = (await (await server.as(`/api/artifacts/${artifact.id}/views`)).json()) as {
    recent: { version: number; access: string; client: string }[];
  };
  expect(views.recent.some((open) => open.version === 1 && open.access === 'owner' && open.client === 'browser')).toBe(true);
});

test('a reader the document is shared with has no history', async ({ browser }) => {
  const artifact = await server.publish({ type: 'markdown', content: '# Notes\n\nOne.', title: 'Notes' });
  await update(artifact.id, '# Notes\n\nTwo.', 1);
  await server.as(`/api/artifacts/${artifact.id}/sharing/people`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'colleague@example.com' }),
  });

  const colleague = await browserFor(browser, 'colleague@example.com');
  await colleague.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(colleague.getByText('Two.')).toBeVisible();
  await expect(colleague.getByRole('button', { name: 'History', exact: true })).toHaveCount(0);
});
