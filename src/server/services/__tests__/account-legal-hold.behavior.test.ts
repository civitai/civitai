import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * Deleting an account is refused while a legal hold covers it. The hold query runs as SQL against a
 * Postgres stand-in, and `deleteUser` is the real service, so a refusal here is the refusal every
 * caller gets. One owner per way of being held, plus a clean one that must still be deletable.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

import {
  getAccountLegalHoldLegs,
  isAccountUnderLegalHold,
  LegalHoldError,
} from '~/server/services/legal-hold.service';
import { deleteUser } from '~/server/services/user.service';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const CLEAN = 1;
const PENDING_REPORT = 2;
const RECENTLY_SENT = 3;
const SENT_OVER_A_YEAR_AGO = 4;
const SECONDARY_ON_REPORT = 5;
const IMAGE_IN_REVIEW = 6;
const IMAGE_BLOCKED_UNREPORTED = 7;
const IMAGE_BLOCKED_REPORTED_LONG_AGO = 8;
const HOLD_MARKER = 10;
const RELEASED_MARKER = 11;
const REPORT_SUBJECT = 9;
const SECONDARY_BLOCKED_REPORTED_LONG_AGO = 12;
const OLD_REPORT_SUBJECT = 13; // owns nothing; names SECONDARY_BLOCKED_REPORTED_LONG_AGO
const NEW_IMAGE_AFTER_OLD_REPORT = 14;
const SENT_LONG_AGO_NOT_ARCHIVED = 15;

let failQueries = false;
let unreadable = false;
type Row = Record<string, unknown>;
/** Replaces what one statement answers, picked out by its text. */
let answer: ((sql: string, rows: Row[]) => Row[]) | null = null;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY,
      "userId" int,
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}',
      images jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "Image" (
      id serial PRIMARY KEY,
      "userId" int NOT NULL,
      "needsReview" text,
      "blockedFor" text
    );
  `);
});

async function createMarkerView() {
  await holder.db.exec(`
    CREATE TABLE "EvidenceHold" ("userId" int NOT NULL, "releasedAt" timestamp(3));
    CREATE VIEW "EvidenceHeldUser" AS
      SELECT "userId" FROM "EvidenceHold" WHERE "releasedAt" IS NULL GROUP BY "userId";
    INSERT INTO "EvidenceHold" VALUES (${HOLD_MARKER}, NULL), (${RELEASED_MARKER}, now());
  `);
}

beforeEach(async () => {
  vi.clearAllMocks();
  failQueries = false;
  unreadable = false;
  answer = null;
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    if (failQueries) throw new Error('connection reset');
    const sql = Array.isArray(first)
      ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
      : (first as Prisma.Sql);
    const { rows } = await holder.db.query<Row>(sql.text, sql.values);
    if (answer) return answer(sql.text, rows);
    // Every column comes back as something other than a boolean.
    return unreadable
      ? rows.map((row) => Object.fromEntries(Object.keys(row).map((k) => [k, null])))
      : rows;
  }) as never);

  await holder.db.exec(`
    DROP VIEW IF EXISTS "EvidenceHeldUser";
    DROP TABLE IF EXISTS "EvidenceHold";
    TRUNCATE "CsamReport", "Image";
    -- Image ids are the owner's id times 100, plus one for a second image. A sent report's images
    -- carry the upload's keys beside the id, as the sending job writes them.
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", details, images) VALUES
      (${PENDING_REPORT}, NULL, NULL, '{}', '[]'),
      (${RECENTLY_SENT}, now() - interval '30 days', now(), 'null', '[]'),
      (${SENT_OVER_A_YEAR_AGO}, now() - interval '400 days', now(), '{}', '[]'),
      (${SENT_LONG_AGO_NOT_ARCHIVED}, now() - interval '400 days', NULL, '{}', '[]'),
      (${REPORT_SUBJECT}, now() - interval '30 days', now(),
        '{"secondaryUserId": ${SECONDARY_ON_REPORT}}', '[]'),
      (${IMAGE_BLOCKED_REPORTED_LONG_AGO}, now() - interval '400 days', now(), '{}',
        '[{"id": ${
          IMAGE_BLOCKED_REPORTED_LONG_AGO * 100
        }, "fileId": "f1", "hash": "h1", "fileAnnotations": {}}]'),
      (${OLD_REPORT_SUBJECT}, now() - interval '400 days', now(),
        '{"secondaryUserId": ${SECONDARY_BLOCKED_REPORTED_LONG_AGO}}',
        '[{"id": 1, "fileId": "f0"}, {"id": ${
          SECONDARY_BLOCKED_REPORTED_LONG_AGO * 100
        }, "fileId": "f2", "hash": "h2"}]'),
      (${NEW_IMAGE_AFTER_OLD_REPORT}, now() - interval '400 days', now(), '{}',
        '[{"id": ${NEW_IMAGE_AFTER_OLD_REPORT * 100}}]'),
      -- Sent and naming the unreported owner, but listing none of their images.
      (${IMAGE_BLOCKED_UNREPORTED}, now() - interval '400 days', now(), '{}', '[{"id": 1}]');
    INSERT INTO "Image" (id, "userId", "needsReview", "blockedFor") VALUES
      (${CLEAN * 100}, ${CLEAN}, 'minor', 'AiNotVerified'),
      (${IMAGE_IN_REVIEW * 100}, ${IMAGE_IN_REVIEW}, 'csam', NULL),
      (${IMAGE_BLOCKED_UNREPORTED * 100}, ${IMAGE_BLOCKED_UNREPORTED}, NULL, 'CSAM'),
      (${IMAGE_BLOCKED_REPORTED_LONG_AGO * 100}, ${IMAGE_BLOCKED_REPORTED_LONG_AGO}, NULL, 'CSAM'),
      (${
        SECONDARY_BLOCKED_REPORTED_LONG_AGO * 100
      }, ${SECONDARY_BLOCKED_REPORTED_LONG_AGO}, NULL, 'CSAM'),
      (${NEW_IMAGE_AFTER_OLD_REPORT * 100}, ${NEW_IMAGE_AFTER_OLD_REPORT}, NULL, 'CSAM'),
      (${NEW_IMAGE_AFTER_OLD_REPORT * 100 + 1}, ${NEW_IMAGE_AFTER_OLD_REPORT}, NULL, 'CSAM');
  `);
});

describe('getAccountLegalHoldLegs', () => {
  it.each([
    ['a pending report', PENDING_REPORT, ['report']],
    ['a report sent within the year', RECENTLY_SENT, ['report']],
    ['a report sent long ago and not yet archived', SENT_LONG_AGO_NOT_ARCHIVED, ['report']],
    ['the secondary user on a report', SECONDARY_ON_REPORT, ['report']],
    ['an image awaiting that review', IMAGE_IN_REVIEW, ['image-review']],
    [
      'an image blocked for it that no sent report lists',
      IMAGE_BLOCKED_UNREPORTED,
      ['image-blocked'],
    ],
    [
      'a new blocked image beside one an old sent report lists',
      NEW_IMAGE_AFTER_OLD_REPORT,
      ['image-blocked'],
    ],
  ])('holds an account with %s', async (_, userId, legs) => {
    expect(await getAccountLegalHoldLegs(userId)).toEqual(legs);
  });

  it.each([
    ['nothing on record', CLEAN],
    ['only a report sent over a year ago', SENT_OVER_A_YEAR_AGO],
    ['a blocked image whose report was sent', IMAGE_BLOCKED_REPORTED_LONG_AGO],
    [
      'a blocked image and a sent report naming them as secondary',
      SECONDARY_BLOCKED_REPORTED_LONG_AGO,
    ],
  ])('does not hold an account with %s', async (_, userId) => {
    expect(await getAccountLegalHoldLegs(userId)).toEqual([]);
  });

  it('reads the hold marker once its view exists, and only an unreleased one', async () => {
    expect(await getAccountLegalHoldLegs(HOLD_MARKER)).toEqual([]);

    await createMarkerView();

    expect(await getAccountLegalHoldLegs(HOLD_MARKER)).toEqual(['hold-marker']);
    expect(await getAccountLegalHoldLegs(RELEASED_MARKER)).toEqual([]);
    expect(await getAccountLegalHoldLegs(CLEAN)).toEqual([]);
  });
});

describe('an answer that is not a boolean', () => {
  it('counts every unreadable column as a hold', async () => {
    unreadable = true;
    expect((await getAccountLegalHoldLegs(CLEAN)).sort()).toEqual(
      ['hold-marker', 'image-blocked', 'image-review', 'report'].sort()
    );
  });
});

describe('an answer that is missing', () => {
  it('counts a hold-marker answer that is not a boolean, or no row, as a hold', async () => {
    await createMarkerView();
    const fromMarker = (replacement: Row[]) => (sql: string, rows: Row[]) =>
      sql.includes('FROM "EvidenceHeldUser"') ? replacement : rows;

    answer = fromMarker([{ held: null }]);
    expect(await getAccountLegalHoldLegs(CLEAN)).toEqual(['hold-marker']);
    answer = fromMarker([]);
    expect(await getAccountLegalHoldLegs(CLEAN)).toEqual(['hold-marker']);
  });

  it('refuses when the lookup returns no row at all', async () => {
    answer = (sql, rows) => (sql.includes('markerViewExists') ? [] : rows);
    expect(await isAccountUnderLegalHold(CLEAN)).toBeNull();
  });
});

describe('isAccountUnderLegalHold', () => {
  it('reads a failed lookup as unknown, never as clear', async () => {
    expect(await isAccountUnderLegalHold(CLEAN)).toBe(false);
    failQueries = true;
    expect(await isAccountUnderLegalHold(CLEAN)).toBeNull();
  });
});

describe('deleteUser under a legal hold', () => {
  const run = (id: number) => deleteUser({ id, username: 'someone' });

  beforeEach(() => {
    dbMock.dbWrite.user.findFirst.mockImplementation((async (args: { where: { id: number } }) => ({
      id: args.where.id,
      meta: {},
    })) as never);
    dbMock.dbWrite.$transaction.mockImplementation((async (ops: unknown) => ops) as never);
  });

  it.each([PENDING_REPORT, SECONDARY_ON_REPORT, IMAGE_IN_REVIEW, IMAGE_BLOCKED_UNREPORTED])(
    'refuses held account %i before anything is written',
    async (userId) => {
      await expect(run(userId)).rejects.toBeInstanceOf(LegalHoldError);
      expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    }
  );

  it('refuses an account held by the marker', async () => {
    await createMarkerView();
    await expect(run(HOLD_MARKER)).rejects.toBeInstanceOf(LegalHoldError);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('refuses when the hold cannot be checked', async () => {
    failQueries = true;
    await expect(run(CLEAN)).rejects.toBeInstanceOf(LegalHoldError);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('deletes an account no hold covers', async () => {
    await run(CLEAN);
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
  });

  it('logs which hold applied, and the refusal carries none of it', async () => {
    const error = await run(IMAGE_IN_REVIEW).catch((e: Error) => e);
    expect((error as Error).message).toBe('Account under legal hold');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'account-legal-hold',
        details: { userId: IMAGE_IN_REVIEW, legs: ['image-review'] },
      })
    );
  });
});
