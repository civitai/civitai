import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  freshRatingReviewDb,
  ratingReviewKysely,
  rows,
  seedEm,
  seedEntity,
  seedUser,
} from './rating-review-pglite.harness';

const { dbHandle, resolve } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  resolve: vi.fn(),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../rating-review-actions', () => ({ resolveRatingReviewAction: resolve }));

const queue = await import('../rating-dispute-queue');
const service = await import('../rating-reviews.service');

let db: PGlite;
let alice: number;
let bob: number;
let nextEntity = 1000;

beforeEach(async () => {
  db = await freshRatingReviewDb();
  dbHandle.current = ratingReviewKysely(db);
  alice = await seedUser(db, 'Alice');
  bob = await seedUser(db, 'bobby');
  resolve.mockReset();
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

type Seed = {
  entityType?: string;
  entityId?: number;
  userId?: number;
  currentLevel?: number;
  suggestedLevel?: number;
  status?: 'Pending' | 'Actioned' | 'Unactioned';
  createdAt?: string;
  resolvedAt?: string | null;
};

async function fileReview(row: Seed = {}) {
  const status = row.status ?? 'Pending';
  const [r] = await rows<{ id: number }>(
    db,
    `INSERT INTO "RatingReview"
       ("entityType", "entityId", "userId", "currentLevel", "suggestedLevel", "status", "createdAt", "resolvedAt")
     VALUES ($1, $2, $3, $4, $5, $6::"ReportStatus", $7, $8) RETURNING "id"`,
    [
      row.entityType ?? 'Post',
      row.entityId ?? nextEntity++,
      row.userId ?? alice,
      row.currentLevel ?? 4,
      row.suggestedLevel ?? 2,
      status,
      row.createdAt ?? '2026-09-01T10:00:00.000Z',
      row.resolvedAt === undefined
        ? status === 'Pending'
          ? null
          : '2026-09-02T10:00:00.000Z'
        : row.resolvedAt,
    ]
  );
  return r.id;
}

const load = (query = '') => queue.ratingDisputeTriageLoad(new URL(`http://x/ratings${query}`));
const ids = (data: { items: { id: number }[] }) => data.items.map((i) => i.id);

async function seedImage(row: {
  url: string;
  postId?: number;
  index?: number;
  nsfwLevel?: number;
}) {
  const [r] = await rows<{ id: number }>(
    db,
    `INSERT INTO "Image" ("url", "type", "postId", "index", "nsfwLevel") VALUES ($1, 'image', $2, $3, $4) RETURNING "id"`,
    [row.url, row.postId ?? null, row.index ?? null, row.nsfwLevel ?? 1]
  );
  return r.id;
}
const connect = (imageId: number, entityType: string, entityId: number) =>
  db.query(
    `INSERT INTO "ImageConnection" ("imageId", "entityType", "entityId") VALUES ($1, $2, $3)`,
    [imageId, entityType, entityId]
  );

describe('ratingDisputeTriageLoad filters', () => {
  it('maps each tab to its entity types, with Other holding the five minor types', async () => {
    const byType: Record<string, number> = {};
    for (const t of [
      'Post',
      'Model',
      'Article',
      'Bounty',
      'BountyEntry',
      'Challenge',
      'Crucible',
      'Collection',
    ])
      byType[t] = await fileReview({ entityType: t });

    expect(ids(await load())).toEqual([byType.Post]);
    expect(ids(await load('?tab=bogus'))).toEqual([byType.Post]);
    expect(ids(await load('?tab=models'))).toEqual([byType.Model]);
    expect(ids(await load('?tab=articles'))).toEqual([byType.Article]);
    expect(new Set(ids(await load('?tab=other')))).toEqual(
      new Set([
        byType.Bounty,
        byType.BountyEntry,
        byType.Challenge,
        byType.Crucible,
        byType.Collection,
      ])
    );
  });

  it('filters by status, defaulting to Pending', async () => {
    const pending = await fileReview();
    const approved = await fileReview({ status: 'Actioned' });
    const rejected = await fileReview({ status: 'Unactioned' });

    expect(ids(await load())).toEqual([pending]);
    expect(ids(await load('?status=Actioned'))).toEqual([approved]);
    expect(ids(await load('?status=Unactioned'))).toEqual([rejected]);
    expect(ids(await load('?status=nonsense'))).toEqual([pending]);
  });

  it('filters by what the owner asked for: a lower or a higher rating', async () => {
    const lower = await fileReview({ currentLevel: 4, suggestedLevel: 1 });
    const higher = await fileReview({ currentLevel: 2, suggestedLevel: 8 });

    expect(ids(await load('?ask=lower'))).toEqual([lower]);
    expect(ids(await load('?ask=higher'))).toEqual([higher]);
    expect(new Set(ids(await load('?ask=sideways')))).toEqual(new Set([lower, higher]));
  });

  it('filters to entities whose text scan raised the rating, at each type threshold', async () => {
    const postRaised = await fileReview({ entityType: 'Post', entityId: 1 });
    const postBelow = await fileReview({ entityType: 'Post', entityId: 2 });
    const noVersion = await fileReview({ entityType: 'Post', entityId: 3 });
    const unscanned = await fileReview({ entityType: 'Post', entityId: 4 });
    await seedEm(db, { entityType: 'Post', entityId: 1, nsfwLevel: 4 });
    await seedEm(db, { entityType: 'Post', entityId: 2, nsfwLevel: 1 });
    await seedEm(db, { entityType: 'Post', entityId: 3, nsfwLevel: 8, result: { labels: {} } });
    const modelAtPg13 = await fileReview({ entityType: 'Model', entityId: 1 });
    const modelAtR = await fileReview({ entityType: 'Model', entityId: 2 });
    await seedEm(db, { entityType: 'Model', entityId: 1, nsfwLevel: 2 });
    await seedEm(db, { entityType: 'Model', entityId: 2, nsfwLevel: 4 });

    expect(ids(await load('?scan=raised'))).toEqual([postRaised]);
    expect(ids(await load('?scan=raised&tab=models'))).toEqual([modelAtR]);
    expect(new Set(ids(await load('?scan=other')))).toEqual(
      new Set([postRaised, postBelow, noVersion, unscanned])
    );
    expect(modelAtPg13).toBeGreaterThan(0);
  });

  it('searches a bare number as a review id or an entity id, and text as an owner prefix', async () => {
    const a = await fileReview({ entityType: 'Post', entityId: 900, userId: alice });
    const b = await fileReview({ entityType: 'Post', entityId: 901, userId: bob });

    expect(ids(await load(`?q=${b}`))).toContain(b);
    expect(ids(await load('?q=900'))).toEqual([a]);
    expect(ids(await load('?q=ali'))).toEqual([a]);
    expect(ids(await load('?q=BOB'))).toEqual([b]);
    expect(ids(await load('?q=lice'))).toEqual([]);
    expect(ids(await load('?q=%25'))).toEqual([]);
    expect(ids(await load('?q=99999999999999'))).toEqual([]);
  });
});

describe('ratingDisputeTriageLoad ordering and paging', () => {
  it('orders Pending oldest-first and decided newest-first, and honours sort', async () => {
    const p1 = await fileReview({ createdAt: '2026-09-01T10:00:00.000Z' });
    const p2 = await fileReview({ createdAt: '2026-09-02T10:00:00.000Z' });
    const d1 = await fileReview({ status: 'Actioned', resolvedAt: '2026-09-05T10:00:00.000Z' });
    const d2 = await fileReview({ status: 'Actioned', resolvedAt: '2026-09-06T10:00:00.000Z' });

    expect(ids(await load())).toEqual([p1, p2]);
    expect(ids(await load('?sort=newest'))).toEqual([p2, p1]);
    expect(ids(await load('?status=Actioned'))).toEqual([d2, d1]);
    expect(ids(await load('?status=Actioned&sort=oldest'))).toEqual([d1, d2]);
  });

  it('breaks timestamp ties by review id', async () => {
    const a = await fileReview();
    const b = await fileReview();
    expect(ids(await load())).toEqual([a, b]);
    expect(ids(await load('?sort=newest'))).toEqual([b, a]);
  });

  it('pages by 50 and reports whether another page follows', async () => {
    for (let i = 0; i < 51; i++)
      await fileReview({
        entityId: i + 1,
        createdAt: `2026-09-01T10:${String(i).padStart(2, '0')}:00.000Z`,
      });

    const first = await load();
    expect(first.items).toHaveLength(50);
    expect(first).toMatchObject({ hasMore: true, offset: 0, page: 1, totalCount: 51 });

    const second = await load('?page=2');
    expect(second.items).toHaveLength(1);
    expect(second).toMatchObject({ hasMore: false, offset: 50, page: 2 });
  });
});

describe('ratingDisputeTriageLoad selection', () => {
  it('returns the selected review as pinned when a filter leaves it off the page', async () => {
    await fileReview();
    const decided = await fileReview({ status: 'Unactioned' });

    const data = await load(`?selected=${decided}`);

    expect(data.pinned).toMatchObject({ id: decided, status: 'Unactioned' });
    expect(data.selectedMissing).toBeNull();
  });

  it('does not pin a review that is already on the page, and flags one that does not exist', async () => {
    const onPage = await fileReview();

    expect((await load(`?selected=${onPage}`)).pinned).toBeNull();

    const missing = await load('?selected=4040');
    expect(missing.pinned).toBeNull();
    expect(missing.selectedMissing).toBe(4040);
  });
});

describe('ratingDisputeTriageLoad facets', () => {
  it('counts each tab for the current status and search, and each chip within the tab', async () => {
    await fileReview({ entityType: 'Post', currentLevel: 4, suggestedLevel: 1 });
    await fileReview({ entityType: 'Post', currentLevel: 1, suggestedLevel: 4, entityId: 2 });
    await fileReview({ entityType: 'Model', entityId: 3 });
    await fileReview({ entityType: 'Challenge', entityId: 4 });
    await fileReview({ entityType: 'Crucible', entityId: 5, userId: bob });
    await fileReview({ entityType: 'Article', status: 'Actioned', entityId: 6 });
    await seedEm(db, { entityType: 'Post', entityId: 2, nsfwLevel: 8 });

    const all = await load();
    expect(all.facets?.tabs).toEqual({ posts: 2, models: 1, articles: 0, other: 2 });
    expect(all.facets?.chips).toEqual({ lower: 1, higher: 1, raised: 1 });

    const narrowed = await load('?ask=higher&q=ali');
    expect(narrowed.facets?.tabs).toEqual({ posts: 2, models: 1, articles: 0, other: 1 });
    expect(narrowed.totalCount).toBe(1);

    expect((await load('?status=Actioned')).facets?.tabs.articles).toBe(1);
  });
});

describe('ratingDisputeTriageLoad rows', () => {
  it('counts every dispute each owner has filed, whatever its status or type', async () => {
    const a1 = await fileReview({ userId: alice });
    await fileReview({ userId: alice, status: 'Actioned', entityType: 'Model' });
    await fileReview({ userId: bob });

    const data = await load();

    expect(data.items.find((i) => i.id === a1)?.ownerDisputeCount).toBe(2);
    expect(data.items.find((i) => i.user.id === bob)?.ownerDisputeCount).toBe(1);
  });

  it('attaches preview images to items and pinned, equal to the single-entity read', async () => {
    const postId = await seedEntity(db, 'Post', { userId: alice });
    await seedImage({ url: 'p2', postId, index: 2 });
    await seedImage({ url: 'p1', postId, index: 1 });
    const articleId = await seedEntity(db, 'Article', { userId: alice });
    await connect(await seedImage({ url: 'a1' }), 'Article', articleId);
    const onPage = await fileReview({ entityType: 'Post', entityId: postId });
    const pinnedId = await fileReview({
      entityType: 'Article',
      entityId: articleId,
      status: 'Actioned',
    });

    const data = await load(`?selected=${pinnedId}`);

    const item = data.items.find((i) => i.id === onPage)!;
    expect(item.preview).toEqual(await service.getRatingReviewImages('Post', postId));
    expect(item.preview.images.map((i) => i.url)).toEqual(['p1', 'p2']);
    expect(data.pinned?.preview).toEqual(await service.getRatingReviewImages('Article', articleId));
    expect(data.pinned?.preview.total).toBe(1);
  });
});

describe('getRatingReviewImagesBatch', () => {
  it('keeps each entity to its own images and cap when several share one query', async () => {
    const p1 = await seedEntity(db, 'Post', { userId: alice });
    const p2 = await seedEntity(db, 'Post', { userId: alice });
    for (const i of [1, 2, 3]) await seedImage({ url: `p1-${i}`, postId: p1, index: i });
    await seedImage({ url: 'p2-1', postId: p2, index: 1 });
    const m1 = await seedEntity(db, 'Model', { userId: alice });
    const mv = await seedEntity(db, 'ModelVersion', { modelId: m1, index: 1 });
    const mp = await seedEntity(db, 'Post', {
      userId: alice,
      modelVersionId: mv,
      publishedAt: '2026-09-01T00:00:00.000Z',
    });
    await seedImage({ url: 'model-img', postId: mp, index: 0 });

    const found = await service.getRatingReviewImagesBatch(
      [
        { entityType: 'Post', entityId: p1 },
        { entityType: 'Post', entityId: p2 },
        { entityType: 'Model', entityId: m1 },
        { entityType: 'Collection', entityId: 404 },
      ],
      2
    );
    const urls = (t: 'Post' | 'Model', id: number) =>
      found.get(service.ratingReviewImagesKey(t, id))?.images.map((i) => i.url);

    expect(urls('Post', p1)).toEqual(['p1-1', 'p1-2']);
    expect(found.get(service.ratingReviewImagesKey('Post', p1))?.total).toBe(3);
    expect(urls('Post', p2)).toEqual(['p2-1']);
    expect(urls('Model', m1)).toEqual(['model-img']);
    expect(found.has(service.ratingReviewImagesKey('Collection', 404))).toBe(false);
  });
});

describe('getRatingReviewImagesBatch covers', () => {
  const batch = (...refs: [string, number][]) =>
    service.getRatingReviewImagesBatch(
      refs.map(([entityType, entityId]) => ({ entityType: entityType as 'Article', entityId }))
    );
  const urls = (found: Awaited<ReturnType<typeof batch>>, type: string, id: number) =>
    found.get(service.ratingReviewImagesKey(type as 'Article', id))?.images.map((i) => i.url);

  it('leads an article with its cover once, even when it is also connected, and totals each article apart', async () => {
    const cover = await seedImage({ url: 'cover' });
    const bodyA = await seedImage({ url: 'body-a' });
    const bodyB = await seedImage({ url: 'body-b' });
    const a1 = await seedEntity(db, 'Article', { userId: alice, coverId: cover });
    const a2 = await seedEntity(db, 'Article', { userId: alice });
    await connect(bodyA, 'Article', a1);
    await connect(cover, 'Article', a1);
    await connect(bodyB, 'Article', a2);

    const found = await batch(['Article', a1], ['Article', a2]);

    expect(urls(found, 'Article', a1)).toEqual(['cover', 'body-a']);
    expect(found.get(service.ratingReviewImagesKey('Article', a1))?.total).toBe(2);
    expect(urls(found, 'Article', a2)).toEqual(['body-b']);
    expect(found.get(service.ratingReviewImagesKey('Article', a2))?.total).toBe(1);
  });

  it('previews a challenge, crucible and collection by their cover, a crucible falling back to its hero image', async () => {
    const challenge = await seedEntity(db, 'Challenge', {
      coverImageId: await seedImage({ url: 'challenge' }),
    });
    const crucible = await seedEntity(db, 'Crucible', {
      imageId: await seedImage({ url: 'crucible' }),
      heroImageId: await seedImage({ url: 'crucible-hero' }),
    });
    const heroOnly = await seedEntity(db, 'Crucible', {
      heroImageId: await seedImage({ url: 'hero-only' }),
    });
    const collection = await seedEntity(db, 'Collection', {
      userId: alice,
      imageId: await seedImage({ url: 'collection' }),
    });

    const found = await batch(
      ['Challenge', challenge],
      ['Crucible', crucible],
      ['Crucible', heroOnly],
      ['Collection', collection]
    );

    expect(urls(found, 'Challenge', challenge)).toEqual(['challenge']);
    expect(urls(found, 'Crucible', crucible)).toEqual(['crucible']);
    expect(urls(found, 'Crucible', heroOnly)).toEqual(['hero-only']);
    expect(urls(found, 'Collection', collection)).toEqual(['collection']);
  });
});

describe('resolveRatingDisputeAction', () => {
  const run = (fields: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return queue.resolveRatingDisputeAction({
      request: { formData: async () => form },
      locals: { user: { id: 77 } },
    } as never);
  };

  it('resolves as the signed-in moderator and reports the outcome', async () => {
    resolve.mockResolvedValue({ ok: true, status: 'Actioned' });

    const out = await run({ reviewId: '12', appliedLevel: '2', modComment: ' fine ' });

    expect(resolve).toHaveBeenCalledWith({
      reviewId: 12,
      appliedLevel: 2,
      modComment: 'fine',
      userId: 77,
    });
    expect(out).toEqual({ success: true, status: 'Actioned' });
  });

  it('refuses a refused resolution with the review it belongs to, and never calls on bad input', async () => {
    resolve.mockResolvedValue({ ok: false, error: 'gone' });

    const refused = await run({ reviewId: '12', appliedLevel: '2' });
    expect(refused).toMatchObject({ status: 409, data: { error: 'gone', key: 12 } });
    expect(refused).toMatchObject({ data: { subject: expect.stringContaining('12') } });

    resolve.mockClear();
    expect(await run({ reviewId: 'x', appliedLevel: '2' })).toMatchObject({ status: 400 });
    expect(resolve).not.toHaveBeenCalled();
  });
});
