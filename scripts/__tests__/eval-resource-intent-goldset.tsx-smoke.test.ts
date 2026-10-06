import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Runs the gold-set script the way `pnpm run tsscript` does — a real `tsx` process with
 * NODE_ENV=development — and checks the dry run prints what it promises.
 *
 * 🔴 This exists because the in-process suites CANNOT see a load-time crash: vitest's
 * module loader evaluates the import graph differently from tsx, and an import cycle that
 * killed the script on load (`TypeError: Cannot read properties of undefined (reading
 * 'modelMetrics')`) left every vitest suite green while the dry run and `--execute`
 * printed nothing. Only spawning the script sees it.
 *
 * The child gets the tracked `.env-example` values so the server env schema validates;
 * the dry run makes no network call, so dummy values are enough.
 */

const ROOT = path.resolve(__dirname, '../..');
const TSX_CLI = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');

function exampleEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of readFileSync(path.join(ROOT, '.env-example'), 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const at = line.indexOf('=');
    env[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return env;
}

describe('eval-resource-intent-goldset under tsx (the real entry point)', () => {
  it('🔴 the dry run loads, prints the committed queries and the pre-registration, and exits 0', async () => {
    const { renderRetrievalPreregistration } = await import('../eval-resource-intent-retrieval');
    const run = spawnSync(
      process.execPath,
      [TSX_CLI, path.join(ROOT, 'scripts/eval-resource-intent-goldset.ts')],
      {
        cwd: ROOT,
        env: { ...process.env, ...exampleEnv(), NODE_ENV: 'development' },
        encoding: 'utf8',
        timeout: 150_000,
      }
    );
    const output = `${run.stdout}\n${run.stderr}`;
    expect(output).not.toContain('TypeError');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Dry run. The gold-set queries');
    expect(run.stdout).toContain('WITH sampled AS (');
    expect(run.stdout).toContain('-- unmatched (part one)');
    expect(run.stdout).toContain(renderRetrievalPreregistration());
  }, 180_000);
});
