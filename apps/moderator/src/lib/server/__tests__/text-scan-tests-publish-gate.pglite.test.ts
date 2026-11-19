import { sql, type Kysely } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB as ModeratorDB } from '../moderator-db/types';
import { LAB_LABELS, type LabEntityType } from '$lib/text-scan-lab/types';
import type * as IntentSet from '$lib/text-scan-tests/intent-set';
import { MOD, seedCase, seedRun, seedSet, useTestSetsDb } from './text-scan-tests-pglite.harness';

// Ids restart per test, so the first set seeded is the pinned one.
const PINNED = 1;
vi.mock('$lib/text-scan-tests/intent-set', async (importOriginal) => {
  const real = await importOriginal<typeof IntentSet>();
  const isIntentEvalSet = (setId: number) => setId === PINNED;
  return {
    ...real,
    INTENT_EVAL_SET_ID: PINNED,
    isIntentEvalSet,
    caseLabels: (setId: number, entityType: LabEntityType) =>
      isIntentEvalSet(setId) ? real.INTENT_LABELS : LAB_LABELS[entityType],
  };
});

vi.mock('../user-actions.service', () => ({
  callModEndpoint: vi.fn(),
  callModEndpointAs: vi.fn(),
  readModEndpoint: vi.fn(),
  requestCookie: vi.fn(() => null),
}));

const { checkIntentPublish, checkLiveIntent } = await import('../text-scan-tests/publish-gate');
const { rerunErrors } = await import('../text-scan-tests/runs');
const { upsertCase } = await import('../text-scan-tests/store');

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

const intentCase = (expected: boolean | undefined, entityId?: number) =>
  seedCase(db, PINNED, {
    entityType: 'Model',
    entityId,
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

  it('refuses a passing run of the text on another set', async () => {
    const other = await seedSet(db);
    const yes = await intentCase(true);
    const run = await seedRun(db, other, {
      kind: 'draft',
      status: 'done',
      promptIds: { base: 1, 'model-com-face-intent': 0 },
      promptOverrides: { [KEY]: TEXT },
    });
    await answer(run, yes, true);
    expect(await check()).toMatchObject({ ok: false });
  });

  it('judges the latest run of the text: a newer failing run beats an older pass', async () => {
    const { yes, no } = await passingRun();
    const newer = await draftRun();
    await answer(newer, yes, false);
    await answer(newer, no, false);
    expect(await check()).toMatchObject({ ok: false, reason: expect.stringMatching(/cleared 1/) });
  });

  it('refuses a run that also drafted the base prompt', async () => {
    await passingRun({
      promptIds: { base: 1, 'model-com-face-intent': 0 },
      promptOverrides: { [KEY]: TEXT, base: 'synthetic base draft' },
    });
    expect(await check()).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/another prompt/),
    });
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

  it('refuses a run when an import changes a case expectation after it', async () => {
    const yes = await intentCase(true, 11);
    const no = await intentCase(false);
    const run = await draftRun();
    await answer(run, yes, true);
    await answer(run, no, false);
    expect(await check()).toMatchObject({ ok: true });
    const [row] = await db
      .selectFrom('text_scan_test_case')
      .select('fields')
      .where('id', '=', String(yes))
      .execute();
    await upsertCase(
      db,
      {
        setId: PINNED,
        entityType: 'Model',
        entityId: 11,
        authorId: null,
        sourceRef: null,
        fields: row.fields as never,
        expected: { 'model-com-face-intent': false },
        note: null,
        origin: 'import',
      },
      MOD
    );
    expect(await check()).toMatchObject({ ok: false, reason: expect.stringMatching(/changed/) });
  });
});

describe('re-running a pinned-set run', () => {
  it('is refused to anyone but the moderator who started it', async () => {
    const yes = await intentCase(true);
    const run = await draftRun({ runBy: OTHER_MOD });
    await answer(run, yes, null, 'error');
    const deps = { db, getPrompts: vi.fn(), quoteTexts: vi.fn(), launch: vi.fn(), audit: vi.fn() };
    await expect(rerunErrors(deps, PINNED, run, MOD)).rejects.toMatchObject({ status: 403 });
    const [after] = await db.selectFrom('text_scan_test_run').select('run_by').execute();
    expect(after.run_by).toBe(OTHER_MOD);
  });
});

describe('checkLiveIntent', () => {
  const liveWith = (intentId: number, content = TEXT) => ({
    ...live,
    active: { ...live.active, [KEY]: { id: intentId, key: KEY, content } },
  });

  it('verifies the live version by a passing baseline of it, by anyone', async () => {
    const { run } = await passingRun({
      kind: 'baseline',
      runBy: OTHER_MOD,
      promptIds: { base: 1, 'model-com-face-intent': 5 },
    });
    expect(await checkLiveIntent(db, liveWith(5, 'synthetic live'))).toEqual({
      ok: true,
      runId: run,
    });
  });

  it('verifies it by a passing draft run of the same text', async () => {
    const { run } = await passingRun({ runBy: OTHER_MOD });
    expect(await checkLiveIntent(db, liveWith(6))).toEqual({ ok: true, runId: run });
  });

  it('verifies a topped-up baseline: a case added after the run row, scanned since', async () => {
    const { run } = await passingRun({
      kind: 'baseline',
      promptIds: { base: 1, 'model-com-face-intent': 5 },
    });
    const added = await intentCase(true);
    await answer(run, added, true);
    expect(await checkLiveIntent(db, liveWith(5, 'x'))).toEqual({ ok: true, runId: run });
  });

  it('marks a restored version with no run of its own unverified', async () => {
    await passingRun({ kind: 'baseline', promptIds: { base: 1, 'model-com-face-intent': 5 } });
    expect(await checkLiveIntent(db, liveWith(4, 'synthetic older text'))).toMatchObject({
      ok: false,
    });
  });

  it('marks it unverified when its run no longer meets the bar under the live base', async () => {
    await passingRun({ kind: 'baseline', promptIds: { base: 1, 'model-com-face-intent': 5 } });
    const moved = {
      ...liveWith(5, 'x'),
      active: { ...liveWith(5, 'x').active, base: { id: 2, key: 'base', content: 'b' } },
    };
    expect(await checkLiveIntent(db, moved)).toMatchObject({ ok: false });
  });
});
