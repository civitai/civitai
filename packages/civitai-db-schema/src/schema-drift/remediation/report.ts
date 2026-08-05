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
  lines.push(`  already enforced (no action)   : ${counts.satisfied}`);
  lines.push(`  READY                          : ${counts.ready}`);
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

  const shown = plan.relations.filter((r) => options.verbose || r.outcome !== 'satisfied');
  const order = { refused: 0, blocked: 1, ready: 2, satisfied: 3 } as const;
  shown.sort((a, b) => order[a.outcome] - order[b.outcome] || a.key.localeCompare(b.key));

  for (const relation of shown) lines.push(...formatRelation(relation));

  lines.push(
    'Not decided by this tool: whether the orphan rows SHOULD be removed as a product ' +
      'matter, whether a referenced entity is soft-deleted rather than gone, whether an ' +
      'application-level cleanup already owns this relation, and the timing of a VALIDATE ' +
      'against a hot table. A READY outcome means the mechanics are safe, not that the ' +
      'change is right.'
  );
  return lines.join('\n');
}
