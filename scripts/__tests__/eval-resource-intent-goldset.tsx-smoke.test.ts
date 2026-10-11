import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import os from 'os';
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
 * 🔴 THE GUARD IS WHAT THE CHILD LOADS, NOT WHETHER IT CRASHES. Whether an unused Prisma
 * client kills the process depends on the host (an installed engine hides it), so the
 * primary assertion is a module-load trace: `fixtures/module-load-trace.cjs` records every
 * module each process loaded, and the dry run must load neither `src/server/db/client`
 * nor `src/server/meilisearch/client` — on any host. The trace has a positive control:
 * it must contain the registration module the dry run does load.
 *
 * As a second layer the child gets no `PRISMA_*` variable, so on a host without a
 * bundled engine an unused client would also crash the run. The server env schema still
 * validates at import, so the child gets the tracked `.env-example` values; nothing in
 * the dry run connects to anything, so those values are never used to reach a service.
 */

const ROOT = path.resolve(__dirname, '../..');
const TSX_CLI = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const TRACE_PRELOAD = path.join(ROOT, 'scripts/__tests__/fixtures/module-load-trace.cjs');

/** Modules the dry run must never load: each constructs a client it has no use for. */
const FORBIDDEN_IN_DRY_RUN = ['src/server/db/client.ts', 'src/server/meilisearch/client.ts'];

/**
 * The deliberate-amendment guard for the CURRENT registration: the sha256 of the
 * pre-registration text the dry run prints. Literal-line tests pin the co-primaries, the
 * verdict block, the control and the power statement; nothing else pins the Sample,
 * Stage 1, Gold and Arms paragraphs, so this hash does. It is meant to be UPDATED ON
 * PURPOSE, in the same commit that amends the registration (and before any run under
 * it) — never to make an accidental change pass. Current value: v3 as re-planned
 * 2026-10-07 from the 100-prompt pilot's nuisance rates, before any registered run (2000
 * drawn, a 1334 scored floor, the re-plan record), taken from the dry run's own stdout in
 * the commit that re-planned it. Previous: v3 as registered 2026-10-07 (the
 * popularity-seed matcher, the two co-primaries, the promotable-label positive control,
 * identical heads as a diagnostic only; 1000 drawn),
 * `fbedfe4b7b6fd5b46fbfa0dc1baa9721599f723a1f0f84e2a656f1f9a16e0b28`; v2,
 * `2ad9ecdaf6810d60fac1c073b76013156e5457ad7ddc6de248d50be82a17c467` (0ae482a241); v1,
 * `0e151995da2101c5e7fff68f150eda2cc8934e73e54e3e3799e04f3ef394ffb3` (c8bc91037f).
 */
const REGISTERED_PREREGISTRATION_SHA256 =
  'c32df9f7a2b6f0ce842f65c1a74f8e46d71e3b6036c25816b58c7ae891ebc9e0';

/** v2's text as registered — the record `renderRetrievalPreregistrationV2` must still print. */
const V2_PREREGISTRATION_SHA256 =
  '2ad9ecdaf6810d60fac1c073b76013156e5457ad7ddc6de248d50be82a17c467';

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
  it('🔴 registration v2 is still recorded byte-for-byte as registered', async () => {
    const { renderRetrievalPreregistrationV2 } = await import(
      '../eval-resource-intent-registration'
    );
    expect(createHash('sha256').update(renderRetrievalPreregistrationV2()).digest('hex')).toBe(
      V2_PREREGISTRATION_SHA256
    );
  });

  it('🔴 the dry run loads no database or search client, needs no Prisma engine, prints the queries and the pre-registration, and exits 0', async () => {
    const { renderRetrievalPreregistration } = await import('../eval-resource-intent-registration');
    const traceDir = mkdtempSync(path.join(os.tmpdir(), 'm3-dry-run-trace-'));
    const env: NodeJS.ProcessEnv = {
      ...withoutPrismaEngine(process.env),
      ...exampleEnv(),
      NODE_ENV: 'development',
      NODE_OPTIONS: `--require ${TRACE_PRELOAD}`,
      M3_MODULE_TRACE_DIR: traceDir,
    };
    expect(Object.keys(env).filter((key) => key.startsWith('PRISMA_'))).toEqual([]);
    const run = spawnSync(
      process.execPath,
      [TSX_CLI, path.join(ROOT, 'scripts/eval-resource-intent-goldset.ts')],
      { cwd: ROOT, env, encoding: 'utf8', timeout: 150_000 }
    );
    const loaded = new Set<string>();
    try {
      for (const file of readdirSync(traceDir)) {
        for (const entry of JSON.parse(readFileSync(path.join(traceDir, file), 'utf8'))) {
          loaded.add(path.relative(ROOT, entry).split(path.sep).join('/'));
        }
      }
    } finally {
      rmSync(traceDir, { recursive: true, force: true });
    }

    // The primary guard, host-independent: what the dry run LOADED.
    expect(loaded.has('scripts/eval-resource-intent-registration.ts')).toBe(true); // control
    expect(FORBIDDEN_IN_DRY_RUN.filter((module) => loaded.has(module))).toEqual([]);

    const output = `${run.stdout}\n${run.stderr}`;
    expect(output).not.toContain('TypeError');
    expect(output).not.toContain('PrismaClientInitializationError');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Dry run. The gold-set queries');
    expect(run.stdout).toContain('WITH sampled AS (');
    expect(run.stdout).toContain('-- unmatched (part one)');
    expect(run.stdout).toContain(renderRetrievalPreregistration());

    // The PRINTED pre-registration block, byte-for-byte as registered. Sliced by the
    // block's own line count, so a log line printed after it cannot leak into the hash.
    const blockLines = renderRetrievalPreregistration().split('\n').length;
    const printed = run.stdout
      .slice(run.stdout.indexOf('M3 RETRIEVAL PRE-REGISTRATION'))
      .split('\n')
      .slice(0, blockLines)
      .join('\n');
    expect(createHash('sha256').update(printed).digest('hex')).toBe(
      REGISTERED_PREREGISTRATION_SHA256
    );
  }, 180_000);

  it('🔴 a report much larger than a pipe buffer arrives COMPLETE through the real exit path', () => {
    // `runAsScript` exits explicitly; without draining first, `process.exit` truncates a
    // piped report (measured: 8–16 KB of a 4 MB report arrived, 5 runs of 5). The fixture
    // prints through the gold-set runner's real `runAsScript`, real drain, real exit.
    const bytes = 4_000_000;
    const end = 'END-OF-REPORT';
    const env: NodeJS.ProcessEnv = {
      ...withoutPrismaEngine(process.env),
      ...exampleEnv(),
      NODE_ENV: 'development',
      M3_BIG_REPORT_BYTES: String(bytes),
      M3_BIG_REPORT_END: end,
    };
    const run = spawnSync(
      process.execPath,
      [TSX_CLI, path.join(ROOT, 'scripts/__tests__/fixtures/big-report-exit.ts')],
      { cwd: ROOT, env, encoding: 'utf8', timeout: 150_000, maxBuffer: 64 * 1024 * 1024 }
    );
    expect(run.status).toBe(0);
    const at = run.stdout.indexOf(end);
    expect(
      at,
      `stdout was ${run.stdout.length} bytes and the end marker never arrived`
    ).toBeGreaterThan(-1);
    expect(run.stdout.slice(at - bytes, at)).toBe('x'.repeat(bytes));
  }, 180_000);
});
