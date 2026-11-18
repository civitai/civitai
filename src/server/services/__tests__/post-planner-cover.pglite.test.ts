import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { SessionUser } from '~/types/session';

// The planner calendar's own SQL on PGlite: each scheduled post's cover and image count hold to
// the request's levels, as the post editor does.

const { getScheduledPosts } = await import('~/server/services/post-planner.service');

const OWNER = 7;
const POST = 100;
const owner = { id: OWNER } as SessionUser;
const moderator = { id: OWNER, isModerator: true } as SessionUser;

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, name text, status text, "userId" int);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int, name text, status text);
    CREATE TABLE "Post" (
      id int PRIMARY KEY, title text, "publishedAt" timestamp(3), "modelVersionId" int,
      "nsfwLevel" int NOT NULL DEFAULT 1, "userId" int NOT NULL
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "postId" int, url text, type text DEFAULT 'image', index int,
      "nsfwLevel" int NOT NULL DEFAULT 1, "needsReview" text
    );
    CREATE TABLE "Tag" (id int PRIMARY KEY, name text);
    CREATE TABLE "PostTag" ("postId" int, "tagId" int);
  `);
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(raw.queryRaw);
});
afterAll(() => db.close());

beforeEach(async () => {
  await db.exec(`
    DELETE FROM "Image"; DELETE FROM "Post";
    INSERT INTO "Post" (id, title, "publishedAt", "userId")
      VALUES (${POST}, 'p', now() + interval '1 day', ${OWNER});
  `);
});

async function calendar(user: SessionUser, servableLevels = allBrowsingLevelsFlag) {
  const { posts } = await getScheduledPosts({
    user,
    servableLevels,
    from: new Date(),
    to: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  });
  return { cover: posts[0]?.cover?.url ?? null, imageCount: posts[0]?.imageCount };
}

describe('getScheduledPosts cover', () => {
  it.each(['csam', 'minor'])(
    "skips the owner's own image held for %s review, for the cover and the count",
    async (hold) => {
      await db.exec(`
        INSERT INTO "Image" (id, "postId", url, index, "needsReview") VALUES
          (1, ${POST}, 'held', 0, '${hold}'), (2, ${POST}, 'clean', 1, NULL);
      `);
      expect(await calendar(owner)).toEqual({ cover: 'clean', imageCount: 1 });
    }
  );

  it('control: an image under another review state stays the cover and counts', async () => {
    await db.exec(`
      INSERT INTO "Image" (id, "postId", url, index, "needsReview") VALUES
        (1, ${POST}, 'other', 0, 'poi'), (2, ${POST}, 'clean', 1, NULL);
    `);
    expect(await calendar(owner)).toEqual({ cover: 'other', imageCount: 2 });
  });

  it('a capped request skips a mature image at index 0, moderators included', async () => {
    await db.exec(`
      INSERT INTO "Image" (id, "postId", url, index, "nsfwLevel") VALUES
        (1, ${POST}, 'mature', 0, 16), (2, ${POST}, 'clean', 1, 1);
    `);
    expect(await calendar(owner, sfwBrowsingLevelsFlag)).toEqual({ cover: 'clean', imageCount: 1 });
    expect(await calendar(moderator, sfwBrowsingLevelsFlag)).toEqual({
      cover: 'clean',
      imageCount: 1,
    });
    expect(await calendar(owner)).toEqual({ cover: 'mature', imageCount: 2 });
  });
});
