import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `reactions` is append-only: a reaction writes `<Entity>_Create`, un-reacting writes `<Entity>_Delete`, and the
 * net is +1 for a create type and -1 for anything else. A create type missing from that list counts every new
 * reaction as an un-react. The fake answers by applying the query's own create list to stored rows.
 */

type Row = { ownerId: number; userId: number; type: string; date: string };

const world = vi.hoisted(() => ({ rows: [] as Row[] }));

vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    $query: async (q: string) => {
      if (!/FROM reactions\b/.test(q)) return q.startsWith('SELECT count()') ? [{ value: 0 }] : [];
      const list = q.match(/sum\(if\(type IN \(([^)]*)\), 1, -1\)\)/);
      if (!list) throw new Error(`unexpected reactions query: ${q}`);
      const creates = new Set([...list[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
      const owner = Number(q.match(/ownerId = (\d+)/)?.[1]);
      const rows = world.rows.filter((r) => r.ownerId === owner);
      const net = (rs: Row[]) => rs.reduce((n, r) => n + (creates.has(r.type) ? 1 : -1), 0);
      const by = (key: (r: Row) => string | number) => {
        const groups = new Map<string | number, Row[]>();
        for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
        return [...groups];
      };
      if (q.includes('GROUP BY reactorId'))
        return by((r) => r.userId).map(([reactorId, rs]) => ({ reactorId, reactions: net(rs) }));
      if (q.startsWith('SELECT sum(value) AS value FROM (')) return [{ value: net(rows) }];
      return by((r) => r.date).map(([date, rs]) => ({ date, value: net(rs) }));
    },
  }),
}));

vi.mock('$lib/server/db', () => {
  const builder = (): Record<string, unknown> => {
    const self: Record<string, unknown> = {
      where: () => self,
      select: () => self,
      execute: async () => [],
    };
    return self;
  };
  return { dbRead: { selectFrom: () => builder() }, dbWrite: {} };
});

vi.mock('$lib/server/followers', () => ({ followersAmong: async () => new Set<number>() }));

vi.mock('$lib/server/cache', () => ({
  createCache: <A, R>({ fetch }: { fetch: (args: A) => Promise<R> }) => ({ get: fetch }),
  createSysCache: <A, R>({ fetch }: { fetch: (args: A) => Promise<R> }) => ({ get: fetch }),
}));

vi.mock('$lib/server/logger', () => ({ getLogger: () => ({ logToAxiom: async () => undefined }) }));

const { getContentAnalytics, getContentTotals, getReactionAudienceSplit } = await import('../analytics');

const OWNER = 1;
const FAN = 2;
const range = { userId: OWNER, from: '2026-11-01', to: '2026-11-02' };
const reaction = (type: string, date = '2026-11-01'): Row => ({ ownerId: OWNER, userId: FAN, type, date });

describe('net reactions count a post reaction', () => {
  beforeEach(() => {
    world.rows = [reaction('Post_Create'), reaction('Image_Create')];
  });

  it('in the reactions total', async () => {
    expect((await getContentTotals(range)).reactions).toBe(2);
  });

  it('in the daily reactions series', async () => {
    const series = (await getContentAnalytics(range)).reactions;
    expect(series.find((p) => p.date === '2026-11-01')?.value).toBe(2);
  });

  it('in the audience split', async () => {
    const split = await getReactionAudienceSplit(range);
    expect(split.nonFollowers).toEqual({ reactions: 2, reactors: 1 });
  });

  it('nets a post reaction and its removal to zero', async () => {
    world.rows = [reaction('Post_Create'), reaction('Post_Delete', '2026-11-02')];
    expect((await getContentTotals(range)).reactions).toBe(0);
  });
});
