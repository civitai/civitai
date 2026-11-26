import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProfilePictureOfUser } from '~/server/services/profile-picture.sql';

// The owner's own picture, whatever its scan state, except one under an owner-hidden review hold.

let pg: PGlite;
const db = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    return pg.query(sql.text, sql.values as unknown[]).then((r) => r.rows);
  },
} as never;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Image" (
      id int PRIMARY KEY, name text, url text, "nsfwLevel" int, hash text, "userId" int,
      ingestion text, type text, width int, height int, metadata jsonb, "needsReview" text
    );
    CREATE TABLE "User" (id int PRIMARY KEY, "profilePictureId" int);
    INSERT INTO "Image" (id, url, "userId", ingestion, "needsReview") VALUES
      (1, 'pending', 1, 'Pending', NULL), (2, 'flagged', 2, 'Scanned', 'csam'),
      (4, 'minor', 4, 'Scanned', 'minor'), (5, 'other-review', 5, 'Scanned', 'poi');
    INSERT INTO "User" VALUES (1, 1), (2, 2), (3, NULL), (4, 4), (5, 5);
  `);
});
afterAll(() => pg.close());

describe('getProfilePictureOfUser', () => {
  it('returns the owner their unscanned picture', async () => {
    expect((await getProfilePictureOfUser(db, 1))?.url).toBe('pending');
  });

  it('returns the owner their picture held for another review', async () => {
    expect((await getProfilePictureOfUser(db, 5))?.url).toBe('other-review');
  });

  it('returns no picture held csam or minor, nor one for a user without a picture', async () => {
    expect(await getProfilePictureOfUser(db, 2)).toBeNull();
    expect(await getProfilePictureOfUser(db, 4)).toBeNull();
    expect(await getProfilePictureOfUser(db, 3)).toBeNull();
  });
});
