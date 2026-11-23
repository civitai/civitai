import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '$lib/server/__tests__/abuse-detection-pglite.harness';
import { APPEAL_MEDIA_SCHEMA } from '$lib/server/__tests__/appeal-media-schema';

/**
 * What Image Lookup's server load sends for an image the media access rule withholds from this
 * moderator, by image id (typed or linked) and in a post's grid: no url, and none of the fields the
 * bytes could be found by. These tests read the load's own return value.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('$lib/server/db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({ query: async () => ({ json: async () => [] }) }),
}));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { load } = await import('../+page.server');

const SCHEMA = `${APPEAL_MEDIA_SCHEMA}
ALTER TABLE "Image" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  ADD COLUMN "updatedAt" TIMESTAMP(3), ADD COLUMN "tosViolation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "scannedAt" TIMESTAMP(3), ADD COLUMN "hideMeta" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN hash TEXT, ADD COLUMN meta JSONB, ADD COLUMN metadata JSONB, ADD COLUMN "scanJobs" JSONB,
  ADD COLUMN index INTEGER;
ALTER TABLE "User" ADD COLUMN "bannedAt" TIMESTAMP(3), ADD COLUMN "profilePictureId" INTEGER,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now();
ALTER TABLE "Post" ADD COLUMN title TEXT, ADD COLUMN detail TEXT, ADD COLUMN "userId" INTEGER,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(), ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "tosViolation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN unlisted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN availability TEXT NOT NULL DEFAULT 'Public';
ALTER TABLE "TagsOnImageDetails" ADD COLUMN automated BOOLEAN, ADD COLUMN confidence INTEGER,
  ADD COLUMN "needsReview" BOOLEAN, ADD COLUMN source TEXT;
CREATE TABLE "Tag" (id INTEGER PRIMARY KEY, name TEXT, "nsfwLevel" INTEGER, "isCategory" BOOLEAN);
CREATE TABLE "ShadowTagsOnImage" ("imageId" INTEGER, "tagId" INTEGER, confidence INTEGER);
ALTER TABLE "Report" ADD COLUMN "internalNotes" TEXT, ADD COLUMN "alsoReportedBy" INTEGER[],
  ADD COLUMN "previouslyReviewedCount" INTEGER, ADD COLUMN "statusSetAt" TIMESTAMP(3),
  ADD COLUMN "statusSetBy" INTEGER;
ALTER TABLE "ModActivity" ADD COLUMN id SERIAL;
CREATE TABLE "ImageReaction" (
  id SERIAL PRIMARY KEY, "userId" INTEGER, "imageId" INTEGER, reaction TEXT,
  "createdAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3)
);
`;

const POST = 50;
const WITHHELD = 401;
const CONTROL = 402;
const KEY = 'withheld-key';

const WITHOUT_GRANT = { id: 2, roles: [] };
const WITH_GRANT = { id: 3, roles: ['moderator:admin'] };

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "User" (id, username) VALUES (7, 'owner');
    INSERT INTO "Post" (id, "userId") VALUES (${POST}, 7);
    INSERT INTO "Image" (id, url, type, ingestion, "blockedFor", width, height, hash, "pHash", "userId", "postId", index) VALUES
      (${WITHHELD}, '${KEY}', 'video', 'Blocked', 'CSAM', 512, 768, 'withheld-hash', 1234, 7, ${POST}, 0),
      (${CONTROL}, 'control-key', 'image', 'Scanned', NULL, 640, 480, 'control-hash', 5678, 7, ${POST}, 1);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const lookup = (user: { id: number; roles: string[] }, search: string) =>
  load({
    url: new URL(`http://moderator.test/retool/image-lookup?${search}`),
    locals: { user, grants: {} },
  } as unknown as Parameters<typeof load>[0]) as Promise<{
    result: { image: Record<string, unknown> } | null;
    post: { images: (Record<string, unknown> & { id: number })[] } | null;
  }>;

const imageFor = async (user: { id: number; roles: string[] }, id: number) => {
  const { result } = await lookup(user, `q=${id}`);
  if (!result) throw new Error(`image ${id} was not found`);
  return result.image;
};

const postImageFor = async (user: { id: number; roles: string[] }, id: number) => {
  const { post } = await lookup(user, `post=${POST}`);
  const found = post?.images.find((i) => i.id === id);
  if (!found) throw new Error(`image ${id} is not in the post`);
  return found;
};

describe('Image Lookup by id, without the grant', () => {
  it.each([
    ['url', ''],
    ['type', null],
    ['width', null],
    ['height', null],
    ['hash', null],
    ['pHash', null],
    ['restricted', true],
  ])('serves %s as %s for a withheld image', async (field, value) => {
    expect((await imageFor(WITHOUT_GRANT, WITHHELD))[field]).toEqual(value);
  });

  it('serves the storage key in no field', async () => {
    expect(JSON.stringify(await imageFor(WITHOUT_GRANT, WITHHELD))).not.toContain(KEY);
  });

  it('serves an unrestricted image as before', async () => {
    expect(await imageFor(WITHOUT_GRANT, CONTROL)).toMatchObject({
      url: 'control-key',
      hash: 'control-hash',
      restricted: false,
    });
  });
});

describe("Image Lookup's post view, without the grant", () => {
  it('serves a withheld image in the grid with no url', async () => {
    expect(await postImageFor(WITHOUT_GRANT, WITHHELD)).toMatchObject({
      url: '',
      type: null,
      restricted: true,
    });
  });

  it('serves an unrestricted image as before', async () => {
    expect(await postImageFor(WITHOUT_GRANT, CONTROL)).toMatchObject({
      url: 'control-key',
      restricted: false,
    });
  });
});

describe('Image Lookup, with the grant', () => {
  it('serves the withheld image by id with its media', async () => {
    expect(await imageFor(WITH_GRANT, WITHHELD)).toMatchObject({
      url: KEY,
      hash: 'withheld-hash',
      restricted: false,
    });
  });

  it('serves it in the post view with its media', async () => {
    expect(await postImageFor(WITH_GRANT, WITHHELD)).toMatchObject({
      url: KEY,
      restricted: false,
    });
  });
});
