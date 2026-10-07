import { beforeEach, describe, expect, it, vi } from 'vitest';
import { walkPages } from './keyset-walk.harness';

/**
 * The downleveled queue pages through a ClickHouse table whose `createdAt` is whole seconds, and one
 * second can hold thousands of rows. Paging must get past such a second.
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
      // The pre-fix predicate, `createdAt <= {cursor:String}`, so a revert fails the way prod did:
      // stuck inside the tied second rather than restarting from the top.
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

const walk = (limit: number) =>
  walkPages((cursor?: string) => getDownleveledImages({ cursor, limit }));

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

  it('accepts the largest UInt32 id', () => {
    expect(parseDownleveledCursor(`${TIED_SECOND}|4294967295`)?.id).toBe(4294967295);
  });

  // A bookmarked pre-fix cursor (a bare timestamp) or a hand-edited one restarts at the first page
  // rather than reaching ClickHouse, which errors on some of these and silently clamps others.
  it.each([
    TIED_SECOND,
    `${TIED_SECOND}|`,
    `${TIED_SECOND}|12a`,
    `x|1`,
    `${TIED_SECOND}|1|2`,
    `${TIED_SECOND}|4294967296`,
    `2026-13-45 99:99:99|1`,
    `2026-02-30 00:00:00|1`,
    `1960-01-01 00:00:00|1`,
    `2200-01-01 00:00:00|1`,
  ])('ignores %j', (cursor) => {
    expect(parseDownleveledCursor(cursor)).toBeUndefined();
  });
});
