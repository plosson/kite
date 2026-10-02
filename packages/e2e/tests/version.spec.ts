import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/** The sidebar says which Kite this is: the version in the root package.json, nothing else. */

let server: RunningServer;
const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

test('the sidebar shows the version the app was built from', async ({ page, context }) => {
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);
  const label = page.getByText(`v${version}`, { exact: true });
  await expect(label).toBeVisible();
  await expect(label).toHaveAttribute('title', `Kite ${version}`);
  await expect(page.getByText('vdev', { exact: true })).toHaveCount(0);
  if (process.env.KITE_SHOTS) {
    await page.screenshot({ path: `${process.env.KITE_SHOTS}/version.png`, clip: { x: 0, y: 0, width: 260, height: 60 } });
  }
});
