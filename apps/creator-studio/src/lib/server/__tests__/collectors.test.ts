import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseKeysetCursor, REACTORS_PAGE_SIZE } from '../../analytics/reactors';

type Fragment = { strings: readonly string[]; values: unknown[] };
type Ident = { ident: string };
type Query = { text: string; params: unknown[] };

// Same stand-in for kysely's `sql` tag as reactors.test.ts: renders the query text and bound parameters so they
// are observable without a live database.
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
  sql.ref = (name: string): Ident => ({
    ident: name
      .split('.')
      .map((p) => `"${p}"`)
      .join('.'),
  });
  sql.lit = (value: number): Ident => ({ ident: String(value) });
  return { sql };
});

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { getCollectors, collectorsHandler } = await import('../collectors');

const OWNER = 42;
const STRANGER = 7;
const IMAGE = 9173928;

const row = (userId: number, extra: Record<string, unknown> = {}) => ({
  userId,
  createdAt: new Date('2026-09-01T12:00:00Z'),
  collections: 1,
  username: `u${userId}`,
  bannedAt: null,
  image: null,
  ...extra,
});

const isFollowProbe = (q: Query) => q.text.includes('"UserEngagement"');
const isTotal = (q: Query) => q.text.includes('count(DISTINCT c."userId")');
const pageQuery = () =>
  state.queries
    .filter((q) => !isFollowProbe(q) && !isTotal(q) && !q.text.startsWith('SELECT id'))
    .at(-1);

function database(rows: Record<string, unknown>[], total = rows.length, followers: number[] = []) {
  state.answer = (q) => {
    if (q.text.startsWith('SELECT id FROM "Image"')) {
      const [id, userId] = q.params;
      return id === IMAGE && userId === OWNER ? [{ id: IMAGE }] : [];
    }
    if (isTotal(q)) return [{ n: total }];
    if (isFollowProbe(q)) {
      const [, ids] = q.params as [number, number[]];
      return ids.filter((id) => followers.includes(id)).map((userId) => ({ userId }));
    }
    return rows;
  };
}

beforeEach(() => {
  state.queries.length = 0;
  database([row(30), row(20), row(10)]);
});

describe('getCollectors ownership', () => {
  it('refuses a caller who does not own the image, before reading any collection', async () => {
    expect(await getCollectors({} as never, STRANGER, 'image', IMAGE, null)).toBeNull();
    expect(state.queries).toHaveLength(1);
  });

  it('answers a non-owner with a 404 from the route', async () => {
    const GET = collectorsHandler('image', 'imageId');
    const call = GET({
      locals: { user: { id: STRANGER } },
      params: { imageId: String(IMAGE) },
      url: new URL('http://x/c'),
    } as never);
    await expect(call).rejects.toMatchObject({ status: 404 });
  });

  it.each(['abc', '0', '-1', '2147483648', ''])(
    'answers route id %j with a 400',
    async (imageId) => {
      const GET = collectorsHandler('image', 'imageId');
      const call = GET({
        locals: { user: { id: OWNER } },
        params: { imageId },
        url: new URL('http://x/c'),
      } as never);
      await expect(call).rejects.toMatchObject({ status: 400 });
      expect(state.queries).toHaveLength(0);
    }
  );

  it('answers a tampered cursor with a 400, not a 500', async () => {
    const GET = collectorsHandler('image', 'imageId');
    const call = GET({
      locals: { user: { id: OWNER } },
      params: { imageId: String(IMAGE) },
      url: new URL('http://x/c?after=2147483648'),
    } as never);
    await expect(call).rejects.toMatchObject({ status: 400 });
    expect(state.queries).toHaveLength(0);
  });
});

describe('getCollectors privacy', () => {
  // The count and the page share one predicate, so neither can name an owner the other hides.
  it.each(['total', 'page'] as const)(
    'limits the %s to accepted items in public collections of other, live accounts',
    async (which) => {
      await getCollectors({} as never, OWNER, 'image', IMAGE, null);
      const q = which === 'total' ? state.queries.find(isTotal) : pageQuery();
      expect(q?.text).toContain("ci.status = 'ACCEPTED'");
      expect(q?.text).toContain("c.read = 'Public'");
      expect(q?.text).toContain("c.availability = 'Public'");
      expect(q?.text).toContain('c."userId" <> ');
      expect(q?.text).toContain("c.mode IS DISTINCT FROM 'Contest'");
      expect(q?.text).toContain('ci."addedById" = c."userId"');
      expect(q?.text).toContain('o."deletedAt" IS NULL');
      expect(q?.params).toContain(OWNER);
    }
  );

  it('reads the item column of the entity asked about', async () => {
    database([row(1)]);
    state.answer = ((prev) => (q: Query) =>
      q.text.startsWith('SELECT id FROM "Article"') ? [{ id: 5 }] : prev(q))(state.answer);
    await getCollectors({} as never, OWNER, 'article', 5, null);
    expect(pageQuery()?.text).toContain('"ci"."articleId" = ');
    expect(pageQuery()?.text).not.toContain('"ci"."imageId"');
  });

  it('skips the page query when nobody qualifies', async () => {
    database([], 0);
    const page = await getCollectors({} as never, OWNER, 'image', IMAGE, null);
    expect(page).toEqual({ total: 0, collectors: [], next: null, prev: null });
    expect(state.queries).toHaveLength(2);
  });
});

describe('getCollectors page', () => {
  it('serves the owner newest account first, and marks followers', async () => {
    database([row(30), row(20, { collections: 3 }), row(10, { bannedAt: new Date() })], 3, [20]);
    const page = await getCollectors({} as never, OWNER, 'image', IMAGE, null);
    expect(page?.collectors.map((c) => [c.userId, c.follows, c.collections, c.banned])).toEqual([
      [30, false, 1, false],
      [20, true, 3, false],
      [10, false, 1, true],
    ]);
    expect(page?.total).toBe(3);
  });

  it('pages older accounts with userId < cursor, descending, without OFFSET', async () => {
    await getCollectors({} as never, OWNER, 'image', IMAGE, { dir: 'after', userId: 500 });
    const q = pageQuery();
    expect(q?.text).toContain('AND "c"."userId" < $');
    expect(q?.text).toMatch(/ORDER BY c\."userId" DESC LIMIT/);
    expect(q?.text).not.toMatch(/offset/i);
    expect(q?.params).toContain(500);
    expect(q?.params).toContain(REACTORS_PAGE_SIZE + 1);
  });

  it('pages newer accounts ascending and returns them newest first', async () => {
    database([row(501), row(502)], 9);
    const page = await getCollectors({} as never, OWNER, 'image', IMAGE, {
      dir: 'before',
      userId: 500,
    });
    expect(pageQuery()?.text).toContain('AND "c"."userId" > $');
    expect(pageQuery()?.text).toMatch(/ORDER BY c\."userId" ASC LIMIT/);
    expect(page?.collectors.map((c) => c.userId)).toEqual([502, 501]);
  });
});

describe('parseKeysetCursor', () => {
  const parse = (qs: string) => parseKeysetCursor(new URLSearchParams(qs));

  it.each([
    'after=abc',
    'after=0',
    'after=-5',
    'after=1e5',
    'after=2147483648',
    'before=',
    'after=5&before=9',
  ])('rejects %s', (qs) => expect(parse(qs).ok).toBe(false));

  it('reads a valid cursor, or none', () => {
    expect(parse('after=2947079')).toEqual({ ok: true, value: { dir: 'after', userId: 2947079 } });
    expect(parse('before=7')).toEqual({ ok: true, value: { dir: 'before', userId: 7 } });
    expect(parse('')).toEqual({ ok: true, value: null });
  });
});
