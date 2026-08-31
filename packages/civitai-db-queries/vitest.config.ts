import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Best-effort: surface the DB connection to the DB-backed test tier. In CI, set TEST_DATABASE_URL directly.
// Locally, fall back to the monorepo-root .env (two levels up) so `pnpm --filter @civitai/db-queries test`
// picks up the dev DATABASE_URL without extra flags. If neither is present, the DB-backed suites skip.
function dbEnvFromRootDotenv(): Record<string, string> {
  const out: Record<string, string> = {};
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, '../../.env');
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
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    env: dbEnvFromRootDotenv(),
  },
});
