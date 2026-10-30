import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
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
  guardedAccountScrubSql,
  isAccountUnderLegalHold,
  isLegalHoldAbort,
  LegalHoldError,
} from '~/server/services/legal-hold.service';
import { deleteUser } from '~/server/services/user.service';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const CLEAN = 1;
const CLEAN_MODEL = 100;
const UNRECORDED_MODEL = 101;
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
const IMAGE_ON_INTERNAL_REPORT = 16; // their image is listed on a report naming someone else
const ALREADY_DELETED = 17;
const IMAGE_ON_OLD_REPORT = 18; // their image is listed on an archived report sent over a year ago
const IMAGE_PAST_INT_RANGE = 19; // a pending report lists their image, whose id is past int range
const BIG_IMAGE_ID = 10_000_000_019;
const EXPIRED_MARKER = 20;
const EXTENDED_MARKER = 21;
const RELEASED_WITH_REPORT = 22; // a released marker, and a pending report naming them
const ALL_USERS = Array.from({ length: 22 }, (_, i) => i + 1);

let failQueries = false;
let unreadable = false;
type Row = Record<string, unknown>;
/** Replaces what one statement answers, picked out by its text. */
let answer: ((sql: string, rows: Row[]) => Row[]) | null = null;
/** Runs just before the guarded scrub executes: a hold landing after the check. */
let beforeScrub: (() => Promise<unknown>) | null = null;

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
    -- bigint, unlike prod's int today, so a report can list an id past int range.
    CREATE TABLE "Image" (
      id bigint PRIMARY KEY,
      "userId" int NOT NULL,
      "needsReview" text,
      "blockedFor" text
    );
    CREATE TABLE "User" (
      id int PRIMARY KEY,
      "deletedAt" timestamp(3),
      email text,
      username text,
      name text,
      "paddleCustomerId" text,
      "customerId" text,
      image text,
      "profilePictureId" int,
      "subscriptionId" text
    );
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
    INSERT INTO "Model" VALUES (${CLEAN_MODEL}, ${CLEAN});
  `);
  await holder.db.exec(
    readFileSync(
      path.resolve(
        __dirname,
        '../../../../packages/civitai-db-schema/prisma/migrations/20261209120000_model_ownership/migration.sql'
      ),
      'utf8'
    )
  );
});

const userRow = async (id: number) =>
  (await holder.db.query<Row>(`SELECT * FROM "User" WHERE id = $1`, [id])).rows[0];

async function createMarkerView() {
  await holder.db.exec(`
    CREATE TABLE "EvidenceHold" (
      "userId" int NOT NULL, "releasedAt" timestamp(3), "releaseAt" timestamp(3),
      "extendedUntil" timestamp(3)
    );
    -- The view's WHERE as the migration that adds it writes it: released and expired holds drop out.
    CREATE VIEW "EvidenceHeldUser" AS
      SELECT "userId" FROM "EvidenceHold"
      WHERE "releasedAt" IS NULL
        AND ("releaseAt" IS NULL OR "releaseAt" > now() OR "extendedUntil" > now())
      GROUP BY "userId";
    INSERT INTO "EvidenceHold" VALUES
      (${HOLD_MARKER}, NULL, NULL, NULL),
      (${RELEASED_MARKER}, now(), NULL, NULL),
      (${EXPIRED_MARKER}, NULL, now() - interval '1 day', NULL),
      (${EXTENDED_MARKER}, NULL, now() - interval '1 day', now() + interval '1 day'),
      (${RELEASED_WITH_REPORT}, now(), NULL, NULL);
  `);
}

/** A query that runs only when awaited. */
const lazy = <T>(run: () => Promise<T>) => {
  let started: Promise<T> | undefined;
  return {
    then: <R1, R2>(res?: (v: T) => R1, rej?: (e: unknown) => R2) =>
      (started ??= run()).then(res, rej),
  };
};

beforeEach(async () => {
  vi.clearAllMocks();
  failQueries = false;
  unreadable = false;
  answer = null;
  beforeScrub = null;
  // Runs when awaited, as Prisma's does, so a transaction's statements run in its array's order.
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(((sql: Prisma.Sql) =>
    lazy(async () => {
      // The scrub is the transaction's first statement.
      const hook = beforeScrub;
      beforeScrub = null;
      if (hook) await hook();
      // A DO block takes no parameters; the guarded scrub is built to carry none.
      if (sql.values.length) await holder.db.query(sql.text, sql.values);
      else await holder.db.exec(sql.text);
      return 1;
    })) as never);
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
    TRUNCATE "CsamReport", "Image", "User";
    INSERT INTO "User" (id, email, username, name, "paddleCustomerId", "customerId", image,
        "profilePictureId", "subscriptionId")
      SELECT u, 'u' || u || '@example.invalid', 'user' || u, 'Name ' || u, 'pad' || u, 'cus' || u,
        'img' || u, u, 'sub' || u
      FROM unnest(ARRAY[${ALL_USERS}]) u;
    UPDATE "User" SET "deletedAt" = now() - interval '1 day' WHERE id = ${ALREADY_DELETED};
    -- Image ids are the owner's id times 100, plus one for a second image. A sent report's images
    -- carry the upload's keys beside the id, as the sending job writes them.
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", details, images) VALUES
      (${PENDING_REPORT}, NULL, NULL, '{}', '[]'),
      (${RELEASED_WITH_REPORT}, NULL, NULL, '{}', '[]'),
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
      (${IMAGE_BLOCKED_UNREPORTED}, now() - interval '400 days', now(), '{}', '[{"id": 1}]'),
      -- Pending, naming the placeholder owner, listing another user's image.
      (-1, NULL, NULL, '{}', '[{"id": ${IMAGE_ON_INTERNAL_REPORT * 100}, "fileId": "f3"}]'),
      (NULL, now() - interval '400 days', now(), '{}', '[{"id": ${IMAGE_ON_OLD_REPORT * 100}}]'),
      -- Pending, naming nobody, with image lists no job writes. Every lookup reads past them.
      (NULL, NULL, NULL, '{}', '{}'),
      (NULL, NULL, NULL, '{}', '[null, 5, {"id": null}, {"id": "abc"}, {"id": 99999999999}]'),
      (NULL, NULL, NULL, '{}', '[{"id": 12345678901234567890}]'),
      (NULL, NULL, NULL, '{}', '[{"id": ${BIG_IMAGE_ID}}]');
    INSERT INTO "Image" (id, "userId", "needsReview", "blockedFor") VALUES
      (${CLEAN * 100}, ${CLEAN}, 'minor', 'AiNotVerified'),
      (${IMAGE_IN_REVIEW * 100}, ${IMAGE_IN_REVIEW}, 'csam', NULL),
      (${IMAGE_BLOCKED_UNREPORTED * 100}, ${IMAGE_BLOCKED_UNREPORTED}, NULL, 'CSAM'),
      (${IMAGE_BLOCKED_REPORTED_LONG_AGO * 100}, ${IMAGE_BLOCKED_REPORTED_LONG_AGO}, NULL, 'CSAM'),
      (${
        SECONDARY_BLOCKED_REPORTED_LONG_AGO * 100
      }, ${SECONDARY_BLOCKED_REPORTED_LONG_AGO}, NULL, 'CSAM'),
      (${NEW_IMAGE_AFTER_OLD_REPORT * 100}, ${NEW_IMAGE_AFTER_OLD_REPORT}, NULL, 'CSAM'),
      (${NEW_IMAGE_AFTER_OLD_REPORT * 100 + 1}, ${NEW_IMAGE_AFTER_OLD_REPORT}, NULL, 'CSAM'),
      (${IMAGE_ON_INTERNAL_REPORT * 100}, ${IMAGE_ON_INTERNAL_REPORT}, NULL, NULL),
      (${IMAGE_ON_OLD_REPORT * 100}, ${IMAGE_ON_OLD_REPORT}, NULL, NULL),
      (${BIG_IMAGE_ID}, ${IMAGE_PAST_INT_RANGE}, NULL, NULL);
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
    [
      'an image listed on a report that names someone else',
      IMAGE_ON_INTERNAL_REPORT,
      ['reported-image'],
    ],
    ['a listed image whose id is past int range', IMAGE_PAST_INT_RANGE, ['reported-image']],
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
    ['an image listed only on an archived report sent over a year ago', IMAGE_ON_OLD_REPORT],
  ])('does not hold an account with %s', async (_, userId) => {
    expect(await getAccountLegalHoldLegs(userId)).toEqual([]);
  });

  it('reads the hold marker once its view exists, and only an unreleased one', async () => {
    expect(await getAccountLegalHoldLegs(HOLD_MARKER)).toEqual([]);

    await createMarkerView();

    expect(await getAccountLegalHoldLegs(HOLD_MARKER)).toEqual(['hold-marker']);
    expect(await getAccountLegalHoldLegs(RELEASED_MARKER)).toEqual([]);
    expect(await getAccountLegalHoldLegs(EXPIRED_MARKER)).toEqual([]);
    expect(await getAccountLegalHoldLegs(EXTENDED_MARKER)).toEqual(['hold-marker']);
    expect(await getAccountLegalHoldLegs(CLEAN)).toEqual([]);
  });

  // A release lets the marker go, never a report.
  it('still holds a released marker’s account by its report', async () => {
    await createMarkerView();
    expect(await getAccountLegalHoldLegs(RELEASED_WITH_REPORT)).toEqual(['report']);
  });

  it('holds every account when the marker table exists without its view', async () => {
    await holder.db.exec(`CREATE TABLE "EvidenceHold" ("userId" int NOT NULL)`);
    expect(await getAccountLegalHoldLegs(CLEAN)).toEqual(['hold-marker']);
  });
});

describe('an answer that is not a boolean', () => {
  it('counts every unreadable column as a hold', async () => {
    unreadable = true;
    expect((await getAccountLegalHoldLegs(CLEAN)).sort()).toEqual(
      ['hold-marker', 'image-blocked', 'image-review', 'report', 'reported-image'].sort()
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
    answer = (sql, rows) => (sql.includes('"markerTable"') ? [] : rows);
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

  beforeEach(async () => {
    dbMock.dbWrite.user.findFirst.mockImplementation((async (args: { where: { id: number } }) => ({
      id: args.where.id,
      meta: {},
    })) as never);
    // Like Prisma's array form: a failing statement fails the transaction.
    // Like Prisma's array form: in order, and a failing statement fails the transaction.
    dbMock.dbWrite.$transaction.mockImplementation((async (ops: unknown[]) => {
      const results = [];
      for (const op of ops) results.push(await op);
      return results;
    }) as never);
    // The move to the placeholder, on the stand-in, so the history write is seen before or after it.
    dbMock.dbWrite.model.updateMany.mockImplementation(((args: {
      where: { userId: number };
      data: { userId?: number };
    }) =>
      lazy(async () =>
        args.data.userId === undefined
          ? { count: 0 }
          : {
              count:
                (
                  await holder.db.query(`UPDATE "Model" SET "userId" = $1 WHERE "userId" = $2`, [
                    args.data.userId,
                    args.where.userId,
                  ])
                ).affectedRows ?? 0,
            }
      )) as never);
    await holder.db.exec(`UPDATE "Model" SET "userId" = ${CLEAN} WHERE id = ${CLEAN_MODEL}`);
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

  it('refuses an account whose marker was released but who is named on a report', async () => {
    await createMarkerView();
    const before = await userRow(RELEASED_WITH_REPORT);
    await expect(run(RELEASED_WITH_REPORT)).rejects.toBeInstanceOf(LegalHoldError);
    expect(await userRow(RELEASED_WITH_REPORT)).toEqual(before);
  });

  it('deletes an account whose marker expired unreleased', async () => {
    await createMarkerView();
    await run(EXPIRED_MARKER);
    expect(await userRow(EXPIRED_MARKER)).toMatchObject({ email: null, username: null });
  });

  it('refuses when the hold cannot be checked', async () => {
    failQueries = true;
    await expect(run(CLEAN)).rejects.toBeInstanceOf(LegalHoldError);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('records the placeholder as the next owner of the models it takes', async () => {
    const accountDeletes = async () =>
      (
        await holder.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "ModelOwnership"
           WHERE "modelId" = $1 AND "userId" = -1 AND reason = 'account-delete'`,
          [CLEAN_MODEL]
        )
      ).rows[0].n;
    const before = await accountDeletes();

    await run(CLEAN);

    expect(await accountDeletes()).toBe(before + 1);
  });

  it('records the outgoing owner first when the model has no history yet', async () => {
    await holder.db.exec(`INSERT INTO "Model" VALUES (${UNRECORDED_MODEL}, ${CLEAN})`);

    await run(CLEAN);

    const { rows } = await holder.db.query<{ userId: number; reason: string }>(
      `SELECT "userId", reason FROM "ModelOwnership" WHERE "modelId" = $1 ORDER BY id`,
      [UNRECORDED_MODEL]
    );
    expect(rows).toEqual([
      { userId: CLEAN, reason: 'baseline' },
      { userId: -1, reason: 'account-delete' },
    ]);
  });

  it('records no new owner when the models are deleted rather than kept', async () => {
    const rows = async () =>
      (await holder.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "ModelOwnership"`))
        .rows[0].n;
    const before = await rows();

    await deleteUser({ id: CLEAN, username: 'someone', removeModels: true });

    expect(await rows()).toBe(before);
  });

  it('deletes an account no hold covers, end to end', async () => {
    await run(CLEAN);

    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.model.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: CLEAN } })
    );
    const row = await userRow(CLEAN);
    expect(row.deletedAt).not.toBeNull();
    expect(row).toMatchObject({
      email: null,
      username: null,
      name: null,
      paddleCustomerId: null,
      image: null,
      profilePictureId: null,
      subscriptionId: null,
      // Kept on purpose: see delete-user-pii-scrub.test.ts.
      customerId: `cus${CLEAN}`,
    });
  });

  // PGlite runs one connection, so these land the hold strictly between the check and the scrub;
  // they show the scrub re-reads every hold, not how it behaves under true concurrency.
  it('stops the scrub when a hold lands after the check, and leaves the account as it was', async () => {
    const before = await userRow(CLEAN);
    beforeScrub = () =>
      holder.db.exec(`INSERT INTO "CsamReport" ("userId", details) VALUES (${CLEAN}, '{}')`);

    await expect(run(CLEAN)).rejects.toBeInstanceOf(LegalHoldError);
    expect(await userRow(CLEAN)).toEqual(before);
  });

  it('stops the scrub when the marker objects appear after a check that found none', async () => {
    const before = await userRow(CLEAN);
    beforeScrub = () => holder.db.exec(`CREATE TABLE "EvidenceHold" ("userId" int NOT NULL)`);

    await expect(run(CLEAN)).rejects.toBeInstanceOf(LegalHoldError);
    expect(await userRow(CLEAN)).toEqual(before);
  });

  it('stops the scrub for a marker that lands after the check', async () => {
    await createMarkerView();
    const before = await userRow(CLEAN);
    beforeScrub = () => holder.db.exec(`INSERT INTO "EvidenceHold" VALUES (${CLEAN}, NULL)`);

    await expect(run(CLEAN)).rejects.toBeInstanceOf(LegalHoldError);
    expect(await userRow(CLEAN)).toEqual(before);
  });

  it('refuses every account when the marker table exists without its view', async () => {
    await holder.db.exec(`CREATE TABLE "EvidenceHold" ("userId" int NOT NULL)`);
    await expect(run(CLEAN)).rejects.toBeInstanceOf(LegalHoldError);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('refuses, without naming the view, when the view is dropped after the check', async () => {
    await createMarkerView();
    const before = await userRow(CLEAN);
    beforeScrub = () => holder.db.exec(`DROP VIEW "EvidenceHeldUser"`);

    const error = await run(CLEAN).catch((e: Error) => e);
    expect(error).toBeInstanceOf(LegalHoldError);
    expect((error as Error).message).not.toContain('EvidenceHeldUser');
    expect(await userRow(CLEAN)).toEqual(before);
  });

  it('still scrubs an account already marked deleted, as before', async () => {
    await run(ALREADY_DELETED);
    expect(await userRow(ALREADY_DELETED)).toMatchObject({ email: null, username: null });
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

describe('isLegalHoldAbort', () => {
  const viewMissing = 'relation "EvidenceHeldUser" does not exist';
  it.each<[string, unknown]>([
    ['Prisma’s raw-query error', { code: 'P2010', meta: { code: 'LH001', message: 'x' } }],
    ['the driver’s error', { code: 'LH001', message: 'x' }],
    ['only the message', new Error('Raw query failed. Code: `LH001`. Message: `x`')],
    [
      'the marker view gone, from Prisma',
      { code: 'P2010', meta: { code: '42P01', message: viewMissing } },
    ],
    ['the marker view gone, from the driver', { code: '42P01', message: viewMissing }],
  ])('counts %s as held', (_, e) => {
    expect(isLegalHoldAbort(e)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['nothing', null],
    ['a connection failure', new Error('connection reset')],
    ['another raw-query failure', { code: 'P2010', meta: { code: '23505', message: 'duplicate' } }],
    [
      'another missing relation',
      { code: 'P2010', meta: { code: '42P01', message: 'relation "Other" does not exist' } },
    ],
  ])('does not count %s as held', (_, e) => {
    expect(isLegalHoldAbort(e)).toBe(false);
  });
});

describe('guardedAccountScrubSql', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'refuses to build a statement for id %s',
    (id) => {
      expect(() => guardedAccountScrubSql(id, false)).toThrow();
    }
  );

  it('carries no parameters, and names the marker view only when asked', () => {
    expect(guardedAccountScrubSql(CLEAN, false).values).toEqual([]);
    expect(guardedAccountScrubSql(CLEAN, false).text).not.toContain('FROM "EvidenceHeldUser"');
    expect(guardedAccountScrubSql(CLEAN, true).text).toContain('FROM "EvidenceHeldUser"');
  });
});
