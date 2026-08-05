/**
 * Text rendering of a remediation plan.
 *
 * The summary leads with the two numbers that matter — how many relations would be
 * remediated by DELETE and how many by UPDATE ... SET NULL — because those are the numbers
 * a reviewer of this plan is actually checking, and burying them under a total is how a
 * plan that deletes 23,500 rows reads as routine.
 */
import type { RelationPlan, RemediationPlan } from './types';

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join('\n');
}

function orphanText(relation: RelationPlan): string {
  return relation.orphanCount === null
    ? 'not measured'
    : relation.orphanCount.toLocaleString('en-US');
}

function formatRelation(relation: RelationPlan): string[] {
  const lines: string[] = [];
  lines.push(`${relation.key}  ->  ${relation.refTable}(${relation.refColumns.join(', ')})`);
  lines.push(`    outcome        : ${relation.outcome.toUpperCase()}`);
  lines.push(`    declared       : ON DELETE ${relation.onDelete} ON UPDATE ${relation.onUpdate}`);
  lines.push(
    `    orphan strategy: ${
      relation.strategy === 'delete-orphans'
        ? 'DELETE the orphan rows'
        : relation.strategy === 'null-orphans'
        ? `UPDATE ... SET ${relation.columns.join(' = NULL, ')} = NULL`
        : 'none — this runner will not modify these rows'
    }`
  );
  lines.push(`    orphans        : ${orphanText(relation)}`);
  lines.push(`    index coverage : ${relation.indexCoverage}`);
  lines.push(`    constraint     : ${relation.constraintValidity}`);
  if (relation.outcome === 'needs-validation') {
    lines.push(
      '    🔴 A previous run added this constraint and did not finish validating it. It is'
    );
    lines.push(
      '       enforcing new and changed rows but has NEVER checked the rows that predate it.'
    );
    lines.push('       ADD CONSTRAINT is deliberately not reissued; only VALIDATE remains.');
  }

  for (const refusal of relation.refusals) {
    lines.push(`    REFUSED [${refusal.code}]`);
    lines.push(indent(refusal.message, '        '));
  }
  for (const prerequisite of relation.prerequisites) {
    lines.push(`    PREREQUISITE [${prerequisite.code}]`);
    lines.push(indent(prerequisite.message, '        '));
    if (prerequisite.sql) lines.push(indent(prerequisite.sql, '        > '));
  }

  if (relation.statements.length > 0) {
    lines.push(
      relation.outcome === 'refused'
        ? '    statements it would run: none (read-only count shown for reference)'
        : '    statements, in order:'
    );
    for (const statement of relation.statements) {
      const flags = [
        statement.writes ? 'WRITES' : 'read-only',
        statement.batched ? 'BATCHED' : null,
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(
        `      [${statement.kind}] (${flags})${statement.note ? ` — ${statement.note}` : ''}`
      );
      lines.push(indent(statement.sql, '        '));
    }
  }
  lines.push('');
  return lines;
}

export interface FormatOptions {
  /** Include `satisfied` relations (a foreign key already exists). Off by default: on a
   *  full run that is ~437 of ~474 lines of "nothing to do". */
  verbose?: boolean;
}

export function formatPlan(plan: RemediationPlan, options: FormatOptions = {}): string {
  const { counts } = plan;
  const lines: string[] = [];

  lines.push('Foreign-key remediation plan (DRY RUN unless --apply was passed)');
  lines.push('');
  lines.push(`  relations considered           : ${counts.relationsConsidered}`);
  // 🔴 SPLIT ON PURPOSE. These used to be one "already enforced (no action)" line, which
  // reported every constraint the catalog could not vouch for as enforced — 408 of them
  // against the committed snapshot, which carries no `convalidated` data for a single
  // relation. That is the half-applied-constraint failure mode relocated from the live
  // path to the `--catalog` path, and it was reassuring in exactly the same way.
  lines.push(`  already enforced (validated)   : ${counts.satisfied}`);
  if (counts.validityUnknown > 0) {
    lines.push(`  🔴 constraint present, VALIDITY NOT ESTABLISHED : ${counts.validityUnknown}`);
    lines.push('     This catalog carries no convalidated data. A NOT VALID constraint is present');
    lines.push(
      '     but has never checked the rows that predate it, and is indistinguishable here'
    );
    lines.push('     from a validated one. Re-read from a live database to resolve.');
  }
  lines.push(`  READY                          : ${counts.ready}`);
  lines.push(`  NEEDS VALIDATION (resume)      : ${counts.needsValidation}`);
  lines.push(`  blocked on a prerequisite      : ${counts.blocked}`);
  lines.push(`  REFUSED                        : ${counts.refused}`);
  lines.push('');
  lines.push("  Orphan remediation, derived from each relation's declared onDelete:");
  lines.push(`    DELETE the orphan rows       : ${counts.deleteStrategy}`);
  lines.push(`    UPDATE ... SET NULL          : ${counts.nullStrategy}`);
  lines.push('');

  if (plan.unmatchedSelectors.length > 0) {
    lines.push(
      `  🔴 ${plan.unmatchedSelectors.length} selector(s) matched no declared relation: ` +
        `${plan.unmatchedSelectors.join(', ')}`
    );
    lines.push('     Every number above is about the relations that DID match, not these.');
    lines.push('');
  }

  const refusalCounts = new Map<string, number>();
  for (const relation of plan.relations) {
    for (const refusal of relation.refusals) {
      refusalCounts.set(refusal.code, (refusalCounts.get(refusal.code) ?? 0) + 1);
    }
  }
  if (refusalCounts.size > 0) {
    lines.push('  Refusals by reason:');
    for (const [code, n] of [...refusalCounts].sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${code.padEnd(32)} : ${n}`);
    }
    lines.push('');
  }

  // Which relations get a detail block by default.
  //
  // A `satisfied` relation carrying a refusal or an unmet prerequisite is NOT
  // nothing-to-do, and hiding it is what made the comment in plan.ts false. But listing
  // EVERY such relation regressed the other way: `constraint-validity-unknown` applies to
  // all 408 existing constraints at once against a catalog with no `convalidated` data, so
  // the default report grew to 6,529 lines and became byte-identical to `--verbose` — the
  // 68 relations an operator actually has to choose between were buried, and the flag
  // stopped meaning anything.
  //
  // The resolution is about GRANULARITY, not about hiding. `constraint-validity-unknown` is
  // a property of the CATALOG, not of any one relation — it is either true of all of them
  // or none — so it belongs in the summary, where it is stated loudly and unconditionally
  // above, and its per-relation detail belongs behind `--verbose`. Every other
  // prerequisite and every refusal is relation-specific and still shows by default.
  const catalogWide = (r: RelationPlan) =>
    r.refusals.length === 0 &&
    r.prerequisites.length > 0 &&
    r.prerequisites.every((p) => p.code === 'constraint-validity-unknown');

  const shown = plan.relations.filter(
    (r) =>
      options.verbose ||
      r.outcome !== 'satisfied' ||
      ((r.prerequisites.length > 0 || r.refusals.length > 0) && !catalogWide(r))
  );
  const order: Record<RelationPlan['outcome'], number> = {
    refused: 0,
    'needs-validation': 1,
    blocked: 2,
    ready: 3,
    satisfied: 4,
  };
  shown.sort((a, b) => order[a.outcome] - order[b.outcome] || a.key.localeCompare(b.key));

  for (const relation of shown) lines.push(...formatRelation(relation));

  lines.push(
    'Not decided by this tool: whether the orphan rows SHOULD be removed as a product ' +
      'matter, whether a referenced entity is soft-deleted rather than gone, whether an ' +
      'application-level cleanup already owns this relation, and the timing of a VALIDATE ' +
      'against a hot table. A READY outcome means the mechanics are safe, not that the ' +
      'change is right.\n\n' +
      '🔴 THIS TOOL HAS NO TRIGGER AWARENESS. It reads tables, columns, constraints and ' +
      'indexes, and nothing else. A trigger may already enforce what a constraint would, ' +
      'or may make the remediation itself fail — ImageResourceNew carries an AFTER DELETE ' +
      'trigger running REFRESH MATERIALIZED VIEW CONCURRENTLY, which cannot run inside a ' +
      'transaction, and ImageResourceNew.imageId plans as an ordinary cascade delete. ' +
      'Read the triggers on a table before remediating it.'
  );
  return lines.join('\n');
}
