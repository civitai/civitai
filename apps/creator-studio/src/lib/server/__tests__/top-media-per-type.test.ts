import { beforeEach, describe, expect, it, vi } from 'vitest';

type MediaType = 'image' | 'video';
// pgType null = deleted: no Postgres row.
type Entity = { imageId: number; reactions: number; pgType: MediaType | null };

const state = vi.hoisted(() => ({
  entities: [] as Entity[],
  rankingSql: [] as string[],
  pgBatches: [] as number[][],
  viewIds: [] as number[][],
  logged: [] as Record<string, unknown>[],
}));

// Models only `ORDER BY reactions DESC` and a trailing `LIMIT n`, and throws on any other shape, so a query this
// file cannot model fails loudly instead of passing on the fake's own behaviour.
function runRanking(sql: string): { imageId: string; reactions: string }[] {
  if (!/ORDER BY reactions DESC\b/.test(sql))
    throw new Error(`fake ClickHouse needs ORDER BY reactions DESC: ${sql.slice(-120)}`);
  const limit = sql.match(/ORDER BY reactions DESC[^)]*LIMIT (\d+)\s*$/);
  if (!limit) throw new Error(`fake ClickHouse cannot model this query's limit: ${sql.slice(-80)}`);
  return [...state.entities]
    .sort((a, b) => b.reactions - a.reactions || b.imageId - a.imageId)
    .slice(0, Number(limit[1]))
    .map((e) => ({ imageId: String(e.imageId), reactions: String(e.reactions) }));
}

vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    $query: async (sql: string) => {
      if (/\bFROM daily_views\b/.test(sql)) {
        state.viewIds.push(
          (sql.match(/entityId IN \(([^)]*)\)/)?.[1] ?? '').split(',').map(Number)
        );
        return [];
      }
      if (!/\bFROM reactions\b/.test(sql)) return [];
      state.rankingSql.push(sql);
      return runRanking(sql);
    },
  }),
}));

// The `Image` lookup is the only `sql` query on this path. Rows come back in descending id order, since Postgres
// promises none, so the page has to keep ClickHouse's ranking itself.
vi.mock('@civitai/db/kysely', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    execute: async () => {
      if (!strings.join('?').includes('FROM "Image"')) return { rows: [] };
      const ids = values[0] as number[];
      state.pgBatches.push(ids);
      const wanted = new Set(ids);
      return {
        rows: state.entities
          .filter((e) => e.pgType !== null && wanted.has(e.imageId))
          .sort((a, b) => b.imageId - a.imageId)
          .map((e) => ({ id: e.imageId, url: `u-${e.imageId}`, nsfwLevel: 1, type: e.pgType })),
      };
    },
  }),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

vi.mock('$lib/server/logger', () => ({
  getLogger: () => ({
    logToAxiom: async (data: Record<string, unknown>) => {
      state.logged.push(data);
    },
  }),
}));

vi.mock('$lib/server/cache', () => ({
  createCache: <A, R>({ fetch }: { fetch: (args: A) => Promise<R> }) => ({ get: fetch }),
  createSysCache: <A, R>({ fetch }: { fetch: (args: A) => Promise<R> }) => ({ get: fetch }),
}));

const { getTopMedia, TOP_MEDIA_PER_TYPE, TOP_MEDIA_READ_CEILING, TOP_MEDIA_ID_CHUNK } =
  await import('../analytics');

const entities = (
  pgType: MediaType | null,
  count: number,
  firstId: number,
  topReactions: number
): Entity[] =>
  Array.from({ length: count }, (_, i) => ({
    imageId: firstId + i,
    reactions: topReactions - i,
    pgType,
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
    state.pgBatches.length = 0;
    state.viewIds.length = 0;
    state.logged.length = 0;
  });

  // The reported case: every video out-reacts every image, and there are more videos than one list holds.
  it('keeps the Images tab when videos out-rank every image', async () => {
    state.entities = [...entities('video', 150, 1_000, 1_000), ...entities('image', 50, 5_000, 50)];
    const { images, videos } = await tabs();

    expect(state.rankingSql).toHaveLength(1);
    expect(images.length).toBe(50);
    expect(videos.length).toBe(TOP_MEDIA_PER_TYPE);
    expect(images.map((i) => i.imageId).slice(0, 3)).toEqual([5_000, 5_001, 5_002]);
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

  // Reactions outlive the image. A creator who deleted a month's worth of reacted images must still see the live ones.
  it('keeps live images behind more deleted ones than a tab holds', async () => {
    state.entities = [...entities(null, 250, 20_000, 2_000), ...entities('image', 30, 5_000, 900)];
    const { images } = await tabs();

    expect(images.length).toBe(30);
    expect(images[0]).toMatchObject({ imageId: 5_000, reactions: 900 });
  });

  it('reads views only for the items it shows', async () => {
    state.entities = [...entities(null, 300, 20_000, 2_000), ...entities('image', 130, 5_000, 900)];
    const { images } = await tabs();

    expect(state.viewIds).toHaveLength(1);
    expect([...state.viewIds[0]].sort()).toEqual(images.map((i) => i.imageId).sort());
  });

  it('looks ids up in Postgres in bounded batches', async () => {
    const count = TOP_MEDIA_ID_CHUNK * 2 + 5;
    state.entities = [
      ...entities(null, count - 10, 100_000, 50_000),
      ...entities('image', 10, 5_000, 10),
    ];
    const { images } = await tabs();

    expect(state.pgBatches.map((b) => b.length)).toEqual([
      TOP_MEDIA_ID_CHUNK,
      TOP_MEDIA_ID_CHUNK,
      5,
    ]);
    expect(images.length).toBe(10);
  });

  // At the ceiling the lowest-ranked ids are not read at all, so it must be visible in the logs when it happens.
  it('logs when the read hits its ceiling, and not below it', async () => {
    state.entities = entities('image', TOP_MEDIA_READ_CEILING - 1, 1_000_000, 10_000_000);
    await tabs();
    expect(state.logged).toEqual([]);

    state.entities = entities('image', TOP_MEDIA_READ_CEILING + 1, 1_000_000, 10_000_000);
    await tabs();
    expect(state.logged).toEqual([
      expect.objectContaining({ name: 'top-media-read-ceiling', userId: 42 }),
    ]);
  });
});
