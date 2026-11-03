import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { runTsxCli, type CliRun } from './support/tsx-cli';
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

const here = fileURLToPath(new URL('.', import.meta.url));
const packageRoot = join(here, '../../..');
const cli = join(packageRoot, 'src/schema-drift/cli.ts');
const fixtureSchema = join(here, 'fixtures/fixture.prisma');
const realSchema = join(packageRoot, 'prisma/schema.full.prisma');

/**
 * Drive the real entry point as a process, so the assertions are about what a person
 * running the command actually gets — exit code included. The unit tests exercise the
 * differ; nobody runs the differ.
 */
async function drift(args: string[]): Promise<CliRun> {
  return runTsxCli(cli, args, {
    cwd: packageRoot,
    // No DATABASE_URL: every case here is --catalog driven, and an inherited one must
    // never be reachable from a test.
    env: { ...process.env, DATABASE_URL: '' },
    maxBuffer: 32 * 1024 * 1024,
  });
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

/**
 * Scoped runs, at the level people run them. `catalog-drifted.json` carries drift on `Comment`,
 * `posts`, `Author` and `Project`, so a one-table scope has drift both inside and outside it and
 * "included" and "excluded" are both observable.
 *
 * The two mutants these are built to kill: a filter that is a NO-OP (every scoped report would
 * carry the unrelated findings, and `--strict` over a clean table would exit 1) and a filter that
 * DROPS EVERYTHING (the scoped table's own findings would vanish, and `--strict` over a drifted
 * table would exit 0 — or the coverage guard would exit 2).
 */
describe('drift CLI, scoped', () => {
  const scoped = (args: string[]) =>
    drift(['--catalog', driftedCatalog, '--schema', fixtureSchema, ...args]);
  const migration = (name: string, sql: string): string => {
    const path = join(dir, name);
    writeFileSync(path, sql);
    return path;
  };

  // Control for every exclusion below: unscoped, the unrelated findings ARE printed.
  it('unscoped, the drifted catalog reports findings on posts, Author and Project (control)', async () => {
    const result = await scoped([]);
    expect(result.stdout).toMatch(/^ {2}posts\.title$/m);
    expect(result.stdout).toMatch(/^ {2}Author\.name$/m);
    expect(result.stdout).toMatch(/^ {2}Project\.projectId\+position$/m);
    expect(result.stdout).not.toMatch(/^Scope:/m);
  });

  it('--tables includes the requested table’s findings and excludes the rest', async () => {
    const result = await scoped(['--tables', 'Comment']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Scope: 1 table\(s\) compared/m);
    expect(result.stdout).toMatch(/^ {2}Comment {2}<- --tables$/m);
    expect(result.stdout).toMatch(/^ {2}Comment\.postId$/m);
    expect(result.stdout).toMatch(/^ {2}Comment\.authorId$/m);
    expect(result.stdout).not.toMatch(/^ {2}posts\./m);
    expect(result.stdout).not.toMatch(/^ {2}Author\./m);
    expect(result.stdout).not.toMatch(/^ {2}Project\./m);
    // the counters are the scope's, not the schema's: Comment has two owning relations
    expect(result.stdout).toMatch(/declared owning-side relations : 2\n/);
  });

  it('--strict follows the scope: a clean table exits 0, a drifted one exits 1', async () => {
    const clean = await scoped(['--strict', '--tables', 'ProjectSlot']);
    const dirty = await scoped(['--strict', '--tables', 'Comment']);
    expect(clean.code).toBe(0);
    expect(dirty.code).toBe(1);
  });

  it('--migration scopes to every table the file touches, and says where each came from', async () => {
    const path = migration(
      'two-tables.sql',
      '-- ALTER TABLE "Author" in a comment is not a statement\n' +
        'CREATE INDEX IF NOT EXISTS "Comment_text_idx" ON "Comment" ("text");\n' +
        'ALTER TABLE "Comment" ADD CONSTRAINT "Comment_postId_fkey" FOREIGN KEY ("postId") ' +
        'REFERENCES "posts"("id") ON DELETE CASCADE NOT VALID;\n'
    );
    const result = await scoped(['--migration', path]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Scope: 2 table\(s\) compared/m);
    expect(result.stdout).toContain(`Comment  <- ${path} (CREATE INDEX, ALTER TABLE)`);
    expect(result.stdout).toContain(`posts    <- ${path} (REFERENCES)`);
    expect(result.stdout).toMatch(/^ {2}posts\.title$/m);
    expect(result.stdout).not.toMatch(/^ {2}Author\./m);
  });

  it('--migration and --tables combine', async () => {
    const path = migration('one.sql', 'ALTER TABLE "Comment" ADD COLUMN IF NOT EXISTS "x" int;');
    const result = await scoped(['--migration', path, '--tables', 'Project']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^ {2}Project {2}<- --tables$/m);
    expect(result.stdout).toMatch(/^ {2}Project\.projectId\+position$/m);
    expect(result.stdout).toMatch(/^ {2}Comment\.postId$/m);
  });

  it('exits 2 on a requested table the schema has no model for, rather than printing clean', async () => {
    const result = await scoped(['--tables', 'Nope']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/cannot cover what it was asked to/);
    expect(result.stderr).toMatch(/"Nope" is in the scope but no model in the schema maps to it/);
    expect(result.stdout).not.toMatch(/MISSING foreign key/);
  });

  it('exits 2 on a requested table the catalog does not have', async () => {
    const result = await scoped(['--tables', 'report_view']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/"report_view" .*not an ordinary table in this catalog/);
  });

  it('exits 2 when the migration drops a table the catalog still has', async () => {
    const path = migration('drop.sql', 'DROP TABLE IF EXISTS "Comment";');
    const result = await scoped(['--migration', path]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/"Comment" is dropped or renamed away .* still in this catalog/);
  });

  it('exits 2 on a migration that touches no table at all', async () => {
    const path = migration('enum.sql', 'ALTER TYPE "Kind" ADD VALUE IF NOT EXISTS \'x\';');
    const result = await scoped(['--migration', path]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/the scope is empty/);
  });

  describe('a migration with a statement it cannot classify', () => {
    const sql =
      'ALTER TABLE "Comment" ADD COLUMN IF NOT EXISTS "x" int;\n' +
      'DO $$ BEGIN ALTER TABLE "Project" ADD COLUMN "y" int; END $$;\n';

    // No --catalog and no DATABASE_URL: the refusal must come before any attempt to connect, or
    // this would fail with "DATABASE_URL is not set" instead.
    it('exits 2 before connecting, naming the statement and the tables it mentions', async () => {
      const path = migration('do-block.sql', sql);
      const result = await drift(['--schema', fixtureSchema, '--migration', path]);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/1 statement\(s\) in the migration could not be classified/);
      expect(result.stderr).toContain(`${path}:2  DO $$ BEGIN`);
      expect(result.stderr).toMatch(/DO block: procedural code/);
      expect(result.stderr).toMatch(/mentions schema tables: Project$/);
      expect(result.stderr).toMatch(/Refusing to run a scoped check over a guessed subset/);
      expect(result.stderr).not.toMatch(/DATABASE_URL is not set/);
    });

    it('--allow-unparsed proceeds, still lists it, and does NOT add what it mentions', async () => {
      const path = migration('do-block-allowed.sql', sql);
      const result = await scoped(['--migration', path, '--allow-unparsed']);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(
        /Statements NOT classified — 1 \(proceeding because of --allow-unparsed\)/
      );
      expect(result.stdout).toMatch(/^Scope: 1 table\(s\) compared/m);
      // Project is mentioned inside the DO block and has drift; it is reported only if named.
      expect(result.stdout).not.toMatch(/^ {2}Project\./m);
      const named = await scoped(['--migration', path, '--allow-unparsed', '--tables', 'Project']);
      expect(named.stdout).toMatch(/^ {2}Project\.projectId\+position$/m);
    });
  });

  it('--json carries the scope next to the report', async () => {
    const result = await scoped(['--json', '--tables', 'Comment']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      scope: { tables: { table: string; origins: { kind: string }[] }[] };
      findings: { table: string }[];
    };
    expect(parsed.scope.tables).toEqual([
      { table: 'Comment', expect: 'present', origins: [{ kind: 'flag' }] },
    ]);
    expect(new Set(parsed.findings.map((f) => f.table))).toEqual(new Set(['Comment']));
  });

  it.each([
    [['--tables', ''], /--tables has an empty entry/],
    [['--tables', 'Comment,,posts'], /--tables has an empty entry/],
    [['--allow-unparsed'], /--allow-unparsed only means something with --migration/],
    [['--dump-catalog', '--tables', 'Comment'], /--dump-catalog captures the whole catalog/],
    [['--migration', '/nonexistent/migration.sql'], /--migration file not found/],
  ])('rejects %j', async (args, message) => {
    const result = await scoped(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(message);
  });
});
