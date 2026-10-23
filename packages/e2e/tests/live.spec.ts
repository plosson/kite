import { test, expect, type Browser, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * Open documents follow changes as they are made: an agent's write, somebody
 * else's edit in another browser, a new comment, a share taken away. Nothing
 * here reloads a page or waits for a clock; each change is made, and the other
 * browser is expected to show it within a short deadline.
 */

let server: RunningServer;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

/** Short on purpose: a change has to arrive pushed, not be found by checking again later. */
const PROMPTLY = { timeout: 3_000 };

const BOARD = {
  nodes: [
    { id: 'n1', type: 'text', x: 0, y: 0, width: 220, height: 90, text: 'Ship the canvas' },
    { id: 'n2', type: 'text', x: 400, y: 0, width: 220, height: 90, text: 'Measure React Flow' },
  ],
  edges: [],
};

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** A second person, in their own browser context, with the artifact shared with them. */
async function colleagueOn(browser: Browser, artifactId: string): Promise<Page> {
  const cookie = await server.signInAs('colleague@example.com');
  await server.as(`/api/artifacts/${artifactId}/sharing/people`, json({ email: 'colleague@example.com' }));
  const context = await browser.newContext();
  await context.addCookies([{ name: 'oa_session', value: cookie.split('=').slice(1).join('='), url: server.baseUrl }]);
  return context.newPage();
}

async function openLive(page: Page, slug: string) {
  await page.goto(`${server.baseUrl}/a/${slug}`);
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-state', 'live');
}

test('an agent’s canvas write shows up at once in every browser that has it open', async ({ page, context, browser }) => {
  const artifact = await server.publish({ type: 'canvas', content: JSON.stringify(BOARD) });
  await server.signInBrowser(context);
  const colleague = await colleagueOn(browser, artifact.id);
  await openLive(page, artifact.slug);
  await openLive(colleague, artifact.slug);
  // Both have read the canvas as it was, so what follows can only arrive live.
  for (const reader of [page, colleague]) {
    await expect(reader.getByTestId('canvas-view')).toHaveAttribute('data-version', '1');
  }

  const token = await server.connectCommandLine('agent');
  const written = await fetch(`${server.baseUrl}/api/artifacts/${artifact.id}/canvas/ops`, {
    ...json({ baseVersion: 1, ops: [{ op: 'add', node: { type: 'text', text: 'From the agent', x: 4000, y: 4000 } }] }),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  expect(written.ok).toBe(true);

  for (const reader of [page, colleague]) {
    await expect(reader.getByTestId('canvas-view')).toHaveAttribute('data-version', '2', PROMPTLY);
    await expect(reader.getByTestId('canvas-incoming')).toHaveText(/1 new node/, PROMPTLY);
  }
  await colleague.getByTestId('canvas-incoming').getByRole('button', { name: 'Show' }).click();
  await expect(colleague.getByTestId('canvas-view').getByText('From the agent')).toBeInViewport();
});

test('an edit in one browser appears in the other, and not as news in its own', async ({ page, context, browser }) => {
  const artifact = await server.publish({ type: 'canvas', content: JSON.stringify(BOARD) });
  await server.signInBrowser(context);
  const colleague = await colleagueOn(browser, artifact.id);
  await openLive(page, artifact.slug);
  await openLive(colleague, artifact.slug);
  await expect(colleague.getByTestId('canvas-view')).toHaveAttribute('data-version', '1');

  const view = page.getByTestId('canvas-view');
  await page.getByTestId('canvas-toolbar').getByRole('button', { name: '+ Text' }).click();
  await view.locator('textarea').fill('Written by the owner');
  await view.locator('textarea').blur();
  await expect(page.getByTestId('canvas-status')).toHaveText(/Saved · v\d+/);
  const saved = await page.getByTestId('canvas-view').getAttribute('data-version');

  // It may land off screen, where nothing is drawn: the pill says so and takes them there.
  await expect(colleague.getByTestId('canvas-view')).toHaveAttribute('data-version', saved!, PROMPTLY);
  await expect(colleague.getByTestId('canvas-incoming')).toHaveText(/1 new node/);
  await colleague.getByTestId('canvas-incoming').getByRole('button', { name: 'Show' }).click();
  await expect(colleague.getByTestId('canvas-view').getByText('Written by the owner')).toBeInViewport();
  // The owner made it, here: not something that arrived.
  await expect(page.getByTestId('canvas-incoming')).toHaveCount(0);
});

test('a Markdown document and its comments follow the owner’s changes', async ({ browser }) => {
  const artifact = await server.publish({ type: 'markdown', content: '# Plan\n\nThe first draft.\n' });
  const colleague = await colleagueOn(browser, artifact.id);
  await openLive(colleague, artifact.slug);
  await expect(colleague.getByText('The first draft.')).toBeVisible();

  await server.update({ id: artifact.id, content: '# Plan\n\nThe second draft.\n', baseVersion: 1 });
  await expect(colleague.getByText('The second draft.')).toBeVisible(PROMPTLY);

  await server.as(`/api/artifacts/${artifact.id}/comments`, json({ body: 'Looks right to me' }));
  await expect(colleague.getByText('Looks right to me')).toBeVisible(PROMPTLY);

  await server.as(`/api/artifacts/${artifact.id}`, json({ title: 'The plan, renamed' }, 'PATCH'));
  await expect(colleague.getByRole('heading', { name: 'The plan, renamed' })).toBeVisible(PROMPTLY);
});

test('an HTML page is shown again when a new version lands', async ({ browser }) => {
  const artifact = await server.publish({ type: 'html', content: '<!doctype html><p>Version one</p>' });
  const colleague = await colleagueOn(browser, artifact.id);
  await openLive(colleague, artifact.slug);
  await expect(colleague.frameLocator('iframe').first().getByText('Version one')).toBeVisible();

  await server.update({ id: artifact.id, content: '<!doctype html><p>Version two</p>', baseVersion: 1 });
  await expect(colleague.frameLocator('iframe').first().getByText('Version two')).toBeVisible(PROMPTLY);
});

test('a share taken away turns the open page into “not here”', async ({ browser }) => {
  const artifact = await server.publish({ type: 'markdown', content: '# Plan\n\nPrivate.\n' });
  const colleague = await colleagueOn(browser, artifact.id);
  await openLive(colleague, artifact.slug);
  await expect(colleague.getByText('Private.')).toBeVisible();

  await server.as(`/api/artifacts/${artifact.id}/sharing/people/${encodeURIComponent('colleague@example.com')}`, {
    method: 'DELETE',
  });
  await expect(colleague.getByText('This is not here')).toBeVisible(PROMPTLY);
  await expect(colleague.getByText('Private.')).toHaveCount(0);
});
