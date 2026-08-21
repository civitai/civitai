import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Node-env unit tests over plain modules — the same shape as apps/auth and apps/creator-studio, and
// NOT the SvelteKit pipeline. `name` is required and must keep the `app:` prefix; see the `apps/*`
// note in the root vitest.config.mts for why dropping it moves this suite into the packages job.
const dir = path.dirname(fileURLToPath(import.meta.url));
const from = (p: string) => path.resolve(dir, p);

/**
 * Feeds the EXPLAIN tier a connection string, as `packages/civitai-db-queries/vitest.config.ts` does.
 * Absent (CI) and those suites skip.
 *
 * 🔴 DATABASE_REPLICA_URL is withheld ON PURPOSE. `$lib/server/db` demands both variables at module
 * scope, so a suite that forgets to mock it throws on import instead of connecting to whatever a
 * developer's `.env` points at. Adding it here to "fix" such a failure removes that protection.
 */
function dbEnvFromRootDotenv(): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = from('../../.env');
  if (!existsSync(envPath)) return out;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== 'DATABASE_URL' && key !== 'TEST_DATABASE_URL') continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export default defineConfig({
  // This config does not load the SvelteKit plugin, so `$lib` and `$env` need aliasing by hand.
  resolve: {
    alias: {
      $lib: from('./src/lib'),
      '$env/dynamic/private': from('./src/test/env.mock.ts'),
    },
  },
  test: {
    name: 'app:moderator',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    env: dbEnvFromRootDotenv(),
  },
});
