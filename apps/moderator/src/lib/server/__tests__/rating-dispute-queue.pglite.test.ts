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

describe('ratingDisputeTriageLoad owner filter', () => {
  it('keeps only that user’s reviews, not those of a username sharing the text, and counts them alone', async () => {
    const mine = await fileReview({ userId: alice, entityType: 'Post' });
    await fileReview({ userId: bob, entityType: 'Post' });
    const collider = await seedUser(db, '1');
    await fileReview({ userId: collider, entityType: 'Post' });
    await fileReview({ userId: alice, entityType: 'Model' });

    const data = await load(`?owner=${alice}`);

    expect(ids(data)).toEqual([mine]);
    expect(data.filters.owner).toBe(alice);
    expect(data.totalCount).toBe(1);
    expect(data.facets?.tabs).toEqual({ posts: 1, models: 1, articles: 0, other: 0 });
    expect(ids(await load(`?owner=${collider}`))).toHaveLength(1);
    expect(ids(await load('?owner=abc'))).toHaveLength(3);
    expect((await load('?owner=abc')).filters.owner).toBeUndefined();
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

describe('ratingDisputeTriageLoad kind filter', () => {
  const OTHER = ['Bounty', 'BountyEntry', 'Challenge', 'Crucible', 'Collection'] as const;

  it('narrows the Other tab to one entity type: rows, total and chip counts, leaving the tab counts whole', async () => {
    const byType: Record<string, number> = {};
    for (const t of OTHER)
      byType[t] = await fileReview({ entityType: t, currentLevel: 4, suggestedLevel: 1 });
    await fileReview({ entityType: 'Challenge', currentLevel: 1, suggestedLevel: 4 });

    const challenges = await load('?tab=other&kind=Challenge');
    expect(challenges.items.map((i) => i.entityType)).toEqual(['Challenge', 'Challenge']);
    expect(challenges.totalCount).toBe(2);
    expect(challenges.filters.kind).toBe('Challenge');
    expect(challenges.facets?.chips).toEqual({ lower: 1, higher: 1, raised: 0 });
    expect(challenges.facets?.tabs.other).toBe(6);
    expect(challenges.facets?.kinds).toEqual({
      Bounty: 1,
      BountyEntry: 1,
      Challenge: 2,
      Crucible: 1,
      Collection: 1,
    });

    expect(ids(await load('?tab=other&kind=Crucible'))).toEqual([byType.Crucible]);
  });

  it('ignores a kind on other tabs and an unknown or foreign kind on the Other tab', async () => {
    const post = await fileReview({ entityType: 'Post' });
    await fileReview({ entityType: 'Bounty' });
    await fileReview({ entityType: 'Crucible' });

    const onPosts = await load('?kind=Bounty');
    expect(ids(onPosts)).toEqual([post]);
    expect(onPosts.filters.kind).toBeUndefined();

    expect((await load('?tab=other&kind=Post')).totalCount).toBe(2);
    expect((await load('?tab=other&kind=bogus')).filters.kind).toBeUndefined();
  });
});

describe('ratingDisputeTriageLoad scanned text', () => {
  const textOf = async (query: string, id: number) =>
    (await load(query)).items.find((i) => i.id === id)?.scannedText;

  it('loads the fields the text scan reads for a post, with HTML as plain text', async () => {
    const postId = await seedEntity(db, 'Post', {
      userId: alice,
      title: 'Sunset',
      detail: '<p>First <b>line</b></p><script>alert(1)</script><p>Second</p>',
    });
    const id = await fileReview({ entityType: 'Post', entityId: postId });

    const text = await textOf('', id);

    expect(text?.fields.map((f) => f.heading)).toEqual(['Title', 'Detail']);
    expect(text?.fields[0].text).toBe('Sunset');
    expect(text?.fields[1].text).toContain('First line');
    expect(text?.fields[1].text).toContain('Second');
    expect(text?.fields[1].text).not.toMatch(/<|alert/);
    expect(text?.truncated).toBe(false);
  });

  it('reads a model’s name and description, then only its public versions with their trained words', async () => {
    const modelId = await seedEntity(db, 'Model', {
      userId: alice,
      name: 'Model X',
      description: '<p>About</p>',
    });
    await seedEntity(db, 'ModelVersion', {
      modelId,
      index: 1,
      name: 'v1',
      description: '<p>one</p>',
      trainedWords: ['alpha', 'beta'],
    });
    await seedEntity(db, 'ModelVersion', {
      modelId,
      index: 2,
      status: 'Draft',
      name: 'draft-only',
      trainedWords: ['hidden'],
    });
    const id = await fileReview({ entityType: 'Model', entityId: modelId });

    const text = await textOf('?tab=models', id);

    expect(text?.fields).toEqual([
      { heading: 'Name', text: 'Model X' },
      { heading: 'Description', text: 'About' },
      { heading: 'Version name', text: 'v1' },
      { heading: 'Version description', text: 'one' },
      { heading: 'Trained words', text: 'alpha, beta' },
    ]);
  });

  it('reads a challenge’s theme elements, caps long text, and omits an entity with no text', async () => {
    const challengeId = await seedEntity(db, 'Challenge', {
      title: 'Ch',
      theme: 'Neon',
      description: `<p>${'word '.repeat(5000)}</p>`,
      metadata: JSON.stringify({ themeElements: ['rain', 'glow'] }),
    });
    const challenge = await fileReview({ entityType: 'Challenge', entityId: challengeId });
    const bountyId = await seedEntity(db, 'Bounty', { userId: alice, name: '   ' });
    const empty = await fileReview({ entityType: 'Bounty', entityId: bountyId });

    const text = await textOf('?tab=other', challenge);

    expect(text?.fields.map((f) => f.heading)).toEqual([
      'Title',
      'Theme',
      'Theme elements',
      'Description',
    ]);
    expect(text?.fields[2].text).toBe('rain, glow');
    expect(text?.truncated).toBe(true);
    expect(text?.fields[3].text.length).toBeLessThanOrEqual(6000);
    expect(await textOf('?tab=other', empty)).toBeNull();
  });

  it('reads an article’s title then its HTML content as plain text', async () => {
    const articleId = await seedEntity(db, 'Article', {
      userId: alice,
      title: 'Guide',
      content: '<h2>Intro</h2><p>Body <em>text</em></p><script>alert(1)</script>',
    });
    const id = await fileReview({ entityType: 'Article', entityId: articleId });

    const text = await textOf('?tab=articles', id);

    expect(text?.fields.map((f) => f.heading)).toEqual(['Title', 'Content']);
    expect(text?.fields[0].text).toBe('Guide');
    expect(text?.fields[1].text).toContain('Intro');
    expect(text?.fields[1].text).toContain('Body text');
    expect(text?.fields[1].text).not.toMatch(/<|alert/);
  });

  it('reads a bounty entry’s description alone', async () => {
    const entryId = await seedEntity(db, 'BountyEntry', {
      userId: alice,
      description: '<p>My <b>entry</b></p>',
    });
    const id = await fileReview({ entityType: 'BountyEntry', entityId: entryId });

    expect((await textOf('?tab=other', id))?.fields).toEqual([
      { heading: 'Description', text: 'My entry' },
    ]);
  });

  it.each(['Crucible', 'Collection'])('reads a %s’s name and description', async (entityType) => {
    const entityId = await seedEntity(db, entityType, {
      userId: alice,
      name: `${entityType} name`,
      description: '<p>About it</p>',
    });
    const id = await fileReview({ entityType, entityId });

    expect((await textOf('?tab=other', id))?.fields).toEqual([
      { heading: 'Name', text: `${entityType} name` },
      { heading: 'Description', text: 'About it' },
    ]);
  });

  it('still loads the queue, with no scanned text, when the text read fails', async () => {
    const articleId = await seedEntity(db, 'Article', { userId: alice, content: '<p>x</p>' });
    const id = await fileReview({ entityType: 'Article', entityId: articleId });
    await db.exec('ALTER TABLE "Article" DROP COLUMN "content"');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const data = await load('?tab=articles');

    expect(ids(data)).toEqual([id]);
    expect(data.items[0].scannedText).toBeNull();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('ratingDisputeTriageLoad rows', () => {
  it('numbers each dispute within its owner’s own, oldest first, whatever the status or type', async () => {
    const a1 = await fileReview({ userId: alice });
    const a2 = await fileReview({ userId: alice, status: 'Actioned', entityType: 'Model' });
    const a3 = await fileReview({ userId: alice });
    const b1 = await fileReview({ userId: bob });

    const data = await load('?status=Pending');
    const count = (id: number) => data.items.find((i) => i.id === id)?.ownerDisputeCount;
    expect(count(a1)).toBe(1);
    expect(count(a3)).toBe(3);
    expect(count(b1)).toBe(1);

    const decided = await load('?status=Actioned&tab=models');
    expect(decided.items.find((i) => i.id === a2)?.ownerDisputeCount).toBe(2);
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

  it('takes a cover from the first preview image, except an article, whose cover stays its own', async () => {
    const postId = await seedEntity(db, 'Post', { userId: alice });
    await seedImage({ url: 'p2', postId, index: 2 });
    await seedImage({ url: 'p1', postId, index: 1 });
    const articleId = await seedEntity(db, 'Article', { userId: alice });
    await connect(await seedImage({ url: 'body' }), 'Article', articleId);
    const onPage = await fileReview({ entityType: 'Post', entityId: postId });
    const articleReview = await fileReview({ entityType: 'Article', entityId: articleId });

    const data = await load(`?selected=${articleReview}`);

    expect(data.items.find((i) => i.id === onPage)?.entity).toMatchObject({
      coverUrl: 'p1',
      coverType: 'image',
    });
    // Connected body images preview, but never stand in as the article's cover.
    expect(data.pinned?.preview.images).toHaveLength(1);
    expect(data.pinned?.entity?.coverUrl).toBeNull();
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

  it('counts and previews only connections whose image still exists', async () => {
    const dangling = 987654;
    const cover = await seedImage({ url: 'cover' });
    const article = await seedEntity(db, 'Article', { userId: alice, coverId: cover });
    const bounty = await seedEntity(db, 'Bounty', { userId: alice });
    // The dangling link sorts first, so a cap applied before the lookup would swallow a slot.
    await connect(dangling, 'Article', article);
    await connect(dangling, 'Bounty', bounty);
    for (let i = 1; i <= 7; i++) {
      const id = await seedImage({ url: `body-${i}` });
      await connect(id, 'Article', article);
      await connect(id, 'Bounty', bounty);
    }

    const found = await batch(['Article', article], ['Bounty', bounty]);
    const art = found.get(service.ratingReviewImagesKey('Article', article));
    const bnt = found.get(service.ratingReviewImagesKey('Bounty', bounty));

    expect(art?.total).toBe(8);
    expect(art?.images.map((i) => i.url)).toEqual([
      'cover',
      'body-1',
      'body-2',
      'body-3',
      'body-4',
      'body-5',
      'body-6',
      'body-7',
    ]);
    expect(bnt?.total).toBe(7);
    expect(bnt?.images).toHaveLength(7);
  });

  it('previews at most the preview limit of a post’s images and still reports the full total', async () => {
    const postId = await seedEntity(db, 'Post', { userId: alice });
    for (let i = 1; i <= service.PREVIEW_LIMIT + 7; i++)
      await seedImage({ url: `p-${i}`, postId, index: i });

    const found = await batch(['Post', postId]);
    const post = found.get(service.ratingReviewImagesKey('Post', postId));

    expect(post?.total).toBe(service.PREVIEW_LIMIT + 7);
    expect(post?.images).toHaveLength(service.PREVIEW_LIMIT);
    expect(post?.images[0].url).toBe('p-1');
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
