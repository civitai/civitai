import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { OWNED_REPORT_TABLES } from '@civitai/shared/report-subjects';

// The pglite tests build their tables from this list, so only the schema can show a misnamed column.
const schema = readFileSync(
  path.resolve(__dirname, '../../../../packages/civitai-db-schema/prisma/schema.full.prisma'),
  'utf8'
);

function fieldsOf(model: string) {
  const body = schema.match(new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm'))?.[1];
  if (!body) return null;
  return new Set(
    body
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => name && !name.startsWith('//') && !name.startsWith('@@'))
  );
}

describe('the shared report-subject list against the schema', () => {
  it.each(OWNED_REPORT_TABLES.map((t) => [`${t.reportTable} -> ${t.table}`, t] as const))(
    '%s names real columns',
    (_, { reportTable, fk, table, ownerColumn }) => {
      expect([...(fieldsOf(reportTable) ?? [])]).toEqual(expect.arrayContaining(['reportId', fk]));
      expect([...(fieldsOf(table) ?? [])]).toEqual(expect.arrayContaining(['id', ownerColumn]));
    }
  );
});
