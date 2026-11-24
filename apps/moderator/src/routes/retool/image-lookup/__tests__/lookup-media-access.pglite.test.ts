import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '$lib/server/__tests__/abuse-detection-pglite.harness';
import { IMAGE_PAGES_SCHEMA as SCHEMA } from '$lib/server/__tests__/appeal-media-schema';

/**
 * What Image Lookup's server load sends for an image the media access rule (`restrictedImageIds`)
 * withholds from this moderator, by image id and in a post's grid: no url, and none of the fields
 * the bytes could be found by.
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
// ClickHouse is the boundary: the scanner's CSAM label on `scanner.hits`.
const { scanner } = vi.hoisted(() => ({ scanner: { hits: [] as number[] } }));
vi.mock('$lib/server/clickhouse', async () => {
  const { imageAuditContentHash } = await import('@civitai/shared/media-signals');
  return {
    getClickhouse: () => ({
      query: async ({ query_params }: { query_params: { hashes?: string[] } }) => {
        const hit = new Set(scanner.hits.map(imageAuditContentHash));
        return {
          json: async () =>
            (query_params?.hashes ?? [])
              .filter((h) => hit.has(h))
              .map((contentHash) => ({ contentHash, csamHit: 1 })),
        };
      },
    }),
  };
});
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { load } = await import('../+page.server');
const { getRecentImagesOutsidePost } = await import('$lib/server/image-lookup.service');
const { restrictedImageIds } = await import('$lib/server/retracted-media');

const POST = 50;
const WITHHELD = 401;
const CONTROL = 402;
const KEY = 'withheld-key';
const SCANNER_HIT = 403;
const HELD_OWNER = 8;
const HELD_OWNER_OTHER = 405;
const OWNER_OTHER = 406;

const WITHOUT_GRANT = { id: 2, roles: [] };
const WITH_GRANT = { id: 3, roles: ['moderator:admin'] };

let db: PGlite;

beforeEach(async () => {
  scanner.hits = [SCANNER_HIT];
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "User" (id, username) VALUES (7, 'owner'), (${HELD_OWNER}, 'held'), (13, 'reporter');
    INSERT INTO "Post" (id, "userId") VALUES (${POST}, 7), (51, ${HELD_OWNER});
    INSERT INTO "EvidenceHeldUser" ("userId") VALUES (${HELD_OWNER});
    INSERT INTO "Image" (id, url, type, ingestion, "blockedFor", width, height, hash, "pHash", "userId", "postId", index) VALUES
      (${WITHHELD}, '${KEY}', 'video', 'Blocked', 'CSAM', 512, 768, 'withheld-hash', 1234, 7, ${POST}, 0),
      (${CONTROL}, 'control-key', 'image', 'Scanned', NULL, 640, 480, 'control-hash', 5678, 7, ${POST}, 1),
      (${SCANNER_HIT}, 'scanner-key', 'image', 'Scanned', NULL, 10, 10, NULL, NULL, 7, NULL, NULL),
      (404, 'held-post-key', 'image', 'Scanned', NULL, 10, 10, NULL, NULL, ${HELD_OWNER}, 51, 0),
      (${HELD_OWNER_OTHER}, 'held-other-key', 'image', 'Scanned', NULL, 10, 10, NULL, NULL, ${HELD_OWNER}, NULL, NULL),
      (${OWNER_OTHER}, 'owner-other-key', 'image', 'Scanned', NULL, 10, 10, NULL, NULL, 7, NULL, NULL);
    UPDATE "Image" SET name = 'file.mp4', "needsReview" = 'csam', "scanJobs" = '{"job": 1}',
      meta = '{"prompt": "p", "negativePrompt": "n", "seed": 1}' WHERE id = ${WITHHELD};
    INSERT INTO "Tag" (id, name) VALUES (1, 'tag');
    INSERT INTO "TagsOnImageDetails" ("imageId", "tagId") VALUES (${WITHHELD}, 1);
    INSERT INTO "ShadowTagsOnImage" ("imageId", "tagId", confidence) VALUES (${WITHHELD}, 1, 90);
    INSERT INTO "Report" (id, "userId", reason, status, details, "createdAt") VALUES
      (1, 13, 'TOSViolation', 'Pending', '{"comment": "x"}', '2026-09-01');
    INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (${WITHHELD}, 1);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const resultFor = async (user: { id: number; roles: string[] }, id: number) => {
  const { result } = await lookup(user, `q=${id}`);
  if (!result) throw new Error(`image ${id} was not found`);
  return result as unknown as Record<string, unknown>;
};

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

  // Nothing that says why it is withheld, as the appeal cards.
  it.each([
    ['name', null],
    ['blockedFor', null],
    ['needsReview', null],
    ['prompt', null],
    ['negativePrompt', null],
    ['meta', null],
    ['promptHighlight', null],
    ['scanJobs', null],
  ])('serves no %s for a withheld image', async (field, value) => {
    expect((await imageFor(WITHOUT_GRANT, WITHHELD))[field]).toEqual(value);
  });

  it.each(['tags', 'shadowTags', 'reports'])('serves no %s for a withheld image', async (key) => {
    expect((await resultFor(WITHOUT_GRANT, WITHHELD))[key]).toEqual([]);
  });

  it('withholds an image only the scanner marks', async () => {
    expect(await imageFor(WITHOUT_GRANT, SCANNER_HIT)).toMatchObject({ url: '', restricted: true });
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

describe("a post report's recent images of the owner", () => {
  const recent = (userId: number, postId: number, csamReview: boolean) =>
    getRecentImagesOutsidePost(userId, postId, { csamReview });

  // civitai/civitai#10202: an account-level hold alone withholds nothing from any moderator.
  it("serves a held owner's other image without the grant", async () => {
    const [image] = await recent(HELD_OWNER, 51, false);
    expect(image).toMatchObject({ id: HELD_OWNER_OTHER, url: 'held-other-key', restricted: false });
  });

  it('serves it to a grant holder', async () => {
    const [image] = await recent(HELD_OWNER, 51, true);
    expect(image).toMatchObject({ id: HELD_OWNER_OTHER, url: 'held-other-key', restricted: false });
  });

  it("serves an unrestricted owner's other image", async () => {
    const images = await recent(7, POST, false);
    expect(images.find((i) => i.id === OWNER_OTHER)).toMatchObject({
      url: 'owner-other-key',
      restricted: false,
    });
  });
});

describe('the media access rule', () => {
  it('withholds an id the primary does not have', async () => {
    expect(await restrictedImageIds([990_000_999, CONTROL], { csamReview: false })).toEqual(
      new Set([990_000_999])
    );
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
