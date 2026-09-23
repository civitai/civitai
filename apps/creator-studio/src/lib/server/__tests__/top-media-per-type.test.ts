import { beforeEach, describe, expect, it, vi } from 'vitest';

type MediaType = 'image' | 'video';
type Entity = { imageId: number; reactions: number; mediaType: MediaType };

const state = vi.hoisted(() => ({ entities: [] as Entity[], rankingSql: [] as string[] }));

// ClickHouse ranks and limits; this fake does only that, and honours the query's own trailing `LIMIT n` /
// `LIMIT n BY col`. It cannot see anything else in the SQL, so the per-type behaviour asserted below comes from
// the limit clause the query actually sends.
function applyLimit(sql: string, rows: Entity[]): Entity[] {
  const ranked = [...rows].sort((a, b) => b.reactions - a.reactions || b.imageId - a.imageId);
  const limit = sql.match(/LIMIT (\d+)(?: BY (\w+))?\s*$/);
  if (!limit) throw new Error(`fake ClickHouse cannot model this query's limit: ${sql.slice(-80)}`);
  const n = Number(limit[1]);
  if (!limit[2]) return ranked.slice(0, n);
  const taken = new Map<unknown, number>();
  return ranked.filter((r) => {
    const key = r[limit[2] as keyof Entity];
    const count = taken.get(key) ?? 0;
    taken.set(key, count + 1);
    return count < n;
  });
}

vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    $query: async (sql: string) => {
      if (!/\bFROM reactions\b/.test(sql)) return [];
      state.rankingSql.push(sql);
      return applyLimit(sql, state.entities).map(({ imageId, reactions }) => ({
        imageId: String(imageId),
        reactions: String(reactions),
      }));
    },
  }),
}));

// Postgres is where the page reads each item's type from, so the fake answers it from the same fixture.
vi.mock('$lib/server/db', () => {
  const chain = (ids: number[]) => ({
    select: () => ({
      execute: async () =>
        state.entities
          .filter((e) => ids.includes(e.imageId))
          .map((e) => ({ id: e.imageId, url: `u-${e.imageId}`, nsfwLevel: 1, type: e.mediaType })),
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

const entities = (mediaType: MediaType, count: number, firstId: number, topReactions: number) =>
  Array.from({ length: count }, (_, i) => ({
    imageId: firstId + i,
    reactions: topReactions - i,
    mediaType,
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
    expect(images.map((i) => i.reactions)).toEqual(
      [...images.map((i) => i.reactions)].sort((a, b) => b - a)
    );
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
});
