import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Rank by "Recent" must show the creator's newest content, not the most-reacted pool re-sorted by date. The
 * defect that shape invites is invisible on a happy-path account: a post from today with two reactions is simply
 * missing from a pool of the 100 most-reacted, and the control looks broken to the one person who uses it.
 *
 * The backends are faked with data rather than with query-text checks: one creator whose NEWEST items have the
 * FEWEST reactions, answered by whichever query the fetcher chooses to ask.
 */

type Img = { id: number; type: 'image' | 'video'; createdAt: string; reactions: number };
type Art = { id: number; createdAt: string; reactions: number; status: 'Published' | 'Draft' };

const world = vi.hoisted(() => ({
  images: [] as Img[],
  articles: [] as Art[],
  // What the fetchers asked Postgres, so a dropped filter / order / cap is visible even though the fakes
  // answer from `world`: the fake cannot be the thing that applies the predicate under test.
  newestImageQueries: [] as { text: string; values: unknown[] }[],
  articleCalls: [] as { method: string; args: unknown[] }[],
}));

vi.mock('@civitai/db/kysely', () => ({
  // Interpolations are kept (as `values`) so the fake can answer by id / type / limit like the real database.
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    return {
      text,
      execute: async () => {
        if (text.includes('JOIN "Post"')) {
          world.newestImageQueries.push({ text: text.replace(/\s+/g, ' '), values });
          const [, type, limit] = values as [number, string, number];
          const rows = world.images
            .filter((i) => i.type === type)
            .sort((a, b) => b.id - a.id)
            .slice(0, limit)
            .map((i) => ({ id: i.id }));
          return { rows };
        }
        if (text.includes('FROM "Image" WHERE id = ANY')) {
          const ids = values[0] as number[];
          return {
            rows: world.images
              .filter((i) => ids.includes(i.id))
              .map((i) => ({
                id: i.id,
                url: `u${i.id}`,
                nsfwLevel: 1,
                type: i.type,
                createdAt: i.createdAt,
              })),
          };
        }
        return { rows: [] };
      },
    };
  },
}));

// A chainable stand-in for the Kysely `Article` queries `fetchTopArticles` issues.
vi.mock('$lib/server/db', () => {
  const builder = () => {
    const q = { limit: undefined as number | undefined, ids: undefined as number[] | undefined };
    const self: Record<string, unknown> = {
      where: (col: string, op: string, val: unknown) => {
        world.articleCalls.push({ method: 'where', args: [col, op, val] });
        if (op === 'in') q.ids = val as number[];
        return self;
      },
      leftJoin: () => self,
      select: () => self,
      orderBy: (...args: unknown[]) => {
        world.articleCalls.push({ method: 'orderBy', args });
        return self;
      },
      limit: (n: number) => {
        world.articleCalls.push({ method: 'limit', args: [n] });
        q.limit = n;
        return self;
      },
      execute: async () => {
        let rows = [...world.articles];
        if (q.limit !== undefined) {
          rows = rows
            .filter((a) => a.status === 'Published')
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
            .slice(0, q.limit);
        }
        if (q.ids) rows = rows.filter((a) => q.ids!.includes(a.id));
        return rows.map((a) => ({
          id: a.id,
          title: `A${a.id}`,
          nsfwLevel: 1,
          publishedAt: a.createdAt,
          createdAt: a.createdAt,
          coverUrl: null,
        }));
      },
    };
    return self;
  };
  return { dbRead: { selectFrom: () => builder() }, dbWrite: {} };
});

vi.mock('$lib/server/cache', () => ({
  createCache: <A, R>({ fetch }: { fetch: (args: A) => Promise<R> }) => ({ get: fetch }),
  createSysCache: <A, R>({ fetch }: { fetch: (args: A) => Promise<R> }) => ({ get: fetch }),
}));

vi.mock('$lib/server/logger', () => ({ getLogger: () => ({ logToAxiom: async () => undefined }) }));

// ClickHouse answers the reaction queries from the same world. A query naming `entityId IN (...)` is the
// lookup for a bounded id list; without it, it is the "most reacted" pool scan.
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    $query: async (q: string) => {
      const isImage = q.includes("'Image_Create'");
      const isArticle = q.includes("'Article_Create'");
      if (!isImage && !isArticle) return []; // views, impressions
      const inList = q.match(/entityId IN \(([\d,]+)\)/);
      const ids = inList ? inList[1].split(',').map(Number) : null;
      const pool = isImage ? world.images : world.articles;
      return pool
        .filter((r) => r.reactions > 0 && (!ids || ids.includes(r.id)))
        .sort((a, b) => b.reactions - a.reactions)
        .map((r) =>
          isImage
            ? { imageId: r.id, reactions: r.reactions }
            : { articleId: r.id, reactions: r.reactions }
        );
    },
  }),
}));

const { getTopMedia, getTopArticles } = await import('../analytics');

const range = { userId: 1, from: '2026-10-01', to: '2026-10-30' };

describe('Recent pool', () => {
  beforeEach(() => {
    world.newestImageQueries = [];
    world.articleCalls = [];
    // 3 older, well-reacted images; the newest has a single reaction, and one newer still has none.
    world.images = [
      { id: 10, type: 'image', createdAt: '2026-09-01T00:00:00.000Z', reactions: 50 },
      { id: 11, type: 'image', createdAt: '2026-09-02T00:00:00.000Z', reactions: 40 },
      { id: 12, type: 'image', createdAt: '2026-09-03T00:00:00.000Z', reactions: 30 },
      { id: 13, type: 'image', createdAt: '2026-10-29T00:00:00.000Z', reactions: 1 },
      { id: 14, type: 'image', createdAt: '2026-10-30T00:00:00.000Z', reactions: 0 },
      { id: 20, type: 'video', createdAt: '2026-10-28T00:00:00.000Z', reactions: 0 },
    ];
    world.articles = [
      { id: 1, createdAt: '2026-08-01T00:00:00.000Z', reactions: 20, status: 'Published' },
      { id: 2, createdAt: '2026-10-29T00:00:00.000Z', reactions: 0, status: 'Published' },
      { id: 3, createdAt: '2026-10-30T00:00:00.000Z', reactions: 5, status: 'Draft' },
    ];
  });

  it('media: the newest image is in the pool even with zero reactions', async () => {
    const media = await getTopMedia({ ...range, pool: 'recent' });
    const images = media.filter((m) => m.type === 'image');
    expect(images.map((m) => m.imageId)).toContain(14);
    expect(images[0].imageId).toBe(14);
    expect(media.some((m) => m.type === 'video' && m.imageId === 20)).toBe(true);
  });

  it('media: createdAt reaches the client so it can order the pool', async () => {
    const media = await getTopMedia({ ...range, pool: 'recent' });
    const newest = media.find((m) => m.imageId === 14);
    expect(newest?.createdAt).toBe('2026-10-30T00:00:00.000Z');
  });

  it('media control: without recent, the pool is the reaction order and a zero-reaction image is absent', async () => {
    const media = await getTopMedia(range);
    expect(media.map((m) => m.imageId)).toEqual([10, 11, 12, 13]);
  });

  it('articles: the newest published article is in the pool; drafts are not', async () => {
    const articles = await getTopArticles({ ...range, pool: 'recent' });
    expect(articles.map((a) => a.articleId).sort()).toEqual([1, 2]);
    expect(articles.find((a) => a.articleId === 2)?.createdAt).toBe('2026-10-29T00:00:00.000Z');
  });

  it('articles control: without recent, only articles with views or reactions are in the pool', async () => {
    const articles = await getTopArticles(range);
    expect(articles.map((a) => a.articleId)).toEqual([1, 3]);
  });
  it("media: asks Postgres for the caller's own published images, newest first, capped per type", async () => {
    await getTopMedia({ ...range, pool: 'recent' });
    expect(world.newestImageQueries).toHaveLength(2);
    for (const { text, values } of world.newestImageQueries) {
      expect(text).toMatch(/i\."userId" = \?/);
      expect(values[0]).toBe(1);
      expect(text).toMatch(/p\."publishedAt" IS NOT NULL AND p\."publishedAt" <= now\(\)/);
      expect(text).toMatch(/ORDER BY i\.id DESC/);
      expect(values[2]).toBe(100);
    }
    expect(world.newestImageQueries.map((q) => q.values[1]).sort()).toEqual(['image', 'video']);
  });

  it("articles: asks Postgres for the caller's own published articles, newest first, capped", async () => {
    await getTopArticles({ ...range, pool: 'recent' });
    const calls = world.articleCalls;
    // the newest-pool query is the one carrying limit(); its filters precede it
    expect(calls.find((c) => c.method === 'limit')?.args).toEqual([100]);
    expect(calls).toContainEqual({ method: 'where', args: ['status', '=', 'Published'] });
    expect(calls).toContainEqual({ method: 'where', args: ['userId', '=', 1] });
    const order = calls.filter((c) => c.method === 'orderBy');
    expect(order).toHaveLength(2);
    // nullable createdAt must not float to the top of a descending sort
    expect((order[0].args[0] as { text: string }).text).toMatch(/desc nulls last/);
    expect(order[1].args).toEqual(['id', 'desc']);
  });
});
