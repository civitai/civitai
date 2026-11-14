import { describe, expect, test } from 'vitest';
import { articleDocument, removeSpoilers } from '@/vector-sync/articles/document';
import { articleDomain, articleRefFromEvent } from '@/vector-sync/articles/domain';
import { getArticleDocs } from '@/vector-sync/articles/source';
import { contentRoute, OUTBOX_TOPIC, selectDomains } from '@/vector-sync/content/consumer';
import { nextRefreshIds } from '@/vector-sync/domain/refresh';
import { syncIds } from '@/vector-sync/domain/sync';
import type { ArticlePayload } from '@/vector-sync/articles/source';

describe('article eligibility and payload, against the real query', () => {
  // One excluded article per clause of ARTICLE_ELIGIBLE_SQL, so dropping any clause fails.
  const EXCLUDED: Record<string, string> = {
    unpublished: `"publishedAt" = NULL`,
    draft: `status = 'Draft'`,
    unscanned: `ingestion = 'Pending'`,
    tosViolation: `"tosViolation" = true`,
    unsearchable: `availability = 'Unsearchable'`,
    private: `availability = 'Private'`,
    earlyAccess: `availability = 'EarlyAccess'`,
    unlisted: `unlisted = true`,
    bannedOwner: `"userId" = 8`,
  };

  test('keeps only eligible articles, with the fields the site filters on', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    await pg.exec(`
      CREATE TABLE "User" (id int PRIMARY KEY, username text, "bannedAt" timestamp);
      CREATE TABLE "Tag" (id int PRIMARY KEY, name text);
      CREATE TABLE "TagsOnArticle" ("articleId" int, "tagId" int);
      CREATE TABLE "Article" (id int PRIMARY KEY, title text, content text, "nsfwLevel" int,
        "publishedAt" timestamp, "userId" int, "coverId" int, "isOfficial" boolean, status text,
        ingestion text, "tosViolation" boolean, availability text, unlisted boolean);
      INSERT INTO "User" VALUES (7, 'someone', NULL), (8, 'banned', '2026-01-02');
      INSERT INTO "Tag" VALUES (1, 'anime'), (2, 'guide');
      INSERT INTO "TagsOnArticle" VALUES (1, 2), (1, 1);
    `);
    const ids = [1, ...Object.keys(EXCLUDED).map((_, i) => i + 2)];
    for (const id of ids)
      await pg.exec(`INSERT INTO "Article" VALUES (${id}, 'My  Guide', '<p>Body</p>', 5,
        '2026-01-01', 7, 99, true, 'Published', 'Scanned', false, 'Public', false)`);
    for (const [i, set] of Object.values(EXCLUDED).entries())
      await pg.exec(`UPDATE "Article" SET ${set} WHERE id = ${i + 2}`);

    try {
      const docs = await getArticleDocs(pg as unknown as Parameters<typeof getArticleDocs>[0], ids);
      expect([...docs.keys()]).toEqual([1]);
      expect(docs.get(1)).toMatchObject({
        title_normalized: 'my guide',
        title: 'My  Guide',
        tags: ['anime', 'guide'],
        tagIds: [1, 2],
        nsfwLevel: [1, 4],
        publishedAt: '2026-01-01T00:00:00.000Z',
        userId: 7,
        username: 'someone',
        coverImageId: 99,
        isOfficial: true,
      });
      expect(docs.get(1)?.search_text).toBe(
        'Title: My Guide\nCreator: someone\nTags: anime, guide\nContent: Body'
      );
    } finally {
      await pg.close();
    }
  }, 60_000);
});

describe('article document', () => {
  test('leaves spoilers out of the embedded text', () => {
    const content =
      '<p>Shown <span data-type="spoiler">the twist <b>ending</b></span> after</p>' +
      '<div data-type=" Spoiler "><p>hidden block</p></div><p>end</p>';
    const { text } = articleDocument({ title: 'T', username: 'u', tags: [], content });
    expect(text).toBe('Title: T\nCreator: u\nTags: \nContent: Shown after end');
  });

  test('passes a body without spoilers through untouched', () => {
    // sanitize-html would rewrite the bare `&` and the unquoted attribute.
    const html = '<p class=x>No secrets & <i>here</i></p>';
    expect(removeSpoilers(html)).toBe(html);
  });
});

describe('article change signals', () => {
  test('an Article or TagsOnArticle change names the article; a snapshot read names none', () => {
    expect(articleRefFromEvent('postgres.Article', { op: 'u', after: { id: 3 } })).toEqual({
      id: 3,
    });
    expect(
      articleRefFromEvent('postgres.Article', { op: 'd', before: { id: 4 }, after: null })
    ).toEqual({ id: 4 });
    expect(
      articleRefFromEvent('postgres.TagsOnArticle', {
        op: 'd',
        before: { articleId: 5, tagId: 1 },
        after: null,
      })
    ).toEqual({ id: 5 });
    expect(articleRefFromEvent('postgres.Article', { op: 'r', after: { id: 6 } })).toBeNull();
  });

  test("the site's search.update rows for articles reach the article domain", () => {
    const route = contentRoute(selectDomains(['article']));
    const outbox = (entityType: string) => ({
      op: 'c',
      after: { event: 'search.update', entityType, entityId: '12' },
    });
    expect(route(OUTBOX_TOPIC, outbox('Article'))).toEqual([['article', { id: 12 }]]);
    expect(route(OUTBOX_TOPIC, outbox('Comic'))).toEqual([]);
    expect(
      articleDomain.topics.flatMap((t) => route(t, { op: 'u', after: { id: 1, articleId: 1 } }))
    ).toEqual([
      ['article', { id: 1 }],
      ['article', { id: 1 }],
    ]);
  });
});

describe('article embedding switch', () => {
  // VECTOR_CONTENT_DOMAINS=article starts the consumer; embedding also needs its own switch.
  test('stays off until VECTOR_ARTICLE_EMBED_ENABLED is true, even with the global switch on', async () => {
    const { config, domainEmbedEnabled } = await import('@/config');
    const global = config.vectorSync.embedEnabled;
    const own = process.env.VECTOR_ARTICLE_EMBED_ENABLED;
    try {
      config.vectorSync.embedEnabled = true;
      delete process.env.VECTOR_ARTICLE_EMBED_ENABLED;
      expect(domainEmbedEnabled(articleDomain.name, articleDomain.embedByDefault)).toBe(false);
      process.env.VECTOR_ARTICLE_EMBED_ENABLED = 'true';
      expect(domainEmbedEnabled(articleDomain.name, articleDomain.embedByDefault)).toBe(true);
    } finally {
      config.vectorSync.embedEnabled = global;
      if (own === undefined) delete process.env.VECTOR_ARTICLE_EMBED_ENABLED;
      else process.env.VECTOR_ARTICLE_EMBED_ENABLED = own;
    }
  });
});

describe('article refresh walk', () => {
  test('an article whose event flushed while embedding was off gets its point on the next pass', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    await pg.exec(`
      CREATE TABLE "User" (id int PRIMARY KEY, username text, "bannedAt" timestamp);
      CREATE TABLE "Tag" (id int PRIMARY KEY, name text);
      CREATE TABLE "TagsOnArticle" ("articleId" int, "tagId" int);
      CREATE TABLE "Article" (id int PRIMARY KEY, title text, content text, "nsfwLevel" int,
        "publishedAt" timestamp, "userId" int, "coverId" int, "isOfficial" boolean, status text,
        ingestion text, "tosViolation" boolean, availability text, unlisted boolean);
      INSERT INTO "User" VALUES (7, 'someone', NULL);
      INSERT INTO "Article" VALUES (1, 'A', '<p>Body</p>', 1, '2026-01-01', 7, NULL, false,
        'Published', 'Scanned', false, 'Public', false);
    `);
    const points = new Map<number, ArticlePayload>();
    const store = {
      payloadFields: async (ids: number[]) =>
        new Map(ids.flatMap((id) => (points.has(id) ? [[id, points.get(id)!] as const] : []))),
      delete: async (ids: number[]) => ids.forEach((id) => points.delete(id)),
      setPayloads: async (p: Map<number, ArticlePayload>) =>
        p.forEach((payload, id) => points.set(id, payload)),
      upsert: async (ps: { id: number; payload: ArticlePayload }[]) =>
        ps.forEach((p) => points.set(p.id, p.payload)),
      assertModel: async () => undefined,
    };
    const embedder = {
      embed: async (
        inputs: { id: string }[],
        o: { onVectors?: (v: Map<number, number[]>) => Promise<void> } = {}
      ) => {
        const vectors = new Map(inputs.map((i) => [Number(i.id), [1]]));
        await o.onVectors?.(vectors);
        return { vectors, failed: [], stamp: undefined };
      },
    };
    const db = pg as unknown as Parameters<typeof nextRefreshIds>[0];
    try {
      // The live event, flushed while the lane could not embed: no point, and nothing retries it.
      await syncIds(getArticleDocs, [1], { pg, store, embedder: null } as never);
      expect(points.has(1)).toBe(false);

      expect(articleDomain.refresh).toBeDefined();
      const { ids } = await nextRefreshIds(db, articleDomain, 0, articleDomain.refresh!.batch);
      await syncIds(getArticleDocs, ids, { pg, store, embedder } as never);
      expect(points.has(1)).toBe(true);
    } finally {
      await pg.close();
    }
  }, 60_000);
});
