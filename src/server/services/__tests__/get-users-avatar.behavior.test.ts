import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { getUsers } from '~/server/services/user.service';

// `user.getAll` with the avatar carries a profile picture only when it may be served.

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, url text NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 1,
      ingestion "ImageIngestionStatus" NOT NULL, "needsReview" text,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, metadata jsonb, "scanJobs" jsonb
    );
    CREATE TABLE "User" (
      id int PRIMARY KEY, username text, email text, image text, "profilePictureId" int,
      "deletedAt" timestamp, "bannedAt" timestamp, muted boolean DEFAULT false, meta jsonb
    );
    INSERT INTO "Image" (id, url, ingestion, "needsReview") VALUES
      (1, 'scanned', 'Scanned', NULL), (2, 'pending', 'Pending', NULL),
      (3, 'flagged', 'Scanned', 'csam'), (4, 'blocked', 'Blocked', NULL);
    INSERT INTO "User" (id, username, "profilePictureId") VALUES
      (1, 'u1', 1), (2, 'u2', 2), (3, 'u3', 3), (4, 'u4', 4);
  `);
});
afterAll(() => pg.close());

beforeEach(() => {
  dbMock.dbRead.$queryRaw.mockImplementation(((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    return pg.query(sql.text, sql.values as unknown[]).then((r) => r.rows);
  }) as never);
});

describe('getUsers with the avatar', () => {
  it('carries only a servable profile picture', async () => {
    const users = await getUsers({ ids: [1, 2, 3, 4], include: ['avatar'], limit: 10 } as never);
    const avatars = Object.fromEntries(users.map((u) => [u.id, u.avatarUrl ?? null]));
    expect(avatars).toEqual({ 1: 'scanned', 2: null, 3: null, 4: null });
  });
});
