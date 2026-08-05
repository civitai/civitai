import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { compareSchemaToCatalog } from '../compare';
import {
  assertMeasuredSomething,
  buildBaseline,
  evaluateGate,
  fingerprint,
  tierOf,
  type Baseline,
} from '../gate';
import { parsePrismaSchema } from '../parse-prisma-schema';
import type { DbCatalog, DriftFinding } from '../types';

const run = promisify(execFile);

const here = fileURLToPath(new URL('.', import.meta.url));
const packageRoot = join(here, '../../..');
const tsx = join(packageRoot, 'node_modules/.bin/tsx');
const gateCli = join(packageRoot, 'src/schema-drift/gate-cli.ts');
const realSchema = join(packageRoot, 'prisma/schema.full.prisma');
const snapshotRelative = 'src/schema-drift/__tests__/fixtures/catalog-production-2026-08-03.json';
const snapshot = join(packageRoot, snapshotRelative);
const baselineRelative = 'src/schema-drift/drift-baseline.json';

const catalog = JSON.parse(readFileSync(snapshot, 'utf8')) as DbCatalog;
const schemaSource = readFileSync(realSchema, 'utf8');
const report = compareSchemaToCatalog(parsePrismaSchema(schemaSource), catalog);

function finding(overrides: Partial<DriftFinding> & Pick<DriftFinding, 'kind'>): DriftFinding {
  return {
    table: 'Model',
    columns: ['description'],
    model: 'Model',
    field: 'description',
    declared: 'required',
    actual: 'NULLABLE',
    ...overrides,
  };
}

describe('fingerprint', () => {
  it('ignores declared/actual prose, so an unrelated edit does not retire an entry', () => {
    // #3589 corrected eight declared referential actions and touched no constraint. A
    // fingerprint that folded `declared` in would have retired eight baseline entries and
    // raised eight identical-looking new ones — a gate red for no reason.
    const before = finding({
      kind: 'missing-foreign-key',
      columns: ['imageId'],
      field: 'image',
      declared: 'FOREIGN KEY -> Image(id) ON DELETE Restrict ON UPDATE Cascade',
      actual: 'no foreign key on these columns',
    });
    const after = {
      ...before,
      declared: 'FOREIGN KEY -> Image(id) ON DELETE Cascade ON UPDATE Cascade',
    };
    expect(fingerprint(after)).toBe(fingerprint(before));
  });

  it('DOES fold the direction into a nullability fingerprint', () => {
    // The opposite case, and the reason the rule above is not "always ignore declared".
    // Flipping a field from optional to required against a NULLABLE column is a NEW hazard
    // on a column that was already listed; a blind fingerprint would let it inherit the old
    // entry's baseline pass.
    const optional = finding({ kind: 'nullability', declared: 'optional', actual: 'NOT NULL' });
    const required = finding({ kind: 'nullability', declared: 'required', actual: 'NULLABLE' });
    expect(fingerprint(required)).not.toBe(fingerprint(optional));
  });

  it('separates findings that differ only in column order', () => {
    const ab = finding({ kind: 'uniqueness', columns: ['a', 'b'], field: undefined });
    const ba = finding({ kind: 'uniqueness', columns: ['b', 'a'], field: undefined });
    expect(fingerprint(ab)).not.toBe(fingerprint(ba));
  });
});

describe('tierOf', () => {
  it('treats a missing column as pending, never as blocking', () => {
    // The column's absence IS the finding, so it can only mean the schema is ahead of the
    // snapshot. Blocking on it would red every PR that adds a field.
    expect(
      tierOf(finding({ kind: 'missing-column', columns: ['probeOnlyNewColumn'] }), catalog)
    ).toBe('pending');
  });

  it('treats nullability and uniqueness as enforced', () => {
    expect(tierOf(finding({ kind: 'nullability' }), catalog)).toBe('enforced');
    expect(tierOf(finding({ kind: 'uniqueness' }), catalog)).toBe('enforced');
  });

  it('splits a missing foreign key on whether the database has the columns', () => {
    // `Model.userId` exists in the snapshot; a made-up column does not.
    const onLiveColumns = finding({ kind: 'missing-foreign-key', columns: ['userId'] });
    const onNewColumns = finding({ kind: 'missing-foreign-key', columns: ['noSuchColumnHere'] });
    expect(tierOf(onLiveColumns, catalog)).toBe('enforced');
    expect(tierOf(onNewColumns, catalog)).toBe('pending');
  });

  it('the two column names above are what this test claims they are', () => {
    // Positive control on the split: if `userId` were absent from the snapshot both cases
    // would read `pending` and the assertion above would pass for the wrong reason.
    const columns = new Set(catalog.columns.map((c) => `${c.table} ${c.column}`));
    expect(columns.has('Model userId')).toBe(true);
    expect(columns.has('Model noSuchColumnHere')).toBe(false);
  });
});

describe('evaluateGate against the real schema and snapshot', () => {
  const baseline = buildBaseline(report, catalog, snapshotRelative);

  it('reproduces the whole baseline and reports nothing new', () => {
    const result = evaluateGate(report, catalog, baseline);
    expect(result.newEnforced).toEqual([]);
    expect(result.newPending).toEqual([]);
    expect(result.resolved).toEqual([]);
    // Positive control on those three zeros: a gate wired to nothing produces exactly the
    // same three empty arrays.
    expect(result.matched).toBe(baseline.entries.length);
    expect(result.matched).toBeGreaterThan(50);
  });

  it('tiers the 2026-08-03 backlog the way the README describes it', () => {
    const byTier = { enforced: 0, pending: 0 };
    for (const entry of baseline.entries) byTier[entry.tier] += 1;
    // Every missing column is pending; every missing FK, nullability and uniqueness finding
    // in this backlog sits on columns the database already has.
    expect(byTier.pending).toBe(baseline.entries.filter((e) => e.kind === 'missing-column').length);
    expect(byTier.enforced).toBeGreaterThan(40);
  });

  it('reports no referential-action finding, because this catalog cannot support one', () => {
    // The 45 live ON UPDATE drifts are absorbed by being structurally unmeasurable here, not
    // by being waved through — and the count of what could not be compared is carried into
    // the result so the verdict can say so instead of printing a clean zero.
    const result = evaluateGate(report, catalog, baseline);
    expect(baseline.entries.some((e) => e.kind === 'referential-action')).toBe(false);
    expect(result.referentialActionUnknown).toBeGreaterThan(400);
  });

  it('blocks a NEW finding on a column the database already has', () => {
    const trimmed: Baseline = {
      catalog: snapshotRelative,
      entries: baseline.entries.filter((e) => e.kind !== 'uniqueness'),
    };
    const result = evaluateGate(report, catalog, trimmed);
    expect(result.newEnforced).toHaveLength(1);
    expect(result.newEnforced[0].kind).toBe('uniqueness');
    expect(result.newPending).toEqual([]);
  });

  it('only warns about a NEW finding whose column is not in the snapshot', () => {
    const trimmed: Baseline = {
      catalog: snapshotRelative,
      entries: baseline.entries.filter((e) => e.kind !== 'missing-column'),
    };
    const result = evaluateGate(report, catalog, trimmed);
    expect(result.newEnforced).toEqual([]);
    expect(result.newPending.length).toBeGreaterThan(0);
    expect(new Set(result.newPending.map((f) => f.kind))).toEqual(new Set(['missing-column']));
  });

  it('lists a baseline entry the run no longer reports, without blocking', () => {
    const withGhost: Baseline = {
      catalog: snapshotRelative,
      entries: [
        ...baseline.entries,
        {
          fingerprint: 'nullability|NoSuchTable|ghost|NoSuchModel|ghost|required',
          kind: 'nullability',
          tier: 'enforced',
          table: 'NoSuchTable',
          columns: ['ghost'],
          model: 'NoSuchModel',
          field: 'ghost',
        },
      ],
    };
    const result = evaluateGate(report, catalog, withGhost);
    expect(result.resolved.map((e) => e.table)).toEqual(['NoSuchTable']);
    expect(result.newEnforced).toEqual([]);
  });
});

describe('assertMeasuredSomething', () => {
  const baseline = buildBaseline(report, catalog, snapshotRelative);

  it('accepts a run that reproduced its baseline', () => {
    expect(assertMeasuredSomething(evaluateGate(report, catalog, baseline), baseline)).toEqual([]);
  });

  it('rejects an empty baseline — a clean pass against it would prove nothing', () => {
    const empty: Baseline = { catalog: snapshotRelative, entries: [] };
    const problems = assertMeasuredSomething(evaluateGate(report, catalog, empty), empty);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/baseline is empty/);
  });

  it('rejects a baseline that reproduced none of its entries', () => {
    const alien: Baseline = {
      catalog: snapshotRelative,
      entries: baseline.entries.map((e) => ({ ...e, fingerprint: `${e.fingerprint}-not-a-match` })),
    };
    const problems = assertMeasuredSomething(evaluateGate(report, catalog, alien), alien);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/none of the .* baseline findings were reproduced/);
  });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Drive the real entry point as a process. The functions above are the gate's logic; this is
 * what CI actually invokes, exit code and all — and an exit code is the only part of it CI
 * reads.
 */
async function gate(args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await run(tsx, [gateCli, ...args], {
      cwd: packageRoot,
      // The gate has no database code path; this asserts it does not grow one by accident.
      env: { ...process.env, DATABASE_URL: '' },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('drift-gate CLI', () => {
  let dir: string;
  let driftedSchema: string;
  let pendingSchema: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'drift-gate-cli-'));

    // Declare a LIVE, NULLABLE column required. The database has the column, so this is the
    // hazard the gate exists to catch: Prisma will type it non-null over a column that can
    // still return null.
    driftedSchema = join(dir, 'enforced.prisma');
    writeFileSync(
      driftedSchema,
      schemaSource.replace('  description         String?', '  description         String ')
    );

    // A brand-new field: no column in the snapshot, so the schema is simply ahead of it.
    pendingSchema = join(dir, 'pending.prisma');
    writeFileSync(
      pendingSchema,
      schemaSource.replace(
        '  description         String?',
        '  description         String?\n  gateProbeNewColumn  String?'
      )
    );
  });

  it('the two probe schemas actually differ from the real one', () => {
    // Positive control on every CLI assertion below: a `.replace` that matched nothing would
    // write the unmodified schema and the "blocks" test would pass or fail for reasons that
    // have nothing to do with the gate.
    expect(readFileSync(driftedSchema, 'utf8')).not.toBe(schemaSource);
    expect(readFileSync(pendingSchema, 'utf8')).not.toBe(schemaSource);
  });

  it('exits 0 on the committed schema, and says what it reproduced', async () => {
    const result = await gate([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/NEW, enforced \(blocking\)\s+: 0/);
    // The zero above is only meaningful next to a non-zero match count.
    expect(result.stdout).toMatch(/baseline findings reproduced\s+: [1-9]\d* of [1-9]\d*/);
  });

  it('exits 1 and names the finding when the change adds enforced drift', async () => {
    const result = await gate(['--schema', driftedSchema]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/NEW, enforced \(blocking\)\s+: 1/);
    expect(result.stdout).toMatch(/nullability\s+Model\.description/);
    expect(result.stderr).toMatch(/BLOCKED/);
  });

  it('exits 0 but warns when the change only adds drift awaiting a migration', async () => {
    const result = await gate(['--schema', pendingSchema]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/NEW, pending migration \(warn\)\s+: 1/);
    expect(result.stdout).toMatch(/missing-column\s+Model\.gateProbeNewColumn/);
  });

  it('exits 2 when the baseline was captured against a different catalog', async () => {
    const baseline = JSON.parse(
      readFileSync(join(packageRoot, baselineRelative), 'utf8')
    ) as Baseline;
    const wrong = join(dir, 'wrong-catalog-baseline.json');
    writeFileSync(wrong, JSON.stringify({ ...baseline, catalog: 'some/other/catalog.json' }));
    const result = await gate(['--baseline', wrong]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/only means anything next to the catalog/);
  });

  it('exits 2 on an empty baseline rather than passing clean', async () => {
    const empty = join(dir, 'empty-baseline.json');
    writeFileSync(empty, JSON.stringify({ catalog: snapshotRelative, entries: [] }));
    const result = await gate(['--baseline', empty]);
    // Not 0. Every finding reads as new, so a pass here would be a fact about the baseline.
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/baseline is empty/);
  });

  it('exits 2 on a catalog that covered nothing', async () => {
    const empty = join(dir, 'empty-catalog.json');
    const emptyCatalog: DbCatalog = { tables: [], columns: [], foreignKeys: [], uniqueIndexes: [] };
    writeFileSync(empty, JSON.stringify(emptyCatalog));
    const result = await gate(['--catalog', empty]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/verdict is meaningless/);
  });

  // This repo is public and so are its CI logs.
  it('does not echo a connection string passed by mistake', async () => {
    const secret = 'postgresql://someuser:sup3rsecret@some-host.example:5432/somedb';
    const result = await gate([secret]);
    expect(result.code).toBe(2);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain('sup3rsecret');
    expect(output).not.toContain('some-host.example');
    expect(output).not.toContain('someuser');
    expect(output).toMatch(/redacted-connection-string/);
  });

  it('prints usage on --help and exits 0', async () => {
    const result = await gate(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Usage: drift-gate/);
  });
});
