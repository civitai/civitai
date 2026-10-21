import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Both training-data purge jobs leave alone every file whose model owner is under a legal hold.
 * The jobs' own queries run against a Postgres stand-in, so the hold predicate is exercised as SQL;
 * only the storage delete is mocked.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockDeleteModelFileObject, mockIsFlipt } = vi.hoisted(() => ({
  mockDeleteModelFileObject: vi.fn(),
  mockIsFlipt: vi.fn(),
}));

vi.mock('~/utils/s3-utils', () => ({
  deleteModelFileObject: mockDeleteModelFileObject,
  resolveModelFileDeleteTarget: () => ({ ok: true, backend: 'b2', bucket: 'b', key: 'k' }),
  getQuarantineBucket: () => 'quarantine',
}));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: mockIsFlipt,
  FLIPT_FEATURE_FLAGS: {
    TRAINING_DATA_PURGE: 'training-data-purge',
    TRAINING_DATA_PURGE_DRY_RUN: 'training-data-purge-dry-run',
  },
}));

import { deleteOldTrainingData } from '~/server/jobs/delete-old-training-data';
import { processReplacedFiles, purgeReplacedFilesJob } from '~/server/jobs/purge-replaced-files';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

// Owners, named for the case each pins. Every owner has one model, one version and two files.
const UNHELD = 1;
const PENDING_REPORT = 2;
const RECENTLY_SENT = 3;
const SENT_OVER_A_YEAR_AGO = 4;
const SECONDARY_ON_REPORT = 5;
const SENT_JUST_UNDER_A_YEAR_AGO = 6;
const SENT_JUST_OVER_A_YEAR_AGO = 7;
const OLD_REPORT_NOT_ARCHIVED = 8;
const OLD_AND_PENDING_REPORTS = 11;
const MODEL_KEPT_AFTER_ACCOUNT_DELETION = 12; // the model now belongs to the placeholder owner
const REPORT_SUBJECT = 9; // owns nothing; the subject of the report naming SECONDARY_ON_REPORT
const OWNERS = [
  UNHELD,
  PENDING_REPORT,
  RECENTLY_SENT,
  SENT_OVER_A_YEAR_AGO,
  SECONDARY_ON_REPORT,
  SENT_JUST_UNDER_A_YEAR_AGO,
  SENT_JUST_OVER_A_YEAR_AGO,
  OLD_REPORT_NOT_ARCHIVED,
  OLD_AND_PENDING_REPORTS,
  MODEL_KEPT_AFTER_ACCOUNT_DELETION,
];
const ELIGIBLE = [UNHELD, SENT_OVER_A_YEAR_AGO, SENT_JUST_OVER_A_YEAR_AGO];
const HELD = OWNERS.filter((owner) => !ELIGIBLE.includes(owner));

const trainingFileUrl = (owner: number) => `https://example.invalid/training-${owner}`;
const replacedFileUrl = (owner: number) => `https://example.invalid/replaced-${owner}`;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY,
      "modelId" int NOT NULL,
      "uploadType" text NOT NULL,
      "trainingStatus" text
    );
    CREATE TABLE "ModelFile" (
      id int PRIMARY KEY,
      "modelVersionId" int NOT NULL,
      type text NOT NULL,
      url text NOT NULL,
      metadata jsonb,
      visibility text NOT NULL DEFAULT 'Sensitive',
      "dataPurged" boolean,
      "replacedAt" timestamp(3)
    );
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY,
      "userId" int,
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}'
    );
  `);
});

let dropHeldColumn = false;

beforeEach(async () => {
  vi.clearAllMocks();
  dropHeldColumn = false;
  loggingMock.logToAxiom.mockImplementation(() => ({ catch: () => undefined }));
  mockDeleteModelFileObject.mockResolvedValue({ deleted: true });
  mockIsFlipt.mockImplementation(async (flag: string) => flag === 'training-data-purge');
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const sql = Array.isArray(first)
      ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
      : (first as Prisma.Sql);
    const { rows } = await holder.db.query<Record<string, unknown>>(sql.text, sql.values);
    return dropHeldColumn ? rows.map(({ held: _held, ...rest }) => rest) : rows;
  }) as never);

  await holder.db.exec(`
    TRUNCATE "Model", "ModelVersion", "ModelFile", "CsamReport";
    INSERT INTO "Model" (id, "userId") SELECT u * 10, u FROM unnest(ARRAY[${OWNERS}]) u;
    INSERT INTO "ModelVersion" (id, "modelId", "uploadType", "trainingStatus")
      SELECT u * 100, u * 10, 'Trained', 'InReview' FROM unnest(ARRAY[${OWNERS}]) u;
    INSERT INTO "ModelFile" (id, "modelVersionId", type, url, metadata)
      SELECT u * 1000, u * 100, 'Training Data', 'https://example.invalid/training-' || u,
        jsonb_build_object('trainingResults', jsonb_build_object(
          'jobId', 'job-' || u, 'completedAt', to_char(now() - interval '60 days', 'YYYY-MM-DD"T"HH24:MI:SS')))
      FROM unnest(ARRAY[${OWNERS}]) u;
    INSERT INTO "ModelFile" (id, "modelVersionId", type, url, "replacedAt")
      SELECT u * 1000 + 1, u * 100, 'Model', 'https://example.invalid/replaced-' || u,
        now() - interval '60 days'
      FROM unnest(ARRAY[${OWNERS}]) u;
    UPDATE "Model" SET "userId" = -1 WHERE id = ${MODEL_KEPT_AFTER_ACCOUNT_DELETION * 10};
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", details) VALUES
      (${PENDING_REPORT}, NULL, NULL, '{}'),
      (${RECENTLY_SENT}, now() - interval '30 days', now(), 'null'),
      (${SENT_OVER_A_YEAR_AGO}, now() - interval '400 days', now(), '{}'),
      (${REPORT_SUBJECT}, now() - interval '30 days', now(), '{"secondaryUserId": ${SECONDARY_ON_REPORT}}'),
      (${SENT_JUST_UNDER_A_YEAR_AGO}, now() - interval '360 days', now(), '{}'),
      (${SENT_JUST_OVER_A_YEAR_AGO}, now() - interval '370 days', now(), '{}'),
      (${OLD_REPORT_NOT_ARCHIVED}, now() - interval '400 days', NULL, '{}'),
      (${OLD_AND_PENDING_REPORTS}, now() - interval '400 days', now(), '{}'),
      (${OLD_AND_PENDING_REPORTS}, NULL, NULL, '{}');
  `);
});

const deletedUrls = () => mockDeleteModelFileObject.mock.calls.map(([url]) => url as string).sort();

const skipReasons = () =>
  Object.fromEntries(
    loggingMock.logToAxiom.mock.calls
      .map(([entry]) => entry as { data?: { reason?: string; modelFileId?: number } })
      .filter((entry) => entry.data?.reason)
      .map((entry) => [entry.data!.modelFileId, entry.data!.reason])
  );

describe('delete-old-training-data under a legal hold', () => {
  it('deletes only the training data of owners no hold covers', async () => {
    await deleteOldTrainingData.run({}).result;

    expect(deletedUrls()).toEqual(ELIGIBLE.map(trainingFileUrl).sort());
    expect(skipReasons()).toEqual(
      Object.fromEntries(HELD.map((owner) => [owner * 1000, 'legal-hold']))
    );
  });

  it('reports held files as would-skip in a dry run', async () => {
    mockIsFlipt.mockImplementation(async () => true);

    await deleteOldTrainingData.run({}).result;

    expect(mockDeleteModelFileObject).not.toHaveBeenCalled();
    const wouldSkip = loggingMock.logToAxiom.mock.calls
      .map(
        ([entry]) => entry as { message?: string; data?: { modelFileId?: number; reason?: string } }
      )
      .filter((entry) => entry.message === 'Dry run, would skip')
      .map((entry) => [entry.data!.modelFileId, entry.data!.reason]);
    expect(Object.fromEntries(wouldSkip)).toEqual(
      Object.fromEntries(HELD.map((owner) => [owner * 1000, 'legal-hold']))
    );
  });

  it('deletes nothing when whether a row is held is unknown', async () => {
    dropHeldColumn = true;

    await deleteOldTrainingData.run({}).result;

    expect(mockDeleteModelFileObject).not.toHaveBeenCalled();
    expect(new Set(Object.values(skipReasons()))).toEqual(new Set(['legal-hold-unknown']));
  });
});

describe('purge-replaced-files under a legal hold', () => {
  it('purges only the replaced files of owners no hold covers', async () => {
    await purgeReplacedFilesJob.run({}).result;

    expect(deletedUrls()).toEqual(ELIGIBLE.map(replacedFileUrl).sort());
    expect(skipReasons()).toEqual(
      Object.fromEntries(HELD.map((owner) => [owner * 1000 + 1, 'legal-hold']))
    );
  });

  it('skips a row whose hold status is unknown', async () => {
    const result = await processReplacedFiles([{ id: 77, url: 'u77', held: null as never }]);

    expect(mockDeleteModelFileObject).not.toHaveBeenCalled();
    expect(result).toEqual({ purged: 0, failed: 0, skipped: 1 });
    expect(skipReasons()).toEqual({ 77: 'legal-hold-unknown' });
  });
});
