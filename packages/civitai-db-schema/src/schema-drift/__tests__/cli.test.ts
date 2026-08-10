import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbCatalog } from '../types';

/**
 * Every case in this file spawns the CLI as a real process, which means a cold `tsx`
 * transpile and a Node start before a single assertion runs. Measured on a developer
 * machine that is doing other work at the same time, a passing case takes 1.1–3.5s —
 * against Vitest's 5s default. That margin is not a margin, and the file failed 1–2 of its
 * 9 cases on every run, a different subset each time, with `Test timed out in 5000ms`.
 *
 * A flaky gate is worse than no gate: it reds for reasons unrelated to the change under
 * review and trains everyone to re-run until green. The dependency here is on how loaded
 * the machine is, not on anything the code does, so it is removed rather than tolerated.
 * A real hang still fails, 60s later.
 */
vi.setConfig({ testTimeout: 60_000 });

const run = promisify(execFile);

const here = fileURLToPath(new URL('.', import.meta.url));
const packageRoot = join(here, '../../..');
const tsx = join(packageRoot, 'node_modules/.bin/tsx');
const cli = join(packageRoot, 'src/schema-drift/cli.ts');
const fixtureSchema = join(here, 'fixtures/fixture.prisma');
const realSchema = join(packageRoot, 'prisma/schema.full.prisma');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Drive the real entry point as a process, so the assertions are about what a person
 * running the command actually gets — exit code included. The unit tests exercise the
 * differ; nobody runs the differ.
 */
async function drift(args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await run(tsx, [cli, ...args], {
      cwd: packageRoot,
      // No DATABASE_URL: every case here is --catalog driven, and an inherited one must
      // never be reachable from a test.
      env: { ...process.env, DATABASE_URL: '' },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

let dir: string;
let emptyCatalog: string;
let alignedCatalog: string;
let driftedCatalog: string;
let actionlessCatalog: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'schema-drift-cli-'));

  const empty: DbCatalog = { tables: [], columns: [], foreignKeys: [], uniqueIndexes: [] };
  emptyCatalog = join(dir, 'empty.json');
  writeFileSync(emptyCatalog, JSON.stringify(empty));

  alignedCatalog = join(here, 'fixtures/catalog-aligned.json');
  driftedCatalog = join(here, 'fixtures/catalog-drifted.json');

  const actionless = JSON.parse(readFileSync(alignedCatalog, 'utf8')) as DbCatalog;
  for (const fk of actionless.foreignKeys) {
    fk.onDelete = null;
    fk.onUpdate = null;
  }
  actionlessCatalog = join(dir, 'actionless.json');
  writeFileSync(actionlessCatalog, JSON.stringify(actionless));
});

describe('drift CLI', () => {
  // THE control this suite exists for. An empty catalog is what a typo'd --db-schema, a
  // wrong DATABASE_URL, or a role without catalog visibility produces, and it makes the
  // tool print a completely clean report. Before this guard the command exited 0 — even
  // under --strict — having compared nothing at all.
  describe('a catalog that covered nothing', () => {
    it('fails, and says the clean sections mean nothing', async () => {
      const result = await drift(['--catalog', emptyCatalog, '--schema', realSchema]);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/not trustworthy/);
      expect(result.stderr).toMatch(/no relations were checked/);
    });

    it('fails under --strict too, and not with the drift-found code', async () => {
      const result = await drift(['--catalog', emptyCatalog, '--schema', realSchema, '--strict']);
      // 2 = could not measure. 1 would claim drift was found, and 0 would be the lie.
      expect(result.code).toBe(2);
    });

    it('still prints a report that LOOKS clean — which is the whole problem', async () => {
      const result = await drift(['--catalog', emptyCatalog, '--schema', realSchema]);
      expect(result.stdout).toMatch(/MISSING foreign key\s+: 0/);
    });
  });

  // Positive control on the three exit-2 assertions above: the same command over a catalog
  // that does cover the schema must succeed. Otherwise the guard could be failing for any
  // reason at all and the tests above would still pass.
  describe('a catalog that covers the schema', () => {
    it('exits 0 and reports no drift', async () => {
      const result = await drift(['--catalog', alignedCatalog, '--schema', fixtureSchema]);
      expect(result.code).toBe(0);
      expect(result.stderr).not.toMatch(/not trustworthy/);
      expect(result.stdout).toMatch(/MISSING foreign key\s+: 0/);
    });

    it('exits 0 by default even with drift present', async () => {
      const result = await drift(['--catalog', driftedCatalog, '--schema', fixtureSchema]);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/MISSING foreign key\s+: 1/);
    });

    it('exits 1 under --strict when drift is present', async () => {
      const result = await drift([
        '--catalog',
        driftedCatalog,
        '--schema',
        fixtureSchema,
        '--strict',
      ]);
      expect(result.code).toBe(1);
    });
  });

  // "Could not compare" is not "compared and found nothing". A catalog with no
  // ON DELETE/UPDATE data yields zero referential-action findings, so a gate would pass
  // having certified none of them.
  it('exits 1 under --strict when referential actions could not be compared', async () => {
    const result = await drift([
      '--catalog',
      actionlessCatalog,
      '--schema',
      fixtureSchema,
      '--strict',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/referential actions could not be compared/);
  });

  // This repo is public and so are its CI logs.
  it('does not echo a connection string passed by mistake', async () => {
    const secret = 'postgresql://someuser:sup3rsecret@some-host.example:5432/somedb';
    const result = await drift([secret]);
    expect(result.code).toBe(2);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain('sup3rsecret');
    expect(output).not.toContain('some-host.example');
    expect(output).not.toContain('someuser');
    expect(output).toMatch(/redacted-connection-string/);
  });

  it('prints usage on --help and exits 0', async () => {
    const result = await drift(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Usage: drift/);
  });
});
