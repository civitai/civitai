import { beforeEach, describe, expect, it, vi } from 'vitest';

type MediaType = 'image' | 'video';
// `type` is Postgres `Image.type`, which the tabs filter on. `ch` is what ClickHouse's `images_created` holds for
// the same id, or null when that table has no row for it.
type Entity = { imageId: number; reactions: number; type: MediaType; ch: MediaType | null };

const state = vi.hoisted(() => ({ entities: [] as Entity[], rankingSql: [] as string[] }));

// Models the three parts of the ranking query this file depends on, and throws on anything it cannot model: the
// kind of join to `images_created`, the ORDER BY, and the trailing `LIMIT n` / `LIMIT n BY mediaType`.
function runRanking(sql: string): { imageId: string; reactions: string; mediaType?: string }[] {
  if (!/ORDER BY reactions DESC\b[^)]*LIMIT \d+/.test(sql))
    throw new Error(`fake ClickHouse needs ORDER BY reactions DESC: ${sql.slice(-120)}`);
  const joinsMediaType = /\bimages_created\b/.test(sql);
  const leftJoin = /\bLEFT JOIN \(SELECT id, any\(mediaType\)/.test(sql);
  const rows = state.entities
    .filter((e) => !joinsMediaType || leftJoin || e.ch !== null)
    .map((e) => ({ ...e, mediaType: e.ch ?? '' }))
    .sort((a, b) => b.reactions - a.reactions || b.imageId - a.imageId);

  const limit = sql.match(/LIMIT (\d+)(?: BY (mediaType))?\s*$/);
  if (!limit) throw new Error(`fake ClickHouse cannot model this query's limit: ${sql.slice(-80)}`);
  const n = Number(limit[1]);
  const taken = new Map<string, number>();
  const kept = limit[2]
    ? rows.filter((r) => {
        const count = taken.get(r.mediaType) ?? 0;
        taken.set(r.mediaType, count + 1);
        return count < n;
      })
    : rows.slice(0, n);
  return kept.map((r) => ({
    imageId: String(r.imageId),
    reactions: String(r.reactions),
    ...(joinsMediaType && { mediaType: r.mediaType }),
  }));
}

vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    $query: async (sql: string) => {
      if (!/\bFROM reactions\b/.test(sql)) return [];
      state.rankingSql.push(sql);
      return runRanking(sql);
    },
  }),
}));

vi.mock('$lib/server/db', () => {
  const chain = (ids: number[]) => ({
    select: () => ({
      execute: async () =>
        state.entities
          .filter((e) => ids.includes(e.imageId))
          .map((e) => ({ id: e.imageId, url: `u-${e.imageId}`, nsfwLevel: 1, type: e.type })),
    }),
  });
  return {
    dbRead: {
      selectFrom: () => ({ where: (_c: string, _op: string, ids: number[]) => chain(ids) }),
    },
    dbWrite: {},
  };
});

vi.mock('$lib/server/cache', () => ({
  createCache: <A, R>({ fetch }: { fetch: (args: A) => Promise<R> }) => ({ get: fetch }),
  createSysCache: <A, R>({ fetch }: { fetch: (args: A) => Promise<R> }) => ({ get: fetch }),
}));

const { getTopMedia, TOP_MEDIA_PER_TYPE } = await import('../analytics');

const entities = (
  type: MediaType,
  count: number,
  firstId: number,
  topReactions: number,
  ch: MediaType | null = type
): Entity[] =>
  Array.from({ length: count }, (_, i) => ({
    imageId: firstId + i,
    reactions: topReactions - i,
    type,
    ch,
  }));

async function tabs() {
  const media = await getTopMedia({ userId: 42, from: '2026-09-01', to: '2026-09-30' });
  return {
    images: media.filter((m) => m.type === 'image'),
    videos: media.filter((m) => m.type === 'video'),
  };
}

describe('top media is ranked per type', () => {
  beforeEach(() => {
    state.rankingSql.length = 0;
  });

  // The reported case: every video out-reacts every image, and there are more videos than one list holds.
  it('keeps the Images tab when videos out-rank every image', async () => {
    state.entities = [...entities('video', 150, 1_000, 1_000), ...entities('image', 50, 5_000, 50)];
    const { images, videos } = await tabs();

    expect(state.rankingSql).toHaveLength(1);
    expect(images.length).toBe(50);
    expect(videos.length).toBe(TOP_MEDIA_PER_TYPE);
    expect(images[0]).toMatchObject({ imageId: 5_000, reactions: 50 });
  });

  it('caps each type on its own', async () => {
    state.entities = [
      ...entities('video', 150, 1_000, 1_000),
      ...entities('image', 130, 5_000, 900),
    ];
    const { images, videos } = await tabs();

    expect(images.length).toBe(TOP_MEDIA_PER_TYPE);
    expect(videos.length).toBe(TOP_MEDIA_PER_TYPE);
    expect(images.at(-1)?.reactions).toBe(900 - (TOP_MEDIA_PER_TYPE - 1));
  });

  // `images_created` has ingestion gaps: live images with no row there. An inner join erased them from both tabs.
  it('keeps a live image that images_created has no row for', async () => {
    state.entities = [
      ...entities('image', 1, 9_000, 5_000, null),
      ...entities('image', 20, 5_000, 900),
    ];
    const { images } = await tabs();

    expect(images[0]).toMatchObject({ imageId: 9_000, reactions: 5_000 });
    expect(images.length).toBe(21);
  });

  // Images missing from images_created rank in their own bucket, so ClickHouse can return more than the cap of
  // one Postgres type; the tab must still hold only its top N.
  it('caps a tab that draws from more than one ClickHouse bucket', async () => {
    state.entities = [
      ...entities('image', 60, 9_000, 1_000, null),
      ...entities('image', 100, 5_000, 500),
    ];
    const { images } = await tabs();

    expect(images.length).toBe(TOP_MEDIA_PER_TYPE);
    expect(images[0]?.imageId).toBe(9_000);
    expect(images.at(-1)?.reactions).toBe(500 - (TOP_MEDIA_PER_TYPE - 60 - 1));
  });
});
