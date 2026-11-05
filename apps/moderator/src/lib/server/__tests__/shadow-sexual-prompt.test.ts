import { beforeEach, describe, expect, it, vi } from 'vitest';
import { filtersSchema, type Filters } from '$lib/shadow-sexual-prompt';

const { ch } = vi.hoisted(() => ({
  ch: {
    calls: [] as { query: string; query_params: Record<string, unknown> }[],
    respond: (_query: string): unknown[] => [],
  },
}));

vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({
    query: async (args: { query: string; query_params: Record<string, unknown> }) => {
      ch.calls.push(args);
      return { json: async () => ch.respond(args.query) };
    },
  }),
}));

const svc = await import('../shadow-sexual-prompt.service');

/**
 * ClickHouse is not available to this suite, so these pin the SQL each panel sends. The semantics the
 * shapes stand for (latest scan per image, negative-prompt fires excluded) were checked by running the
 * same builders over inline rows on a real ClickHouse; see the PR.
 */

const filters = (over: Partial<Filters> = {}): Filters => ({ ...filtersSchema.parse({}), ...over });

/** The dedup CTE, and the rest of the query around it. */
const parts = (query: string) => {
  const cte = svc.latestPerImage();
  expect(query.split(cte)).toHaveLength(2);
  expect(query).toContain('FROM latest');
  return { cte, outer: query.replace(cte, () => '') };
};

const panels = (f: Filters) => ({
  daily: svc.dailyCountsQuery(f),
  agreement: svc.agreementQuery(f),
  list: svc.wouldRaiseListQuery(f),
  count: svc.wouldRaiseCountQuery(f),
});

beforeEach(() => {
  ch.calls = [];
  ch.respond = () => [];
});

describe('one row per image', () => {
  it.each(Object.entries(panels(filters())))(
    '%s groups scans by image alone and takes the latest',
    (_name, { query }) => {
      const { cte } = parts(query);
      expect(cte).toContain(`FROM ${svc.SHADOW_TABLE}`);
      // Grouping by anything finer (workflow, prompt hash) counts a rescanned image once per scan.
      expect(cte).toMatch(/GROUP BY imageId\s*\)/);
      // Every column comes from ONE argMax, so a field and its verdict cannot come from different scans.
      expect(cte.match(/argMax\(/g)).toHaveLength(1);
      expect(cte).toMatch(
        /argMax\(tuple\(triggered, field, score, onSite, currentNsfwLevel, wouldNsfwLevel, wouldRaise\), \(scannedAt, workflowId\)\)/
      );
    }
  );

  it.each(Object.entries(panels(filters({ source: 'on', current: 'pg' }))))(
    '%s filters on the latest scan, never inside the dedup',
    (_name, { query }) => {
      // A filter inside the CTE picks the latest MATCHING scan, resurrecting an older verdict.
      const { cte } = parts(query);
      expect(cte).not.toMatch(/onSite = |has\(|wouldRaise = 1/);
      expect(cte).toContain(
        "WHERE toDate(scannedAt, 'UTC') > toDate(now(), 'UTC') - {days:UInt32}"
      );
    }
  );
});

describe('fires exclude the negative prompt', () => {
  it('defines a fire as triggered on a field other than the negative prompt', () => {
    expect(svc.FIRED).toBe(`(triggered = 1 AND field != 'Negative Prompt')`);
  });

  it('counts fires by day with that definition', () => {
    expect(svc.dailyCountsQuery(filters()).query).toContain(`countIf(${svc.FIRED}) AS fired`);
  });

  it('splits the agreement table on that definition, both ways', () => {
    const { query } = svc.agreementQuery(filters());
    expect(query).toContain(`countIf(${svc.FIRED}) AS fired`);
    expect(query).toContain(`countIf(NOT ${svc.FIRED}) AS notFired`);
  });
});

describe('filters', () => {
  it('defaults to fourteen days, every source, PG and PG-13, first page', () => {
    expect(filtersSchema.parse({})).toEqual({ days: 14, source: 'all', current: 'low', page: 1 });
  });

  it('degrades hand-edited junk to the defaults', () => {
    expect(filtersSchema.parse({ days: '13', source: 'x', current: 'r', page: '-2' })).toEqual(
      filtersSchema.parse({})
    );
  });

  it('lists only would-raise images at PG or PG-13 by default', () => {
    const { query, query_params } = svc.wouldRaiseListQuery(filters());
    const { outer } = parts(query);
    expect(outer).toContain('wouldRaise = 1');
    expect(outer).toContain('has({levels:Array(UInt8)}, currentNsfwLevel)');
    expect(query_params.levels).toEqual([1, 2]);
  });

  it.each([
    ['pg', [1]],
    ['pg13', [2]],
    ['unrated', [0]],
  ] as const)('narrows the list to %s', (current, levels) => {
    expect(svc.wouldRaiseListQuery(filters({ current })).query_params.levels).toEqual(levels);
    expect(svc.wouldRaiseCountQuery(filters({ current })).query_params.levels).toEqual(levels);
  });

  it('drops the level condition for any level', () => {
    const { query, query_params } = svc.wouldRaiseListQuery(filters({ current: 'all' }));
    expect(query).not.toContain('has(');
    expect(query_params).not.toHaveProperty('levels');
  });

  it.each([
    ['on', 1],
    ['off', 0],
  ] as const)('restricts every panel to %s-site images', (source, onSite) => {
    for (const { query, query_params } of Object.values(panels(filters({ source })))) {
      expect(parts(query).outer).toContain('onSite = {onSite:UInt8}');
      expect(query_params.onSite).toBe(onSite);
    }
  });

  it('reads every source when none is chosen', () => {
    for (const { query, query_params } of Object.values(panels(filters()))) {
      expect(query).not.toContain('onSite = ');
      expect(query_params).not.toHaveProperty('onSite');
    }
  });

  it('passes the window to every panel', () => {
    for (const { query_params } of Object.values(panels(filters({ days: 30 }))))
      expect(query_params.days).toBe(30);
  });

  it('pages the list without moving the count', () => {
    const third = filters({ page: 3 });
    expect(svc.wouldRaiseListQuery(third).query_params).toMatchObject({ limit: 50, offset: 100 });
    expect(svc.wouldRaiseCountQuery(third).query).not.toMatch(/LIMIT|OFFSET/);
  });
});

describe('fillDays', () => {
  const zero = { scanned: 0, fired: 0, raised: 0, raisedFromPg: 0, raisedFromPg13: 0 };

  it('returns every day in the window newest first, zero-filling the quiet ones', () => {
    const seen = {
      ...zero,
      raisedFromRPlus: 0,
      raisedFromUnrated: 0,
      day: '2026-11-01',
      scanned: 5,
    };
    const days = svc.fillDays([seen], 3, new Date('2026-11-02T23:59:00Z'));
    expect(days.map((d) => d.day)).toEqual(['2026-11-02', '2026-11-01', '2026-10-31']);
    expect(days[1]).toBe(seen);
    expect(days[0]).toMatchObject({ ...zero, day: '2026-11-02' });
  });
});

describe('row mapping', () => {
  it('turns quoted 64-bit values into numbers and the scan time into an ISO instant', async () => {
    ch.respond = (query) =>
      query.includes('count() AS total')
        ? [{ total: '120' }]
        : [
            {
              imageId: '9007199254',
              currentNsfwLevel: 1,
              wouldNsfwLevel: 4,
              score: 0.5,
              field: 'Positive Prompt',
              onSite: 0,
              scannedAt: '2026-11-02 08:15:00',
            },
          ];
    expect(await svc.getWouldRaise(filters())).toEqual({
      total: 120,
      rows: [
        {
          imageId: 9007199254,
          currentNsfwLevel: 1,
          wouldNsfwLevel: 4,
          score: 0.5,
          field: 'Positive Prompt',
          onSite: false,
          scannedAt: '2026-11-02T08:15:00Z',
        },
      ],
    });
  });

  it('reads daily counts as numbers', async () => {
    const today = new Date().toISOString().slice(0, 10);
    ch.respond = () => [
      {
        day: today,
        scanned: '7',
        fired: '3',
        raised: '2',
        raisedFromPg: '1',
        raisedFromPg13: '1',
        raisedFromRPlus: '0',
        raisedFromUnrated: '0',
      },
    ];
    const [first] = await svc.getDailyCounts(filters({ days: 7 }));
    expect(first).toEqual({
      day: today,
      scanned: 7,
      fired: 3,
      raised: 2,
      raisedFromPg: 1,
      raisedFromPg13: 1,
      raisedFromRPlus: 0,
      raisedFromUnrated: 0,
    });
  });
});
