import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Preview from '~/server/services/text-scan/preview';
import type * as TextScanPrompt from '~/server/services/text-scan/prompt';
import type * as Submit from '~/server/services/text-scan/submit';
import type * as CsamHold from '~/server/services/text-scan/actions/csam-hold';
import type * as TextScanMode from '~/server/services/text-scan/mode';
import type * as ModelProfile from '~/server/services/text-scan/profiles/model.profile';
import type { TextScanSubject } from '~/server/services/text-scan/types';
import type { TextScanEachVerdict } from '~/server/services/text-scan/preview';
import type { TextScanField, TextScanOutput } from '~/server/services/text-scan/types';

/** The .com version-text rater against real rows. Ids and strings are invented. */

const previewTextScanEach =
  vi.fn<
    (...args: Parameters<typeof Preview.previewTextScanEach>) => Promise<TextScanEachVerdict[]>
  >();
vi.mock('~/server/services/text-scan/preview', async (importOriginal) => ({
  ...(await importOriginal<typeof Preview>()),
  previewTextScanEach: async (...args: Parameters<typeof Preview.previewTextScanEach>) => ({
    workflowId: 'wf-1',
    verdicts: await previewTextScanEach(...args),
  }),
}));
const applyCsamHold = vi.fn<typeof CsamHold.applyCsamHold>();
vi.mock('~/server/services/text-scan/actions/csam-hold', async (importOriginal) => ({
  ...(await importOriginal<typeof CsamHold>()),
  applyCsamHold: (...args: Parameters<typeof CsamHold.applyCsamHold>) => applyCsamHold(...args),
}));
const modelSubject: TextScanSubject = {
  fields: [{ heading: 'Name', text: 'Model name' }],
  declared: {},
  userId: 101,
};
const loadModelScanSubjects = vi.fn(
  async (ids: number[], _options?: unknown) => new Map(ids.map((id) => [id, modelSubject]))
);
vi.mock('~/server/services/text-scan/profiles/model.profile', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelProfile>()),
  loadModelScanSubjects: (ids: number[], options?: unknown) => loadModelScanSubjects(ids, options),
}));
// The Model scan's own gates, closed or open per test; the hold must not depend on them.
const gates = vi.hoisted(() => ({ mode: 'active', csamMode: 'review' }));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanMode>()),
  getTextScanMode: async () => gates.mode,
  getTextScanCsamMode: async () => gates.csamMode,
}));
const promptIds = vi.hoisted(() => ({ nsfw: 2 }));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanPrompt>()),
  getActiveTextScanPrompts: async () => ({
    base: { id: 1, key: 'base', content: 'base' },
    'label:nsfw': { id: promptIds.nsfw, key: 'label:nsfw', content: 'nsfw' },
    'label:minor': { id: 3, key: 'label:minor', content: 'minor' },
    'label:poi': { id: 4, key: 'label:poi', content: 'poi' },
    'label:csam': { id: 5, key: 'label:csam', content: 'csam' },
  }),
  getTextScanConfig: async () => ({
    model: 'test-model',
    maxInputChars: 1000,
    maxSegments: 1,
    thinking: false,
  }),
}));
const scanEntityInBackground = vi.fn();
vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof Submit>()),
  scanEntityInBackground: (...args: unknown[]) => scanEntityInBackground(...args),
}));

const {
  comVersionTextQueueKey,
  comVersionTextVerdictKey,
  COM_VERSION_TEXT_MAX_ATTEMPTS,
  comVersionTextHitHash,
  COM_VERSION_TEXT_QUIET_MS,
  COM_VERSION_TEXT_STEPS_PER_WORKFLOW,
  COM_VERSION_TEXT_WORKFLOWS_PER_MODEL_RUN,
  COM_VERSION_TEXT_WORKFLOWS_PER_RUN,
  processComFaceVersionText,
  queueComFaceVersionText,
  rateComFaceVersionText,
  sweepComFaceVersionText,
} = await import('~/server/services/model-com-face-version-text.service');

const { textScanTextHash } = await import('~/server/services/text-scan/prompt');
const { logToAxiom } = await import('~/server/logging/client');

const MODEL_ID = 7;

const clean: TextScanOutput = {
  nsfw: { level: 'none', reason: '' },
  minor: { detected: false, reason: '' },
  poi: { detected: false, names: [], reason: '' },
  csam: { detected: false, reason: '' },
};
const ok = (output: Partial<TextScanOutput> = {}): TextScanEachVerdict => ({
  status: 'ok',
  output: { ...clean, ...output },
});
const mature = ok({ nsfw: { level: 'x', reason: '' } });

/** Answers each string from `answers`, clean when unlisted. */
function rateWith(answers: Record<string, TextScanEachVerdict>) {
  previewTextScanEach.mockImplementation(async ({ fields }) =>
    fields.map((field: TextScanField) => answers[field.text as string] ?? ok())
  );
}
const ratedTexts = () =>
  previewTextScanEach.mock.calls.flatMap(([{ fields }]) => fields.map((field) => field.text));

let db: PGlite;
const rows = async <T>(text: string, values: unknown[] = []) =>
  (await db.query<T>(text, values)).rows;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, "sfwName" text, "deletedAt" timestamp);
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int, name text, "trainedWords" text[], status text,
      availability text, meta jsonb
    );
    CREATE TABLE "KeyValue" (key text PRIMARY KEY, value jsonb);
  `);
});
afterAll(() => db.close());

beforeEach(async () => {
  previewTextScanEach.mockReset();
  applyCsamHold.mockReset();
  loadModelScanSubjects.mockClear();
  applyCsamHold.mockResolvedValue(undefined);
  gates.mode = 'active';
  gates.csamMode = 'review';
  promptIds.nsfw = 2;
  scanEntityInBackground.mockReset();
  rateWith({});
  await db.exec(`DELETE FROM "Model"; DELETE FROM "ModelVersion"; DELETE FROM "KeyValue";`);

  const raw = async (sql: Prisma.Sql) => (await db.query(sql.text, sql.values)).rows;
  for (const client of [dbMock.dbWrite, dbMock.dbRead]) {
    client.$queryRaw.mockImplementation(raw as never);
    client.$executeRaw.mockImplementation(
      (async (sql: Prisma.Sql) => (await db.query(sql.text, sql.values)).affectedRows ?? 0) as never
    );
    client.model.findUnique.mockImplementation(
      (async ({ where }: { where: { id: number } }) =>
        (await rows(`SELECT * FROM "Model" WHERE id = $1`, [where.id]))[0] ?? null) as never
    );
    // Translates the production `where`, so its own filter values drive the query.
    client.modelVersion.findMany.mockImplementation((async ({
      where,
    }: {
      where: { modelId: number; status?: string; availability?: { not?: string } };
    }) => {
      const conditions = ['"modelId" = $1'];
      const values: unknown[] = [where.modelId];
      if (where.status !== undefined) {
        values.push(where.status);
        conditions.push(`status = $${values.length}`);
      }
      if (where.availability?.not !== undefined) {
        values.push(where.availability.not);
        conditions.push(`availability <> $${values.length}`);
      }
      return rows(
        `SELECT id, name, "trainedWords" FROM "ModelVersion"
       WHERE ${conditions.join(' AND ')} ORDER BY id`,
        values
      );
    }) as never);
    client.keyValue.findMany.mockImplementation((async ({
      where,
    }: {
      where: { key: { in?: string[]; startsWith?: string } };
    }) =>
      where.key.in
        ? rows(`SELECT * FROM "KeyValue" WHERE key = ANY($1)`, [where.key.in])
        : rows(`SELECT * FROM "KeyValue" WHERE key LIKE $1 || '%'`, [
            where.key.startsWith,
          ])) as never);
  }
});

async function seed({
  sfwName = 'Retro Style',
  versions,
}: {
  sfwName?: string | null;
  versions: {
    id: number;
    name: string;
    words: string[] | null;
    status?: string;
    availability?: string;
  }[];
}) {
  await db.query(`INSERT INTO "Model" VALUES ($1, $2, NULL)`, [MODEL_ID, sfwName]);
  for (const v of versions)
    await db.query(`INSERT INTO "ModelVersion" VALUES ($1, $2, $3, $4, $5, $6, '{}')`, [
      v.id,
      MODEL_ID,
      v.name,
      v.words,
      v.status ?? 'Published',
      v.availability ?? 'Public',
    ]);
}

const queued = async (modelId = MODEL_ID) =>
  (
    await rows<{ value: Record<string, unknown> }>(`SELECT value FROM "KeyValue" WHERE key = $1`, [
      comVersionTextQueueKey(modelId),
    ])
  )[0]?.value;

async function verdicts(versionId: number) {
  const [row] = await rows<{ value: Record<string, unknown> }>(
    `SELECT value FROM "KeyValue" WHERE key = $1`,
    [comVersionTextVerdictKey(versionId)]
  );
  return row?.value;
}

describe('rateComFaceVersionText', () => {
  it('rates each string alone: one mature word is hidden, the name and the other words are shown', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha', 'beta', 'gamma'] }] });
    rateWith({ beta: mature });

    await expect(rateComFaceVersionText(MODEL_ID)).resolves.toMatchObject({ status: 'complete' });

    expect(await verdicts(1)).toMatchObject({
      shown: ['v1', 'alpha', 'gamma'],
      hidden: ['beta'],
      held: [],
      pending: false,
    });
    expect(previewTextScanEach).toHaveBeenCalledTimes(1);
    expect(ratedTexts().sort()).toEqual(['alpha', 'beta', 'gamma', 'v1']);
  });

  it('stores the verdicts outside the version meta clients receive', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['beta'] }] });
    rateWith({ beta: mature });
    await rateComFaceVersionText(MODEL_ID);

    const [version] = await rows<{ meta: unknown }>(`SELECT meta FROM "ModelVersion" WHERE id = 1`);
    expect(version.meta).toEqual({});
    expect(await verdicts(1)).toMatchObject({ hidden: ['beta'] });
  });

  it('rates the name of a version whose trained words are NULL', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: null }] });
    await rateComFaceVersionText(MODEL_ID);
    expect(await verdicts(1)).toMatchObject({ shown: ['v1'], words: [], pending: false });
  });

  it('a refused string is hidden; a string with no verdict stays pending and the rest still land', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha', 'beta', 'gamma'] }] });
    rateWith({ alpha: { status: 'refused' }, beta: { status: 'unavailable' } });

    await expect(rateComFaceVersionText(MODEL_ID)).resolves.toMatchObject({ status: 'unrated' });
    expect(await verdicts(1)).toMatchObject({
      shown: ['v1', 'gamma'],
      hidden: ['alpha'],
      pending: true,
    });
  });

  it('a minor, poi or csam detection holds the string; a missing label leaves it unrated', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha', 'beta', 'gamma'] }] });
    rateWith({
      alpha: ok({ minor: { detected: true, reason: '' } }),
      beta: ok({ poi: { detected: true, names: [], reason: '' } }),
      gamma: { status: 'ok', output: { nsfw: { level: 'none', reason: '' } } },
    });
    await rateComFaceVersionText(MODEL_ID);
    expect(await verdicts(1)).toMatchObject({
      shown: ['v1'],
      held: ['alpha', 'beta'],
      pending: true,
    });
  });

  it.each([
    ['Model text scan off', 'off', 'review'],
    ['csam mode not review', 'active', 'off'],
  ])('a csam detection writes the Model csam hold with the %s', async (_, mode, csamMode) => {
    gates.mode = mode;
    gates.csamMode = csamMode;
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha', 'beta'] }] });
    rateWith({ beta: ok({ csam: { detected: true, reason: 'r' } }) });
    await rateComFaceVersionText(MODEL_ID);

    expect(applyCsamHold).toHaveBeenCalledTimes(1);
    const [hold] = applyCsamHold.mock.calls[0];
    expect(hold).toMatchObject({
      entityType: 'Model',
      entityId: MODEL_ID,
      workflowId: 'wf-1',
      outcome: { csam: { detected: true } },
      textHash: textScanTextHash(modelSubject),
      promptIds: { csam: 5 },
    });
    expect(hold.subject.fields).toEqual(modelSubject.fields);
    expect(loadModelScanSubjects).toHaveBeenCalledWith([MODEL_ID], { publicVersionsOnly: true });
    expect(hold.subject.meta).toEqual({
      comVersionTextHits: [
        { versionId: 1, field: 'trainedWords', index: 1, hash: comVersionTextHitHash('beta') },
      ],
      comVersionTextHoldHash: textScanTextHash(modelSubject),
    });
    expect(JSON.stringify(hold.subject.meta)).not.toContain('beta');
    expect(scanEntityInBackground).toHaveBeenCalledWith({
      entityType: 'Model',
      entityId: MODEL_ID,
      force: true,
    });
    expect(await verdicts(1)).toMatchObject({ shown: ['v1', 'alpha'], held: ['beta'] });
  });

  it('names every place a held string sits, version names included, without its text', async () => {
    await seed({
      versions: [
        { id: 1, name: 'gamma', words: ['alpha'] },
        { id: 2, name: 'v2', words: ['beta', 'gamma'] },
      ],
    });
    rateWith({ gamma: ok({ csam: { detected: true, reason: '' } }) });
    await rateComFaceVersionText(MODEL_ID);
    const [hold] = applyCsamHold.mock.calls[0];
    const hash = comVersionTextHitHash('gamma');
    expect(hold.subject.meta).toEqual({
      comVersionTextHits: [
        { versionId: 1, field: 'name', hash },
        { versionId: 2, field: 'trainedWords', index: 1, hash },
      ],
      comVersionTextHoldHash: textScanTextHash(modelSubject),
    });
    expect(hash).toBe(createHash('sha256').update('gamma').digest('hex'));

    // Only the hold carries the hashes: nothing a viewer's read can reach does.
    const readable = JSON.stringify([
      await rows(`SELECT meta FROM "ModelVersion"`),
      await rows(`SELECT value FROM "KeyValue"`),
      await rows(`SELECT * FROM "Model"`),
    ]);
    expect(readable).not.toContain(hash);
    expect(readable).not.toContain(textScanTextHash(modelSubject));
  });

  it('logs a failed hold without its error message, which can carry the held text', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    rateWith({ alpha: ok({ csam: { detected: true, reason: '' } }) });
    const error = Object.assign(new Error(`insert failed: ${modelSubject.fields[0].text} alpha`), {
      code: 'P2010',
    });
    applyCsamHold.mockRejectedValue(error);
    await queueComFaceVersionText(MODEL_ID);
    vi.mocked(logToAxiom).mockClear();

    await processComFaceVersionText(new Date(Date.now() + COM_VERSION_TEXT_QUIET_MS));

    const logged = JSON.stringify(vi.mocked(logToAxiom).mock.calls);
    expect(logged).toContain('P2010');
    expect(logged).not.toContain(String(modelSubject.fields[0].text));
    expect(logged).not.toContain('alpha');
  });

  it('a csam hit with no Model scan subject fails the run and writes no verdicts', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    rateWith({ alpha: ok({ csam: { detected: true, reason: '' } }) });
    loadModelScanSubjects.mockResolvedValueOnce(new Map());
    await expect(rateComFaceVersionText(MODEL_ID)).rejects.toThrow();
    expect(applyCsamHold).not.toHaveBeenCalled();
    expect(await verdicts(1)).toBeUndefined();
  });

  it('a step that only partly parsed holds a minor or poi detection and leaves the rest unrated', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha', 'beta', 'gamma'] }] });
    rateWith({
      alpha: { status: 'partial', output: { minor: { detected: true, reason: '' } } },
      beta: { status: 'partial', output: { poi: { detected: true, names: [], reason: '' } } },
      gamma: { status: 'partial', output: { nsfw: { level: 'none', reason: '' } } },
    });
    await rateComFaceVersionText(MODEL_ID);
    expect(await verdicts(1)).toMatchObject({
      held: ['alpha', 'beta'],
      shown: ['v1'],
      pending: true,
    });
    expect(applyCsamHold).not.toHaveBeenCalled();
  });

  it('no csam detection writes no hold', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    rateWith({ alpha: ok({ minor: { detected: true, reason: '' } }) });
    await rateComFaceVersionText(MODEL_ID);
    expect(applyCsamHold).not.toHaveBeenCalled();
    expect(scanEntityInBackground).not.toHaveBeenCalled();
  });

  it('a csam detection in a step whose other labels did not parse is still held', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    rateWith({ alpha: { status: 'partial', output: { csam: { detected: true, reason: '' } } } });
    await rateComFaceVersionText(MODEL_ID);
    expect(applyCsamHold).toHaveBeenCalledTimes(1);
    expect(await verdicts(1)).toMatchObject({ held: ['alpha'] });
  });

  it('a hold that fails writes no verdicts, so the strings are rated again', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    rateWith({ alpha: ok({ csam: { detected: true, reason: '' } }) });
    applyCsamHold.mockRejectedValue(new Error('hold write failed'));
    await queueComFaceVersionText(MODEL_ID);

    const counts = await processComFaceVersionText(
      new Date(Date.now() + COM_VERSION_TEXT_QUIET_MS)
    );
    expect(counts.failed).toBe(1);
    expect(await verdicts(1)).toBeUndefined();
    expect(await queued()).toMatchObject({ attempt: 1 });
  });

  it('a dry run rates and counts csam hits but writes nothing', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    rateWith({ alpha: ok({ csam: { detected: true, reason: '' } }) });
    await expect(rateComFaceVersionText(MODEL_ID, 20, { dryRun: true })).resolves.toMatchObject({
      csamHits: 1,
    });
    expect(applyCsamHold).not.toHaveBeenCalled();
    expect(scanEntityInBackground).not.toHaveBeenCalled();
    expect(await verdicts(1)).toBeUndefined();
  });

  it('a dry run reads from the replica, never the primary', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    dbMock.dbWrite.model.findUnique.mockClear();
    dbMock.dbWrite.modelVersion.findMany.mockClear();
    dbMock.dbWrite.keyValue.findMany.mockClear();
    await rateComFaceVersionText(MODEL_ID, 20, { dryRun: true });
    expect(ratedTexts().sort()).toEqual(['alpha', 'v1']);
    expect(dbMock.dbWrite.model.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelVersion.findMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.keyValue.findMany).not.toHaveBeenCalled();
    expect(dbMock.dbRead.modelVersion.findMany).toHaveBeenCalled();
  });

  it('re-rates only text without a verdict: an owner swapping a hidden word gets the new word rated', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha', 'beta'] }] });
    rateWith({ beta: mature });
    await rateComFaceVersionText(MODEL_ID);
    previewTextScanEach.mockClear();

    await db.query(`UPDATE "ModelVersion" SET "trainedWords" = '{alpha,delta}' WHERE id = 1`);
    await rateComFaceVersionText(MODEL_ID);

    expect(ratedTexts()).toEqual(['delta']);
    expect(await verdicts(1)).toMatchObject({ shown: ['v1', 'alpha', 'delta'], hidden: [] });
  });

  it('writes nothing for a version whose text changed while it was being rated', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    previewTextScanEach.mockImplementation(async ({ fields }) => {
      await db.query(`UPDATE "ModelVersion" SET name = 'v1 renamed' WHERE id = 1`);
      return fields.map(() => ok());
    });
    await rateComFaceVersionText(MODEL_ID);
    expect(await verdicts(1)).toBeUndefined();
  });

  it('rates only versions civitai.com can show, and nothing for a model without a face', async () => {
    await seed({
      versions: [
        { id: 1, name: 'v1', words: [] },
        { id: 2, name: 'draft', words: [], status: 'Draft' },
        { id: 3, name: 'private', words: [], availability: 'Private' },
      ],
    });
    await rateComFaceVersionText(MODEL_ID);
    expect(ratedTexts()).toEqual(['v1']);

    await db.query(`UPDATE "Model" SET "sfwName" = NULL`);
    await db.exec(`DELETE FROM "KeyValue"`);
    previewTextScanEach.mockClear();
    await rateComFaceVersionText(MODEL_ID);
    expect(previewTextScanEach).not.toHaveBeenCalled();
  });

  it('rates nothing for a deleted model', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    await db.query(`UPDATE "Model" SET "deletedAt" = now()`);
    await rateComFaceVersionText(MODEL_ID);
    expect(previewTextScanEach).not.toHaveBeenCalled();
    expect(await verdicts(1)).toBeUndefined();
  });

  it('a string too long to rate on its own is hidden', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    rateWith({ alpha: { status: 'too-long' } });
    await expect(rateComFaceVersionText(MODEL_ID)).resolves.toMatchObject({ status: 'complete' });
    expect(await verdicts(1)).toMatchObject({ shown: ['v1'], hidden: ['alpha'], pending: false });
  });

  it('a budget-limited run that rated nothing reports unrated, so it backs off', async () => {
    const words = Array.from({ length: 45 }, (_, i) => `w${i}`);
    await seed({ versions: [{ id: 1, name: 'v1', words }] });
    previewTextScanEach.mockImplementation(async ({ fields }) =>
      fields.map((): TextScanEachVerdict => ({ status: 'unavailable' }))
    );
    await expect(rateComFaceVersionText(MODEL_ID, 2)).resolves.toMatchObject({
      status: 'unrated',
      workflows: 2,
    });
  });

  it('a rating call that throws leaves its strings unrated', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    previewTextScanEach.mockRejectedValue(new Error('orchestrator down'));
    await expect(rateComFaceVersionText(MODEL_ID)).resolves.toMatchObject({ status: 'unrated' });
    expect(await verdicts(1)).toMatchObject({ shown: [], hidden: [], held: [], pending: true });
  });

  it('re-rates every string once the rating prompts change, and the sweep finds those versions', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    await rateComFaceVersionText(MODEL_ID);
    await expect(sweepComFaceVersionText()).resolves.toEqual([]);

    promptIds.nsfw = 20;
    await expect(sweepComFaceVersionText()).resolves.toEqual([MODEL_ID]);
    previewTextScanEach.mockClear();
    rateWith({ alpha: mature });
    await rateComFaceVersionText(MODEL_ID);
    expect(ratedTexts().sort()).toEqual(['alpha', 'v1']);
    expect(await verdicts(1)).toMatchObject({ shown: ['v1'], hidden: ['alpha'] });
  });

  it(`splits a model's strings into workflows of ${COM_VERSION_TEXT_STEPS_PER_WORKFLOW} and stops at the budget`, async () => {
    const words = Array.from({ length: 45 }, (_, i) => `w${i}`);
    await seed({ versions: [{ id: 1, name: 'v1', words }] });

    await expect(rateComFaceVersionText(MODEL_ID, 2)).resolves.toMatchObject({
      status: 'partial',
      workflows: 2,
    });
    expect(previewTextScanEach.mock.calls.map(([{ fields }]) => fields.length)).toEqual([20, 20]);
    expect(await verdicts(1)).toMatchObject({ pending: true });

    await expect(rateComFaceVersionText(MODEL_ID, 2)).resolves.toMatchObject({
      status: 'complete',
      workflows: 1,
    });
    expect(await verdicts(1)).toMatchObject({ pending: false });
  });
});

describe('processComFaceVersionText', () => {
  it('waits out the quiet period after an edit, then rates and leaves the queue', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    await queueComFaceVersionText(MODEL_ID);

    await processComFaceVersionText(new Date());
    expect(previewTextScanEach).not.toHaveBeenCalled();
    expect(await queued()).toBeDefined();

    await processComFaceVersionText(new Date(Date.now() + COM_VERSION_TEXT_QUIET_MS));
    expect(await verdicts(1)).toMatchObject({ shown: ['v1', 'alpha'] });
    expect(await queued()).toBeUndefined();
  });

  it('retries a model with unrated strings only after a growing backoff', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    rateWith({ alpha: { status: 'unavailable' } });
    await queueComFaceVersionText(MODEL_ID);
    const base = Date.now() + COM_VERSION_TEXT_QUIET_MS;
    const at = (ms: number) => new Date(base + ms);

    await processComFaceVersionText(at(0));
    expect(await queued()).toMatchObject({ attempt: 1 });
    previewTextScanEach.mockClear();
    await processComFaceVersionText(at(55_000));
    expect(previewTextScanEach).not.toHaveBeenCalled();

    await processComFaceVersionText(at(65_000));
    expect(previewTextScanEach).toHaveBeenCalledTimes(1);
    expect(await queued()).toMatchObject({ attempt: 2 });
    previewTextScanEach.mockClear();
    await processComFaceVersionText(at(65_000 + 115_000));
    expect(previewTextScanEach).not.toHaveBeenCalled();
  });

  it(`drops a model from the queue after ${COM_VERSION_TEXT_MAX_ATTEMPTS} attempts, for the sweep to queue again`, async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    rateWith({ alpha: { status: 'unavailable' } });
    const entry = {
      editAt: new Date(0).toISOString(),
      source: 'edit',
      attempt: COM_VERSION_TEXT_MAX_ATTEMPTS,
      nextAt: '',
    };
    await db.query(`INSERT INTO "KeyValue" VALUES ($1, $2)`, [
      comVersionTextQueueKey(MODEL_ID),
      JSON.stringify(entry),
    ]);
    await processComFaceVersionText(new Date());
    expect(await queued()).toBeUndefined();
    await expect(sweepComFaceVersionText()).resolves.toEqual([MODEL_ID]);
    expect(await queued()).toMatchObject({ source: 'sweep' });
  });

  it('keeps the queue row of an edit made while the model was being rated', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    await queueComFaceVersionText(MODEL_ID);
    previewTextScanEach.mockImplementation(async ({ fields }) => {
      await queueComFaceVersionText(MODEL_ID);
      return fields.map(() => ok());
    });
    await processComFaceVersionText(new Date(Date.now() + COM_VERSION_TEXT_QUIET_MS));
    expect(await queued()).toMatchObject({ source: 'edit' });
  });

  it(`rates owner edits before sweep rows and spends at most ${COM_VERSION_TEXT_WORKFLOWS_PER_RUN} workflows a run, ${COM_VERSION_TEXT_WORKFLOWS_PER_MODEL_RUN} per model`, async () => {
    const words = (model: number) => `{${Array.from({ length: 200 }, (_, i) => `m${model}w${i}`)}}`;
    await seed({ versions: [{ id: 1, name: 'v1', words: [] }] });
    await db.query(`UPDATE "ModelVersion" SET "trainedWords" = $1 WHERE id = 1`, [words(7)]);
    for (const id of [8, 9, 10, 11]) {
      await db.query(`INSERT INTO "Model" VALUES ($1, 'Other', NULL)`, [id]);
      await db.query(
        `INSERT INTO "ModelVersion" VALUES ($1, $1, $2, $3, 'Published', 'Public', '{}')`,
        [id, `edited${id}`, words(id)]
      );
    }
    await sweepComFaceVersionText();
    await db.exec(`DELETE FROM "KeyValue" WHERE key = '${comVersionTextQueueKey(11)}'`);
    await queueComFaceVersionText(11);

    const counts = await processComFaceVersionText(
      new Date(Date.now() + COM_VERSION_TEXT_QUIET_MS)
    );
    expect(ratedTexts()[0]).toBe('edited11');
    expect(counts.workflows).toBe(COM_VERSION_TEXT_WORKFLOWS_PER_RUN);
    const perModel = new Map<string, number>();
    for (const [{ fields }] of previewTextScanEach.mock.calls) {
      const model = String(fields[0].text).match(/\d+/)![0];
      perModel.set(model, (perModel.get(model) ?? 0) + 1);
    }
    expect(Math.max(...perModel.values())).toBe(COM_VERSION_TEXT_WORKFLOWS_PER_MODEL_RUN);
    expect(perModel.get('11')).toBe(COM_VERSION_TEXT_WORKFLOWS_PER_MODEL_RUN);
    expect(await queued()).toBeDefined();
  });
});

describe('sweepComFaceVersionText', () => {
  it('queues faced models whose shown versions have no verdict, a pending one, or a stale one', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    dbMock.dbWrite.$queryRaw.mockClear();
    await expect(sweepComFaceVersionText()).resolves.toEqual([MODEL_ID]);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();

    await db.exec(`DELETE FROM "KeyValue"`);
    await rateComFaceVersionText(MODEL_ID);
    await expect(sweepComFaceVersionText()).resolves.toEqual([]);

    await db.query(`UPDATE "ModelVersion" SET "trainedWords" = '{alpha,beta}' WHERE id = 1`);
    await expect(sweepComFaceVersionText()).resolves.toEqual([MODEL_ID]);

    await db.exec(`DELETE FROM "KeyValue"`);
    rateWith({ alpha: { status: 'unavailable' } });
    await db.query(`UPDATE "ModelVersion" SET "trainedWords" = '{alpha}' WHERE id = 1`);
    await rateComFaceVersionText(MODEL_ID);
    await expect(sweepComFaceVersionText()).resolves.toEqual([MODEL_ID]);
  });

  it('skips models already queued, without a face, or with only versions .com does not show', async () => {
    await seed({
      versions: [{ id: 1, name: 'draft', words: [], status: 'Draft' }],
    });
    await db.query(`INSERT INTO "Model" VALUES (8, NULL, NULL), (9, 'Queued', NULL)`);
    await db.query(
      `INSERT INTO "ModelVersion" VALUES
         (2, 8, 'v', '{}', 'Published', 'Public', '{}'),
         (3, 9, 'v', '{}', 'Published', 'Public', '{}')`
    );
    await queueComFaceVersionText(9);
    await expect(sweepComFaceVersionText()).resolves.toEqual([]);
  });
});
