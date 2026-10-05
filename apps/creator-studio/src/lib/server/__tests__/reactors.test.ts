import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assembleReactorPage,
  parseReactorQuery,
  REACTORS_PAGE_SIZE,
  type ReactorQuery,
} from '../../analytics/reactors';

type Fragment = { strings: readonly string[]; values: unknown[] };
type Ident = { ident: string };
type Query = { text: string; params: unknown[] };

// A stand-in for kysely's `sql` tag that renders nested fragments and identifiers the way Postgres receives
// them, so each query's text and bound parameters are observable without a live database.
const state = vi.hoisted(() => ({
  queries: [] as Query[],
  answer: (_q: Query): Record<string, unknown>[] => [],
}));

vi.mock('@civitai/db/kysely', () => {
  const render = (f: Fragment, params: unknown[]): string =>
    f.strings.reduce((out, s, i) => {
      if (i === f.values.length) return out + s;
      const v = f.values[i];
      if (v && typeof v === 'object' && 'ident' in v) return out + s + (v as Ident).ident;
      if (v && typeof v === 'object' && 'strings' in v)
        return out + s + render(v as Fragment, params);
      params.push(v);
      return `${out}${s}$${params.length}`;
    }, '');
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const frag: Fragment & { execute: () => Promise<{ rows: unknown[] }> } = {
      strings,
      values,
      execute: async () => {
        const params: unknown[] = [];
        const q = { text: render(frag, params).replace(/\s+/g, ' ').trim(), params };
        state.queries.push(q);
        return { rows: state.answer(q) };
      },
    };
    return frag;
  };
  sql.table = (name: string): Ident => ({ ident: `"${name}"` });
  sql.ref = (name: string): Ident => ({ ident: `"${name}"` });
  sql.lit = (value: number): Ident => ({ ident: String(value) });
  return { sql };
});

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { getReactors, reactorsHandler } = await import('../reactors');

const OWNER = 42;
const STRANGER = 7;
const IMAGE = 9173928;

const reactorRow = (userId: number, extra: Record<string, unknown> = {}) => ({
  userId,
  createdAt: new Date('2026-09-01T12:00:00Z'),
  username: `u${userId}`,
  deletedAt: null,
  bannedAt: null,
  image: null,
  ...extra,
});

const isFollowProbe = (q: Query) => q.text.includes('"UserEngagement"');

/**
 * Answers like Postgres over one image owned by OWNER, with `reactors` as the page query's rows and `followers`
 * as the users who follow OWNER.
 */
function database(
  reactors: Record<string, unknown>[],
  counts: Record<string, number> = { Like: 3, Laugh: 1 },
  followers: number[] = []
) {
  state.answer = (q) => {
    if (q.text.startsWith('SELECT id FROM "Image"')) {
      const [id, userId] = q.params;
      return id === IMAGE && userId === OWNER ? [{ id: IMAGE }] : [];
    }
    if (q.text.includes('count(*)'))
      return Object.entries(counts).map(([reaction, n]) => ({ reaction, n }));
    if (isFollowProbe(q)) {
      const [target, ids] = q.params as [number, number[]];
      return target === OWNER
        ? ids.filter((id) => followers.includes(id)).map((userId) => ({ userId }))
        : [];
    }
    return reactors;
  };
}

const pageQuery = () => state.queries.filter((q) => !isFollowProbe(q)).at(-1);

const firstPage: ReactorQuery = { reaction: null, cursor: null };

beforeEach(() => {
  state.queries.length = 0;
  database([reactorRow(30), reactorRow(20), reactorRow(10)]);
});

describe('getReactors ownership', () => {
  it('refuses a caller who does not own the image, before reading a single reaction', async () => {
    expect(await getReactors({} as never, STRANGER, 'image', IMAGE, firstPage)).toBeNull();
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0].params).toEqual([IMAGE, STRANGER]);
  });

  it('serves the owner', async () => {
    const page = await getReactors({} as never, OWNER, 'image', IMAGE, firstPage);
    expect(page?.reactors.map((r) => r.userId)).toEqual([30, 20, 10]);
  });

  it('checks ownership against the article table for an article', async () => {
    await getReactors({} as never, STRANGER, 'article', 5, firstPage);
    expect(state.queries[0].text).toMatch(
      /^SELECT id FROM "Article" WHERE id = \$1 AND "userId" = \$2$/
    );
  });

  it('answers a non-owner with a 404 from the route, the same as a missing entity', async () => {
    const GET = reactorsHandler('image', 'imageId');
    const call = GET({
      locals: { user: { id: STRANGER } },
      params: { imageId: String(IMAGE) },
      url: new URL(`http://x/analytics/content/image/${IMAGE}/reactors`),
    } as never);
    await expect(call).rejects.toMatchObject({ status: 404 });
  });
});

describe('getReactors page', () => {
  it('opens on the first reaction type anyone used when none is named', async () => {
    database([reactorRow(1)], { Laugh: 2, Cry: 1 });
    const page = await getReactors({} as never, OWNER, 'image', IMAGE, firstPage);
    expect(page?.reaction).toBe('Laugh');
    expect(pageQuery()?.params).toContain('Laugh');
  });

  it('drops Dislike from the counts', async () => {
    database([], { Like: 2, Dislike: 9 });
    const page = await getReactors({} as never, OWNER, 'image', IMAGE, firstPage);
    expect(page?.counts).toEqual({ Like: 2, Heart: 0, Laugh: 0, Cry: 0 });
  });

  it('does not run the page query for a type nobody used', async () => {
    const page = await getReactors({} as never, OWNER, 'image', IMAGE, {
      reaction: 'Cry',
      cursor: null,
    });
    expect(page?.reactors).toEqual([]);
    expect(state.queries).toHaveLength(2);
  });

  it('shows a deleted reactor without their name or picture, and flags a banned one', async () => {
    database([
      reactorRow(3, { deletedAt: new Date(), username: 'gone', image: 'abc' }),
      reactorRow(2, { bannedAt: new Date() }),
    ]);
    const page = await getReactors({} as never, OWNER, 'image', IMAGE, firstPage);
    expect(page?.reactors[0]).toMatchObject({ deleted: true, username: null, image: null });
    expect(page?.reactors[1]).toMatchObject({ deleted: false, banned: true, username: 'u2' });
  });

  it('pages older accounts with userId < cursor, descending', async () => {
    await getReactors({} as never, OWNER, 'image', IMAGE, {
      reaction: 'Like',
      cursor: { dir: 'after', userId: 500 },
    });
    const q = pageQuery();
    expect(q?.text).toContain('AND "userId" < $3 ORDER BY "userId" DESC LIMIT $4');
    expect(q?.params).toEqual([IMAGE, 'Like', 500, REACTORS_PAGE_SIZE + 1]);
  });

  it('pages newer accounts with userId > cursor, ascending', async () => {
    database([reactorRow(501), reactorRow(502)]);
    const page = await getReactors({} as never, OWNER, 'image', IMAGE, {
      reaction: 'Like',
      cursor: { dir: 'before', userId: 500 },
    });
    expect(pageQuery()?.text).toContain('AND "userId" > $3 ORDER BY "userId" ASC LIMIT $4');
    expect(page?.reactors.map((r) => r.userId)).toEqual([502, 501]);
  });

  // The outer sort is what assembleReactorPage's slice relies on: the joins may return rows in any order, and
  // without it the wrong row is dropped as the "+1".
  it('orders the joined rows in the fetch direction, not only the inner scan', async () => {
    for (const [cursor, dir] of [
      [null, 'DESC'],
      [{ dir: 'after', userId: 500 }, 'DESC'],
      [{ dir: 'before', userId: 500 }, 'ASC'],
    ] as const) {
      await getReactors({} as never, OWNER, 'image', IMAGE, { reaction: 'Like', cursor });
      expect(pageQuery()?.text).toMatch(
        new RegExp(String.raw`\) r .* ORDER BY r\."userId" ${dir}$`)
      );
    }
  });

  it('never pages with OFFSET', async () => {
    await getReactors({} as never, OWNER, 'image', IMAGE, {
      reaction: 'Like',
      cursor: { dir: 'after', userId: 500 },
    });
    expect(pageQuery()?.text).not.toMatch(/offset/i);
  });
});

describe('getReactors follows', () => {
  // One keyset fetch: PAGE_SIZE + 1 ids stepping from `from`, in the fetch's own order.
  const fetched = (from: number, step: -1 | 1) =>
    Array.from({ length: REACTORS_PAGE_SIZE + 1 }, (_, i) => from + i * step);
  const probe = () => {
    const probes = state.queries.filter(isFollowProbe);
    expect(probes).toHaveLength(1);
    return probes[0].params as [number, number[]];
  };

  it('marks the reactors who follow the owner, and only them', async () => {
    database([reactorRow(30), reactorRow(20), reactorRow(10)], undefined, [20]);
    const page = await getReactors({} as never, OWNER, 'image', IMAGE, firstPage);
    expect(page?.reactors.map((r) => [r.userId, r.follows])).toEqual([
      [30, false],
      [20, true],
      [10, false],
    ]);
  });

  it('asks about follows of the owner, not of the reactor', async () => {
    database([reactorRow(30)], undefined, [30]);
    await getReactors({} as never, OWNER, 'image', IMAGE, firstPage);
    expect(probe()[0]).toBe(OWNER);
    expect(state.queries.find(isFollowProbe)?.text).toMatch(
      /WHERE "targetUserId" = \$1 AND "type" = 'Follow' AND "userId" = ANY\(\$2\)$/
    );
  });

  // The probe is one pkey lookup per id, so its cost stays flat only while it is handed the shown page and never
  // the reaction list; a deep page is where a widening would cost the most.
  it.each([
    ['the first page', null, fetched(1000, -1)],
    ['a deep page', { dir: 'after', userId: 40_001 } as const, fetched(40_000, -1)],
    [
      'a page back towards newer accounts',
      { dir: 'before', userId: 39_999 } as const,
      fetched(40_000, 1),
    ],
  ])('probes only the rows %s shows, never the look-ahead row', async (_, cursor, ids) => {
    database(ids.map((id) => reactorRow(id)));
    const page = await getReactors({} as never, OWNER, 'image', IMAGE, {
      reaction: 'Like',
      cursor,
    });
    const shown = page?.reactors.map((r) => r.userId) ?? [];
    expect(shown).toHaveLength(REACTORS_PAGE_SIZE);
    expect(shown).not.toContain(ids.at(-1));
    expect(probe()[1]).toEqual(shown);
  });

  it('does not probe the owner or a deleted account, and never marks them', async () => {
    database(
      [reactorRow(OWNER), reactorRow(20, { deletedAt: new Date() }), reactorRow(10)],
      undefined,
      [OWNER, 20, 10]
    );
    const page = await getReactors({} as never, OWNER, 'image', IMAGE, firstPage);
    expect(probe()[1]).toEqual([10]);
    expect(page?.reactors.map((r) => r.follows)).toEqual([false, false, true]);
  });
});

describe('parseReactorQuery', () => {
  const parse = (qs: string) => parseReactorQuery(new URLSearchParams(qs));

  it.each([
    'reaction=Like&after=abc',
    'reaction=Like&after=-5',
    'reaction=Like&after=0',
    'reaction=Like&after=1e5',
    'reaction=Like&after=12.5',
    'reaction=Like&after=2147483648',
    'reaction=Like&after=99999999999999999999',
    'reaction=Like&before=',
    'reaction=Like&after=5&before=9',
    'after=5',
    'reaction=Dislike',
    'reaction=like',
    "reaction=Like';--",
  ])('rejects %s instead of passing it to Postgres', (qs) => {
    expect(parse(qs).ok).toBe(false);
  });

  it('reads a valid cursor', () => {
    expect(parse('reaction=Laugh&after=2947079')).toEqual({
      ok: true,
      value: { reaction: 'Laugh', cursor: { dir: 'after', userId: 2947079 } },
    });
    expect(parse('reaction=Cry&before=2147483647')).toEqual({
      ok: true,
      value: { reaction: 'Cry', cursor: { dir: 'before', userId: 2147483647 } },
    });
    expect(parse('')).toEqual({ ok: true, value: { reaction: null, cursor: null } });
  });

  it.each(['abc', '0', '-1', '2147483648', '1e400', ''])(
    'answers route id %j with a 400 before any query',
    async (imageId) => {
      const GET = reactorsHandler('image', 'imageId');
      const call = GET({
        locals: { user: { id: OWNER } },
        params: { imageId },
        url: new URL('http://x/r'),
      } as never);
      await expect(call).rejects.toMatchObject({ status: 400 });
      expect(state.queries).toHaveLength(0);
    }
  );

  it('answers a tampered cursor with a 400 from the route, not a 500', async () => {
    const GET = reactorsHandler('image', 'imageId');
    const call = GET({
      locals: { user: { id: OWNER } },
      params: { imageId: String(IMAGE) },
      url: new URL(`http://x/r?reaction=Like&after=2147483648`),
    } as never);
    await expect(call).rejects.toMatchObject({ status: 400 });
    expect(state.queries).toHaveLength(0);
  });
});

describe('assembleReactorPage', () => {
  const ids = (from: number, n: number, step: number) =>
    Array.from({ length: n }, (_, i) => ({ userId: from + i * step }));

  it('first page: a full extra row means there is a next page, and there is no previous one', () => {
    const page = assembleReactorPage(ids(1000, REACTORS_PAGE_SIZE + 1, -1), null);
    expect(page.rows).toHaveLength(REACTORS_PAGE_SIZE);
    expect(page.next).toBe(1000 - (REACTORS_PAGE_SIZE - 1));
    expect(page.prev).toBeNull();
  });

  it('last page: no next', () => {
    const page = assembleReactorPage(ids(1000, 3, -1), { dir: 'after', userId: 1001 });
    expect(page.next).toBeNull();
    expect(page.prev).toBe(1000);
  });

  it('previous page: flips ascending rows back to newest first', () => {
    const page = assembleReactorPage(ids(1001, REACTORS_PAGE_SIZE + 1, 1), {
      dir: 'before',
      userId: 1000,
    });
    expect(page.rows[0].userId).toBe(1000 + REACTORS_PAGE_SIZE);
    expect(page.rows.at(-1)?.userId).toBe(1001);
    expect(page.prev).toBe(1000 + REACTORS_PAGE_SIZE);
    expect(page.next).toBe(1001);
  });

  it('previous page that reaches the newest account: no previous', () => {
    const page = assembleReactorPage(ids(1001, 4, 1), { dir: 'before', userId: 1000 });
    expect(page.prev).toBeNull();
    expect(page.rows.map((r) => r.userId)).toEqual([1004, 1003, 1002, 1001]);
  });

  it('an emptied page past the end offers no further paging', () => {
    expect(assembleReactorPage([], { dir: 'after', userId: 1 })).toEqual({
      rows: [],
      next: null,
      prev: null,
    });
  });
});
