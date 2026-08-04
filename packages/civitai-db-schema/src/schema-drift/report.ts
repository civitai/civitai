import type { DriftFinding, DriftKind, DriftReport } from './types';

const KIND_TITLES: Record<DriftKind, string> = {
  'missing-foreign-key': 'Missing foreign keys (declared in the schema, absent in the database)',
  'referential-action':
    'Referential-action drift (foreign key present, ON DELETE/UPDATE differs from the schema)',
  'missing-column': 'Missing columns (declared in the schema, absent from the table)',
  nullability: 'Nullability drift (schema optionality vs column NOT NULL)',
  uniqueness: 'Uniqueness drift (@unique/@@unique with no total unique index)',
};

const KIND_ORDER: DriftKind[] = [
  'missing-foreign-key',
  'referential-action',
  'missing-column',
  'nullability',
  'uniqueness',
];

function label(finding: DriftFinding): string {
  return `${finding.table}.${finding.columns.join('+')}`;
}

/** Render a report as text for a terminal or a CI log. */
export function formatReport(report: DriftReport, options: { verbose?: boolean } = {}): string {
  const { counts } = report;
  const lines: string[] = [];

  lines.push('Schema <-> database drift');
  lines.push('');
  lines.push('Relations');
  lines.push(`  declared owning-side relations : ${counts.declaredRelations}`);
  lines.push(`  checked against the database   : ${counts.relationsChecked}`);
  lines.push(`  skipped (view / absent table)  : ${counts.relationsSkipped}`);
  lines.push(`  MISSING foreign key            : ${counts.missingForeignKeys}`);
  lines.push(`  wrong referential action       : ${counts.referentialActionDrifts}`);
  if (counts.referentialActionUnknown > 0) {
    lines.push(
      `  action not comparable          : ${counts.referentialActionUnknown} (catalog carried no ON DELETE/UPDATE data)`
    );
  }
  lines.push('');
  lines.push('Columns');
  lines.push(`  MISSING column                 : ${counts.missingColumns}`);
  lines.push(`  nullability checked            : ${counts.columnsChecked}`);
  lines.push(`  nullability drift              : ${counts.nullabilityDrifts}`);
  lines.push('');
  lines.push('Uniqueness');
  lines.push(`  declarations checked           : ${counts.uniqueDeclarationsChecked}`);
  lines.push(`  missing unique index           : ${counts.uniquenessDrifts}`);
  lines.push('');

  for (const kind of KIND_ORDER) {
    const findings = report.findings.filter((f) => f.kind === kind);
    if (findings.length === 0) continue;
    lines.push(`${KIND_TITLES[kind]} — ${findings.length}`);
    const sorted = [...findings].sort((a, b) => label(a).localeCompare(label(b)));
    for (const finding of sorted) {
      lines.push(`  ${label(finding)}`);
      lines.push(`      declared: ${finding.declared}`);
      lines.push(`      database: ${finding.actual}`);
      if (finding.detail) lines.push(`      note: ${finding.detail}`);
    }
    lines.push('');
  }

  if (options.verbose && report.skippedModels.length > 0) {
    lines.push(`Skipped models — ${report.skippedModels.length}`);
    for (const skipped of [...report.skippedModels].sort((a, b) =>
      a.model.localeCompare(b.model)
    )) {
      lines.push(`  ${skipped.model} (${skipped.table}): ${skipped.reason}`);
    }
    lines.push('');
  }

  lines.push(
    'Not checked by this tool: check constraints, column defaults, column types, enum ' +
      'values, non-unique indexes, PRIMARY KEYS (@id / @@id — the uniqueness section above ' +
      'covers @unique/@@unique only), columns and tables present in the database but not ' +
      'the schema, whether a foreign key points at the table the schema names, and ' +
      'PROGRAMMABILITY (views, functions, triggers — a deployed view can emit columns its ' +
      'committed definition does not). Their absence from this report is not evidence that ' +
      'they are clean — they are not audited at all.'
  );

  return lines.join('\n');
}
