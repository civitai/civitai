import { describe, expect, it } from 'vitest';
import { OWNED_REPORT_TABLES } from '@civitai/shared/report-subjects';
import { OWNED_REPORT_ENTITIES, REPORT_ENTITIES } from '../report-entities';

/** The main app checks who a report is about from the shared list; the queues here read their own. */
describe('report entities and the shared report-subject list', () => {
  const key = (e: { reportTable: string; fk: string; table: string; ownerColumn: string }) =>
    `${e.reportTable}.${e.fk} -> ${e.table}.${e.ownerColumn}`;

  it('name the same owned report types, joined the same way', () => {
    expect(OWNED_REPORT_ENTITIES.map(key).sort()).toEqual(OWNED_REPORT_TABLES.map(key).sort());
  });

  it('leave only the user and chat reports to be resolved separately', () => {
    const owned = new Set<string>(OWNED_REPORT_TABLES.map((e) => e.reportTable));
    expect(
      REPORT_ENTITIES.map((e) => e.reportTable)
        .filter((t) => !owned.has(t))
        .sort()
    ).toEqual(['ChatReport', 'UserReport']);
  });
});
