import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LabScanResult, LabText } from '$lib/text-scan-lab/types';

/**
 * Test-set runs over the REAL `text-scan-lab/schema.sql`, with only the harness faked: what a
 * failed chunk, a deleted source or a re-run leaves behind is rows and statuses, which only a real table
 * can show.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '../../../../text-scan-lab/schema.sql'), 'utf8');

const holder = vi.hoisted(() => ({ pg: null as PGlite | null }));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));
vi.mock('../moderator-db', async () => {
  const { Kysely } = await import('kysely');
  const { pgliteDialect } = await import('./abuse-detection-pglite.harness');
  let db: unknown;
  let bound: PGlite | null = null;
  return {
    getModeratorDb: () => {
      if (bound !== holder.pg) {
        bound = holder.pg;
        db = new Kysely({ dialect: pgliteDialect(holder.pg!) });
      }
      return db;
    },
  };
});

const harness = vi.hoisted(() => ({
  scanTexts: vi.fn(),
  getPrompts: vi.fn(),
}));
vi.mock('../text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../text-scan-lab/harness-client')>()),
  ...harness,
}));

// The purge's own behaviour is text-scan-purge.pglite.test.ts; here only that a run purges first.
const purge = vi.hoisted(() => ({ purgeDeletedSources: vi.fn() }));
vi.mock('../text-scan-lab/purge.service', () => purge);

const { LabHarnessError } = await import('../text-scan-lab/harness-client');
const { createDraft, saveWorkingCopy, updateDraft } = await import(
  '../text-scan-lab/drafts.service'
);
const { addCase, createSet, updateExpected } = await import('../text-scan-lab/test-sets.service');
const {
  RUN_STALE_MS,
  RunError,
  casesPerSecond,
  compareRuns,
  getRunOutcome,
  getRunProgress,
  latestRunTotals,
  listRuns,
  prepareRerun,
  prepareRun,
  rerunErrors,
  startRun,
} = await import('../text-scan-lab/runs.service');

const MOD = 990001;
const PROMPT_IDS = { base: 1, nsfw: 2 };

const okResult = (key: string, level = 'r'): LabScanResult => ({
  key,
  ok: true,
  workflowId: `wf-${key}`,
  promptIds: PROMPT_IDS,
  output: { nsfw: { level, reason: 'fake' } },
  elapsedMs: 5,
});
/** Every text scans ok at `level`. */
const allOk =
  (level = 'r') =>
  async (_type: string, texts: LabText[]) =>
    texts.map((t) => okResult(t.key, level));

beforeEach(async () => {
  vi.clearAllMocks();
  holder.pg = await PGlite.create();
  await holder.pg.exec(SCHEMA);
  purge.purgeDeletedSources.mockResolvedValue({ checked: 0, wiped: 0 });
  harness.getPrompts.mockResolvedValue({
    active: {
      base: { id: 1, key: 'base', content: 'BASE PROMPT' },
      'label:nsfw': { id: 2, key: 'label:nsfw', content: 'NSFW DEF' },
    },
    config: { model: 'fake-model', maxInputChars: 1000, thinking: false },
  });
});

async function setWithCases(n: number) {
  const set = await createSet({ name: 'calibration', description: null }, MOD);
  const caseIds: number[] = [];
  for (let i = 1; i <= n; i++) {
    const { case: c } = await addCase(
      {
        setId: set.id,
        entityType: 'Model',
        entityId: i,
        authorId: 7,
        fields: [{ heading: 'Name', text: `model ${i}` }],
        expected: { nsfw: { min: 'r', max: 'x' } },
        synthetic: false,
        note: null,
      },
      MOD
    );
    caseIds.push(c.id);
  }
  return { setId: set.id, caseIds };
}

const results = async (runId: number) =>
  (
    await holder.pg!.query<{ case_id: string; status: string; output: any }>(
      'SELECT case_id, status, output FROM text_scan_test_result WHERE run_id = $1 ORDER BY case_id',
      [runId]
    )
  ).rows;
const runRow = async (runId: number) =>
  (await holder.pg!.query<any>('SELECT * FROM text_scan_test_run WHERE id = $1', [runId])).rows[0];

describe('startRun', () => {
  it('scores ok results and records what ran', async () => {
    const { setId, caseIds } = await setWithCases(2);
    harness.scanTexts.mockImplementation(async (_t: string, texts: LabText[]) => [
      okResult(texts[0].key, 'x'),
      okResult(texts[1].key, 'pg13'),
    ]);

    const run = await startRun({ setId, version: 'active' }, MOD);

    expect(harness.scanTexts).toHaveBeenCalledWith(
      'Model',
      [
        { key: String(caseIds[0]), fields: [{ heading: 'Name', text: 'model 1' }] },
        { key: String(caseIds[1]), fields: [{ heading: 'Name', text: 'model 2' }] },
      ],
      undefined,
      { keyLabel: 'case' }
    );
    expect((await results(run.id)).map((r) => [r.status, r.output.nsfw.level])).toEqual([
      ['ok', 'x'],
      ['ok', 'pg13'],
    ]);
    const row = await runRow(run.id);
    expect(row).toMatchObject({
      status: 'done',
      version: 'active',
      prompts: null,
      prompt_ids: PROMPT_IDS,
      model: 'fake-model',
    });
    expect(row.finished_at).not.toBeNull();
    expect(row.totals.nsfw).toMatchObject({ scored: 2, correct: 1, tp: 1, fn: 1 });
  });

  it('stores a case whose source was deleted as skipped and never scans it', async () => {
    const { setId, caseIds } = await setWithCases(2);
    await holder.pg!.query(
      'UPDATE text_scan_test_case SET fields = NULL, source_deleted_at = now() WHERE id = $1',
      [caseIds[0]]
    );
    harness.scanTexts.mockImplementation(allOk());

    const run = await startRun({ setId, version: 'active' }, MOD);

    expect(harness.scanTexts.mock.calls[0][1].map((t: LabText) => t.key)).toEqual([
      String(caseIds[1]),
    ]);
    expect((await results(run.id)).map((r) => r.status)).toEqual(['skipped', 'ok']);
    expect((await runRow(run.id)).totals.nsfw.scored).toBe(1);
  });

  it('stores a chunk whose harness call throws as errors and still finishes the run', async () => {
    const { setId } = await setWithCases(60);
    harness.scanTexts
      .mockImplementationOnce(allOk())
      .mockRejectedValueOnce(new LabHarnessError('orchestrator down'));

    const run = await startRun({ setId, version: 'active' }, MOD);

    expect(harness.scanTexts).toHaveBeenCalledTimes(2);
    expect(harness.scanTexts.mock.calls.map((c) => c[1].length)).toEqual([50, 10]);
    const rows = await results(run.id);
    expect(rows.filter((r) => r.status === 'ok')).toHaveLength(50);
    const errors = rows.filter((r) => r.status === 'error');
    expect(errors).toHaveLength(10);
    expect(errors[0].output).toEqual({ error: 'orchestrator down' });
    const row = await runRow(run.id);
    expect(row.status).toBe('done');
    expect(row.totals.nsfw.scored).toBe(50);
  });

  it('marks the run failed when every item errored, without retrying a refused first request', async () => {
    const { setId } = await setWithCases(60);
    harness.scanTexts.mockRejectedValue(new LabHarnessError('Not allowed'));

    const run = await startRun({ setId, version: 'active' }, MOD);

    expect(harness.scanTexts).toHaveBeenCalledTimes(1);
    expect(run.status).toBe('failed');
    const rows = await results(run.id);
    expect(rows).toHaveLength(60);
    expect(rows.every((r) => r.status === 'error' && r.output.error === 'Not allowed')).toBe(true);
  });

  it('a refused first chunk errors the rest of the type without sending it', async () => {
    const { setId } = await setWithCases(150);
    harness.scanTexts.mockRejectedValue(new LabHarnessError('chunk 1 refused'));

    const run = await startRun({ setId, version: 'active' }, MOD);

    expect(harness.scanTexts).toHaveBeenCalledTimes(1);
    expect(harness.scanTexts.mock.calls[0][3]).toEqual({ keyLabel: 'case' });
    const statuses = (await results(run.id)).map((r) => r.status);
    expect(statuses.filter((s) => s === 'error')).toHaveLength(150);
    expect(run.status).toBe('failed');
  });

  it('a refusal after the first chunk does not stop the type', async () => {
    const { setId } = await setWithCases(150);
    harness.scanTexts
      .mockImplementation(allOk())
      .mockImplementationOnce(allOk())
      .mockImplementationOnce(async () => {
        throw new LabHarnessError('case 60: too big');
      });

    const run = await startRun({ setId, version: 'active' }, MOD);

    expect(harness.scanTexts).toHaveBeenCalledTimes(3);
    const rows = await results(run.id);
    expect(rows.filter((r) => r.status === 'error')).toHaveLength(50);
    expect(rows.filter((r) => r.status === 'ok')).toHaveLength(100);
  });

  it("keeps scanning another entity type after one type's first request is refused", async () => {
    const { setId } = await setWithCases(1);
    await addCase(
      {
        setId,
        entityType: 'Comment',
        entityId: 5,
        authorId: null,
        fields: [{ heading: 'Comment', text: 'buy now' }],
        expected: {},
        synthetic: false,
        note: null,
      },
      MOD
    );
    harness.scanTexts.mockImplementation(async (type: string, texts: LabText[]) => {
      if (type === 'Model') throw new LabHarnessError('Model refused');
      return texts.map((t) => okResult(t.key));
    });

    const run = await startRun({ setId, version: 'active' }, MOD);

    expect(harness.scanTexts.mock.calls.map((c) => c[0])).toEqual(['Model', 'Comment']);
    expect((await results(run.id)).map((r) => r.status)).toEqual(['error', 'ok']);
    expect(run.status).toBe('done');
  });

  it("stores a failed workflow's orchestrator error verbatim, with its workflow id", async () => {
    const { setId } = await setWithCases(1);
    harness.scanTexts.mockImplementation(async (_t: string, texts: LabText[]) => [
      {
        key: texts[0].key,
        ok: false,
        error: 'workflow wf-x failed: model not found',
        workflowId: 'wf-x',
      },
    ]);
    const run = await startRun({ setId, version: 'active' }, MOD);
    const row = (
      await holder.pg!.query<{ output: any; workflow_id: string }>(
        'SELECT output, workflow_id FROM text_scan_test_result WHERE run_id = $1',
        [run.id]
      )
    ).rows[0];
    expect(row).toEqual({
      output: { error: 'workflow wf-x failed: model not found' },
      workflow_id: 'wf-x',
    });
  });

  it('stores an unparsed reply as an error', async () => {
    const { setId } = await setWithCases(1);
    harness.scanTexts.mockImplementation(async (_t: string, texts: LabText[]) => [
      { ...okResult(texts[0].key), output: null, parseError: 'not JSON' },
    ]);
    const run = await startRun({ setId, version: 'active' }, MOD);
    expect((await results(run.id))[0]).toMatchObject({
      status: 'error',
      output: { error: 'Unparsed reply: not JSON' },
    });
    expect(run.status).toBe('failed');
  });

  it("runs a draft with its overrides and records them and the draft's version", async () => {
    const { setId } = await setWithCases(1);
    const draft = await createDraft(
      { name: 'd', prompts: { 'label:nsfw': 'NSFW DRAFT' }, note: null },
      MOD
    );
    harness.scanTexts.mockImplementation(allOk());

    const run = await startRun({ setId, version: draft.id }, MOD);

    expect(harness.scanTexts.mock.calls[0][2]).toEqual({ 'label:nsfw': 'NSFW DRAFT' });
    const row = await runRow(run.id);
    expect(row).toMatchObject({
      version: String(draft.id),
      prompts: { 'label:nsfw': 'NSFW DRAFT' },
    });
    expect(Number(row.draft_id)).toBe(draft.id);
    expect(new Date(row.draft_updated_at).getTime()).toBe(draft.updatedAt.getTime());
  });

  it('refuses a draft with a blank prompt, naming the key, before anything is written', async () => {
    const { setId } = await setWithCases(1);
    const {
      rows: [{ id }],
    } = await holder.pg!.query<{ id: string }>(
      `INSERT INTO text_scan_prompt_draft (name, prompts, created_by, updated_by)
       VALUES ('blank', '{"label:poi": "  "}', 1, 1) RETURNING id`
    );

    await expect(startRun({ setId, version: Number(id) }, MOD)).rejects.toThrow(
      /label:poi is empty/
    );
    expect(harness.scanTexts).not.toHaveBeenCalled();
    expect((await holder.pg!.query('SELECT 1 FROM text_scan_test_run')).rows).toHaveLength(0);
  });

  it('refuses a set over the run limit', async () => {
    const { setId } = await setWithCases(0);
    await holder.pg!.query(
      `INSERT INTO text_scan_test_case (set_id, entity_type, entity_id, fields, text_hash, added_by)
       SELECT $1, 'Model', g, '[{"heading":"Name","text":"t"}]', 'h', 1 FROM generate_series(1, 501) g`,
      [setId]
    );
    const refusal = startRun({ setId, version: 'active' }, MOD);
    await expect(refusal).rejects.toBeInstanceOf(RunError);
    await expect(refusal).rejects.toThrow(/501 cases/);
    expect(harness.scanTexts).not.toHaveBeenCalled();
  });
});

describe('purging deleted sources first', () => {
  /** Stands in for the purge finding the first case's source deleted. */
  const wipeFirst = (caseId: number) =>
    purge.purgeDeletedSources.mockImplementation(async () => {
      await holder.pg!.query(
        'UPDATE text_scan_test_case SET fields = NULL, source_deleted_at = now() WHERE id = $1',
        [caseId]
      );
      return { checked: 1, wiped: 1 };
    });

  it('purges the set before a run reads its cases, so a just-deleted source is skipped', async () => {
    const { setId, caseIds } = await setWithCases(2);
    wipeFirst(caseIds[0]);
    harness.scanTexts.mockImplementation(allOk());

    const run = await startRun({ setId, version: 'active' }, MOD);

    expect(purge.purgeDeletedSources).toHaveBeenCalledWith(expect.anything(), setId);
    expect(harness.scanTexts.mock.calls[0][1].map((t: LabText) => t.key)).toEqual([
      String(caseIds[1]),
    ]);
    expect((await results(run.id)).map((r) => r.status)).toEqual(['skipped', 'ok']);
  });

  it('purges before planning, so a wiped case is not counted', async () => {
    const { setId, caseIds } = await setWithCases(12);
    wipeFirst(caseIds[0]);
    expect(await prepareRun({ setId, version: 'active' }, MOD)).toMatchObject({
      count: 11,
      skipped: 1,
    });
  });

  it('starts no run when the purge fails', async () => {
    const { setId } = await setWithCases(1);
    purge.purgeDeletedSources.mockRejectedValue(new Error('main db down'));
    await expect(startRun({ setId, version: 'active' }, MOD)).rejects.toThrow('main db down');
    expect(harness.scanTexts).not.toHaveBeenCalled();
    const { rows } = await holder.pg!.query('SELECT 1 FROM text_scan_test_run');
    expect(rows).toHaveLength(0);
  });
});

describe('prepareRun', () => {
  it('counts every case with text, whatever its entity type, and starts nothing', async () => {
    const { setId } = await setWithCases(10);
    await addCase(
      {
        setId,
        entityType: 'Comment',
        entityId: 99,
        authorId: null,
        fields: [{ heading: 'Comment', text: 'buy now' }],
        expected: {},
        synthetic: false,
        note: null,
      },
      MOD
    );
    const prepared = await prepareRun({ setId, version: 'active' }, MOD);
    expect(prepared).toMatchObject({ count: 11, skipped: 0 });
    expect(harness.scanTexts).not.toHaveBeenCalled();
    const { rows } = await holder.pg!.query('SELECT 1 FROM text_scan_test_run');
    expect(rows).toHaveLength(0);
  });

  it("runs the moderator's own working copy, recording its prompts", async () => {
    const { setId } = await setWithCases(1);
    const mine = (await saveWorkingCopy(MOD, { 'label:nsfw': 'MY NSFW' }, null))!;
    harness.scanTexts.mockImplementation(allOk());

    const run = await (
      await (await prepareRun({ setId, version: mine.id }, MOD)).execute(MOD)
    ).finished;

    expect(harness.scanTexts.mock.calls[0][2]).toEqual({ 'label:nsfw': 'MY NSFW' });
    expect(run).toMatchObject({ version: String(mine.id), draftId: mine.id });
    expect((await runRow(run.id)).prompts).toEqual({ 'label:nsfw': 'MY NSFW' });
  });

  it("refuses another moderator's working copy as if it did not exist", async () => {
    const { setId } = await setWithCases(1);
    const theirs = (await saveWorkingCopy(MOD + 1, { 'label:nsfw': 'THEIR NSFW' }, null))!;

    for (const attempt of [
      prepareRun({ setId, version: theirs.id }, MOD),
      startRun({ setId, version: theirs.id }, MOD),
    ]) {
      await expect(attempt).rejects.toBeInstanceOf(RunError);
      await expect(attempt).rejects.toThrow(`Draft ${theirs.id} not found.`);
    }
    expect(harness.scanTexts).not.toHaveBeenCalled();
  });

  it("stamps the case count and the draft's version, so either changing voids a confirmation", async () => {
    const { setId } = await setWithCases(2);
    const draft = await createDraft({ name: 'd', prompts: { 'label:nsfw': 'A' }, note: null }, MOD);
    const before = (await prepareRun({ setId, version: draft.id }, MOD)).stamp;
    expect(before).toBe(`2:${draft.updatedAt.toISOString()}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await updateDraft(
      draft.id,
      { prompts: { 'label:nsfw': 'B' }, note: null, expectedUpdatedAt: draft.updatedAt },
      MOD
    );
    expect((await prepareRun({ setId, version: draft.id }, MOD)).stamp).not.toBe(before);
    expect((await prepareRun({ setId, version: 'active' }, MOD)).stamp).toBe('2:');
  });
});

describe('prepareRerun', () => {
  it("stamps the run's error count", async () => {
    const { setId } = await setWithCases(3);
    harness.scanTexts.mockImplementation(async (_t: string, texts: LabText[]) =>
      texts.map((t) => ({ key: t.key, ok: false, error: 'x' }))
    );
    const run = await startRun({ setId, version: 'active' }, MOD);
    const prepared = await prepareRerun(setId, run.id, MOD);
    expect(prepared).toMatchObject({ count: 3, skipped: 0, stamp: '3:' });
  });
});

describe('rerunErrors', () => {
  it("re-scans only the error rows, with the run's stored prompts", async () => {
    const { setId } = await setWithCases(60);
    const draft = await createDraft(
      { name: 'd', prompts: { 'label:nsfw': 'NSFW DRAFT' }, note: null },
      MOD
    );
    harness.scanTexts
      .mockImplementationOnce(allOk('x'))
      .mockRejectedValueOnce(new LabHarnessError('orchestrator down'));
    const run = await startRun({ setId, version: draft.id }, MOD);
    const before = await results(run.id);
    await updateDraft(
      draft.id,
      { prompts: { 'label:nsfw': 'EDITED' }, note: null, expectedUpdatedAt: draft.updatedAt },
      MOD
    );

    harness.scanTexts.mockReset().mockImplementation(allOk('pg13'));
    purge.purgeDeletedSources.mockClear();
    const rerun = await rerunErrors(setId, run.id, MOD);

    expect(purge.purgeDeletedSources).toHaveBeenCalledWith(expect.anything(), setId);
    expect(harness.scanTexts).toHaveBeenCalledTimes(1);
    const [, texts, overrides] = harness.scanTexts.mock.calls[0];
    const errorKeys = before.filter((r) => r.status === 'error').map((r) => String(r.case_id));
    expect(texts.map((t: LabText) => t.key)).toEqual(errorKeys);
    expect(overrides).toEqual({ 'label:nsfw': 'NSFW DRAFT' });

    const after = await results(run.id);
    expect(after.filter((r) => r.status === 'ok')).toHaveLength(60);
    // The rows that were ok are untouched: still the first pass's 'x'.
    for (const r of before.filter((b) => b.status === 'ok'))
      expect(after.find((a) => a.case_id === r.case_id)!.output.nsfw.level).toBe('x');
    expect(rerun.status).toBe('done');
    expect((await runRow(run.id)).totals.nsfw).toMatchObject({ scored: 60, correct: 50 });
  });

  it('refuses when an active prompt the run used has since changed', async () => {
    const { setId } = await setWithCases(1);
    const second = await addCase(
      {
        setId,
        entityType: 'Model',
        entityId: 2,
        authorId: null,
        fields: [{ heading: 'Name', text: 'two' }],
        expected: {},
        synthetic: false,
        note: null,
      },
      MOD
    );
    harness.scanTexts.mockImplementation(async (_t: string, texts: LabText[]) =>
      texts.map((t) =>
        t.key === String(second.case.id) ? okResult(t.key) : { key: t.key, ok: false, error: 'x' }
      )
    );
    const run = await startRun({ setId, version: 'active' }, MOD);
    harness.getPrompts.mockResolvedValue({
      active: {
        base: { id: 1, key: 'base', content: 'BASE PROMPT' },
        'label:nsfw': { id: 3, key: 'label:nsfw', content: 'NEWER' },
      },
      config: { model: 'fake-model', maxInputChars: 1000, thinking: false },
    });
    harness.scanTexts.mockClear();

    await expect(rerunErrors(setId, run.id, MOD)).rejects.toThrow(/label:nsfw/);
    expect(harness.scanTexts).not.toHaveBeenCalled();
  });

  it.each([
    { change: { model: 'other-model', thinking: false }, message: /The model changed/ },
    { change: { model: 'fake-model', thinking: true }, message: /The thinking setting changed/ },
  ])('refuses when the config changed since the run ($message)', async ({ change, message }) => {
    const { setId } = await setWithCases(1);
    harness.scanTexts.mockImplementation(async (_t: string, texts: LabText[]) =>
      texts.map((t) => ({ key: t.key, ok: false, error: 'x' }))
    );
    const run = await startRun({ setId, version: 'active' }, MOD);
    expect(await runRow(run.id)).toMatchObject({ model: 'fake-model', thinking: false });
    harness.getPrompts.mockResolvedValue({
      active: {
        base: { id: 1, key: 'base', content: 'BASE PROMPT' },
        'label:nsfw': { id: 2, key: 'label:nsfw', content: 'NSFW DEF' },
      },
      config: { maxInputChars: 1000, ...change },
    });
    harness.scanTexts.mockClear();

    await expect(rerunErrors(setId, run.id, MOD)).rejects.toThrow(message);
    expect(harness.scanTexts).not.toHaveBeenCalled();
  });

  it('refuses a run that did not record its model or thinking setting', async () => {
    const { setId } = await setWithCases(1);
    harness.scanTexts.mockImplementation(async (_t: string, texts: LabText[]) =>
      texts.map((t) => ({ key: t.key, ok: false, error: 'x' }))
    );
    const run = await startRun({ setId, version: 'active' }, MOD);
    await holder.pg!.query(
      'UPDATE text_scan_test_run SET model = NULL, thinking = NULL WHERE id = $1',
      [run.id]
    );
    harness.scanTexts.mockClear();

    await expect(rerunErrors(setId, run.id, MOD)).rejects.toThrow(/did not record its model/);
    expect(harness.scanTexts).not.toHaveBeenCalled();
  });
});

describe('scoring against current expectations', () => {
  it('rescores every run when a case is relabelled, so a comparison shows no flip', async () => {
    const { setId, caseIds } = await setWithCases(1); // expects nsfw r–x
    harness.scanTexts.mockImplementation(allOk('pg13'));
    const first = await startRun({ setId, version: 'active' }, MOD);
    expect(first.totals!.nsfw.correct).toBe(0);

    await updateExpected(setId, caseIds[0], { nsfw: { min: 'pg13', max: 'pg13' } }, null);
    const second = await startRun({ setId, version: 'active' }, MOD);

    const comparison = await compareRuns(setId, first.id, second.id);
    expect(comparison.newlyRight).toEqual([]);
    expect(comparison.newlyWrong).toEqual([]);
    expect(comparison.a.totals!.nsfw).toMatchObject({ scored: 1, correct: 1 });
    expect(comparison.b.totals!.nsfw).toMatchObject({ scored: 1, correct: 1 });
    const listed = await listRuns(setId);
    expect(listed.map((r) => r.totals!.nsfw.correct)).toEqual([1, 1]);
    expect((await latestRunTotals(setId)).active!.totals.nsfw.correct).toBe(1);
  });

  it('flips a case only when its output changed', async () => {
    const { setId } = await setWithCases(1);
    harness.scanTexts.mockImplementation(allOk('pg13'));
    const a = await startRun({ setId, version: 'active' }, MOD);
    harness.scanTexts.mockImplementation(allOk('x'));
    const b = await startRun({ setId, version: 'active' }, MOD);
    const comparison = await compareRuns(setId, a.id, b.id);
    expect(comparison.newlyRight).toMatchObject([
      { label: 'nsfw', outputB: { nsfw: { level: 'x' } } },
    ]);
  });
});

describe('a wiped case', () => {
  const wipe = (caseId: number) =>
    holder.pg!.query(
      'UPDATE text_scan_test_case SET fields = NULL, source_deleted_at = now() WHERE id = $1',
      [caseId]
    );

  it("drops out of earlier runs' totals and comparisons", async () => {
    const { setId, caseIds } = await setWithCases(2); // expects nsfw r–x
    harness.scanTexts.mockImplementation(allOk('pg13'));
    const a = await startRun({ setId, version: 'active' }, MOD);
    harness.scanTexts.mockImplementation(allOk('x'));
    const b = await startRun({ setId, version: 'active' }, MOD);
    expect((await compareRuns(setId, a.id, b.id)).newlyRight).toHaveLength(2);

    await wipe(caseIds[0]);

    const comparison = await compareRuns(setId, a.id, b.id);
    expect(comparison.newlyRight.map((f) => f.caseId)).toEqual([caseIds[1]]);
    expect(comparison.a.totals!.nsfw).toMatchObject({ scored: 1, correct: 0 });
    expect(comparison.b.totals!.nsfw).toMatchObject({ scored: 1, correct: 1 });
    expect((await listRuns(setId)).map((r) => r.totals!.nsfw.scored)).toEqual([1, 1]);
    expect((await latestRunTotals(setId)).active!.totals.nsfw.scored).toBe(1);
  });

  it('keeps its status but stores no output when it is purged while the run is scanning', async () => {
    const { setId, caseIds } = await setWithCases(2);
    harness.scanTexts.mockImplementation(async (type: string, texts: LabText[]) => {
      await wipe(caseIds[0]);
      return allOk()(type, texts);
    });
    const run = await startRun({ setId, version: 'active' }, MOD);
    const rows = await holder.pg!.query<{
      case_id: string;
      status: string;
      output: unknown;
      workflow_id: string;
    }>(
      'SELECT case_id, status, output, workflow_id FROM text_scan_test_result WHERE run_id = $1 ORDER BY case_id',
      [run.id]
    );
    expect(rows.rows[0]).toMatchObject({
      status: 'ok',
      output: null,
      workflow_id: `wf-${caseIds[0]}`,
    });
    expect(rows.rows[1].output).not.toBeNull();
    expect((await runRow(run.id)).totals.nsfw.scored).toBe(1);
  });
});

describe('latestRunTotals', () => {
  it("returns each version's latest finished run, ignoring one still running", async () => {
    const { setId } = await setWithCases(1);
    const draft = await createDraft(
      { name: 'd', prompts: { base: 'BASE DRAFT' }, note: null },
      MOD
    );
    harness.scanTexts.mockImplementation(allOk('pg13'));
    await startRun({ setId, version: 'active' }, MOD);
    harness.scanTexts.mockImplementation(allOk('r'));
    const latestActive = await startRun({ setId, version: 'active' }, MOD);
    const draftRun = await startRun({ setId, version: draft.id }, MOD);
    await holder.pg!.query(
      `INSERT INTO text_scan_test_run (set_id, version, status, run_by) VALUES ($1, 'active', 'running', 1)`,
      [setId]
    );

    const latest = await latestRunTotals(setId);

    expect(latest.active).toMatchObject({ runId: latestActive.id });
    expect(latest.active!.totals.nsfw.correct).toBe(1);
    expect(latest.drafts[String(draft.id)]).toMatchObject({ runId: draftRun.id });
    expect(Object.keys(latest.drafts)).toEqual([String(draft.id)]);
  });
});

describe('casesPerSecond', () => {
  it("measures the set's last finished run, skipped cases left out", async () => {
    const { setId, caseIds } = await setWithCases(3);
    harness.scanTexts.mockImplementation(allOk());
    const run = await startRun({ setId, version: 'active' }, MOD);
    await holder.pg!.query(
      `UPDATE text_scan_test_run SET started_at = now() - interval '2 seconds', finished_at = now() WHERE id = $1`,
      [run.id]
    );
    await holder.pg!.query(
      `UPDATE text_scan_test_result SET status = 'skipped' WHERE run_id = $1 AND case_id = $2`,
      [run.id, caseIds[0]]
    );
    expect(await casesPerSecond(setId)).toBeCloseTo(1, 1);
  });

  it('is null for a set that never finished a run', async () => {
    const { setId } = await setWithCases(1);
    expect(await casesPerSecond(setId)).toBeNull();
  });
});

describe('getRunOutcome', () => {
  it('returns each result with its case expectation, and errors of unwiped cases verbatim', async () => {
    const { setId, caseIds } = await setWithCases(3);
    harness.scanTexts.mockImplementation(async (_t: string, texts: LabText[]) => [
      okResult(texts[0].key, 'x'),
      { key: texts[1].key, ok: false, error: 'Orchestrator said no' },
      { key: texts[2].key, ok: false, error: 'Wiped later' },
    ]);
    const run = await startRun({ setId, version: 'active' }, MOD);
    await holder.pg!.query(
      'UPDATE text_scan_test_case SET fields = NULL, source_deleted_at = now() WHERE id = $1',
      [caseIds[2]]
    );

    const outcome = await getRunOutcome(setId, run.id);

    expect(outcome.run.id).toBe(run.id);
    expect(outcome.rows).toEqual([
      {
        caseId: caseIds[0],
        expected: { nsfw: { min: 'r', max: 'x' } },
        status: 'ok',
        output: { nsfw: { level: 'x', reason: 'fake' } },
        wiped: false,
      },
      expect.objectContaining({ caseId: caseIds[1], status: 'error', wiped: false }),
      expect.objectContaining({ caseId: caseIds[2], status: 'error', wiped: true }),
    ]);
    expect(outcome.errors).toEqual([{ caseId: caseIds[1], error: 'Orchestrator said no' }]);
  });

  it('refuses a run from another set', async () => {
    const { setId } = await setWithCases(1);
    const other = await createSet({ name: 'other', description: null }, MOD);
    harness.scanTexts.mockImplementation(allOk());
    const run = await startRun({ setId, version: 'active' }, MOD);
    await expect(getRunOutcome(other.id, run.id)).rejects.toThrow('not found in this set');
  });
});

describe('runs scan after the request', () => {
  it('returns the run as running at once, and records progress per chunk until it finishes', async () => {
    const { setId } = await setWithCases(60);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    harness.scanTexts.mockImplementation(async (type: string, texts: LabText[]) => {
      if (texts.length === 10) await gate;
      return allOk()(type, texts);
    });

    const started = await (await prepareRun({ setId, version: 'active' }, MOD)).execute(MOD);

    expect(started.run).toMatchObject({ status: 'running', scanTotal: 60, scanDone: 0 });
    await vi.waitFor(async () =>
      expect(await getRunProgress(setId, started.run.id)).toEqual({
        runId: started.run.id,
        status: 'running',
        done: 50,
        total: 60,
      })
    );
    release();
    const finished = await started.finished;
    expect(finished.status).toBe('done');
    expect(await getRunProgress(setId, finished.id)).toMatchObject({
      status: 'done',
      done: 60,
      total: 60,
    });
  });

  it('logs a run that throws, rejecting only for a caller that waits', async () => {
    const { setId } = await setWithCases(1);
    harness.scanTexts.mockImplementation(allOk());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = await (await prepareRun({ setId, version: 'active' }, MOD)).execute(MOD);
    // Fails the run's final write, after the scan.
    await holder.pg!.query('DROP TABLE text_scan_test_case CASCADE');
    await expect(started.finished).rejects.toThrow();
    expect(error).toHaveBeenCalledWith(
      `text-scan run ${started.run.id}: failed`,
      expect.any(String)
    );
    error.mockRestore();
  });
});

describe('an interrupted run', () => {
  /** A run left 'running' by a process that stopped after scanning `scanned` of its cases. */
  async function abandoned(scanned: number) {
    const { setId, caseIds } = await setWithCases(3);
    const { rows } = await holder.pg!.query<{ id: string }>(
      `INSERT INTO text_scan_test_run (set_id, version, status, run_by, model, thinking, scan_total,
         scan_done, progress_at)
       VALUES ($1, 'active', 'running', $2, 'fake-model', false, 3, $3,
         now() - make_interval(secs => $4))
       RETURNING id`,
      [setId, MOD, scanned, RUN_STALE_MS / 1000 + 1]
    );
    const runId = Number(rows[0].id);
    for (const caseId of caseIds.slice(0, scanned))
      await holder.pg!.query(
        `INSERT INTO text_scan_test_result (run_id, case_id, status, output)
         VALUES ($1, $2, 'ok', '{"nsfw":{"level":"r"}}')`,
        [runId, caseId]
      );
    return { setId, caseIds, runId };
  }

  it('reads as interrupted once its progress is stale', async () => {
    const { setId, runId } = await abandoned(1);
    expect(await getRunProgress(setId, runId)).toMatchObject({ status: 'interrupted', done: 1 });
    expect((await listRuns(setId))[0].status).toBe('interrupted');
  });

  it('is finished by re-running: the cases it never reached become errors and are scanned', async () => {
    const { setId, caseIds, runId } = await abandoned(1);
    harness.scanTexts.mockImplementation(allOk());

    const prepared = await prepareRerun(setId, runId, MOD);
    expect(prepared.count).toBe(2);
    const run = await (await prepared.execute(MOD)).finished;

    expect(harness.scanTexts.mock.calls[0][1].map((t: LabText) => t.key)).toEqual(
      caseIds.slice(1).map(String)
    );
    expect(run.status).toBe('done');
    expect((await results(runId)).map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
  });

  it('is not re-run while it is still moving', async () => {
    const { setId, runId } = await abandoned(1);
    await holder.pg!.query('UPDATE text_scan_test_run SET progress_at = now() WHERE id = $1', [
      runId,
    ]);
    await expect(prepareRerun(setId, runId, MOD)).rejects.toThrow('not finished');
  });
});

describe("re-running another moderator's working-copy run", () => {
  it('is refused; the owner may', async () => {
    const { setId } = await setWithCases(1);
    const theirs = (await saveWorkingCopy(MOD + 1, { 'label:nsfw': 'THEIR NSFW' }, null))!;
    harness.scanTexts.mockImplementation(async (_t: string, texts: LabText[]) =>
      texts.map((t) => ({ key: t.key, ok: false, error: 'x' }))
    );
    const run = await startRun({ setId, version: theirs.id }, MOD + 1);

    const refusal = prepareRerun(setId, run.id, MOD);
    await expect(refusal).rejects.toBeInstanceOf(RunError);
    await expect(refusal).rejects.toThrow(/another moderator's unpublished changes/);
    await expect(prepareRerun(setId, run.id, MOD + 1)).resolves.toMatchObject({ count: 1 });
  });
});
