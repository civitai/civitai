import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Preview from '~/server/services/text-scan/preview';
import type * as Submit from '~/server/services/text-scan/submit';
import type { TextScanEachVerdict } from '~/server/services/text-scan/preview';
import type { TextScanField, TextScanOutput } from '~/server/services/text-scan/types';

/** The .com version-text rater against real rows. Ids and strings are invented. */

const previewTextScanEach = vi.fn<typeof Preview.previewTextScanEach>();
vi.mock('~/server/services/text-scan/preview', async (importOriginal) => ({
  ...(await importOriginal<typeof Preview>()),
  previewTextScanEach: (...args: Parameters<typeof Preview.previewTextScanEach>) =>
    previewTextScanEach(...args),
}));
const scanEntityInBackground = vi.fn();
vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof Submit>()),
  scanEntityInBackground: (...args: unknown[]) => scanEntityInBackground(...args),
}));

const {
  comVersionTextQueueKey,
  comVersionTextVerdictKey,
  COM_VERSION_TEXT_QUIET_MS,
  COM_VERSION_TEXT_STEPS_PER_WORKFLOW,
  COM_VERSION_TEXT_WORKFLOWS_PER_RUN,
  processComFaceVersionText,
  queueComFaceVersionText,
  rateComFaceVersionText,
  sweepComFaceVersionText,
} = await import('~/server/services/model-com-face-version-text.service');

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
  scanEntityInBackground.mockReset();
  rateWith({});
  await db.exec(`DELETE FROM "Model"; DELETE FROM "ModelVersion"; DELETE FROM "KeyValue";`);

  const raw = async (sql: Prisma.Sql) => (await db.query(sql.text, sql.values)).rows;
  dbMock.dbWrite.$queryRaw.mockImplementation(raw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(
    (async (sql: Prisma.Sql) => (await db.query(sql.text, sql.values)).affectedRows ?? 0) as never
  );
  dbMock.dbWrite.model.findUnique.mockImplementation(
    (async ({ where }: { where: { id: number } }) =>
      (await rows(`SELECT * FROM "Model" WHERE id = $1`, [where.id]))[0] ?? null) as never
  );
  dbMock.dbWrite.modelVersion.findMany.mockImplementation((async ({
    where,
  }: {
    where: { modelId: number };
  }) =>
    rows(
      `SELECT id, name, "trainedWords" FROM "ModelVersion"
       WHERE "modelId" = $1 AND status = 'Published' AND availability <> 'Private' ORDER BY id`,
      [where.modelId]
    )) as never);
  dbMock.dbWrite.keyValue.findMany.mockImplementation((async ({
    where,
  }: {
    where: { key: { in?: string[]; startsWith?: string } };
  }) =>
    where.key.in
      ? rows(`SELECT * FROM "KeyValue" WHERE key = ANY($1)`, [where.key.in])
      : rows(`SELECT * FROM "KeyValue" WHERE key LIKE $1 || '%'`, [
          where.key.startsWith,
        ])) as never);
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

  it('a csam detection queues a forced Model text scan', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    rateWith({ alpha: ok({ csam: { detected: true, reason: '' } }) });
    await rateComFaceVersionText(MODEL_ID);
    expect(scanEntityInBackground).toHaveBeenCalledWith({
      entityType: 'Model',
      entityId: MODEL_ID,
      force: true,
    });
    expect(await verdicts(1)).toMatchObject({ held: ['alpha'] });
  });

  it('no csam detection queues no Model text scan', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    rateWith({ alpha: ok({ minor: { detected: true, reason: '' } }) });
    await rateComFaceVersionText(MODEL_ID);
    expect(scanEntityInBackground).not.toHaveBeenCalled();
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

  it(`splits a model's strings into workflows of ${COM_VERSION_TEXT_STEPS_PER_WORKFLOW} and stops at the budget`, async () => {
    const words = Array.from({ length: 45 }, (_, i) => `w${i}`);
    await seed({ versions: [{ id: 1, name: 'v1', words }] });

    await expect(rateComFaceVersionText(MODEL_ID, 2)).resolves.toEqual({
      status: 'partial',
      workflows: 2,
    });
    expect(previewTextScanEach.mock.calls.map(([{ fields }]) => fields.length)).toEqual([20, 20]);
    expect(await verdicts(1)).toMatchObject({ pending: true });

    await expect(rateComFaceVersionText(MODEL_ID, 2)).resolves.toEqual({
      status: 'complete',
      workflows: 1,
    });
    expect(await verdicts(1)).toMatchObject({ pending: false });
  });
});

describe('processComFaceVersionText', () => {
  const queued = async (modelId = MODEL_ID) =>
    (
      await rows<{ value: Record<string, unknown> }>(
        `SELECT value FROM "KeyValue" WHERE key = $1`,
        [comVersionTextQueueKey(modelId)]
      )
    )[0]?.value;

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

  it('keeps a model with unrated strings queued for a later retry', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    rateWith({ alpha: { status: 'unavailable' } });
    await queueComFaceVersionText(MODEL_ID);
    const later = new Date(Date.now() + COM_VERSION_TEXT_QUIET_MS);

    await processComFaceVersionText(later);
    expect(await queued()).toMatchObject({ attempt: 1 });
    previewTextScanEach.mockClear();
    await processComFaceVersionText(later);
    expect(previewTextScanEach).not.toHaveBeenCalled();
  });

  it(`rates owner edits before sweep rows and spends at most ${COM_VERSION_TEXT_WORKFLOWS_PER_RUN} workflows a run`, async () => {
    const words = Array.from(
      { length: COM_VERSION_TEXT_WORKFLOWS_PER_RUN * 20 },
      (_, i) => `w${i}`
    );
    await seed({ versions: [{ id: 1, name: 'v1', words }] });
    await db.query(`INSERT INTO "Model" VALUES (8, 'Other', NULL)`);
    await db.query(
      `INSERT INTO "ModelVersion" VALUES (2, 8, 'edited', '{}', 'Published', 'Public', '{}')`
    );
    await sweepComFaceVersionText();
    await db.exec(`DELETE FROM "KeyValue" WHERE key = '${comVersionTextQueueKey(8)}'`);
    await queueComFaceVersionText(8);

    const counts = await processComFaceVersionText(
      new Date(Date.now() + COM_VERSION_TEXT_QUIET_MS)
    );
    expect(ratedTexts()[0]).toBe('edited');
    expect(counts.workflows).toBe(COM_VERSION_TEXT_WORKFLOWS_PER_RUN);
    expect(await queued()).toBeDefined();
  });
});

describe('sweepComFaceVersionText', () => {
  it('queues faced models whose shown versions have no verdict, a pending one, or a stale one', async () => {
    await seed({ versions: [{ id: 1, name: 'v1', words: ['alpha'] }] });
    await expect(sweepComFaceVersionText()).resolves.toEqual([MODEL_ID]);

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
