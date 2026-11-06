import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import { expireDraftResults, purgeDeletedSources } from '../text-scan-tests/sources';
import {
  useMainDb,
  useTestSetsDb,
  resultsOf,
  seedCase,
  seedRun,
  seedSet,
} from './text-scan-tests-pglite.harness';

let db: Kysely<ModeratorDB>;
let main: Kysely<MainDB>;
let setId: number;

const sets = useTestSetsDb();
const mains = useMainDb();

beforeEach(async () => {
  ({ db } = sets);
  ({ main } = mains);
  setId = await seedSet(db);
});

describe('purgeDeletedSources', () => {
  it('wipes text and stored verdicts of cases whose source or author is gone, never free text', async () => {
    await main
      .insertInto('User')
      .values([{ id: 10 }, { id: 11, deletedAt: new Date() }] as never)
      .execute();
    await main
      .insertInto('CommentV2')
      .values([
        { id: 1, userId: 10 },
        { id: 3, userId: 11 },
      ] as never)
      .execute();
    const live = await seedCase(db, setId, { entityId: 1, authorId: 10 });
    const missing = await seedCase(db, setId, { entityId: 2, authorId: 10 });
    const authorGone = await seedCase(db, setId, { entityId: 3, authorId: 11 });
    const free = await seedCase(db, setId);
    const authorOnlyGone = await seedCase(db, setId, { authorId: 11 });
    const authorOnlyLive = await seedCase(db, setId, { authorId: 10 });
    const runId = await seedRun(db, setId, { status: 'done' });
    await db
      .insertInto('text_scan_test_result')
      .values(
        [live, missing].map((id) => ({
          run_id: String(runId),
          case_id: String(id),
          status: 'ok',
          output: '{"scam":{"reason":"quotes text"}}',
        }))
      )
      .execute();

    const before = await db.selectFrom('text_scan_test_case').selectAll().orderBy('id').execute();
    expect(await purgeDeletedSources(db, main, { write: false })).toEqual({ checked: 5, wiped: 3 });
    expect(await db.selectFrom('text_scan_test_case').selectAll().orderBy('id').execute()).toEqual(
      before
    );
    expect((await resultsOf(db, runId)).every((r) => r.output !== null)).toBe(true);

    expect(await purgeDeletedSources(db, main, { write: true })).toEqual({ checked: 5, wiped: 3 });
    const cases = await db
      .selectFrom('text_scan_test_case')
      .select(['id', 'fields'])
      .orderBy('id')
      .execute();
    expect(cases.map((c) => [Number(c.id), c.fields === null])).toEqual([
      [live, false],
      [missing, true],
      [authorGone, true],
      [free, false],
      [authorOnlyGone, true],
      [authorOnlyLive, false],
    ]);
    const outputs = new Map((await resultsOf(db, runId)).map((r) => [Number(r.case_id), r.output]));
    expect(outputs.get(missing)).toBeNull();
    expect(outputs.get(live)).not.toBeNull();
  });
});

describe('purgeDeletedSources and the retired ModelRules entity type', () => {
  it('still wipes a stored ModelRules case once its model is gone', async () => {
    await main
      .insertInto('User')
      .values([{ id: 10 }] as never)
      .execute();
    await main
      .insertInto('Model')
      .values([{ id: 7, userId: 10 }] as never)
      .execute();
    const live = await seedCase(db, setId, { entityType: 'ModelRules', entityId: 7, authorId: 10 });
    const gone = await seedCase(db, setId, { entityType: 'ModelRules', entityId: 8, authorId: 10 });

    expect(await purgeDeletedSources(db, main, { write: true })).toEqual({ checked: 2, wiped: 1 });
    const cases = await db
      .selectFrom('text_scan_test_case')
      .select(['id', 'fields'])
      .orderBy('id')
      .execute();
    expect(cases.map((c) => [Number(c.id), c.fields === null])).toEqual([
      [live, false],
      [gone, true],
    ]);
  });
});

describe('expireDraftResults', () => {
  it('drops expired draft results and keeps the run, its totals and every baseline', async () => {
    const caseId = await seedCase(db, setId);
    const expired = await seedRun(db, setId, {
      kind: 'draft',
      status: 'done',
      expiresAt: new Date('2026-01-01'),
      totals: [{ label: 'scam', scored: 1, passed: 1 }],
    });
    const current = await seedRun(db, setId, {
      kind: 'draft',
      status: 'done',
      expiresAt: new Date('2099-01-01'),
    });
    const baseline = await seedRun(db, setId, { status: 'done' });
    for (const runId of [expired, current, baseline])
      await db
        .insertInto('text_scan_test_result')
        .values({ run_id: String(runId), case_id: String(caseId), status: 'ok', output: '{}' })
        .execute();

    expect(await expireDraftResults(db, { write: false })).toEqual({ runs: 1, results: 1 });
    expect(await resultsOf(db, expired)).toHaveLength(1);
    expect(await expireDraftResults(db, { write: true })).toEqual({ runs: 1, results: 1 });
    expect(await resultsOf(db, expired)).toHaveLength(0);
    expect(await resultsOf(db, current)).toHaveLength(1);
    expect(await resultsOf(db, baseline)).toHaveLength(1);
    const run = await db
      .selectFrom('text_scan_test_run')
      .select('totals')
      .where('id', '=', String(expired))
      .executeTakeFirstOrThrow();
    expect(run.totals).toEqual([{ label: 'scam', scored: 1, passed: 1 }]);
  });
});
