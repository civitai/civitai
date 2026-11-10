import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as LegalHold from '~/server/services/legal-hold.service';
import '~/__tests__/mocks/logging.mock';

/** A moderator's delete of every image of an account keeps each feedback capture its state keeps. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  ModEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/legal-hold.service', async (importOriginal) => ({
  ...(await importOriginal<typeof LegalHold>()),
  assertAccountNotUnderLegalHold: vi.fn(async () => ({ markerView: true })),
}));
vi.mock('~/server/services/image.service', () => ({
  deleteImages: vi.fn(async (ids: number[], _posts: boolean, opts?: { onlyWhere?: Prisma.Sql }) => {
    const where = opts?.onlyWhere ? Prisma.sql`AND (${opts.onlyWhere})` : Prisma.empty;
    const sql = Prisma.sql`DELETE FROM "Image" WHERE id = ANY(${ids}::int[]) ${where} RETURNING id`;
    return (await holder.db.query(sql.text, sql.values)).rows;
  }),
}));

import deleteUserImages from '~/pages/api/mod/delete-user-images';

const CAPTURE = FEEDBACK_CAPTURE_OWNER_ID;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "EvidenceHold" ("userId" int NOT NULL);
    CREATE VIEW "EvidenceHeldUser" AS SELECT "userId" FROM "EvidenceHold";
    CREATE TABLE "EvidenceHoldImage" ("imageId" int NOT NULL);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "needsReview" text,
      "blockedFor" text, minor boolean NOT NULL DEFAULT false
    );
  `);
});
afterAll(() => holder.db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  await holder.db.exec(`
    TRUNCATE "Image";
    INSERT INTO "Image" (id, "userId", "needsReview", minor) VALUES
      (1, ${CAPTURE}, 'csam', false), (2, ${CAPTURE}, NULL, true), (3, ${CAPTURE}, NULL, false);
  `);
  vi.mocked(dbMock.dbRead.image.findMany).mockImplementation(
    (async () => (await holder.db.query(`SELECT id, "postId" FROM "Image"`)).rows) as never
  );
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    return (await holder.db.query(sql.text, sql.values)).rows;
  }) as never);
});

describe('delete-user-images on the feedback capture account', () => {
  // Its images are every reporter's page captures; each one is acted on as an image instead.
  it('refuses, deleting nothing', async () => {
    const res = { statusCode: 200, body: undefined as unknown };
    Object.assign(res, {
      status: (code: number) => Object.assign(res, { statusCode: code }),
      json: (body: unknown) => Object.assign(res, { body }),
    });
    await deleteUserImages({ query: { userId: String(CAPTURE) } } as never, res as never);

    expect(res.statusCode).toBe(400);
    const left = await holder.db.query<{ id: number }>(`SELECT id FROM "Image" ORDER BY id`);
    expect(left.rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });
});
