import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ComicChapterRead.unread` is the row's soft delete — the platform's own comic metrics count a read as
 * `unread = false`. Creator Studio's comics panel counted every row, so an un-read chapter would still be
 * counted as read. Prod holds 0 such rows today, which is exactly why this needs a test rather than a look at
 * the screen: the defect is invisible until the first un-read and the numbers stay plausible afterwards.
 */

const state = vi.hoisted(() => ({ queries: [] as string[] }));

// The `sql` tag itself, so the query text is observable without standing up a Kysely executor. Interpolations
// come back as `?` rather than being dropped, so a predicate built out of a bound value stays visible.
vi.mock('@civitai/db/kysely', () => ({
  sql: (strings: TemplateStringsArray) => {
    state.queries.push(strings.join('?'));
    return { execute: async () => ({ rows: [] }) };
  },
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

// Narrow fakes rather than spreads of the real modules: `cache` builds a Redis client at import and
// `clickhouse` opens a connection, and this test asserts on a query string that neither participates in.
vi.mock('$lib/server/cache', () => ({
  createCache: <A, R>({ fetch }: { fetch: (args: A) => Promise<R> }) => ({ get: fetch }),
  createSysCache: <A, R>({ fetch }: { fetch: (args: A) => Promise<R> }) => ({ get: fetch }),
}));

vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({ $query: async () => [] }),
}));

const { getComics } = await import('../analytics');

/**
 * The comics panel's own query, identified by what it selects rather than by call order, with `--` comments
 * stripped. The stripping is load-bearing: the query is commented, and a comment mentioning the predicate
 * would satisfy every assertion below without the predicate existing.
 */
async function comicsQuery() {
  state.queries.length = 0;
  await getComics({ userId: 1818607, from: '2026-08-01', to: '2026-08-21' });
  const query = state.queries.find((q) => q.includes('"ComicProject"'));
  expect(query, 'the comics panel never issued its Postgres query').toBeDefined();
  return (query as string)
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Everything from the ComicChapterRead join up to the next clause. */
function readJoinClause(sql: string) {
  const match = sql.match(/LEFT JOIN "ComicChapterRead"[\s\S]*?(?=LEFT JOIN|WHERE|GROUP BY|$)/i);
  expect(match, 'the comics query no longer joins ComicChapterRead').not.toBeNull();
  return (match as RegExpMatchArray)[0];
}

describe('comics analytics excludes soft-deleted chapter reads', () => {
  beforeEach(() => {
    state.queries.length = 0;
  });

  it('filters the read rows on unread', async () => {
    expect(readJoinClause(await comicsQuery())).toMatch(/unread/i);
  });

  // `unread = true` would satisfy a bare /unread/ match while counting exactly the rows that must not count,
  // so the polarity is asserted separately from the presence of the predicate.
  it('keeps the rows that are NOT un-read', async () => {
    const clause = readJoinClause(await comicsQuery());
    expect(clause).toMatch(/"?unread"?\s*=\s*false|not\s+r?\.?"?unread"?/i);
    expect(clause).not.toMatch(/"?unread"?\s*=\s*true/i);
  });

  // In WHERE instead of ON, the predicate turns the LEFT JOIN inner and every comic nobody has read
  // disappears from the creator's list — a worse bug than the one being fixed.
  it('applies the filter on the join, not in WHERE', async () => {
    const sql = await comicsQuery();
    expect(sql).toMatch(/LEFT JOIN "ComicChapterRead"/i);

    // From the FROM clause on, so the aggregate's own `FILTER (WHERE ...)` — which sits in the select list,
    // above it — is not mistaken for the statement's WHERE. Both offsets are asserted before slicing:
    // `search` returns -1 on a miss and `slice(-1)` is the last CHARACTER, which no assertion can fail
    // against. A refactor scoping the creator through a CTE would land there and stop this guarding.
    const fromIndex = sql.search(/FROM "ComicProject"/i);
    expect(fromIndex, 'the comics query no longer selects FROM ComicProject').toBeGreaterThanOrEqual(0);

    const fromOnwards = sql.slice(fromIndex);
    const whereIndex = fromOnwards.search(/\bWHERE\b/i);
    expect(whereIndex, 'the comics query no longer has a statement WHERE').toBeGreaterThanOrEqual(0);

    expect(fromOnwards.slice(whereIndex)).not.toMatch(/unread/i);
  });
});
