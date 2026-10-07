import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The downleveled queue pages through a ClickHouse table whose `createdAt` is whole seconds, and on
 * prod one second holds 15,736 rows (2026-10-07). Paging must get past such a second.
 *
 * ClickHouse is faked: the fake applies whichever cursor predicate the query was given, so this pins
 * the cursor the service hands back. The SQL text that predicate stands for is pinned separately below.
 */

type ChRow = { imageId: number; originalLevel: number; createdAt: string };

const { ch } = vi.hoisted(() => ({
  ch: { rows: [] as ChRow[], queries: [] as string[] },
}));

const newestFirst = (a: ChRow, b: ChRow) =>
  b.createdAt.localeCompare(a.createdAt) || b.imageId - a.imageId;

vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({
    query: async ({
      query,
      query_params: p,
    }: {
      query: string;
      query_params: Record<string, string | number>;
    }) => {
      ch.queries.push(query);
      let rows = [...ch.rows];
      if (p.cursorAt != null)
        rows = rows.filter(
          (r) =>
            r.createdAt < String(p.cursorAt) ||
            (r.createdAt === p.cursorAt && r.imageId < Number(p.cursorId))
        );
      // The pre-fix predicate, `createdAt <= {cursor:String}`, so a revert is observable here.
      if (p.cursor != null) rows = rows.filter((r) => r.createdAt <= String(p.cursor));
      rows = rows.sort(newestFirst).slice(0, Number(p.lim));
      return { json: async () => rows };
    },
  }),
}));

vi.mock('../db', () => ({
  dbRead: {
    selectFrom: () => {
      let ids: number[] = [];
      const qb = {
        select: () => qb,
        where: (_col: string, _op: string, value: number[]) => {
          ids = value;
          return qb;
        },
        execute: async () =>
          ids.map((id) => ({ id, url: 'u', nsfwLevel: 1, type: 'image', width: 1, height: 1 })),
      };
      return qb;
    },
  },
}));

const { getDownleveledImages, parseDownleveledCursor } = await import(
  '../downleveled-review.service'
);

const TIED_SECOND = '2026-06-30 03:13:29';
// Five rows in one second, between an older and a newer row.
const SEED: ChRow[] = [
  { imageId: 900, originalLevel: 4, createdAt: '2026-06-30 03:13:30' },
  ...[505, 504, 503, 502, 501].map((imageId) => ({
    imageId,
    originalLevel: 4,
    createdAt: TIED_SECOND,
  })),
  { imageId: 100, originalLevel: 4, createdAt: '2026-06-30 03:13:28' },
];
const EXPECTED = [900, 505, 504, 503, 502, 501, 100];

beforeEach(() => {
  ch.rows = SEED;
  ch.queries.length = 0;
});

const walk = async (limit: number) => {
  const seen: number[] = [];
  let cursor: string | undefined;
  // Bounded: a cursor stuck inside one second must fail the assertion, not hang the run.
  for (let page = 0; page < 12; page++) {
    const result = await getDownleveledImages({ cursor, limit });
    seen.push(...result.items.map((i) => i.id));
    if (result.nextCursor == null) break;
    cursor = result.nextCursor;
  }
  return seen;
};

describe('downleveled queue paging', () => {
  it.each([1, 2, 3, 4])(
    'reaches every row exactly once through a tied second at %i per page',
    async (limit) => {
      expect(await walk(limit)).toEqual(EXPECTED);
    }
  );

  it('breaks createdAt ties on imageId, in the predicate and the order', async () => {
    await getDownleveledImages({ cursor: `${TIED_SECOND}|503`, limit: 2 });

    const query = ch.queries.at(-1) ?? '';
    expect(query).toContain('(createdAt, imageId) < ({cursorAt:DateTime}, {cursorId:UInt32})');
    expect(query).toMatch(/ORDER BY createdAt DESC, imageId DESC\s+LIMIT/);
  });
});

describe('parseDownleveledCursor', () => {
  it('reads the cursor the service writes', () => {
    expect(parseDownleveledCursor(`${TIED_SECOND}|503`)).toEqual({ at: TIED_SECOND, id: 503 });
  });

  // A bookmarked pre-fix cursor (a bare timestamp) or a hand-edited one restarts at the first page
  // rather than reaching ClickHouse as a malformed parameter.
  it.each([TIED_SECOND, `${TIED_SECOND}|`, `${TIED_SECOND}|12a`, `x|1`, `${TIED_SECOND}|1|2`])(
    'ignores %j',
    (cursor) => {
      expect(parseDownleveledCursor(cursor)).toBeUndefined();
    }
  );
});
