import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { runTsxCli, type CliRun } from './support/tsx-cli';
import { compareSchemaToCatalog } from '../compare';
import {
  absorbedEscalations,
  assertMeasuredSomething,
  blocking,
  buildBaseline,
  evaluateGate,
  fingerprint,
  referencedTarget,
  snapshotAge,
  STALE_AFTER_DAYS,
  tierOf,
  type Baseline,
} from '../gate';
import { parsePrismaSchema } from '../parse-prisma-schema';
import type { DbCatalog, DriftFinding } from '../types';

const here = fileURLToPath(new URL('.', import.meta.url));
const packageRoot = join(here, '../../..');
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

  it('DOES fold the referenced table into a missing-FK fingerprint', () => {
    // Repointing a relation keeps the model, the field and the constrained column identical,
    // so without the target the fingerprint is unchanged and the edit inherits the old
    // entry's baseline pass with no mention in the output.
    const toImage = finding({
      kind: 'missing-foreign-key',
      columns: ['imageId'],
      field: 'image',
      declared: 'FOREIGN KEY -> Image(id) ON DELETE Cascade ON UPDATE Cascade',
    });
    const toPost = {
      ...toImage,
      declared: 'FOREIGN KEY -> Post(id) ON DELETE Cascade ON UPDATE Cascade',
    };
    expect(fingerprint(toPost)).not.toBe(fingerprint(toImage));
  });

  it('still ignores the ACTION prose, which is what #3589 changed', () => {
    // The two rules have to coexist: target IN, actions OUT.
    const restrict = finding({
      kind: 'missing-foreign-key',
      columns: ['imageId'],
      field: 'image',
      declared: 'FOREIGN KEY -> Image(id) ON DELETE Restrict ON UPDATE Cascade',
    });
    const cascade = {
      ...restrict,
      declared: 'FOREIGN KEY -> Image(id) ON DELETE Cascade ON UPDATE Cascade',
    };
    expect(fingerprint(cascade)).toBe(fingerprint(restrict));
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

  // SEPARATOR ALPHABET, DERIVED — not five spellings hand-picked.
  //
  // Each case builds `table = A{S}B` / `column = C` against `A` / `B{S}C`. Under an
  // implementation separator M those two keys are equal IFF `S === M`, so a case only ever
  // catches its own separator. The previous version listed five, which meant a sixth nobody
  // enumerated was invisible: `-`, `#`, `::`, `--` and `~!~` all survived at 382/0 — and `-`
  // and `#` are legal inside a QUOTED Postgres identifier, so that is the hazard class the
  // guard exists for, not a hypothetical.
  //
  // Enumerating the alphabet is what lets the claim be stated at its true scope, which is
  // narrower than "any character": empty, space, every ASCII punctuation character, five
  // multi-character candidates, and five non-ASCII ones. THAT IS THE WHOLE CLAIM. A finite
  // enumeration cannot prove a property over an infinite alphabet, and a separator outside
  // this list is not covered by these cases — `ZZQ` still survives them, as would any other
  // unenumerated multi-character run. The fuzz below is a second, differently-constructed
  // check that catches single-character separators without naming them; between them, every
  // separator anyone has actually proposed for this line dies.
  const ASCII_PUNCTUATION = [...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'];
  const SEPARATOR_CANDIDATES: { name: string; sep: string }[] = [
    { name: 'empty', sep: '' },
    { name: 'space', sep: ' ' },
    ...ASCII_PUNCTUATION.map((c) => ({ name: `punctuation ${c}`, sep: c })),
    ...['::', '--', '~!~', '||', '__'].map((c) => ({ name: `multi-char ${c}`, sep: c })),
    // Non-ASCII, because a QUOTED Postgres identifier may contain them and an ASCII-only
    // alphabet silently excludes them: `§` survived the first version of this enumeration.
    ...['§', '±', '£', '·', '\u00a0'].map((c) => ({
      name: `non-ascii U+${c.codePointAt(0)?.toString(16).padStart(4, '0')}`,
      sep: c,
    })),
  ];

  it.each(SEPARATOR_CANDIDATES)(
    'cannot confuse (table, column) pairs that collide under a $name separator',
    ({ sep }) => {
      const catalogWithOther: DbCatalog = {
        tables: [`A${sep}B`, 'A'],
        // ONLY the second pair exists in the database
        columns: [{ table: 'A', column: `B${sep}C`, notNull: false }],
        foreignKeys: [],
        uniqueIndexes: [],
      };
      const onAbsentColumn = finding({
        kind: 'missing-foreign-key',
        table: `A${sep}B`,
        columns: ['C'],
        model: 'AB',
        field: 'c',
        declared: 'FOREIGN KEY -> Other(id) ON DELETE Cascade ON UPDATE Cascade',
      });

      expect(tierOf(onAbsentColumn, catalogWithOther)).toBe('pending');
      // Positive control: the pair that IS present must still resolve, so the assertion
      // above cannot pass merely because every lookup fails.
      expect(
        tierOf({ ...onAbsentColumn, table: 'A', columns: [`B${sep}C`] }, catalogWithOther)
      ).toBe('enforced');
    }
  );

  it('keeps distinct (table, column) pairs distinct across a deterministic fuzz', () => {
    // Differently constructed from the enumeration above, on purpose. Rather than testing
    // one separator per case, this builds pairs that are AMBIGUOUS BY CONSTRUCTION — the
    // same character run split at two different points — so their naive concatenation is
    // identical and only a separator that cannot occur inside an identifier keeps them
    // apart. Seeded, so a failure is reproducible rather than a flake.
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = 'abAB01' + '!"#$%&\'()*+,-./:;<=>?@[]^_`{|}~ ';
    const pick = () => alphabet[Math.floor(rand() * alphabet.length)];

    let checked = 0;
    for (let n = 0; n < 200; n += 1) {
      const len = 4 + Math.floor(rand() * 6);
      const run = Array.from({ length: len }, pick).join('');
      const i = 1 + Math.floor(rand() * (run.length - 2));
      let j = 1 + Math.floor(rand() * (run.length - 2));
      if (i === j) j = i === 1 ? i + 1 : i - 1;

      const present = { table: run.slice(0, i), column: run.slice(i) };
      const absent = { table: run.slice(0, j), column: run.slice(j) };
      if (present.table === absent.table) continue;

      const catalog: DbCatalog = {
        tables: [present.table, absent.table],
        columns: [{ ...present, notNull: false }],
        foreignKeys: [],
        uniqueIndexes: [],
      };
      const f = finding({
        kind: 'missing-foreign-key',
        table: absent.table,
        columns: [absent.column],
        model: 'M',
        field: 'f',
        declared: 'FOREIGN KEY -> Other(id) ON DELETE Cascade ON UPDATE Cascade',
      });
      expect(tierOf(f, catalog)).toBe('pending');
      checked += 1;
    }
    // Positive control on the loop: a `continue` that swallowed every case would leave this
    // test green having asserted nothing.
    expect(checked).toBeGreaterThan(100);
  });

  it('a COMPOSITE foreign key is pending unless EVERY column exists', () => {
    // Distinguishes `.every` from `.some`, which are identical on the single-column keys the
    // rest of this file uses — so `.every -> .some` was a surviving mutant, on the one tier
    // decided at runtime. A composite key half-migrated (one column landed, one did not) is
    // not enforceable: there is nothing to put a constraint on yet.
    const bothPresent = finding({
      kind: 'missing-foreign-key',
      table: 'ImageResource',
      columns: ['imageId', 'modelVersionId'],
      model: 'ImageResource',
      field: 'image',
      declared: 'FOREIGN KEY -> Image(id) ON DELETE Cascade ON UPDATE Cascade',
    });
    const onePresent = { ...bothPresent, columns: ['imageId', 'noSuchColumnHere'] };
    const noneMissing = { ...bothPresent, columns: ['noSuchColumnHere', 'alsoNotAColumn'] };

    expect(tierOf(bothPresent, catalog)).toBe('enforced');
    expect(tierOf(onePresent, catalog)).toBe('pending'); // `.some` would say 'enforced'
    expect(tierOf(noneMissing, catalog)).toBe('pending');
  });

  it('the composite column names above are what that test claims (positive control)', () => {
    const columns = new Set(catalog.columns.map((c) => `${c.table} ${c.column}`));
    expect(columns.has('ImageResource imageId')).toBe(true);
    expect(columns.has('ImageResource modelVersionId')).toBe(true);
    expect(columns.has('ImageResource noSuchColumnHere')).toBe(false);
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
    const known = new Set(catalog.columns.map((c) => `${c.table} ${c.column}`));
    // Pending is "the snapshot has no column to hang a constraint on": every missing column,
    // plus any missing FK still waiting on one of its own columns. Nullability and uniqueness
    // are emitted only for surface the differ found, so they are never pending.
    const expectedPending = baseline.entries.filter(
      (e) =>
        e.kind === 'missing-column' ||
        (e.kind === 'missing-foreign-key' && e.columns.some((c) => !known.has(`${e.table} ${c}`)))
    );
    expect(baseline.entries.filter((e) => e.tier === 'pending')).toEqual(expectedPending);
    // Positive controls on both sides: an empty `expectedPending` would match a tier field
    // that had stopped being set at all.
    expect(expectedPending.length).toBeGreaterThan(10);
    expect(baseline.entries.filter((e) => e.tier === 'enforced').length).toBeGreaterThan(40);
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

describe('referencedTarget parses compare.ts output', () => {
  // PINS A CROSS-MODULE COUPLING. `referencedTarget` reads the referenced table out of the
  // `declared` string that compare.ts formats. If that format ever changes, the parse returns
  // null, every missing-FK fingerprint collapses to `?`, and distinct findings silently merge
  // into one. This makes that a red suite instead of a silent degradation.
  const missingFks = report.findings.filter((f) => f.kind === 'missing-foreign-key');

  it('resolves a target for EVERY missing foreign key in the real report', () => {
    expect(missingFks.length).toBeGreaterThanOrEqual(37); // positive control on the loop below
    const unparsed = missingFks.filter((f) => !referencedTarget(f));
    expect(unparsed.map((f) => f.declared)).toEqual([]);
  });

  it('resolves targets that are real model tables, not fragments', () => {
    const tables = new Set(catalog.tables);
    const targets = new Set(missingFks.map((f) => referencedTarget(f) as string));
    expect(targets.size).toBeGreaterThan(1);
    // Every parsed target should name a real table; a regex that grabbed the wrong span
    // would produce fragments that match nothing.
    expect([...targets].filter((t) => !tables.has(t))).toEqual([]);
  });

  it('returns null for kinds that have no referenced table', () => {
    expect(referencedTarget(finding({ kind: 'nullability' }))).toBeNull();
    expect(referencedTarget(finding({ kind: 'missing-column' }))).toBeNull();
  });
});

describe('tier escalation', () => {
  const baseline = buildBaseline(report, catalog, snapshotRelative);

  it('blocks a baseline finding whose tier rose from pending to enforced', () => {
    // The migration-landed-without-its-constraint case: the finding was accepted while its
    // column did not exist, the column exists now, and the fingerprint never changed. Before
    // this it was absorbed into `matched` and the run exited 0.
    const enforcedEntry = baseline.entries.find((e) => e.tier === 'enforced');
    expect(enforcedEntry).toBeDefined();
    const downgraded = {
      catalog: snapshotRelative,
      entries: baseline.entries.map((e) =>
        e.fingerprint === enforcedEntry?.fingerprint ? { ...e, tier: 'pending' as const } : e
      ),
    };

    const result = evaluateGate(report, catalog, downgraded);
    expect(result.escalated).toHaveLength(1);
    expect(result.escalated[0].from).toBe('pending');
    expect(result.escalated[0].to).toBe('enforced');
    // It still counts as reproduced — the trust control must not be weakened by this...
    expect(result.matched).toBe(baseline.entries.length);
    // ...but it must block.
    expect(blocking(result)).toHaveLength(1);
    expect(result.newEnforced).toEqual([]);
  });

  it('does not treat an unchanged tier as an escalation', () => {
    const result = evaluateGate(report, catalog, baseline);
    expect(result.escalated).toEqual([]);
    expect(blocking(result)).toEqual([]);
  });

  it('does not treat enforced -> pending as a regression', () => {
    const pendingEntry = baseline.entries.find((e) => e.tier === 'pending');
    expect(pendingEntry).toBeDefined();
    const upgraded = {
      catalog: snapshotRelative,
      entries: baseline.entries.map((e) =>
        e.fingerprint === pendingEntry?.fingerprint ? { ...e, tier: 'enforced' as const } : e
      ),
    };
    expect(evaluateGate(report, catalog, upgraded).escalated).toEqual([]);
  });
});

describe('snapshotAge', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');

  it('reports a fresh snapshot without warning', () => {
    const age = snapshotAge('2026-08-03T00:00:00.000Z', now);
    expect(age.ageDays).toBe(2);
    expect(age.warnings).toEqual([]);
    expect(age.label).toMatch(/2026-08-03/);
  });

  it('warns once the snapshot is older than the threshold', () => {
    const old = new Date(now.getTime() - (STALE_AFTER_DAYS + 1) * 86_400_000).toISOString();
    const age = snapshotAge(old, now);
    expect(age.ageDays).toBe(STALE_AFTER_DAYS + 1);
    expect(age.warnings).toHaveLength(1);
    expect(age.warnings[0]).toMatch(/pending\/warn/);
  });

  it('treats a MISSING capture date as a problem, not as a default', () => {
    // A frozen catalog with no date cannot have its decay assessed at all.
    const age = snapshotAge(undefined, now);
    expect(age.ageDays).toBeNull();
    expect(age.warnings).toHaveLength(1);
    expect(age.label).toMatch(/UNKNOWN/);
  });

  it('does not silently accept an unreadable date', () => {
    const age = snapshotAge('last tuesday', now);
    expect(age.ageDays).toBeNull();
    expect(age.warnings).toHaveLength(1);
  });

  it('pins the 90-day policy in ABSOLUTE terms, not relative to itself', () => {
    // Every other staleness assertion is written in terms of STALE_AFTER_DAYS, so it moves
    // with the constant: setting it to 999999 — which disables the only signal the gate has
    // about its own decay — changed no test result at all. A test whose expectation is
    // derived from the implementation cannot see the implementation change.
    expect(STALE_AFTER_DAYS).toBe(90);

    const at = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    expect(snapshotAge(at(120), now).warnings).toHaveLength(1);
    expect(snapshotAge(at(30), now).warnings).toEqual([]);
  });

  it('warns AT the threshold, not one day past it', () => {
    // The `>=` boundary. Every other case here uses STALE_AFTER_DAYS + 1, so `>=` -> `>`
    // survived: an off-by-one that delays the only signal the gate has about its own decay.
    const exactly = new Date(now.getTime() - STALE_AFTER_DAYS * 86_400_000).toISOString();
    const oneLess = new Date(now.getTime() - (STALE_AFTER_DAYS - 1) * 86_400_000).toISOString();
    expect(snapshotAge(exactly, now).ageDays).toBe(STALE_AFTER_DAYS);
    expect(snapshotAge(exactly, now).warnings).toHaveLength(1);
    expect(snapshotAge(oneLess, now).warnings).toEqual([]);
  });

  it('treats a FUTURE capture date as a problem, not as maximally fresh', () => {
    // A negative age can never reach the threshold, so a skewed clock would disable the
    // staleness signal indefinitely while looking healthier than a real capture.
    const future = new Date(now.getTime() + 5 * 86_400_000).toISOString();
    const age = snapshotAge(future, now);
    expect(age.warnings).toHaveLength(1);
    expect(age.warnings[0]).toMatch(/future/i);
    expect(age.label).toMatch(/FUTURE/);
  });

  it('the committed snapshot carries a capture date', () => {
    // The whole staleness signal is inert if the artefact has no stamp.
    expect(catalog.capturedAt).toBeTruthy();
    expect(snapshotAge(catalog.capturedAt, now).ageDays).not.toBeNull();
  });
});

describe('absorbedEscalations', () => {
  const baseline = buildBaseline(report, catalog, snapshotRelative);

  it('reports a pending -> enforced transition a refresh would swallow', () => {
    const target = baseline.entries.find((e) => e.tier === 'enforced');
    expect(target).toBeDefined();
    const previous: Baseline = {
      catalog: snapshotRelative,
      entries: baseline.entries.map((e) =>
        e.fingerprint === target?.fingerprint ? { ...e, tier: 'pending' as const } : e
      ),
    };
    const absorbed = absorbedEscalations(previous, baseline);
    expect(absorbed).toHaveLength(1);
    expect(absorbed[0].finding.table).toBe(target?.table);
  });

  it('is silent when no tier moved', () => {
    expect(absorbedEscalations(baseline, baseline)).toEqual([]);
  });

  it('does not report enforced -> pending, or an entry that is merely new', () => {
    const flipped: Baseline = {
      catalog: snapshotRelative,
      entries: baseline.entries.map((e) => ({ ...e, tier: 'enforced' as const })),
    };
    // every pending entry became enforced above, so the reverse direction must be silent
    expect(absorbedEscalations(flipped, baseline)).toEqual([]);
    // an entry absent from the previous baseline is new, not escalated
    expect(absorbedEscalations({ catalog: snapshotRelative, entries: [] }, baseline)).toEqual([]);
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

/**
 * Drive the real entry point as a process. The functions above are the gate's logic; this is
 * what CI actually invokes, exit code and all — and an exit code is the only part of it CI
 * reads.
 */
async function gate(args: string[]): Promise<CliRun> {
  return runTsxCli(gateCli, args, {
    cwd: packageRoot,
    // The gate has no database code path; this asserts it does not grow one by accident.
    env: { ...process.env, DATABASE_URL: '' },
    maxBuffer: 32 * 1024 * 1024,
  });
}

// Every case below spawns the real entry point as a PROCESS, so each pays a cold tsx
// transpile plus a Node start before its first assertion. Measured on an idle machine the
// slowest is 3.5s against Vitest's 5s default — a 1.4x margin, which a 2-core CI runner will
// not honour. That is a test that fails on ambient machine speed rather than on the code, and
// a different case each run, which is the worst kind of red. 60s still bounds a genuine hang.
//
// Set here rather than in the package's vitest.config.ts on purpose: the config is a shared
// file and a concurrent change to it is already in flight for the sibling cli.test.ts, which
// has the same shape and the same problem.
const pendingCount = (stdout: string): number =>
  Number(/NEW, pending migration \(warn\)\s+: (\d+)/.exec(stdout)?.[1] ?? NaN);

describe('drift-gate CLI', { timeout: 60_000 }, () => {
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
    // Counted against what the committed schema already reports, never as a literal: any field
    // that has landed ahead of its migration contributes a pending finding of its own, so a
    // pinned total reds this suite for schema work that has nothing to do with the gate. The
    // sibling --update-baseline assertion below carries the same note for the same reason.
    const control = await gate([]);
    const before = pendingCount(control.stdout);
    // Without this the delta below is NaN-vs-NaN and passes no matter what the gate printed.
    expect(before).not.toBeNaN();

    const result = await gate(['--schema', pendingSchema]);
    expect(result.code).toBe(0);
    expect(pendingCount(result.stdout)).toBe(before + 1);
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

  it('exits 2 on a catalog whose nullability read answered uniformly', async () => {
    // Wires up `assertCatalogSanity`, which was TESTED but not WIRED — deleting the call from
    // gate-cli.ts survived the whole suite, because the only exit-2 CLI case used an EMPTY
    // catalog, which trips `assessCoverage` instead and would keep passing with sanity gone.
    // This is the isolation seam: a function can be hermetically correct and never called.
    //
    // The motivating bug: `SELECT a.attnotnull notnull` parses as the postfix IS NOT NULL
    // operator and returns constant true, fabricating one-directional nullability drift.
    const uniform = join(dir, 'uniform-notnull.json');
    const broken = JSON.parse(JSON.stringify(catalog)) as DbCatalog;
    for (const column of broken.columns) column.notNull = true;
    writeFileSync(uniform, JSON.stringify(broken));

    const result = await gate(['--catalog', uniform]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/all \d+ columns report notNull=true/);
  });

  it('exits 1 when a baseline finding escalates from pending to enforced', async () => {
    // End-to-end for the escalation path: the schema is untouched and every fingerprint
    // matches, so only the tier comparison can produce this verdict.
    const committed = JSON.parse(
      readFileSync(join(packageRoot, baselineRelative), 'utf8')
    ) as Baseline;
    const target = committed.entries.find((e) => e.tier === 'enforced');
    expect(target).toBeDefined();
    const downgraded = join(dir, 'downgraded-baseline.json');
    writeFileSync(
      downgraded,
      JSON.stringify({
        ...committed,
        entries: committed.entries.map((e) =>
          e.fingerprint === target?.fingerprint ? { ...e, tier: 'pending' } : e
        ),
      })
    );

    const result = await gate(['--baseline', downgraded]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/escalated pending -> enforced\s+: 1/);
    expect(result.stdout).toMatch(/ROSE from pending to enforced/);
    expect(result.stderr).toMatch(/1 escalated/);
  });

  it('prints the snapshot capture date on every run, not only when it is stale', async () => {
    const result = await gate([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/catalog snapshot captured\s+: 2026-08-03 \(\d+ day\(s\) old\)/);
  });

  it('warns loudly when the snapshot carries no capture date', async () => {
    const undated = join(dir, 'undated-catalog.json');
    const stripped = JSON.parse(JSON.stringify(catalog)) as DbCatalog;
    delete stripped.capturedAt;
    writeFileSync(undated, JSON.stringify(stripped));
    // Baseline records the catalog path, so point it at this one to get past that check.
    const committed = JSON.parse(
      readFileSync(join(packageRoot, baselineRelative), 'utf8')
    ) as Baseline;
    const rebased = join(dir, 'undated-baseline.json');
    const rel = relative(packageRoot, undated).split('\\').join('/');
    writeFileSync(rebased, JSON.stringify({ ...committed, catalog: rel }));

    const result = await gate(['--catalog', undated, '--baseline', rebased]);
    expect(result.stdout).toMatch(/UNKNOWN/);
    expect(result.stdout).toMatch(/STALE:/);
    // Advisory, never fatal — a date cannot make a PR author's change wrong.
    expect(result.code).toBe(0);
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

  // --update-baseline had NO test of any kind: not the write, not the escalation report, not
  // the previous-baseline read. Two mutants passed the whole suite green — `absorbed = []`,
  // which makes the entire escalation remedy inert, and reading `previous` AFTER the write
  // instead of before, which is the single most likely real edit to that block. Both are
  // killed here. Written against a COPY of the real baseline in a temp dir, so no case can
  // touch the committed artefact.
  describe('--update-baseline', () => {
    let committed: Baseline;

    beforeAll(() => {
      committed = JSON.parse(readFileSync(join(packageRoot, baselineRelative), 'utf8')) as Baseline;
    });

    const freshCopy = (entries: Baseline['entries']): string => {
      const path = join(dir, `baseline-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(path, `${JSON.stringify({ ...committed, entries }, null, 2)}\n`);
      return path;
    };

    it('rewrites the baseline and reports what it compared against', async () => {
      const workBaseline = freshCopy(committed.entries);
      const result = await gate(['--update-baseline', '--baseline', workBaseline]);
      expect(result.code).toBe(0);
      // One entry per finding, counted from the same schema+snapshot pair the CLI reads —
      // never a literal. The totals move whenever a field lands ahead of its migration, and
      // pinning them reds this suite for schema work that has nothing to do with the gate.
      expect(result.stdout).toMatch(
        new RegExp(`Wrote ${report.findings.length} accepted finding\\(s\\)`)
      );
      // The PAIR, not a bare zero: "0 absorbed" and "nothing was compared" must not be the
      // same output. This is what makes the escalation report falsifiable.
      expect(result.stdout).toMatch(
        new RegExp(
          `escalations absorbed: 0 \\(compared against ${committed.entries.length} previous`
        )
      );
    });

    it('is byte-idempotent — a no-op refresh rewrites the same file', async () => {
      const path = freshCopy(committed.entries);
      // Refresh once to reach the state a refresh produces, and compare the SECOND write to
      // the first. Comparing against the committed entries instead asserts that the schema
      // currently has no drift beyond the baseline, which is a fact about whatever else is in
      // flight rather than about the writer being idempotent.
      await gate(['--update-baseline', '--baseline', path]);
      const before = readFileSync(path, 'utf8');
      await gate(['--update-baseline', '--baseline', path]);
      expect(readFileSync(path, 'utf8')).toBe(before);
    });

    it('REPORTS an escalation it absorbs, reading the previous file BEFORE overwriting it', async () => {
      // Kills both survivors. `absorbed = []` fails the count and the named line; reading
      // `previous` after the write makes it identical to the new baseline, so no transition
      // is visible and the count is 0.
      const target = committed.entries.find((e) => e.tier === 'enforced');
      expect(target).toBeDefined();
      const path = freshCopy(
        committed.entries.map((e) =>
          e.fingerprint === target?.fingerprint ? { ...e, tier: 'pending' as const } : e
        )
      );

      const result = await gate(['--update-baseline', '--baseline', path]);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/1 finding\(s\) ROSE from pending to enforced/);
      expect(result.stdout).toContain(`${target?.table}.${target?.columns.join('+')}`);
      expect(result.stdout).toMatch(/escalations absorbed: 1 /);

      // and the write really happened, with the tier corrected
      const written = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
      expect(written.entries.find((e) => e.fingerprint === target?.fingerprint)?.tier).toBe(
        'enforced'
      );
    });

    it('says it SKIPPED the comparison when the previous baseline is unusable', async () => {
      // Valid JSON, wrong shape — a truncated write or a bad merge resolution. This used to
      // throw `Cannot read properties of undefined (reading 'map')` and exit 2 AFTER the new
      // baseline had already been written: a refresh reporting failure having succeeded.
      const path = join(dir, 'malformed-baseline.json');
      writeFileSync(path, '{}');
      const result = await gate(['--update-baseline', '--baseline', path]);

      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/Escalation check SKIPPED/);
      expect(result.stdout).toMatch(/not "no escalations found"/);
      expect(result.stderr).not.toMatch(/Cannot read properties/);
      // the refresh still completed
      expect((JSON.parse(readFileSync(path, 'utf8')) as Baseline).entries).toHaveLength(
        report.findings.length
      );
    });

    it('says it SKIPPED when there was no previous baseline at all', async () => {
      const path = join(dir, 'does-not-exist-yet.json');
      const result = await gate(['--update-baseline', '--baseline', path]);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/Escalation check SKIPPED: no previous baseline existed/);
    });

    it('prints the snapshot age, which is the command run right after a recapture', async () => {
      const path = freshCopy(committed.entries);
      const result = await gate(['--update-baseline', '--baseline', path]);
      expect(result.stdout).toMatch(/catalog snapshot captured: 2026-08-03 \(\d+ day\(s\) old\)/);
    });
  });

  it('names BOTH kinds in the pending-tier guidance, since a recapture treats them differently', async () => {
    // Prose, but load-bearing prose: it is what someone reads at the moment they decide to
    // accept a pending finding, and it was wrong for missing-foreign-key until round 2.
    const result = await gate(['--schema', pendingSchema]);
    expect(result.stdout).toMatch(/missing-column\s+the column arrives, and the finding goes away/);
    expect(result.stdout).toMatch(/missing-foreign-key.*becomes ENFORCED/s);
  });

  it('prints usage on --help and exits 0', async () => {
    const result = await gate(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Usage: drift-gate/);
  });
});
