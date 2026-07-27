import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * `oauthClient.searchForModerator` — the moderator-only global OAuth-client search
 * that backs the App-Blocks external-submit mod picker.
 *
 * Drives the REAL `oauthClientRouter` via `createCaller` so the `moderatorProcedure`
 * middleware (the mod gate) is exercised, not mocked. `dbRead`/`dbWrite` are mocked so
 * importing the router never drags in the generated Prisma client; the `findMany` mock
 * both RECORDS the `where`/`select`/`orderBy`/`take`/`cursor` the router builds (so we
 * can assert the query shape a mocked DB can't otherwise prove) AND serves a fixed,
 * pre-sorted dataset honoring keyset pagination for the two-page test.
 */

const APP_BLOCK_EXCLUDE = { NOT: { id: { startsWith: 'appblk-' } } };

type Row = {
  id: string;
  name: string;
  allowedScopes: number;
  logoUrl: string | null;
  isConfidential: boolean;
  isVerified: boolean;
  createdAt: Date;
  user: { id: number; username: string | null } | null;
};

const mocks = vi.hoisted(() => ({
  // Pre-sorted (createdAt desc, id asc) dataset the findMany mock slices by take+cursor.
  dataset: [] as Row[],
  findMany: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { oauthClient: { findMany: mocks.findMany } },
  dbWrite: { oauthClient: {}, apiKey: {} },
}));
// The router imports this at module load for the (unrelated) delete path — stub it so
// importing the router doesn't reach the orchestrator client.
vi.mock('~/server/services/orchestrator/civitai', () => ({
  invalidateCivitaiUser: vi.fn(async () => undefined),
}));

import { oauthClientRouter } from '../oauth-client.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

const mod = { id: 1, isModerator: true, tier: 'free', username: 'mod', onboarding: 0x1f };
const nonMod = { id: 3, isModerator: false, tier: 'free', username: 'user', onboarding: 0x1f };

function row(over: Partial<Row> & { id: string }): Row {
  return {
    name: 'Client',
    allowedScopes: 1,
    logoUrl: null,
    isConfidential: true,
    isVerified: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    user: { id: 1, username: 'mod' },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dataset = [];
  // Default: slice the dataset honoring Prisma's INCLUSIVE cursor + `take`, so the
  // pagination test gets a faithful two-page seek. Arg-assertion tests ignore the
  // return value.
  mocks.findMany.mockImplementation(async (args: any) => {
    const all = mocks.dataset;
    const take: number = args?.take ?? all.length;
    const startId: string | undefined = args?.cursor?.id;
    const idx = startId ? all.findIndex((r) => r.id === startId) : 0;
    const from = idx < 0 ? 0 : idx;
    return all.slice(from, from + take);
  });
});

describe('oauthClient.searchForModerator — mod gate', () => {
  it('non-moderator caller → FORBIDDEN, DB never queried', async () => {
    const caller = oauthClientRouter.createCaller(fakeCtx(nonMod) as never);
    await expect(caller.searchForModerator({})).rejects.toBeInstanceOf(TRPCError);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('anonymous caller → UNAUTHORIZED/FORBIDDEN, DB never queried', async () => {
    const caller = oauthClientRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.searchForModerator({})).rejects.toBeInstanceOf(TRPCError);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});

describe('oauthClient.searchForModerator — where construction', () => {
  it('empty query → the CALLER’s own clients only (userId + app-block exclude, no OR)', async () => {
    const caller = oauthClientRouter.createCaller(fakeCtx(mod) as never);
    await caller.searchForModerator({});
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ AND: [{ userId: mod.id }, APP_BLOCK_EXCLUDE] });
  });

  it('non-empty query → matches client name (case-insensitive ILIKE)', async () => {
    const caller = oauthClientRouter.createCaller(fakeCtx(mod) as never);
    await caller.searchForModerator({ query: 'Cool' });
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.AND[1]).toEqual(APP_BLOCK_EXCLUDE);
    expect(where.AND[0].OR).toContainEqual({ name: { contains: 'Cool', mode: 'insensitive' } });
  });

  it('non-empty query → matches owner username (case-insensitive ILIKE)', async () => {
    const caller = oauthClientRouter.createCaller(fakeCtx(mod) as never);
    await caller.searchForModerator({ query: 'alice' });
    const or = mocks.findMany.mock.calls[0][0].where.AND[0].OR;
    expect(or).toContainEqual({ user: { username: { contains: 'alice', mode: 'insensitive' } } });
  });

  it('numeric query → matches owner id exactly (in addition to the ILIKE clauses)', async () => {
    const caller = oauthClientRouter.createCaller(fakeCtx(mod) as never);
    await caller.searchForModerator({ query: '42' });
    const or = mocks.findMany.mock.calls[0][0].where.AND[0].OR;
    expect(or).toContainEqual({ userId: 42 });
    // still an ILIKE name/username match too
    expect(or).toContainEqual({ name: { contains: '42', mode: 'insensitive' } });
  });

  it('non-numeric query → NO owner-id clause', async () => {
    const caller = oauthClientRouter.createCaller(fakeCtx(mod) as never);
    await caller.searchForModerator({ query: 'alice' });
    const or: any[] = mocks.findMany.mock.calls[0][0].where.AND[0].OR;
    expect(or.some((c) => 'userId' in c)).toBe(false);
  });

  it('all-digits query beyond int32 → NO owner-id clause (avoids Postgres int4 overflow 500)', async () => {
    const caller = oauthClientRouter.createCaller(fakeCtx(mod) as never);
    await caller.searchForModerator({ query: '9999999999' });
    const or: any[] = mocks.findMany.mock.calls[0][0].where.AND[0].OR;
    // out-of-range int → only the ILIKE name/username clauses, no `userId` (which would overflow int4)
    expect(or.some((c) => 'userId' in c)).toBe(false);
    expect(or).toContainEqual({ name: { contains: '9999999999', mode: 'insensitive' } });
  });

  it('ALWAYS excludes App-Block (appblk-*) clients at the DB level, even with a query', async () => {
    const caller = oauthClientRouter.createCaller(fakeCtx(mod) as never);
    await caller.searchForModerator({ query: 'appblk' });
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.AND).toContainEqual(APP_BLOCK_EXCLUDE);
  });
});

describe('oauthClient.searchForModerator — projection & ordering', () => {
  it('selects ONLY safe fields (user:{id,username}) and NEVER the secret', async () => {
    const caller = oauthClientRouter.createCaller(fakeCtx(mod) as never);
    await caller.searchForModerator({ query: 'x' });
    const args = mocks.findMany.mock.calls[0][0];
    expect(args.select).toEqual({
      id: true,
      name: true,
      allowedScopes: true,
      logoUrl: true,
      isConfidential: true,
      isVerified: true,
      createdAt: true,
      user: { select: { id: true, username: true } },
    });
    // Belt-and-suspenders: no credential field is ever requested.
    expect(args.select).not.toHaveProperty('secret');
    expect(args.select.user.select).not.toHaveProperty('secret');
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
  });
});

describe('oauthClient.searchForModerator — keyset pagination', () => {
  it('second page via nextCursor returns the next batch with NO overlap', async () => {
    // 5 clients, page size 2. Page 1 → [c0,c1] + nextCursor; page 2 → [c2,c3].
    mocks.dataset = [0, 1, 2, 3, 4].map((i) =>
      row({ id: `c${i}`, name: `App ${i}`, createdAt: new Date(2026, 0, 5 - i) })
    );
    const caller = oauthClientRouter.createCaller(fakeCtx(mod) as never);

    const page1 = await caller.searchForModerator({ query: 'App', limit: 2 });
    expect(page1.items.map((r) => r.id)).toEqual(['c0', 'c1']);
    expect(page1.nextCursor).toBe('c2');

    const page2 = await caller.searchForModerator({
      query: 'App',
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((r) => r.id)).toEqual(['c2', 'c3']);

    const page1Ids = new Set(page1.items.map((r) => r.id));
    for (const r of page2.items) expect(page1Ids.has(r.id)).toBe(false);
  });

  it('a final short page returns no nextCursor', async () => {
    mocks.dataset = [row({ id: 'only', name: 'App only' })];
    const caller = oauthClientRouter.createCaller(fakeCtx(mod) as never);
    const res = await caller.searchForModerator({ query: 'App', limit: 20 });
    expect(res.items.map((r) => r.id)).toEqual(['only']);
    expect(res.nextCursor).toBeUndefined();
  });
});
