import { test, expect, type Browser, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * Who opened a document, as its owner sees it: a count in the list, and the
 * Views panel on the document. A reader opening it in a real browser is the
 * thing being counted, so that part is a real browser too.
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

test('the owner sees who opened a document, their own opens included', async ({ page, context, browser }) => {
  const artifact = await server.publish({ type: 'markdown', content: '# Launch plan\n\nDraft.', title: 'Launch plan' });
  const colleague = await browserFor(browser, 'colleague@example.com');
  await server.as(`/api/artifacts/${artifact.id}/sharing/people`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'colleague@example.com' }),
  });

  await colleague.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(colleague.getByRole('heading', { name: 'Launch plan' }).first()).toBeVisible();
  // A reader is not offered somebody else's numbers.
  await expect(colleague.getByRole('button', { name: 'Views', exact: true })).toHaveCount(0);

  await server.signInBrowser(context);
  await page.goto(server.baseUrl);
  await expect(page.getByTestId('view-count')).toContainText('1');

  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await page.getByRole('button', { name: 'Views', exact: true }).click();
  const panel = page.getByTestId('views-panel');
  await expect(panel).toContainText('colleague@example.com');
  await expect(panel).toContainText('Invited');
  // Opening the page just now was a view too, labelled as theirs.
  await expect(panel).toContainText('You');
  await expect(panel).toContainText('1 by you · 1 by others');
  await expect(panel).toContainText('0 reads by agents');

  // Back in the list, the owner's own open is in the count.
  await page.goto(server.baseUrl);
  await expect(page.getByTestId('view-count')).toContainText('2');
});
