import { test, expect, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * Workspaces in the sidebar, in a real browser: dragging, the move button for
 * when dragging is not possible, deleting, and a move the server refuses.
 */

let server: RunningServer;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

async function createWorkspace(name: string, description = `${name} things`): Promise<string> {
  const response = await server.as('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description }),
  });
  if (response.status !== 201) throw new Error(await response.text());
  return ((await response.json()) as { id: string }).id;
}

function section(page: Page, id: string) {
  return page.locator(`[data-workspace-id="${id}"]`);
}

test('dragging a kite onto a workspace moves it, and the move survives a reload', async ({ page, context }) => {
  const kite = await server.publish({ type: 'markdown', content: '# Quarterly report' });
  const research = await createWorkspace('Research');
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);

  const row = section(page, 'inbox').locator(`[data-artifact-id="${kite.id}"]`);
  await expect(row).toBeVisible();
  await row.dragTo(section(page, research).locator('button').first());

  await expect(section(page, research).locator(`[data-artifact-id="${kite.id}"]`)).toBeVisible();
  await expect(section(page, 'inbox').locator(`[data-artifact-id="${kite.id}"]`)).toHaveCount(0);

  await page.reload();
  await expect(section(page, research).locator(`[data-artifact-id="${kite.id}"]`)).toBeVisible();
});

test('the move button moves a kite without dragging', async ({ page, context }) => {
  const kite = await server.publish({ type: 'markdown', content: '# Notes' });
  const research = await createWorkspace('Research');
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);

  const row = section(page, 'inbox').locator(`[data-artifact-id="${kite.id}"]`);
  await row.hover();
  await page.getByRole('button', { name: 'Move “Notes”' }).click();
  // The current workspace is offered but cannot be chosen.
  await expect(page.getByRole('dialog').getByRole('button', { name: /Inbox/ })).toBeDisabled();
  await page.getByRole('dialog').getByRole('button', { name: 'Research' }).click();

  await expect(section(page, research).locator(`[data-artifact-id="${kite.id}"]`)).toBeVisible();
  // Moving did not open the kite.
  await expect(page).toHaveURL(server.baseUrl + '/');
});

test('deleting a workspace puts its kites back in Inbox and deletes none', async ({ page, context }) => {
  const kite = await server.publish({ type: 'markdown', content: '# Keep me' });
  const doomed = await createWorkspace('Doomed');
  await server.as(`/api/artifacts/${kite.id}/workspace`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: doomed }),
  });
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);

  await section(page, doomed).hover();
  await page.getByRole('button', { name: 'Edit workspace Doomed' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Its 1 kite move to Inbox. No kite is deleted.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete workspace' }).click();

  await expect(section(page, doomed)).toHaveCount(0);
  await expect(section(page, 'inbox').locator(`[data-artifact-id="${kite.id}"]`)).toBeVisible();
});

test('a move the server refuses puts the kite back and says so', async ({ page, context }) => {
  const kite = await server.publish({ type: 'markdown', content: '# Bounce' });
  const gone = await createWorkspace('Gone soon');
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);
  await expect(section(page, gone)).toBeVisible();

  // Deleted behind the page's back, as another tab would.
  await server.as(`/api/workspaces/${gone}`, { method: 'DELETE' });

  await section(page, 'inbox').locator(`[data-artifact-id="${kite.id}"]`).dragTo(section(page, gone).locator('button').first());

  await expect(page.getByRole('alert')).toContainText('No such workspace');
  await expect(section(page, 'inbox').locator(`[data-artifact-id="${kite.id}"]`)).toBeVisible();
});

test('a new workspace needs a description, and a duplicate name is refused in place', async ({ page, context }) => {
  await createWorkspace('Research');
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);

  await page.getByRole('button', { name: 'New workspace' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('research');
  await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled();
  await dialog.getByLabel('Description').fill('Papers');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog.getByText('You already have a workspace called "research".')).toBeVisible();
});
