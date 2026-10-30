import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Both training-data purge jobs leave alone every file whose model owner, or any owner it had before,
 * is under a legal hold.
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
import {
  HOLD_MARKER_TABLE,
  HOLD_MARKER_VIEW,
  heldModelIdsSql,
  modelDataHeldSql,
} from '~/server/services/legal-hold.service';
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
const MARKER_HELD = 13; // no report; a hold marker set by a person
const MARKER_RELEASED = 14; // no report; a hold marker that was released
const IMAGE_REVIEW_HELD = 15; // no report; an image of theirs awaits review
const TRANSFERRED_FROM_HELD = 16; // unheld; given the model of PENDING_REPORT
const TRANSFERRED_FROM_UNHELD = 17; // unheld; given the model of UNHELD
const REPORTED_IMAGE_HELD = 18; // named on no report; an image of theirs is listed on one
const REPORTED_IMAGE_SUBJECT = 19; // owns nothing; the subject of that report
const ONCE_PLACEHOLDER_OWNED = 20; // unheld; given back by restore a model the placeholder owner had
const PLACEHOLDER_NOT_RESTORED = 22; // unheld; moved a model off the placeholder with no restore
const RESTORED_TO_HELD = 23; // named on a pending report; given back a placeholder-owned model
const PLACEHOLDER_AGAIN = 24; // unheld; restored once, back to the placeholder, then moved off it
const LEGACY_PLACEHOLDER_RESTORED = 25; // unheld; restored a model the backfill found with the placeholder
const TRANSFERRED_FROM_IMAGE_HELD = 21; // unheld; given the model of IMAGE_REVIEW_HELD
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
  MARKER_HELD,
  MARKER_RELEASED,
  IMAGE_REVIEW_HELD,
  TRANSFERRED_FROM_HELD,
  TRANSFERRED_FROM_UNHELD,
  REPORTED_IMAGE_HELD,
  ONCE_PLACEHOLDER_OWNED,
  TRANSFERRED_FROM_IMAGE_HELD,
  PLACEHOLDER_NOT_RESTORED,
  RESTORED_TO_HELD,
  PLACEHOLDER_AGAIN,
  LEGACY_PLACEHOLDER_RESTORED,
];
const ELIGIBLE = [
  UNHELD,
  SENT_OVER_A_YEAR_AGO,
  SENT_JUST_OVER_A_YEAR_AGO,
  MARKER_RELEASED,
  TRANSFERRED_FROM_UNHELD,
  ONCE_PLACEHOLDER_OWNED,
];
const HELD = OWNERS.filter((owner) => !ELIGIBLE.includes(owner));

const ownershipMigration = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261209120000_model_ownership/migration.sql'
);

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
      details jsonb NOT NULL DEFAULT '{}',
      images jsonb
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "needsReview" text,
      "blockedFor" text
    );
    CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL);
  `);
  await holder.db.exec(
    readFileSync(
      path.resolve(
        __dirname,
        '../../../../packages/civitai-db-schema/prisma/migrations/20261019220000_evidence_hold/migration.sql'
      ),
      'utf8'
    )
  );
  await holder.db.exec(readFileSync(ownershipMigration, 'utf8'));
  // Each transferred model's owners, from its first to its current one. Append-only, so set once.
  await holder.db.exec(`
    INSERT INTO "ModelOwnership" ("modelId", "userId", reason) VALUES
      (${TRANSFERRED_FROM_HELD * 10}, ${PENDING_REPORT}, 'create'),
      (${TRANSFERRED_FROM_HELD * 10}, ${TRANSFERRED_FROM_HELD}, 'transfer'),
      (${TRANSFERRED_FROM_UNHELD * 10}, ${UNHELD}, 'create'),
      (${TRANSFERRED_FROM_UNHELD * 10}, ${TRANSFERRED_FROM_UNHELD}, 'transfer'),
      (${ONCE_PLACEHOLDER_OWNED * 10}, -1, 'account-delete'),
      (${ONCE_PLACEHOLDER_OWNED * 10}, ${ONCE_PLACEHOLDER_OWNED}, 'restore'),
      (${TRANSFERRED_FROM_IMAGE_HELD * 10}, ${IMAGE_REVIEW_HELD}, 'create'),
      (${TRANSFERRED_FROM_IMAGE_HELD * 10}, ${TRANSFERRED_FROM_IMAGE_HELD}, 'transfer'),
      (${PLACEHOLDER_NOT_RESTORED * 10}, -1, 'account-delete'),
      (${PLACEHOLDER_NOT_RESTORED * 10}, ${PLACEHOLDER_NOT_RESTORED}, 'transfer'),
      (${RESTORED_TO_HELD * 10}, ${RESTORED_TO_HELD}, 'create'),
      (${RESTORED_TO_HELD * 10}, -1, 'account-delete'),
      (${RESTORED_TO_HELD * 10}, ${RESTORED_TO_HELD}, 'restore'),
      (${PLACEHOLDER_AGAIN * 10}, -1, 'account-delete'),
      (${PLACEHOLDER_AGAIN * 10}, ${PLACEHOLDER_AGAIN}, 'restore'),
      (${PLACEHOLDER_AGAIN * 10}, -1, 'account-delete'),
      (${PLACEHOLDER_AGAIN * 10}, ${PLACEHOLDER_AGAIN}, 'transfer'),
      (${LEGACY_PLACEHOLDER_RESTORED * 10}, -1, 'baseline'),
      (${LEGACY_PLACEHOLDER_RESTORED * 10}, ${LEGACY_PLACEHOLDER_RESTORED}, 'baseline'),
      (${LEGACY_PLACEHOLDER_RESTORED * 10}, ${LEGACY_PLACEHOLDER_RESTORED}, 'restore');
    INSERT INTO "Image" (id, "userId", "needsReview") VALUES
      (1, ${IMAGE_REVIEW_HELD}, 'csam'),
      (2, ${REPORTED_IMAGE_HELD}, NULL);
  `);
  // The report legs are pinned by the reports below on their own; the marker legs by these rows.
  await holder.db.exec(`
    ALTER TABLE "CsamReport" DISABLE TRIGGER "CsamReport_evidence_hold";
    INSERT INTO "EvidenceHold" ("userId", role, reason, "releasedAt", "releasedById", "releaseReason") VALUES
      (${MARKER_HELD}, 'manual', 'review', NULL, NULL, NULL),
      (${MARKER_RELEASED}, 'manual', 'review', now(), 1, 'done');
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
    INSERT INTO "CsamReport" ("userId", images) VALUES (${REPORTED_IMAGE_SUBJECT}, '[{"id": 2}]');
    INSERT INTO "CsamReport" ("userId") VALUES (${RESTORED_TO_HELD});
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

describe('model ownership history', () => {
  it('keeps a model transferred away from a held owner held', async () => {
    await purgeReplacedFilesJob.run({}).result;
    await deleteOldTrainingData.run({}).result;

    expect(deletedUrls()).not.toContain(replacedFileUrl(TRANSFERRED_FROM_HELD));
    expect(deletedUrls()).not.toContain(trainingFileUrl(TRANSFERRED_FROM_HELD));
    expect(deletedUrls()).toContain(replacedFileUrl(TRANSFERRED_FROM_UNHELD));
    expect(deletedUrls()).toContain(trainingFileUrl(TRANSFERRED_FROM_UNHELD));
  });

  it('deletes nothing without the history table', async () => {
    await holder.db.exec(`ALTER TABLE "ModelOwnership" RENAME TO "ModelOwnershipAside"`);
    try {
      await purgeReplacedFilesJob.run({}).result.catch(() => undefined);
      await deleteOldTrainingData.run({}).result.catch(() => undefined);
    } finally {
      await holder.db.exec(`ALTER TABLE "ModelOwnershipAside" RENAME TO "ModelOwnership"`);
    }

    expect(mockDeleteModelFileObject).not.toHaveBeenCalled();
  });

  it('deletes nothing when the hold marker view is missing but its table is there', async () => {
    await holder.db.exec(`ALTER VIEW "${HOLD_MARKER_VIEW}" RENAME TO "MarkerViewAside"`);
    try {
      await purgeReplacedFilesJob.run({}).result;
      await deleteOldTrainingData.run({}).result;
    } finally {
      await holder.db.exec(`ALTER VIEW "MarkerViewAside" RENAME TO "${HOLD_MARKER_VIEW}"`);
    }

    expect(mockDeleteModelFileObject).not.toHaveBeenCalled();
  });

  it('holds the same models checked as a set as one at a time', async () => {
    const compare = async (markerView: boolean) => {
      const { rows } = await holder.db.query<{ id: number; one: boolean; many: boolean }>(
        Prisma.sql`
          SELECT m.id, ${modelDataHeldSql(Prisma.raw('m.id'), markerView)} AS one,
            m.id IN (${heldModelIdsSql(Prisma.sql`SELECT id FROM "Model"`, markerView)}) AS many
          FROM "Model" m ORDER BY m.id
        `.text
      );
      expect(rows.length).toBe(OWNERS.length);
      expect(rows.filter((r) => r.one !== r.many)).toEqual([]);
      return rows.filter((r) => !r.one).map((r) => r.id / 10);
    };

    expect(await compare(true)).toEqual([...ELIGIBLE].sort((a, b) => a - b));
    // With neither marker object, the marker leg holds no one: only the other legs decide.
    await holder.db.exec(`
      ALTER VIEW "${HOLD_MARKER_VIEW}" RENAME TO "MarkerViewAside";
      ALTER TABLE "${HOLD_MARKER_TABLE}" RENAME TO "MarkerTableAside";
    `);
    try {
      expect(await compare(false)).toEqual([...ELIGIBLE, MARKER_HELD].sort((a, b) => a - b));
    } finally {
      await holder.db.exec(`
        ALTER VIEW "MarkerViewAside" RENAME TO "${HOLD_MARKER_VIEW}";
        ALTER TABLE "MarkerTableAside" RENAME TO "${HOLD_MARKER_TABLE}";
      `);
    }
  });

  it('refuses to change or remove a recorded owner', async () => {
    await expect(holder.db.exec(`UPDATE "ModelOwnership" SET "userId" = 1`)).rejects.toThrow(
      'append-only'
    );
    await expect(holder.db.exec(`DELETE FROM "ModelOwnership"`)).rejects.toThrow('append-only');
    await expect(holder.db.exec(`TRUNCATE "ModelOwnership"`)).rejects.toThrow('append-only');
  });
});
