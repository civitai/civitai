import { sql, type Kysely } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB as ModeratorDB } from '../moderator-db/types';
import type * as IntentSet from '$lib/text-scan-tests/intent-set';
import { MOD, seedCase, seedRun, seedSet, useTestSetsDb } from './text-scan-tests-pglite.harness';

// Ids restart per test, so the first set seeded is the pinned one.
const PINNED = 1;
vi.mock('$lib/text-scan-tests/intent-set', async (importOriginal) => ({
  ...(await importOriginal<typeof IntentSet>()),
  INTENT_EVAL_SET_ID: PINNED,
  isIntentEvalSet: (setId: number) => setId === PINNED,
}));

const { checkIntentPublish } = await import('../text-scan-tests/publish-gate');

const KEY = 'label:model-com-face-intent';
const TEXT = 'synthetic intent draft';
const OTHER_MOD = 990200014;
const live = {
  active: { base: { id: 1, key: 'base', content: 'synthetic base' } },
  config: { model: 'model-a', maxInputChars: 1000, thinking: false },
};

let db: Kysely<ModeratorDB>;
const sets = useTestSetsDb();

beforeEach(async () => {
  ({ db } = sets);
  expect(await seedSet(db, { name: 'pinned' })).toBe(PINNED);
});

const intentCase = (expected: boolean | undefined) =>
  seedCase(db, PINNED, {
    entityType: 'Model',
    expected: expected === undefined ? {} : { 'model-com-face-intent': expected },
  });

const draftRun = (over: Parameters<typeof seedRun>[2] = {}) =>
  seedRun(db, PINNED, {
    kind: 'draft',
    status: 'done',
    promptIds: { base: 1, 'model-com-face-intent': 0 },
    promptOverrides: { [KEY]: TEXT },
    ...over,
  });

const answer = (runId: number, caseId: number, detected: boolean | null, status = 'ok') =>
  db
    .insertInto('text_scan_test_result')
    .values({
      run_id: String(runId),
      case_id: String(caseId),
      status,
      output:
        status === 'ok'
          ? JSON.stringify(detected === null ? {} : { 'model-com-face-intent': { detected } })
          : null,
    })
    .execute();

/** Two cases, one expected detected and one expected clear, both answered right by one run. */
async function passingRun(over: Parameters<typeof seedRun>[2] = {}) {
  const yes = await intentCase(true);
  const no = await intentCase(false);
  const run = await draftRun(over);
  await answer(run, yes, true);
  await answer(run, no, false);
  return { run, yes, no };
}

const check = (content = TEXT, userId = MOD, liveState = live) =>
  checkIntentPublish(db, { content, userId, live: liveState });

describe('checkIntentPublish', () => {
  it("passes the saver's own finished run of the same text that meets the bar", async () => {
    const { run } = await passingRun();
    expect(await check()).toEqual({ ok: true, runId: run });
  });

  it('refuses text with no run', async () => {
    await intentCase(true);
    expect(await check()).toMatchObject({ ok: false });
  });

  it('refuses a run of other text, even one byte off', async () => {
    await passingRun();
    expect(await check(TEXT + ' ')).toMatchObject({ ok: false });
  });

  it('refuses a run that cleared an expected-detected case', async () => {
    const yes = await intentCase(true);
    const run = await draftRun();
    await answer(run, yes, false);
    expect(await check()).toMatchObject({ ok: false, reason: expect.stringMatching(/cleared 1/) });
  });

  it('refuses a run that flagged an expected-clear case', async () => {
    const no = await intentCase(false);
    const run = await draftRun();
    await answer(run, no, true);
    expect(await check()).toMatchObject({ ok: false, reason: expect.stringMatching(/flagged 1/) });
  });

  it('refuses a run missing a current case: added after it, unanswered, or errored', async () => {
    await passingRun();
    await intentCase(true);
    expect(await check()).toMatchObject({ ok: false, reason: expect.stringMatching(/missing/) });
  });

  it('refuses a run whose verdict for a case errored or had no answer', async () => {
    const yes = await intentCase(true);
    const no = await intentCase(false);
    const run = await draftRun();
    await answer(run, yes, null);
    await answer(run, no, null, 'error');
    expect(await check()).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/missing.* 2 /),
    });
  });

  it('refuses a run when a case changed after it', async () => {
    const { yes } = await passingRun();
    await sql`UPDATE text_scan_test_case SET updated_at = now() + interval '1 minute' WHERE id = ${yes}`.execute(
      db
    );
    expect(await check()).toMatchObject({ ok: false });
  });

  it('refuses a run under another base prompt, model or thinking setting', async () => {
    await passingRun();
    const base2 = { ...live, active: { base: { ...live.active.base, id: 2 } } };
    expect(await check(TEXT, MOD, base2)).toMatchObject({ ok: false });
    expect(
      await check(TEXT, MOD, { ...live, config: { ...live.config, model: 'model-b' } })
    ).toMatchObject({ ok: false });
    expect(
      await check(TEXT, MOD, { ...live, config: { ...live.config, thinking: true } })
    ).toMatchObject({ ok: false });
  });

  it('refuses a run someone else started, and a run that has not finished', async () => {
    await passingRun({ runBy: OTHER_MOD });
    expect(await check()).toMatchObject({ ok: false });
    await sql`UPDATE text_scan_test_run SET run_by = ${MOD}, status = 'running'`.execute(db);
    expect(await check()).toMatchObject({ ok: false });
  });

  it('refuses a run whose scan of a case with no intent expectation errored', async () => {
    const unlabelled = await intentCase(undefined);
    const { run } = await passingRun();
    await answer(run, unlabelled, null, 'error');
    expect(await check()).toMatchObject({ ok: false, reason: expect.stringMatching(/missing/) });
  });

  it('ignores a case with no intent expectation once it has a verdict', async () => {
    const unlabelled = await intentCase(undefined);
    const { run } = await passingRun();
    await answer(run, unlabelled, true);
    expect(await check()).toEqual({ ok: true, runId: run });
  });
});
