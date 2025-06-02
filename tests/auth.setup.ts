import { expect, Page, test as setup } from '@playwright/test';
import fs from 'fs';
import { env } from '../src/env/server';
import { testAuthData } from './auth/data';

// make sure we're using local DB for testing
setup.beforeAll('check db', async () => {
  expect(
    env.DATABASE_URL.includes('localhost:15432') || env.DATABASE_URL.includes('db:5432')
    // ).toBeFalsy();
  ).toBeTruthy();
});

const SESSION_VALID_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

// save various user info for testing
const authSetup = async (page: Page, d: (typeof testAuthData)[keyof typeof testAuthData]) => {
  if (
    fs.existsSync(d.path) &&
    Date.now() - fs.statSync(d.path).mtime.getTime() < SESSION_VALID_MS
  ) {
    // console.log(`Skipping auth setup for ${d.userId}, file exists: ${d.path}`);
    return;
  }

  console.log(`Setting up user ID: ${d.userId}`);

  await page.goto(`/testing/testing-login?userId=${d.userId}`);
  await page.waitForURL('/');
  // await expect(page.getByRole('button', { name: 'View profile and more' })).toBeVisible();
  await page.context().storageState({ path: d.path });
};

setup('auth as mod', async ({ page }) => {
  await authSetup(page, testAuthData.mod);
});
setup('auth as newbie', async ({ page }) => {
  await authSetup(page, testAuthData.newbie);
});
setup('auth as degen', async ({ page }) => {
  await authSetup(page, testAuthData.degen);
});
setup('auth as banned', async ({ page }) => {
  await authSetup(page, testAuthData.banned);
});
// setup('auth as deleted', async ({ page }) => {
//   await authSetup(page, testAuthData.deleted);
// });
setup('auth as muted', async ({ page }) => {
  await authSetup(page, testAuthData.muted);
});
