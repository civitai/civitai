import { describe, expect, it, vi } from 'vitest';

/**
 * The origin facet is a predicate over the `triggers` jsonb, which is an array on current rows and a
 * single object on rows from before the backfill. Asserted on the compiled SQL because the predicate
 * has to reach the list, the count and both facet reads, or the chips and the list disagree.
 */
const captured = vi.hoisted(() => [] as string[]);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(captured);
  return { dbRead: db, dbWrite: db };
});

const { getGenerationRestrictions, getRestrictionFacets, getRemixSources, ORIGIN_FILTERS } =
  await import('../user-restriction.service');

const emitted = async (run: () => Promise<unknown>) => {
  captured.length = 0;
  await run();
  return [...captured];
};

describe('origin filter', () => {
  it('restricts the list and its count to rows with a remix trigger', async () => {
    const sqls = await emitted(() =>
      getGenerationRestrictions({ page: 1, limit: 20, origin: 'remix' })
    );
    expect(sqls).toHaveLength(2);
    for (const sql of sqls) {
      expect(sql).toContain('jsonb_path_exists(ur."triggers", \'$.origin.remix\'::jsonpath)');
      expect(sql).toContain("'$[*] ? (!exists(@.origin.enhancer) && @.remixOfId > 0)'::jsonpath");
    }
  });

  it('restricts typed to prompt-only rows with a recorded origin and no remix or enhancer', async () => {
    const [list] = await emitted(() =>
      getGenerationRestrictions({ page: 1, limit: 20, origin: 'typed' })
    );
    expect(list).toContain(`'$[*] ? (@.prompt like_regex ".")'::jsonpath`);
    expect(list).toContain(
      `'$[*] ? (@.prompt like_regex "." && (!exists(@.origin) || @.origin == null))'::jsonpath`
    );
    expect(list).toMatch(
      /and not \(jsonb_path_exists\(ur\."triggers", '\$\[\*\] \? \(@\.prompt like_regex "." &&/
    );
    expect(list).toContain('$.origin.enhancer');
    expect(list).toContain('$.origin.remix');
  });

  it('keeps a trigger whose origin lookup was incomplete out of typed', async () => {
    const [list] = await emitted(() =>
      getGenerationRestrictions({ page: 1, limit: 20, origin: 'typed' })
    );
    expect(list).toContain(`'$[*] ? (@.origin.incomplete == true)'::jsonpath`);
    expect(list).toMatch(/and not \(.*@\.origin\.incomplete == true/s);
  });

  it('does not exclude incomplete rows from the remix filter', async () => {
    const [list] = await emitted(() =>
      getGenerationRestrictions({ page: 1, limit: 20, origin: 'remix' })
    );
    expect(list).not.toContain('incomplete');
  });

  it('restricts unchanged-remix to rows with a trigger whose remix prompt matched the source', async () => {
    const sqls = await emitted(() =>
      getGenerationRestrictions({ page: 1, limit: 20, origin: 'unchanged-remix' })
    );
    expect(sqls).toHaveLength(2);
    for (const sql of sqls)
      expect(sql).toContain(`'$[*] ? (@.origin.remix.promptMatch == "identical")'::jsonpath`);
  });

  it('accepts unchanged-remix as an origin filter value', () => {
    expect(ORIGIN_FILTERS).toEqual(['remix', 'typed', 'unchanged-remix']);
  });

  it('adds no origin predicate when none is asked for', async () => {
    const sqls = await emitted(() => getGenerationRestrictions({ page: 1, limit: 20 }));
    for (const sql of sqls) expect(sql).not.toContain('jsonb_path_exists');
  });
});

describe('facets', () => {
  it('counts statuses under the origin filter and origins under the status filter', async () => {
    const sqls = await emitted(() => getRestrictionFacets({ status: 'Pending', origin: 'remix' }));
    const byStatus = sqls.find((s) => s.includes('group by "ur"."status"'))!;
    const byOrigin = sqls.find((s) => s.includes('filter (where'))!;

    expect(byStatus).toContain('$.origin.remix');
    expect(byStatus).not.toContain('"ur"."status" =');
    expect(byOrigin).toContain('"ur"."status" =');
    expect(byOrigin).toContain('count(*) filter (where');
    expect(byOrigin).not.toContain('group by');
  });

  it('counts unchanged remixes in the origin facet', async () => {
    const sqls = await emitted(() => getRestrictionFacets({}));
    const byOrigin = sqls.find((s) => s.includes('filter (where'))!;
    expect(byOrigin).toContain('"unchangedRemix"');
    expect(byOrigin).toContain('@.origin.remix.promptMatch == "identical"');
  });

  it('counts types under the status and origin filters, ignoring the type filter itself', async () => {
    const sqls = await emitted(() =>
      getRestrictionFacets({ type: 'generation', status: 'Pending', origin: 'remix', userId: 4 })
    );
    expect(sqls).toHaveLength(3);
    const byType = sqls.find((s) => s.includes('group by "ur"."type"'))!;

    expect(byType).toContain('"ur"."status" =');
    expect(byType).toContain('$.origin.remix');
    expect(byType).toContain('"ur"."userId" =');
    expect(byType).not.toContain('"ur"."type" =');
  });

  it('returns zeros for an empty queue', async () => {
    expect(await getRestrictionFacets({})).toEqual({
      status: { any: 0, Pending: 0, Upheld: 0, Overturned: 0 },
      origin: { all: 0, remix: 0, typed: 0, 'unchanged-remix': 0 },
      type: { generation: 0, 'bot-account': 0, scam: 0 },
    });
  });
});

describe('remix sources', () => {
  it('reads nothing for no ids', async () => {
    expect(await emitted(() => getRemixSources([]))).toEqual([]);
  });

  it('reads the stored prompt out of the image meta', async () => {
    const [sql] = await emitted(() => getRemixSources([5]));
    expect(sql).toContain(`i."meta" ->> 'prompt'`);
    expect(sql).toContain('"i"."id" in ($1)');
  });
});
