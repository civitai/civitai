import fs from 'fs';
import os from 'os';
import path from 'path';
import { onTestFinished, vi } from 'vitest';
import { __resetPageRoutesForTest } from '~/server/utils/page-routes';

/** The keys of a real `pages-manifest.json`, internal and API entries included. */
export const FIXTURE_MANIFEST_ROUTES = [
  '/_app',
  '/_document',
  '/_error',
  '/404',
  '/',
  '/images',
  '/models/[id]/[[...slug]]',
  '/user/[username]',
  '/api',
  '/api/trpc/[trpc]',
  '/api/v1/images',
];

/** Points the page-route allow-list at a fixture build directory holding `routes`. */
export function usePagesManifestFixture(routes: string[] = FIXTURE_MANIFEST_ROUTES) {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-manifest-'));
  onTestFinished(() => fs.rmSync(distDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(distDir, 'server'));
  fs.writeFileSync(
    path.join(distDir, 'server', 'pages-manifest.json'),
    JSON.stringify(Object.fromEntries(routes.map((r) => [r, `pages${r}.js`])))
  );
  vi.stubEnv('NEXT_DIST_DIR', distDir);
  __resetPageRoutesForTest();
  return distDir;
}
