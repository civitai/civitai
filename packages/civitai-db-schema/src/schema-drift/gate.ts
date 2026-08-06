/**
 * Delta gate for the schema<->database drift detector.
 *
 * Pure: no I/O, no database, no clock, no filesystem. `gate-cli.ts` does the wiring.
 *
 * WHAT THIS GATE IS FOR. The detector reports the drift that exists; a gate has to answer a
 * narrower question — did THIS change make it worse? Blocking on the whole report would be
 * red on every run (there are 61 findings on `main` today) and a permanently-red gate just
 * teaches everyone to click through it. So the shape here is the one this org already runs
 * in its infrastructure repo: block only a PASS->FAIL regression the change introduces,
 * warn about everything that was already broken, and never block on a pre-existing finding.
 *
 * TWO SEVERITIES, AND WHY THE SPLIT IS NOT A JUDGEMENT CALL. Migrations in this project are
 * applied BY HAND, per environment. A schema declaration is therefore routinely ahead of the
 * database on purpose, for as long as it takes someone to run the migration. A gate that
 * could not tell that apart from real drift would block every PR that adds a column, which
 * is most of them.
 *
 * The discriminator is structural, not a taste ranking: does the finding concern database
 * surface that ALREADY EXISTS?
 *
 *   ENFORCED  the columns are in the catalog and the constraint is not. The database has
 *             the shape; it simply does not enforce what the schema promises. Adding
 *             `@unique` to a live column with no unique index, or flipping a live NULLABLE
 *             column to required, is a hazard the moment it merges — Prisma will hand
 *             callers a type the database does not back. BLOCKS.
 *   PENDING   the column is not in the catalog at all, so the schema is simply ahead of the
 *             snapshot. Expected while a migration is outstanding. WARNS.
 *
 * `missing-column` is always PENDING by construction (the column's absence is the finding).
 * `nullability` and `uniqueness` are always ENFORCED by construction — the differ only emits
 * them for columns it found in the catalog. `missing-foreign-key` is the only kind that can
 * be either, and it is decided by looking its constrained columns up in the catalog.
 *
 * WHAT THIS GATE DOES NOT MEASURE. Referential actions. The committed catalog snapshot
 * carries no `ON DELETE`/`ON UPDATE` data, so all ~408 comparable foreign keys read as "not
 * comparable" and this gate can produce no `referential-action` finding at all. A live run
 * does measure them and found 45 — every one an `ON UPDATE` Cascade-vs-NoAction on a
 * hand-written App Blocks foreign key, zero `ON DELETE` mismatches. Those are absorbed here
 * by being structurally unmeasurable rather than by being waved through, and the gate says
 * so on its own line rather than printing a clean zero. See `assertMeasuredSomething`.
 */
import type { CatalogColumn, DbCatalog, DriftFinding, DriftReport } from './types';

export type GateTier = 'enforced' | 'pending';

export interface BaselineEntry {
  fingerprint: string;
  kind: DriftFinding['kind'];
  tier: GateTier;
  table: string;
  columns: string[];
  model: string;
  field?: string;
}

export interface Baseline {
  /**
   * Repo-relative path of the catalog the baseline was captured against. A baseline is only
   * meaningful next to the catalog it was measured with; swapping the catalog silently would
   * turn every entry into a mismatch and the gate into noise.
   */
  catalog: string;
  entries: BaselineEntry[];
}

export interface GateResult {
  /** Findings not present in the baseline, split by tier. */
  newEnforced: DriftFinding[];
  newPending: DriftFinding[];
  /**
   * Findings that DO match a baseline entry, but whose tier has risen from `pending` to
   * `enforced` since it was recorded. Blocking, like `newEnforced`.
   *
   * This is the same hazard the nullability fingerprint exists to close, one level up. A
   * relation on a column that did not yet exist is accepted as `pending`; when the migration
   * lands WITHOUT its constraint, the column appears in the catalog and the finding becomes
   * enforceable. The fingerprint is unchanged, so without this the escalation is absorbed
   * into `matched` and the run reports `NEW enforced: 0, NEW pending: 0, exit 0`.
   *
   * PURELY FORWARD-LOOKING TODAY, and worth stating rather than implying: escalation needs an
   * entry that is BOTH `pending` and `missing-foreign-key`, and the current baseline has ZERO
   * of those. All 12 pending entries are `missing-column`, which `tierWith` hardcodes to
   * `pending` and which therefore can never rise. So this guard cannot fire on anything in
   * the baseline as it stands; it fires on relations accepted from here on.
   */
  escalated: EscalatedFinding[];
  /** Baseline entries the current run no longer reports — remediated, or gone stale. */
  resolved: BaselineEntry[];
  /** Baseline entries the current run reproduced. The positive control on a zero. */
  matched: number;
  /** Every current finding, tiered. */
  total: number;
  /** Referential-action comparisons the catalog could not support. */
  referentialActionUnknown: number;
}

export interface EscalatedFinding {
  finding: DriftFinding;
  from: GateTier;
  to: GateTier;
}

/** Everything the gate blocks on: newly-introduced enforced drift, plus tier escalations. */
export function blocking(result: GateResult): DriftFinding[] {
  return [...result.newEnforced, ...result.escalated.map((e) => e.finding)];
}

/**
 * A stable identity for a finding, so "the same drift" survives an unrelated edit.
 *
 * `declared` and `actual` are deliberately EXCLUDED for every kind but nullability. They
 * carry prose that legitimately changes without the drift changing: a missing foreign key's
 * `declared` embeds its `ON DELETE`/`ON UPDATE`, so #3589 — which corrected eight declared
 * actions and touched no constraint — would have retired eight baseline entries and raised
 * eight identical-looking new ones.
 *
 * Nullability is the exception because its `declared` is one word, `required` or `optional`,
 * and that word IS the finding. A field flipped from optional to required against a NULLABLE
 * column is a NEW hazard on a column that was already listed, and a fingerprint blind to the
 * direction would let it inherit the old entry's baseline pass.
 *
 * A missing foreign key additionally folds in its REFERENCED TABLE. The #3589 argument covers
 * the referential-action prose, not the relation's target: repointing `ImageResource.image`
 * from `Image` to `Post` keeps the same field and the same constrained column, so without
 * this the fingerprint is unchanged and a semantically catastrophic edit inherits the old
 * entry's pass with no mention in the output. The actions stay out; only the target goes in.
 */
export function fingerprint(finding: DriftFinding): string {
  const parts = [
    finding.kind,
    finding.table,
    finding.columns.join(','),
    finding.model,
    finding.field ?? '',
  ];
  if (finding.kind === 'nullability') parts.push(finding.declared);
  if (finding.kind === 'missing-foreign-key') parts.push(referencedTarget(finding) ?? '?');
  return parts.join('|');
}

/**
 * The referenced table of a missing foreign key, or `null` if it cannot be read.
 *
 * `DriftFinding` does not carry the referenced table as a field — it lives inside the
 * `declared` string that `compare.ts` builds, `FOREIGN KEY -> Image(id) ON DELETE ...`. So
 * this parses another module's output, which is a coupling and not a free one: if that format
 * changes this returns `null` and every missing-FK fingerprint collapses to `?`. Measured,
 * that does NOT silently merge findings — the other five fields keep all 37 distinct, giving
 * 0 collisions — so the failure mode is a LOUD one: every FK fingerprint stops matching its
 * baseline entry, and the gate reports 37 resolved plus 37 new rather than passing quietly.
 *
 * That coupling is PINNED by a test asserting all 37 of the real report's missing-FK findings
 * parse to a non-empty target, so a format change in `compare.ts` reds the suite instead of
 * degrading this in silence. Widening `DriftFinding` with a first-class `refTable` would be
 * tidier and is the right follow-up; it changes a shared type that other suites assert on
 * with `toEqual`, so it does not belong in the same change as a NUL-byte fix.
 */
export function referencedTarget(finding: DriftFinding): string | null {
  if (finding.kind !== 'missing-foreign-key') return null;
  const match = /FOREIGN KEY -> ([^(]+)\(/.exec(finding.declared);
  return match ? match[1].trim() : null;
}

/**
 * NUL cannot appear in a Postgres identifier, so it is a safe tuple separator — but it is
 * written as the ESCAPE `\u0000`, never as a raw byte. A literal NUL makes the file binary to
 * git and to grep (`grep -c` returns rc=1, which reads as "0 matches"), and GitHub then omits
 * the file's patch from the PR diff entirely. This file shipped that way once and all 293
 * lines of it were invisible to review. `compare.ts:15` uses the same escape.
 */
function columnKey(table: string, column: string): string {
  return `${table}\u0000${column}`;
}

function catalogColumns(columns: readonly CatalogColumn[]): Set<string> {
  return new Set(columns.map((c) => columnKey(c.table, c.column)));
}

/**
 * Which severity a finding carries. See the module comment: this is decided by whether the
 * database already has the columns, not by how bad the kind sounds.
 */
export function tierOf(finding: DriftFinding, catalog: DbCatalog): GateTier {
  const known = catalogColumns(catalog.columns);
  return tierWith(finding, known);
}

function tierWith(finding: DriftFinding, known: Set<string>): GateTier {
  switch (finding.kind) {
    case 'missing-column':
      // The column's absence IS the finding, so this is always the schema running ahead of
      // the snapshot. Never blocking.
      return 'pending';
    case 'nullability':
    case 'uniqueness':
    case 'referential-action':
      // The differ only emits these for surface it found in the catalog.
      return 'enforced';
    case 'missing-foreign-key':
      return finding.columns.every((c) => known.has(columnKey(finding.table, c)))
        ? 'enforced'
        : 'pending';
  }
}

export function toBaselineEntry(finding: DriftFinding, tier: GateTier): BaselineEntry {
  return {
    fingerprint: fingerprint(finding),
    kind: finding.kind,
    tier,
    table: finding.table,
    columns: finding.columns,
    model: finding.model,
    ...(finding.field === undefined ? {} : { field: finding.field }),
  };
}

/** Build a baseline from a report. Sorted, so a refresh produces a reviewable diff. */
export function buildBaseline(
  report: DriftReport,
  catalog: DbCatalog,
  catalogPath: string
): Baseline {
  const known = catalogColumns(catalog.columns);
  const entries = report.findings
    .map((f) => toBaselineEntry(f, tierWith(f, known)))
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  return { catalog: catalogPath, entries };
}

/**
 * Tier changes a baseline REFRESH would silently absorb.
 *
 * THE HOLE THIS CLOSES. `evaluateGate`'s escalation guard can only fire when the catalog
 * gains a column, and a catalog only gains a column via a recapture — at which point the
 * documented procedure is to run `--update-baseline` in the same commit. So the guard's own
 * trigger condition arrives bundled with the command that overwrites the evidence: the
 * escalation becomes a `"tier": "pending"` -> `"tier": "enforced"` line inside a regenerated
 * baseline instead of a gate failure. (With a dated filename it is worse — the catalog-pairing
 * check exits 2 before `evaluateGate` runs at all, and its remedy is the same refresh.)
 *
 * A refresh is a deliberate act and should not fail, so this does not block. It makes the
 * absorbed transitions VISIBLE at the moment they are absorbed, in the output of the command
 * doing the absorbing, so they land in the recapture commit's log rather than nowhere.
 */
export function absorbedEscalations(previous: Baseline, next: Baseline): EscalatedFinding[] {
  const before = new Map(previous.entries.map((e) => [e.fingerprint, e]));
  const out: EscalatedFinding[] = [];
  for (const entry of next.entries) {
    const old = before.get(entry.fingerprint);
    if (old && old.tier === 'pending' && entry.tier === 'enforced') {
      out.push({
        finding: {
          kind: entry.kind,
          table: entry.table,
          columns: entry.columns,
          model: entry.model,
          field: entry.field,
          declared: '(recorded in the previous baseline as pending)',
          actual: 'the database now has these columns and still has no such constraint',
        },
        from: 'pending',
        to: 'enforced',
      });
    }
  }
  return out;
}

export function evaluateGate(
  report: DriftReport,
  catalog: DbCatalog,
  baseline: Baseline
): GateResult {
  const known = catalogColumns(catalog.columns);
  const baselineByFingerprint = new Map(baseline.entries.map((e) => [e.fingerprint, e]));
  const seen = new Set<string>();

  const newEnforced: DriftFinding[] = [];
  const newPending: DriftFinding[] = [];
  const escalated: EscalatedFinding[] = [];
  let matched = 0;

  for (const finding of report.findings) {
    const id = fingerprint(finding);
    const tier = tierWith(finding, known);
    const entry = baselineByFingerprint.get(id);

    if (entry) {
      seen.add(id);
      matched += 1;
      // A match is not automatically a pass. The baseline records the tier a finding had
      // when it was accepted, and a finding can RISE from `pending` to `enforced` without
      // its fingerprint changing: the accepted case was "no such column yet", and then the
      // migration lands without its constraint. What was accepted is not what is now true,
      // so it blocks. (The reverse, enforced -> pending, cannot happen from a schema edit —
      // it needs a column to leave the catalog — and is not treated as a regression.)
      if (entry.tier === 'pending' && tier === 'enforced') {
        escalated.push({ finding, from: entry.tier, to: tier });
      }
      continue;
    }

    if (tier === 'enforced') newEnforced.push(finding);
    else newPending.push(finding);
  }

  const resolved = baseline.entries.filter((e) => !seen.has(e.fingerprint));

  return {
    newEnforced,
    newPending,
    escalated,
    resolved,
    matched,
    total: report.findings.length,
    referentialActionUnknown: report.counts.referentialActionUnknown,
  };
}

/**
 * Reasons a gate verdict cannot be trusted, independent of what it decided.
 *
 * "0 new drift" and "wired to nothing" produce byte-identical output. `assessCoverage` in
 * `compare.ts` already catches a comparison that visited nothing; this catches the layer
 * above it — a run that compared fine but whose baseline no longer describes it, which
 * yields either a flood of spurious "new" findings or, worse, a clean pass because the
 * baseline is empty.
 *
 * Returns an empty array when the verdict is meaningful.
 */
export function assertMeasuredSomething(result: GateResult, baseline: Baseline): string[] {
  const problems: string[] = [];

  if (baseline.entries.length === 0) {
    problems.push(
      'the baseline is empty — every finding would read as new, and a clean run would prove ' +
        'nothing. Regenerate it with `pnpm --filter @civitai/db-schema drift:baseline`.'
    );
    return problems;
  }

  if (result.matched === 0) {
    problems.push(
      `none of the ${baseline.entries.length} baseline findings were reproduced. The baseline ` +
        'and this run are not describing the same pair of inputs (wrong schema, wrong ' +
        'catalog, or a fingerprint change).'
    );
  }

  return problems;
}

/**
 * How stale the catalog snapshot is, and what that costs.
 *
 * THE DECAY THIS EXISTS TO MAKE VISIBLE. The gate compares the schema against a FROZEN
 * capture of the database. Every column created after that capture is absent from it, so a
 * finding on such a column can only ever be tiered `pending` — warn-only. Blocking coverage
 * therefore shrinks monotonically as the snapshot ages, while the check stays reassuringly
 * green. Nothing about the verdict changes as this happens, which is precisely why it has to
 * be printed.
 *
 * The clock is a parameter, not a global, so this is testable without freezing time.
 *
 * It never blocks. A gate that went red purely because a date passed would be red for
 * everyone at once, for a reason no PR author can fix, and would be switched off.
 */
export interface SnapshotAge {
  /** Always printed, so the age is visible on every run rather than only once it is bad. */
  label: string;
  ageDays: number | null;
  /** Escalated notes, printed only when there is something to say. Never blocking. */
  warnings: string[];
}

export function snapshotAge(capturedAt: string | null | undefined, now: Date): SnapshotAge {
  if (!capturedAt) {
    return {
      label: 'UNKNOWN — the snapshot carries no `capturedAt`',
      ageDays: null,
      warnings: [
        'The catalog snapshot has no capture date, so its age cannot be assessed — and ' +
          "therefore neither can this gate's blocking coverage. Recapture it with " +
          '`drift --dump-catalog`, which stamps one.',
      ],
    };
  }
  const captured = new Date(capturedAt);
  if (Number.isNaN(captured.getTime())) {
    return {
      label: `UNREADABLE (${capturedAt})`,
      ageDays: null,
      warnings: [`The snapshot's \`capturedAt\` (${capturedAt}) is not a readable date.`],
    };
  }
  const ageDays = Math.floor((now.getTime() - captured.getTime()) / 86_400_000);
  if (ageDays < 0) {
    // A capture cannot be in the future. Left alone this prints a negative age and can never
    // reach STALE_AFTER_DAYS, so a clock skew or a hand-edited stamp would disable the
    // staleness signal indefinitely while looking healthier than a fresh capture.
    return {
      label: `${capturedAt.slice(0, 10)} — IN THE FUTURE by ${-ageDays} day(s)`,
      ageDays,
      warnings: [
        `The snapshot claims to have been captured ${-ageDays} day(s) in the future. Its age ` +
          'cannot be trusted, and a future stamp can never trip the staleness check. Recapture ' +
          'it, or fix the clock that produced it.',
      ],
    };
  }
  const warnings =
    ageDays >= STALE_AFTER_DAYS
      ? [
          `The snapshot is ${ageDays} days old. Every column created since then is absent ` +
            'from it, so drift on those columns can only be reported as pending/warn. ' +
            'Recapture it (`drift --dump-catalog`) and refresh the baseline in the same commit.',
        ]
      : [];
  return { label: `${capturedAt.slice(0, 10)} (${ageDays} day(s) old)`, ageDays, warnings };
}

/**
 * Days after which the snapshot's age is called out as a problem rather than just reported.
 * Advisory only: it never blocks. A gate that reddened because a date passed would be red for
 * everyone at once, for a reason no PR author can fix, and would be switched off.
 */
export const STALE_AFTER_DAYS = 90;

function describe(finding: DriftFinding): string {
  const where = `${finding.table}.${finding.columns.join('+')}`;
  const via = finding.field ? ` (${finding.model}.${finding.field})` : ` (${finding.model})`;
  return `${finding.kind}  ${where}${via}\n      declared: ${finding.declared}\n      database: ${finding.actual}`;
}

export function formatGateResult(
  result: GateResult,
  baseline: Baseline,
  age?: SnapshotAge
): string {
  const lines: string[] = [];
  lines.push('Schema <-> database drift gate');
  lines.push('');
  // Always the PAIR, never the bare zero: a "0 new" that is not accompanied by a non-zero
  // matched count is indistinguishable from a gate wired to nothing.
  lines.push(`  baseline findings reproduced   : ${result.matched} of ${baseline.entries.length}`);
  lines.push(`  findings in this run           : ${result.total}`);
  lines.push(`  NEW, enforced (blocking)       : ${result.newEnforced.length}`);
  lines.push(`  escalated pending -> enforced  : ${result.escalated.length} (blocking)`);
  lines.push(`  NEW, pending migration (warn)  : ${result.newPending.length}`);
  lines.push(`  baseline entries no longer seen: ${result.resolved.length}`);
  // Conditional: against a catalog that DOES carry action data this used to print
  // "not compared: 0 (this catalog carries no ON DELETE/UPDATE data)", which is false.
  lines.push(
    result.referentialActionUnknown > 0
      ? `  referential actions not compared: ${result.referentialActionUnknown} ` +
          '(this catalog carries no ON DELETE/UPDATE data — "not measured", not "clean")'
      : '  referential actions             : all comparable ones were compared'
  );

  // ALWAYS printed, not only once it is bad. The gate compares against a FROZEN capture, so
  // every column created after it can only ever be tiered pending/warn: blocking coverage
  // shrinks monotonically as this number grows, and nothing else in the verdict changes as it
  // happens. A number that is only shown when it crosses a threshold is a number nobody has a
  // feel for when it does.
  if (age) {
    lines.push(`  catalog snapshot captured      : ${age.label}`);
    for (const note of age.warnings) {
      lines.push('');
      lines.push(`  STALE: ${note}`);
    }
  }

  if (result.escalated.length > 0) {
    lines.push('');
    lines.push(`Findings that ROSE from pending to enforced — ${result.escalated.length}`);
    lines.push(
      '  These block. Each was accepted into the baseline as "the column does not exist ' +
        'yet".\n  The column exists now and the constraint still does not, so what was ' +
        'accepted is no\n  longer what is true — a migration landed without its constraint.'
    );
    for (const e of result.escalated) lines.push(`  ${describe(e.finding)}`);
  }

  if (result.newEnforced.length > 0) {
    lines.push('');
    lines.push(`NEW drift on columns the database already has — ${result.newEnforced.length}`);
    lines.push(
      '  These block. The database has the columns and does not enforce what this change ' +
        'declares,\n  so the promise is false the moment it merges.'
    );
    for (const finding of result.newEnforced) lines.push(`  ${describe(finding)}`);
  }

  if (result.newPending.length > 0) {
    lines.push('');
    lines.push(`NEW drift awaiting a migration — ${result.newPending.length} (not blocking)`);
    lines.push(
      '  The column is not in the catalog snapshot, so the schema is ahead of it. Expected ' +
        'while a\n  migration is outstanding.\n' +
        '  What a recapture does to these is NOT uniform, and it is worth knowing before you ' +
        'accept one:\n' +
        '    missing-column      the column arrives, and the finding goes away.\n' +
        '    missing-foreign-key the column arrives and the constraint does not, so it ' +
        'becomes ENFORCED\n' +
        '                        and starts failing this gate. That is the migration-without-' +
        'its-constraint\n                        case, and it is a real defect rather than a ' +
        'bookkeeping change.'
    );
    for (const finding of result.newPending) lines.push(`  ${describe(finding)}`);
  }

  if (result.resolved.length > 0) {
    lines.push('');
    lines.push(`Baseline entries this run no longer reports — ${result.resolved.length}`);
    lines.push(
      '  Either remediated (good — drop them from the baseline) or the finding moved. Not ' +
        'blocking.'
    );
    for (const entry of result.resolved) {
      lines.push(`  ${entry.kind}  ${entry.table}.${entry.columns.join('+')} (${entry.model})`);
    }
  }

  return lines.join('\n');
}
