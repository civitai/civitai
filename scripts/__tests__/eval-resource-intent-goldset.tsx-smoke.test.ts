import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Runs the gold-set script the way `pnpm run tsscript` does — a real `tsx` process with
 * NODE_ENV=development — and checks the dry run prints what it promises and exits 0.
 *
 * 🔴 This exists because the in-process suites CANNOT see a load-time failure: vitest's
 * module loader evaluates the import graph differently from tsx. Two have shipped: an
 * import cycle that crashed on load (`TypeError: Cannot read properties of undefined
 * (reading 'modelMetrics')`), and a Prisma client the dry run never used, whose
 * engine-load rejection exited 1 after the full dry run had printed — but only on a host
 * without a Prisma engine, so the test passed wherever the engine was installed.
 *
 * 🔴 SO THE CHILD IS HERMETIC: every inherited `PRISMA_*` variable is removed, so the dry
 * run must not need a Prisma engine at all. The server env schema still validates at
 * import, so the child gets the tracked `.env-example` values; nothing in the dry run
 * connects to anything, so those values are never used to reach a service.
 */

const ROOT = path.resolve(__dirname, '../..');
const TSX_CLI = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');

/**
 * sha256 of the pre-registration text as `origin/main` printed it at c8bc91037f (the
 * merge of #5441), taken from that commit's own dry-run stdout. The registration is v1
 * and must not change by accident: moving code around must leave it byte-identical.
 */
const REGISTERED_PREREGISTRATION_SHA256 =
  '0e151995da2101c5e7fff68f150eda2cc8934e73e54e3e3799e04f3ef394ffb3';

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

function withoutPrismaEngine(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        !entry[0].startsWith('PRISMA_') && entry[1] !== undefined
    )
  );
}

describe('eval-resource-intent-goldset under tsx (the real entry point)', () => {
  it('🔴 the dry run needs no Prisma engine: it prints the queries and the pre-registration, and exits 0', async () => {
    const { renderRetrievalPreregistration } = await import('../eval-resource-intent-registration');
    const env: NodeJS.ProcessEnv = {
      ...withoutPrismaEngine(process.env),
      ...exampleEnv(),
      NODE_ENV: 'development',
    };
    expect(Object.keys(env).filter((key) => key.startsWith('PRISMA_'))).toEqual([]);
    const run = spawnSync(
      process.execPath,
      [TSX_CLI, path.join(ROOT, 'scripts/eval-resource-intent-goldset.ts')],
      { cwd: ROOT, env, encoding: 'utf8', timeout: 150_000 }
    );
    const output = `${run.stdout}\n${run.stderr}`;
    expect(output).not.toContain('TypeError');
    expect(output).not.toContain('PrismaClientInitializationError');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Dry run. The gold-set queries');
    expect(run.stdout).toContain('WITH sampled AS (');
    expect(run.stdout).toContain('-- unmatched (part one)');
    expect(run.stdout).toContain(renderRetrievalPreregistration());

    // The PRINTED pre-registration block, byte-for-byte as registered.
    const printed = run.stdout.slice(run.stdout.indexOf('M3 RETRIEVAL PRE-REGISTRATION'));
    expect(createHash('sha256').update(printed.replace(/\n+$/, '')).digest('hex')).toBe(
      REGISTERED_PREREGISTRATION_SHA256
    );
  }, 180_000);
});
