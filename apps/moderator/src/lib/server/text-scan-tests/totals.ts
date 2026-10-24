import { sql, type Kysely } from 'kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import type { Expected } from '../../text-scan-tests/expected';
import {
  scoreCase,
  summarise,
  type LabelSummary,
  type ResultStatus,
} from '../../text-scan-tests/score';

type Db = Kysely<ModeratorDB>;

export async function computeTotals(db: Db, runId: number): Promise<LabelSummary[]> {
  const rows = await db
    .selectFrom('text_scan_test_result as r')
    .innerJoin('text_scan_test_case as c', 'c.id', 'r.case_id')
    .select(['r.status', 'r.output', 'c.expected'])
    .where('r.run_id', '=', String(runId))
    .execute();
  return summarise(
    rows.map((r) =>
      scoreCase((r.expected ?? {}) as Expected, {
        status: r.status as ResultStatus,
        output: r.output,
      })
    )
  );
}

export async function refreshSetTotals(db: Db, setId: number): Promise<number> {
  const runs = await db
    .selectFrom('text_scan_test_run')
    .select('id')
    .where('set_id', '=', String(setId))
    .where('status', 'in', ['done', 'cancelled'])
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
    .execute();
  for (const r of runs)
    await db
      .updateTable('text_scan_test_run')
      .set({ totals: JSON.stringify(await computeTotals(db, Number(r.id))) })
      .where('id', '=', r.id)
      .execute();
  return runs.length;
}
