import { PGlite } from '@electric-sql/pglite';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
} from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';

// The service's SQL, run as written against an in-process Postgres.
vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  kysely: null as unknown,
  clickhouse: undefined as undefined | { $query: (...args: unknown[]) => Promise<unknown[]> },
  excluded: [] as number[],
  cache: new Map<string, unknown>(),
}));
vi.mock('~/server/db/kyselyDb', () => ({
  get kyselyRead() {
    return holder.kysely;
  },
}));
vi.mock('~/server/clickhouse/client', () => ({
  get clickhouse() {
    return holder.clickhouse;
  },
}));
vi.mock('~/server/services/metric-excluded-users.service', () => ({
  getMetricExcludedUserIds: async () => holder.excluded,
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  // A per-test cache with the real one's contract: a failed fetch is not stored.
  fetchThroughCache: async (key: string, fetch: () => Promise<unknown>) => {
    if (!holder.cache.has(key)) holder.cache.set(key, await fetch());
    return holder.cache.get(key);
  },
}));

const { getCreatorEngagement, InvalidCursorError, NEWEST_SCAN_BUDGET } = await import(
  '~/server/services/creator-engagement.service'
);
type Query = Parameters<typeof getCreatorEngagement>[0];

const dialect = (pg: PGlite): Dialect => {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      const result = await pg.query(compiled.sql, compiled.parameters as unknown[]);
      return { rows: result.rows as never[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const noop = async () => undefined;
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: noop,
      acquireConnection: async () => connection,
      beginTransaction: noop,
      commitTransaction: noop,
      rollbackTransaction: noop,
      releaseConnection: noop,
      destroy: noop,
    }),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
};

const NOW = new Date('2026-06-15T12:00:00.000Z');
const ago = (days: number, ms = 0) =>
  new Date(NOW.getTime() - days * 86_400_000 + ms).toISOString();

// Synthetic ids. Caller 1 owns images 10-18 and models 30-33; creator 2 owns image 20 and model 40.
// 14-18 and 31-33 each fail one visibility gate, and each has engagement that would rank it.
const CALLER = 1;
const OTHER = 2;

const SCHEMA = `
CREATE TYPE "CommentEntityType" AS ENUM ('image', 'model');
CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int, "publishedAt" timestamp(3));
CREATE TABLE "Image" (
  id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, name text, url text NOT NULL,
  type text NOT NULL DEFAULT 'image', "createdAt" timestamp(3) NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 1,
  ingestion text NOT NULL DEFAULT 'Scanned', "needsReview" text, "tosViolation" boolean NOT NULL DEFAULT false
);
CREATE INDEX ON "Image" ("userId", "createdAt");
CREATE TABLE "Model" (
  id int PRIMARY KEY, "userId" int NOT NULL, name text NOT NULL, "createdAt" timestamp(3) NOT NULL,
  "nsfwLevel" int NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'Published', "deletedAt" timestamp(3),
  availability text NOT NULL DEFAULT 'Public'
);
CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int, status text);
CREATE TABLE "ModelMetric" ("modelId" int PRIMARY KEY, "downloadCount" int);
CREATE TABLE "ImageReaction" (
  id serial PRIMARY KEY, "imageId" int, "userId" int, reaction text, "createdAt" timestamp(3)
);
CREATE TABLE "ResourceReview" (
  id serial PRIMARY KEY, "modelId" int, "userId" int, recommended boolean, exclude boolean DEFAULT false,
  "tosViolation" boolean DEFAULT false, "createdAt" timestamp(3), "postId" int
);
CREATE TABLE "CommentV3" (
  id serial PRIMARY KEY, "entityType" "CommentEntityType", "entityId" int, "userId" int,
  "createdAt" timestamptz, "deletedAt" timestamptz, "tosViolation" boolean DEFAULT false,
  hidden boolean DEFAULT false
);
CREATE TABLE "CollectionItem" (
  id serial PRIMARY KEY, "imageId" int, "modelId" int, "addedById" int, status text, "createdAt" timestamp(3)
);
CREATE TABLE "BuzzTip" ("entityType" text, "entityId" int, "fromUserId" int, amount int);
`;

const FIXTURE = `
INSERT INTO "Post" VALUES (1, ${CALLER}, '${ago(60)}'), (2, ${OTHER}, '${ago(
  60
)}'), (3, ${CALLER}, NULL), (4, ${CALLER}, '2099-01-01');
INSERT INTO "Image"(id, "userId", "postId", name, url, type, "createdAt", ingestion) VALUES
  (10, ${CALLER}, 1, 'old', 'u10', 'image', '${ago(40)}', 'Scanned'),
  (11, ${CALLER}, 1, NULL, 'u11', 'image', '${ago(10)}', 'Scanned'),
  (12, ${CALLER}, 1, 'busy', 'u12', 'image', '${ago(3)}', 'Scanned'),
  (13, ${CALLER}, 1, 'clip', 'u13', 'video', '${ago(1)}', 'Scanned'),
  (14, ${CALLER}, 3, 'unpublished', 'u14', 'image', '${ago(2)}', 'Scanned'),
  (15, ${CALLER}, 1, 'pending', 'u15', 'image', '${ago(2)}', 'Pending'),
  (20, ${OTHER}, 2, 'not yours', 'u20', 'image', '${ago(2)}', 'Scanned');
INSERT INTO "Image"(id, "userId", "postId", name, url, "createdAt", "needsReview", "tosViolation") VALUES
  (16, ${CALLER}, 1, 'in review', 'u16', '${ago(2)}', 'minor', false),
  (17, ${CALLER}, 1, 'tos', 'u17', '${ago(2)}', NULL, true),
  (18, ${CALLER}, 4, 'scheduled post', 'u18', '${ago(2)}', NULL, false);
INSERT INTO "Model"(id, "userId", name, "createdAt", status) VALUES
  (30, ${CALLER}, 'My LoRA', '${ago(5)}', 'Published'),
  (31, ${CALLER}, 'Draft', '${ago(4)}', 'Draft'),
  (40, ${OTHER}, 'Theirs', '${ago(5)}', 'Published');
INSERT INTO "Model"(id, "userId", name, "createdAt", "deletedAt", availability) VALUES
  (32, ${CALLER}, 'Deleted', '${ago(4)}', '${ago(1)}', 'Public'),
  (33, ${CALLER}, 'Private', '${ago(4)}', NULL, 'Private');
INSERT INTO "ModelVersion" VALUES (300, 30, 'Published'), (301, 30, 'Published'), (302, 30, 'Draft');
INSERT INTO "ModelMetric" VALUES (30, 77), (40, 9999);

-- Image 12: the 7-day edge exactly (counts), one millisecond before it (does not), 20 days, 40 days,
-- plus the caller's own reaction and a Dislike, neither of which counts.
INSERT INTO "ImageReaction"("imageId", "userId", reaction, "createdAt") VALUES
  (12, 3, 'Like', '${ago(7)}'),
  (12, 4, 'Like', '${ago(7, -1)}'),
  (12, 5, 'Heart', '${ago(20)}'),
  (12, 6, 'Cry', '${ago(40)}'),
  (12, 7, 'Laugh', '${ago(1)}'),
  (12, ${CALLER}, 'Like', '${ago(1)}'),
  (12, 8, 'Dislike', '${ago(1)}'),
  (11, 3, 'Like', '${ago(2)}'),
  (20, 3, 'Like', '${ago(1)}'), (20, 4, 'Like', '${ago(1)}'), (20, 5, 'Like', '${ago(1)}'),
  (20, 6, 'Like', '${ago(1)}'), (20, 7, 'Like', '${ago(1)}'), (20, 8, 'Like', '${ago(1)}'),
  (16, 3, 'Like', '${ago(1)}'), (17, 3, 'Like', '${ago(1)}'), (18, 3, 'Like', '${ago(1)}');
INSERT INTO "CommentV3"("entityType", "entityId", "userId", "createdAt", "deletedAt", hidden) VALUES
  ('image', 12, 3, '${ago(1)}', NULL, false),
  ('image', 12, 4, '${ago(20)}', NULL, false),
  ('image', 12, ${CALLER}, '${ago(1)}', NULL, false),
  ('image', 12, 5, '${ago(1)}', '${ago(1)}', false),
  ('model', 30, 3, '${ago(1)}', NULL, false),
  ('model', 32, 3, '${ago(1)}', NULL, false),
  ('model', 33, 3, '${ago(1)}', NULL, false),
  ('image', 12, 9, '${ago(1)}', NULL, true);
INSERT INTO "CommentV3"("entityType", "entityId", "userId", "createdAt", "tosViolation") VALUES
  ('image', 11, 10, '${ago(1)}', true);
INSERT INTO "CollectionItem"("imageId", "modelId", "addedById", status, "createdAt") VALUES
  (12, NULL, 3, 'ACCEPTED', '${ago(5)}'),
  (12, NULL, 4, 'REJECTED', '${ago(5)}'),
  (12, NULL, ${CALLER}, 'ACCEPTED', '${ago(5)}'),
  (NULL, 30, 4, 'ACCEPTED', '${ago(50)}');
INSERT INTO "BuzzTip" VALUES ('Image', 12, 3, 100), ('Image', 12, 4, 50), ('Model', 30, 3, 25), ('Image', 20, 3, 999);
INSERT INTO "ResourceReview"("modelId", "userId", recommended, exclude, "createdAt") VALUES
  (30, 3, true, false, '${ago(2)}'),
  (30, 4, false, false, '${ago(20)}'),
  (30, ${CALLER}, true, false, '${ago(1)}'),
  (30, 5, true, true, '${ago(1)}'),
  (40, 3, true, false, '${ago(1)}');
INSERT INTO "ResourceReview"("modelId", "userId", recommended, "tosViolation", "createdAt") VALUES
  (30, 9, true, true, '${ago(1)}');
-- Written from the reviewers' own draft and scheduled posts, so hidden until those go live.
INSERT INTO "Post" VALUES (5, 6, NULL), (6, 7, '2099-01-01');
INSERT INTO "ResourceReview"("modelId", "userId", recommended, "createdAt", "postId") VALUES
  (30, 6, true, '${ago(1)}', 5),
  (30, 7, false, '${ago(1)}', 6);
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  await pg.exec(FIXTURE);
  holder.kysely = new Kysely({ dialect: dialect(pg) });
});

afterAll(async () => {
  await pg.close();
});

beforeEach(() => {
  holder.clickhouse = undefined;
  holder.excluded = [];
  holder.cache.clear();
});

const query = (q: Partial<Query>): Query => ({
  userId: CALLER,
  sort: 'newest',
  limit: 100,
  baseUrl: 'https://example.test',
  now: NOW,
  ...q,
});

async function allPages(q: Partial<Query>) {
  const seen: { type: string; id: number }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await getCreatorEngagement(query({ ...q, cursor }));
    seen.push(...res.items.map((i) => ({ type: i.type, id: i.id })));
    if (!res.metadata.nextCursor) return { seen, pages: page + 1 };
    cursor = res.metadata.nextCursor;
  }
  throw new Error('did not stop paging');
}

const forge = (cursor: object) => Buffer.from(JSON.stringify(cursor)).toString('base64url');

describe('sort=newest', () => {
  it("returns only the caller's visible items, newest first, across both kinds", async () => {
    const res = await getCreatorEngagement(query({}));
    expect(res.items.map((i) => `${i.type}:${i.id}`)).toEqual([
      'video:13',
      'image:12',
      'model:30',
      'image:11',
      'image:10',
    ]);
    expect(res.metadata.nextCursor).toBeNull();
  });

  it('counts other people only, and puts the 7-day edge inside the window', async () => {
    const res = await getCreatorEngagement(query({ type: 'image' }));
    const busy = res.items.find((i) => i.id === 12)!;
    expect(busy.d7).toMatchObject({
      reactions: { total: 2, like: 1, heart: 0, laugh: 1, cry: 0 },
      comments: 1,
      collects: 1,
    });
    expect(busy.d30).toMatchObject({
      reactions: { total: 4, like: 2, heart: 1, laugh: 1, cry: 0 },
      comments: 2,
      collects: 1,
    });
    expect(busy.allTime).toMatchObject({
      reactions: { total: 5, like: 2, heart: 1, laugh: 1, cry: 1 },
      comments: 2,
      collects: 1,
      tippedBuzz: 150,
    });
  });

  it('omits views when ClickHouse cannot answer instead of reporting zero', async () => {
    const res = await getCreatorEngagement(query({ type: 'image' }));
    expect(res.items[0].d7).not.toHaveProperty('views');
    expect(res.items[0].allTime).not.toHaveProperty('views');
  });

  it('puts each ClickHouse view window in its own block, and zero for an image with no row', async () => {
    // ClickHouse sums as UInt64, which arrives as a string.
    holder.clickhouse = { $query: async () => [{ id: 12, d7: '5', d30: '40', all: '300' }] };
    const res = await getCreatorEngagement(query({ type: 'image' }));
    const busy = res.items.find((i) => i.id === 12)!;
    expect([busy.d7.views, busy.d30.views, busy.allTime.views]).toEqual([5, 40, 300]);
    const quiet = res.items.find((i) => i.id === 11)!;
    expect([quiet.d7.views, quiet.d30.views, quiet.allTime.views]).toEqual([0, 0, 0]);
  });

  it('maps model reviews to thumbs and reads versions and downloads', async () => {
    const res = await getCreatorEngagement(query({ type: 'model' }));
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      id: 30,
      type: 'model',
      versionCount: 2,
      d7: { reactions: { total: 1, thumbsUp: 1, thumbsDown: 0 }, comments: 1, collects: 0 },
      d30: { reactions: { total: 2, thumbsUp: 1, thumbsDown: 1 } },
      allTime: { downloads: 77, tippedBuzz: 25, collects: 1 },
    });
  });

  it('leaves reviews from posts not yet live out of the thumbs', async () => {
    const [model] = (await getCreatorEngagement(query({ type: 'model' }))).items;
    expect(model.allTime.reactions).toMatchObject({ total: 2, thumbsUp: 1, thumbsDown: 1 });
  });

  it('drops metric-suppressed reactors from reaction counts', async () => {
    holder.excluded = [7];
    const res = await getCreatorEngagement(query({ type: 'image' }));
    expect(res.items.find((i) => i.id === 12)!.d7.reactions).toMatchObject({ total: 1, laugh: 0 });
  });

  it('pages one item at a time to the same sequence, without repeats', async () => {
    const whole = (await getCreatorEngagement(query({}))).items.map((i) => ({
      type: i.type,
      id: i.id,
    }));
    const { seen } = await allPages({ limit: 1 });
    expect(seen).toEqual(whole);
  });

  it("a cursor forged from another creator's item still yields only the caller's", async () => {
    const res = await getCreatorEngagement(
      query({ cursor: forge({ s: 'n', t: Date.parse(ago(0)), k: 'i', id: 20 }) })
    );
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.every((i) => [10, 11, 12, 13, 30].includes(i.id))).toBe(true);
  });

  it('rejects a cursor whose time is outside the range a Date holds', async () => {
    await expect(
      getCreatorEngagement(query({ cursor: forge({ s: 'n', t: 9e15, k: 'i', id: 12 }) }))
    ).rejects.toThrow(InvalidCursorError);
  });

  it('rejects a cursor it did not issue', async () => {
    await expect(getCreatorEngagement(query({ cursor: 'not-a-cursor' }))).rejects.toThrow(
      'Invalid cursor'
    );
  });
});

describe('sort=engagement', () => {
  it("ranks by 30-day score and never returns another creator's ids from ClickHouse", async () => {
    holder.clickhouse = { $query: async () => [{ id: 20 }, { id: 11 }, { id: 12 }] };
    const res = await getCreatorEngagement(query({ sort: 'engagement' }));
    // 12: 4 reactions + 2 comments + 1 collect; 30: 2 reviews + 1 comment; 11: 1 reaction.
    expect(res.items.map((i) => `${i.type}:${i.id}`)).toEqual(['image:12', 'model:30', 'image:11']);
    expect(res.metadata.imageCandidates).toBe('reactions-30d');
  });

  it('scans reactions once per creator for the all, image and video rankings', async () => {
    let scans = 0;
    holder.clickhouse = {
      // The candidate scan is a plain string; the views read is a tagged template.
      $query: async (sqlOrStrings: unknown) => {
        if (typeof sqlOrStrings !== 'string') return [];
        scans++;
        return [{ id: 13 }, { id: 11 }, { id: 12 }];
      },
    };
    const ids = async (type?: Query['type']) =>
      (await getCreatorEngagement(query({ sort: 'engagement', type }))).items.map((i) => i.id);
    expect(await ids()).toEqual([12, 30, 11]);
    expect(await ids('image')).toEqual([12, 11]);
    expect(await ids('video')).toEqual([]);
    expect(scans).toBe(1);
  });

  it('falls back to the newest images when ClickHouse is unavailable', async () => {
    const res = await getCreatorEngagement(query({ sort: 'engagement', type: 'image' }));
    expect(res.items.map((i) => i.id)).toEqual([12, 11]);
    expect(res.metadata.imageCandidates).toBe('newest');
  });

  it('pages the ranking with a stable cursor, and a forged one cannot widen it', async () => {
    holder.clickhouse = { $query: async () => [{ id: 20 }, { id: 11 }, { id: 12 }] };
    const { seen } = await allPages({ sort: 'engagement', limit: 1 });
    expect(seen.map((s) => s.id)).toEqual([12, 30, 11]);

    const forged = await getCreatorEngagement(
      query({ sort: 'engagement', cursor: forge({ s: 'e', v: 1_000_000, k: 'm', id: 40 }) })
    );
    expect(forged.items.map((i) => i.id)).toEqual([12, 30, 11]);
  });
});

describe('visibility gates', () => {
  const RANKED = async () => {
    holder.clickhouse = { $query: async () => [12, 11, 16, 17, 18].map((id) => ({ id })) };
    return getCreatorEngagement(query({ sort: 'engagement' }));
  };
  const listedIds = async () => {
    const newest = (await getCreatorEngagement(query({}))).items.map((i) => i.id);
    holder.cache.clear();
    const ranked = (await RANKED()).items.map((i) => i.id);
    return { newest, ranked };
  };

  // Each hidden row has engagement that would list it; the visible ones are the negative control.
  it.each([
    ['an image awaiting review (needsReview)', 16],
    ['a ToS-violating image', 17],
    ['an image on a post scheduled for the future', 18],
    ['a deleted model', 32],
    ['a Private model', 33],
  ])('lists neither by newest nor by engagement %s', async (_label, id) => {
    const { newest, ranked } = await listedIds();
    expect(newest).toEqual(expect.arrayContaining([12, 11, 30]));
    expect(ranked).toEqual(expect.arrayContaining([12, 30, 11]));
    expect(newest).not.toContain(id);
    expect(ranked).not.toContain(id);
  });

  const item = async (type: 'image' | 'model', id: number) =>
    (await getCreatorEngagement(query({ type }))).items.find((i) => i.id === id)!;

  it('does not count a hidden comment', async () => {
    // Image 12's one visible 7-day comment, beside a hidden one.
    expect((await item('image', 12)).d7.comments).toBe(1);
  });

  it('does not count a ToS-violating comment', async () => {
    // Image 11's only comment.
    expect((await item('image', 11)).d7.comments).toBe(0);
  });

  it('does not count a ToS-violating review', async () => {
    // Model 30's one visible 7-day review, beside a ToS-violating one.
    expect((await item('model', 30)).d7.reactions).toMatchObject({ total: 1, thumbsUp: 1 });
  });
});

describe('the scan budget', () => {
  beforeAll(async () => {
    // A creator with more images than one page may examine, and their one video below all of them.
    await pg.exec(`
      INSERT INTO "Post" VALUES (9, 9, '${ago(60)}');
      INSERT INTO "Image"(id, "userId", "postId", url, type, "createdAt")
        SELECT 100000 + g, 9, 9, 'x', 'image', '${ago(1)}'::timestamp - g * interval '1 second'
        FROM generate_series(1, ${NEWEST_SCAN_BUDGET + 10}) g;
      INSERT INTO "Image"(id, "userId", "postId", url, type, "createdAt")
        VALUES (99999, 9, 9, 'v', 'video', '${ago(30)}');
    `);
  });

  it('returns a short page with a cursor rather than scanning past the budget, then reaches the item', async () => {
    const first = await getCreatorEngagement(query({ userId: 9, type: 'video', limit: 5 }));
    expect(first.items).toEqual([]);
    expect(first.metadata.nextCursor).not.toBeNull();

    const { seen, pages } = await allPages({ userId: 9, type: 'video', limit: 5 });
    expect(seen.map((s) => s.id)).toEqual([99999]);
    expect(pages).toBeLessThan(5);
  });
});
