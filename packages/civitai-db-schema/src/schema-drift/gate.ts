/**
 * Delta gate for the schema<->database drift detector.
 *
 * Pure: no I/O, no database, no clock, no filesystem. `gate-cli.ts` does the wiring.
 *
 * WHAT THIS GATE IS FOR. The detector reports the drift that exists; a gate has to answer a
 * narrower question — did THIS change make it worse? Blocking on the whole report would be
 * red on every run (the accepted backlog on `main` is over a hundred findings) and a
 * permanently-red gate just teaches everyone to click through it. So the shape here is the one
 * this org already runs in its infrastructure repo: block only a PASS->FAIL regression the
 * change introduces, warn about everything that was already broken, and never block on a
 * pre-existing finding.
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
 * REFERENTIAL ACTIONS are measured only when the catalog carries `ON DELETE`/`ON UPDATE`
 * (the 2026-10-16 capture does). A `referential-action` finding is always ENFORCED. A catalog
 * without action data reports them as "not compared" on their own line rather than as a
 * clean zero. See `assertMeasuredSomething`.
 */
import type { CatalogColumn, DbCatalog, DriftFinding, DriftReport } from './types';

export type GateTier = 'enforced' | 'pending';

/** What a baseline entry records about the finding itself. Derived; never hand-written. */
export interface BaselineFinding {
  fingerprint: string;
  kind: DriftFinding['kind'];
  tier: GateTier;
  table: string;
  columns: string[];
  model: string;
  field?: string;
}

/**
 * An ACCEPTED finding: the finding, plus why it was accepted and where that was decided.
 *
 * WHY A REASON IS REQUIRED. The baseline turns a finding into a pass, so each entry carries why
 * it was accepted: otherwise "accepted for a reason" and "accepted because someone ran
 * `drift:baseline` to make the gate green" read as the same line. The gate fails on an entry
 * without a valid reason (`reasonProblems`), and the writer refuses to add one without being
 * told (`acceptIntoBaseline`).
 */
export interface BaselineEntry extends BaselineFinding {
  /** Why this drift is accepted. See `validateReason` for what counts. */
  reason: string;
  /** Where it was decided: a PR (`#1234`) or a migration directory name. See `validateRef`. */
  ref: string;
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

/**
 * The shape the gate's comparison logic actually reads: fingerprints and tiers. A freshly built
 * baseline (`buildBaseline`, no reasons yet) and a committed one (`Baseline`) both satisfy it,
 * so evaluating a candidate does not require inventing reasons for it first.
 */
export interface BaselineLike {
  catalog: string;
  entries: readonly BaselineFinding[];
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
   * PURELY FORWARD-LOOKING: escalation needs an entry that is BOTH `pending` and
   * `missing-foreign-key`, and since the 2026-10-16 recapture the baseline has no pending
   * entries at all. It fires on relations accepted from here on.
   */
  escalated: EscalatedFinding[];
  /** Baseline entries the current run no longer reports — remediated, or gone stale. */
  resolved: BaselineFinding[];
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
 * `declared` and `actual` are deliberately EXCLUDED except for nullability and
 * referential-action (below). They carry prose that legitimately changes without the drift changing: a missing foreign key's
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
 *
 * A referential-action finding folds in both action pairs, because for that kind the actions
 * ARE the finding. Without them, flipping `onDelete` on a relation already accepted for an
 * inert `ON UPDATE` mismatch would inherit that entry's pass.
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
  if (finding.kind === 'referential-action') parts.push(finding.declared, finding.actual);
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

export function toBaselineEntry(finding: DriftFinding, tier: GateTier): BaselineFinding {
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

/**
 * Build a CANDIDATE baseline from a report: every finding, no reasons. Sorted, so a refresh
 * produces a reviewable diff. `acceptIntoBaseline` turns it into a committed `Baseline`.
 */
export function buildBaseline(
  report: DriftReport,
  catalog: DbCatalog,
  catalogPath: string
): { catalog: string; entries: BaselineFinding[] } {
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
export function absorbedEscalations(
  previous: BaselineLike,
  next: BaselineLike
): EscalatedFinding[] {
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
  baseline: BaselineLike
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
export function assertMeasuredSomething(result: GateResult, baseline: BaselineLike): string[] {
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
  baseline: BaselineLike,
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

// ---------------------------------------------------------------------------
// Baseline reasons
// ---------------------------------------------------------------------------

/**
 * Shortest reason accepted, after trimming. Long enough that a reason has to say something,
 * short enough not to demand an essay for an obvious case. A length floor alone is walkable
 * by padding, which is why the word and placeholder checks below exist as well.
 */
export const MIN_REASON_LENGTH = 20;

/** Fewest distinct words of two or more letters a reason must contain. */
export const MIN_REASON_WORDS = 4;

/**
 * Words that are not a reason. Matched against the WHOLE normalised reason (so "accepted" is
 * refused and "accepted because ids are never updated" is not) and against its FIRST word, so
 * "TODO: explain why this is fine later" is refused however long it gets.
 */
const PLACEHOLDERS = new Set([
  'todo',
  'tbd',
  'tba',
  'fixme',
  'xxx',
  'wip',
  'accepted',
  'accept',
  'ok',
  'okay',
  'fine',
  'na',
  'n/a',
  'none',
  'null',
  'undefined',
  'unknown',
  'placeholder',
  'reason',
  'baseline',
  'pre-existing',
  'preexisting',
  'legacy',
  'see pr',
  'see above',
  'same as above',
  'misc',
  'temp',
  'test',
]);
const PLACEHOLDER_PREFIXES = ['todo', 'tbd', 'tba', 'fixme', 'xxx', 'wip', 'placeholder'];

/** Why `reason` is not an acceptable baseline reason, or `null` if it is. */
export function validateReason(reason: unknown): string | null {
  if (typeof reason !== 'string') return 'has no reason';
  const trimmed = reason.trim();
  if (trimmed.length === 0) return 'has an empty reason';
  const normalised = normaliseReason(trimmed);
  if (PLACEHOLDERS.has(normalised)) return `has a placeholder reason ("${trimmed}")`;
  const first = normalised.split(/[^a-z/]+/).filter(Boolean)[0] ?? '';
  if (PLACEHOLDER_PREFIXES.includes(first)) return `has a placeholder reason ("${trimmed}")`;
  if (trimmed.length < MIN_REASON_LENGTH) {
    return `has a reason shorter than ${MIN_REASON_LENGTH} characters ("${trimmed}")`;
  }
  const words = new Set((normalised.match(/[a-z]{2,}/g) ?? []).map((w) => w));
  if (words.size < MIN_REASON_WORDS) {
    return `has a reason with fewer than ${MIN_REASON_WORDS} distinct words ("${trimmed}")`;
  }
  return null;
}

/**
 * A ref says where the acceptance was decided, so it has to be something a reader can look up:
 * a pull request (`#1234`) or a migration directory name (`20261220120000_event_turf`).
 * Free text is refused — a ref nobody can resolve is a second reason field, not a pointer.
 */
const REF_PATTERN = /^(#[1-9]\d*|\d{14}_[a-z0-9_]+)$/;

export function validateRef(ref: unknown): string | null {
  if (typeof ref !== 'string' || ref.trim().length === 0) return 'has no ref';
  if (!REF_PATTERN.test(ref)) {
    return `has a ref that is neither a PR (#1234) nor a migration directory name ("${ref}")`;
  }
  return null;
}

export interface ReasonProblem {
  fingerprint: string;
  problem: string;
}

/**
 * Every entry of a committed baseline that does not carry an auditable reason and ref. The gate
 * fails on any of these: an entry without a reason is a finding passing for no recorded cause.
 *
 * Reads the entries as `unknown`-shaped JSON on purpose — this is the guard on a hand-editable
 * file, so it must not trust the type the file claims to have.
 */
export function reasonProblems(baseline: { entries: readonly unknown[] }): ReasonProblem[] {
  const out: ReasonProblem[] = [];
  for (const raw of baseline.entries) {
    const entry = (raw ?? {}) as Partial<BaselineEntry>;
    const fp = typeof entry.fingerprint === 'string' ? entry.fingerprint : '(no fingerprint)';
    const problems = [validateReason(entry.reason), validateRef(entry.ref)].filter(
      (p): p is string => p !== null
    );
    for (const problem of problems) out.push({ fingerprint: fp, problem });
  }
  return out;
}

/**
 * The one reason every entry got when the baseline was first created. It is a valid reason for
 * those entries — it says truthfully that they were accepted wholesale and not reviewed — but it
 * is not a reason for anything accepted since, so `acceptIntoBaseline` refuses it as a NEW
 * entry's `--reason`. Compared after normalising case, whitespace and trailing punctuation, so a
 * re-typed copy is refused as well.
 */
export const BACKFILL_REASON =
  'Pre-existing at the 2026-10-20 production capture; accepted wholesale when the baseline ' +
  'was created, not reviewed entry by entry.';

function normaliseReason(reason: string): string {
  return reason
    .trim()
    .toLowerCase()
    .replace(/[\s.!:;,'"`-]+$/g, '')
    .replace(/\s+/g, ' ');
}

/** `validateReason`, plus the refusals that apply only to a reason being given NOW. */
function newReasonProblem(reason: string): string | null {
  const problem = validateReason(reason);
  if (problem !== null) return problem;
  if (normaliseReason(reason) === normaliseReason(BACKFILL_REASON)) {
    return (
      'has the shared backfill reason, which records that an entry was NOT reviewed; a newly ' +
      'accepted entry needs its own'
    );
  }
  return null;
}

export interface Acceptance {
  reason?: string;
  ref?: string;
}

export type AcceptResult =
  | {
      ok: true;
      baseline: Baseline;
      /** Entries whose reason and ref came from the previous baseline, unchanged. */
      carried: number;
      /** Entries that took `--reason` / `--ref` in this refresh. */
      accepted: BaselineFinding[];
    }
  | {
      ok: false;
      /** Entries that needed a reason and could not be given one. */
      needReason: BaselineFinding[];
      problems: string[];
    };

/**
 * Turn a candidate baseline into a committed one, carrying every existing reason over.
 *
 * Each candidate entry is matched to the previous baseline BY FINGERPRINT AND TIER. A match
 * whose previous reason and ref are valid keeps them, byte for byte — a refresh must never
 * rewrite a reason someone wrote. A TIER CHANGE is not a match: an entry accepted as `pending`
 * and now `enforced` (an absorbed escalation) was accepted for a reason that is no longer true,
 * so it is a new acceptance, and the refusal names it as having risen. Everything else — a
 * finding the previous baseline did not have, one whose tier changed, or one it had without a
 * valid reason — needs `acceptance.reason` and `acceptance.ref`, and if either is missing or
 * invalid NOTHING is returned to write. All or nothing: a partial write would commit a baseline
 * the gate then fails.
 *
 * A NEW acceptance may not use `BACKFILL_REASON`: that string records that an entry was NOT
 * reviewed. Entries that already carry it keep it.
 */
export function acceptIntoBaseline(
  previous: { entries: readonly Partial<BaselineEntry>[] } | null,
  candidate: { catalog: string; entries: readonly BaselineFinding[] },
  acceptance: Acceptance
): AcceptResult {
  const before = new Map<string, Partial<BaselineEntry>>();
  for (const e of previous?.entries ?? []) {
    if (typeof e.fingerprint === 'string') before.set(e.fingerprint, e);
  }

  const needReason: BaselineFinding[] = [];
  const tierChanges: string[] = [];
  const entries: BaselineEntry[] = [];
  let carried = 0;
  const reasonProblem =
    acceptance.reason === undefined ? 'no --reason' : newReasonProblem(acceptance.reason);
  const refProblem = acceptance.ref === undefined ? 'no --ref' : validateRef(acceptance.ref);

  for (const finding of candidate.entries) {
    const old = before.get(finding.fingerprint);
    // A reason is carried only for the SAME acceptance: same fingerprint AND same tier. A
    // finding accepted as `pending` ("the column does not exist yet") that is now `enforced`
    // was accepted for a reason that is no longer true, and carrying it would absorb a
    // blocking escalation with no --reason at all.
    const sameTier = old?.tier === finding.tier;
    const keep =
      old && sameTier && validateReason(old.reason) === null && validateRef(old.ref) === null;
    if (keep) {
      carried += 1;
      entries.push(withReason(finding, old.reason as string, old.ref as string));
    } else {
      needReason.push(finding);
      if (old && !sameTier) {
        const verb =
          old.tier === 'pending' && finding.tier === 'enforced' ? 'rose' : 'changed tier';
        tierChanges.push(
          `${finding.kind}  ${finding.table}.${finding.columns.join('+')} (${finding.model}) ` +
            `${verb} from ${old.tier ?? 'unknown'} to ${finding.tier}`
        );
      }
      if (reasonProblem === null && refProblem === null) {
        entries.push(
          withReason(finding, (acceptance.reason as string).trim(), acceptance.ref as string)
        );
      }
    }
  }

  if (needReason.length > 0 && (reasonProblem !== null || refProblem !== null)) {
    const problems: string[] = [];
    for (const change of tierChanges) {
      problems.push(
        `${change}: the reason it was accepted under no longer describes it, so it needs a ` +
          'new --reason and --ref'
      );
    }
    if (reasonProblem !== null) {
      problems.push(
        acceptance.reason === undefined
          ? '--reason "<why this drift is accepted>" is required'
          : `--reason ${reasonProblem.replace(/^has /, 'is ')}`
      );
    }
    if (refProblem !== null) {
      problems.push(
        acceptance.ref === undefined
          ? '--ref <#PR or migration directory name> is required'
          : `--ref ${refProblem.replace(/^has /, 'is ')}`
      );
    }
    return { ok: false, needReason, problems };
  }

  return {
    ok: true,
    baseline: { catalog: candidate.catalog, entries },
    carried,
    accepted: needReason,
  };
}

/**
 * Fixed key order — the finding's fields, then `reason`, then `ref` — so the committed file
 * diffs as two added lines per entry rather than a reshuffle.
 */
function withReason(finding: BaselineFinding, reason: string, ref: string): BaselineEntry {
  return {
    fingerprint: finding.fingerprint,
    kind: finding.kind,
    tier: finding.tier,
    table: finding.table,
    columns: finding.columns,
    model: finding.model,
    ...(finding.field === undefined ? {} : { field: finding.field }),
    reason,
    ref,
  };
}
