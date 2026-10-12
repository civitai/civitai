import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import type { Context } from '~/server/createContext';
import type * as TesterSegment from '~/server/flipt/tester-segment';
import type * as HomeBlockCache from '~/server/services/home-block-cache.service';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import {
  BIRTHDAY_2026_PREVIEW_FROM,
  BIRTHDAY_2026_STARTS_AT,
} from '~/shared/constants/birthday2026.constants';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

/**
 * A home block with `metadata.featureFlag` (or of type Event) must reach only the viewers it is
 * for, on every path a row is read through, and must never sit in a cache another viewer reads.
 *
 * Driven through the real controller and service over an in-memory HomeBlock table. The flag
 * evaluation (`isFlagOnFor`, `getEventAccess`) is real; only the Flipt answers are faked.
 */

const FLIPT_KEY = 'birthday-2026'; // featureFlags.birthday2026.fliptKey

const state = vi.hoisted(() => ({
  flags: new Map<string, { public: boolean; testers: Set<number> }>(),
  // fetchThroughCache: shared across viewers, like the Redis entry it stands in for.
  shared: new Map<string, unknown>(),
  // getHomeBlockCached: the shared by-id entry, keyed without a user like the real one.
  rendered: new Map<string, unknown>(),
  renderedCalls: [] as { id: number; hit: boolean }[],
}));

vi.mock('~/server/flipt/tester-segment', async (importOriginal) => ({
  ...(await importOriginal<typeof TesterSegment>()),
  isFliptOnForTesters: async (flag: string, user: { id?: number; isModerator?: boolean }) => {
    if (user.isModerator) return true;
    const f = state.flags.get(flag);
    return !!f && (f.public || (!!user.id && f.testers.has(user.id)));
  },
  isFliptPublic: async (flag: string) => !!state.flags.get(flag)?.public,
  isFliptFlagReadable: async (flag: string) => state.flags.has(flag),
}));

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: async (key: string, fetcher: () => Promise<unknown>) => {
    if (!state.shared.has(key)) state.shared.set(key, await fetcher());
    return state.shared.get(key);
  },
}));

vi.mock('~/server/services/home-block-cache.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockCache>()),
  getHomeBlockCached: vi.fn(
    async (block: { id: number; type: string; sourceId?: number | null }, _d, metadata) => {
      const key = `${block.type}:${block.sourceId ?? block.id}`;
      const hit = state.rendered.has(key);
      if (!hit) state.rendered.set(key, { ...block, metadata, items: ['rendered'] });
      state.renderedCalls.push({ id: block.id, hit });
      return { ...(state.rendered.get(key) as object), ...block, metadata };
    }
  ),
}));

const { getHomeBlocksHandler, getSystemHomeBlocksHandler, getHomeBlocksByIdHandler } = await import(
  '~/server/controllers/home-block.controller'
);
const { createHomeBlockAdmin, setHomeBlocksOrder, updateHomeBlockAdmin, upsertHomeBlock } =
  await import('~/server/services/home-block.service');
const { getHomeBlockCached } = await import('~/server/services/home-block-cache.service');
const { REDIS_KEYS } = await import('~/server/redis/client');

type Row = {
  id: number;
  type: HomeBlockType;
  userId: number;
  sourceId: number | null;
  index: number;
  permanent: boolean;
  metadata: Record<string, unknown>;
};

const sys = (over: Partial<Row> & Pick<Row, 'id'>): Row => ({
  type: HomeBlockType.Collection,
  userId: -1,
  sourceId: null,
  index: over.id,
  permanent: false,
  metadata: { collection: { id: over.id * 10 } },
  ...over,
});
const clone = (id: number, userId: number, source: Row): Row => ({
  id,
  type: source.type,
  userId,
  sourceId: source.id,
  index: source.index + 1,
  permanent: false,
  metadata: {},
});

const OPEN = sys({ id: 1 });
const GATED = sys({ id: 2, metadata: { collection: { id: 20 }, featureFlag: 'birthday2026' } });
const GATED_PERMANENT = sys({
  id: 3,
  permanent: true,
  metadata: { collection: { id: 30 }, featureFlag: 'birthday2026' },
});
const OPEN_PERMANENT = sys({ id: 4, permanent: true });
const EVENT = sys({
  id: 5,
  type: HomeBlockType.Event,
  permanent: true,
  metadata: { event: 'birthday2026', featureFlag: 'birthday2026' },
});
const UNKNOWN_FLAG = sys({ id: 6, metadata: { collection: { id: 60 }, featureFlag: 'not-a-key' } });

const ANON = undefined;
const TESTER = { id: 10 };
const TESTER_2 = { id: 11 };
const STRANGER = { id: 20 };
const MOD = { id: 30, isModerator: true };

let rows: Row[] = [];

function matches(r: Row, where: Record<string, any> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (k === 'OR') return (v as Record<string, any>[]).some((w) => matches(r, w));
    if (k === 'source') {
      const src = rows.find((x) => x.id === r.sourceId);
      return !!src && matches(src, v);
    }
    if (k === 'id' && v !== null && typeof v === 'object') {
      if ('in' in v) return (v.in as number[]).includes(r.id);
      if ('not' in v) return v.not?.in ? !v.not.in.includes(r.id) : r.id !== v.not;
    }
    return (r as Record<string, unknown>)[k] === v;
  });
}

function seed(...table: Row[]) {
  rows = table;
  dbMock.dbRead.homeBlock.findMany.mockImplementation(async (args: any) =>
    rows.filter((r) => matches(r, args?.where)).sort((a, b) => a.index - b.index)
  );
  dbMock.dbRead.homeBlock.findUnique.mockImplementation(
    async (args: any) => rows.find((r) => r.id === args?.where?.id) ?? null
  );
  dbMock.dbRead.homeBlock.findFirst.mockImplementation(
    async (args: any) => rows.find((r) => matches(r, args?.where)) ?? null
  );
  dbMock.dbRead.homeBlock.findUniqueOrThrow.mockImplementation(async (args: any) => {
    const r = rows.find((x) => x.id === args.where.id);
    if (!r) throw new Error('No HomeBlock found');
    return r;
  });
  // userHasCustomHomeBlocks: `... WHERE hb."userId"=${userId}`
  dbMock.dbRead.$queryRaw.mockImplementation(async (_s: unknown, userId: number) => [
    { exists: rows.some((r) => r.userId === userId) },
  ]);
}

const setFlag = (opts: { public?: boolean; testers?: number[] }) =>
  state.flags.set(FLIPT_KEY, {
    public: !!opts.public,
    testers: new Set(opts.testers ?? [TESTER.id, TESTER_2.id]),
  });

const ctxFor = (user?: { id: number; isModerator?: boolean }) =>
  ({
    user,
    cache: { skip: false, canCache: true, edgeTTL: 60, browserTTL: 60 },
  } as unknown as Context);

// Sorted: which rows a viewer gets is the subject, not their order.
const ids = (blocks: { id: number }[]) => blocks.map((b) => b.id).sort((a, b) => a - b);

const listIds = async (user?: { id: number; isModerator?: boolean }, input = {}) =>
  ids(await getHomeBlocksHandler({ ctx: ctxFor(user), input }));

const systemIds = async (user?: { id: number; isModerator?: boolean }) =>
  ids(await getSystemHomeBlocksHandler({ ctx: ctxFor(user), input: {} }));

beforeEach(() => {
  vi.clearAllMocks();
  state.flags.clear();
  state.shared.clear();
  state.rendered.clear();
  state.renderedCalls.length = 0;
  setFlag({ public: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('T1: the anonymous list is the unflagged list', () => {
  it('drops a gated row for an anonymous viewer while its flag is not public', async () => {
    seed(OPEN, GATED, GATED_PERMANENT, OPEN_PERMANENT);
    expect(await listIds(ANON)).toEqual([OPEN.id, OPEN_PERMANENT.id]);
  });

  it('control: the same rows reach an anonymous viewer once the flag is public, and a tester now', async () => {
    seed(OPEN, GATED, GATED_PERMANENT, OPEN_PERMANENT);
    expect(await listIds(TESTER)).toEqual([
      OPEN.id,
      GATED.id,
      GATED_PERMANENT.id,
      OPEN_PERMANENT.id,
    ]);
    setFlag({ public: true });
    expect(await listIds(ANON)).toEqual([OPEN.id, GATED.id, GATED_PERMANENT.id, OPEN_PERMANENT.id]);
  });
});

describe('T2: a tester warming the shared permanent-block cache', () => {
  const table = () => [
    OPEN,
    GATED_PERMANENT,
    OPEN_PERMANENT,
    clone(100, TESTER.id, OPEN),
    clone(101, STRANGER.id, OPEN),
  ];

  it('does not hand the gated permanent row to the next viewer', async () => {
    seed(...table());
    expect(await listIds(TESTER)).toContain(GATED_PERMANENT.id);
    // The shared entry holds the row unfiltered: that is what makes the next two reads a test.
    const cached = state.shared.get(REDIS_KEYS.CACHES.HOME_BLOCKS_PERMANENT) as Row[];
    expect(cached.map((r) => r.id)).toContain(GATED_PERMANENT.id);

    expect(await listIds(STRANGER)).toEqual([OPEN_PERMANENT.id, 101]);
    expect(await listIds(ANON)).toEqual([OPEN.id, OPEN_PERMANENT.id]);
  });

  it('control: a second tester reading the same warm entry does see it', async () => {
    seed(...table(), clone(102, TESTER_2.id, OPEN));
    await listIds(TESTER);
    expect(await listIds(TESTER_2)).toContain(GATED_PERMANENT.id);
  });
});

describe('T3: a clone inherits its source flag', () => {
  it('hides a `{}` clone of a gated source from a viewer the flag is off for', async () => {
    seed(OPEN, GATED, clone(100, STRANGER.id, GATED), clone(101, STRANGER.id, OPEN));
    expect(await listIds(STRANGER)).toEqual([101]);
  });

  it('control: the same clone reaches a flagged viewer', async () => {
    seed(OPEN, GATED, clone(100, TESTER.id, GATED), clone(101, TESTER.id, OPEN));
    expect(await listIds(TESTER)).toEqual([100, 101]);
  });
});

describe('T4: a guessed id', () => {
  it('is refused before the shared by-id cache is read', async () => {
    seed(OPEN, GATED);
    await expect(
      getHomeBlocksByIdHandler({ ctx: ctxFor(STRANGER), input: { id: GATED.id } })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(getHomeBlockCached).not.toHaveBeenCalled();
  });

  it('control: a flagged viewer is served and the 200 is kept off the edge', async () => {
    seed(OPEN, GATED);
    const ctx = ctxFor(TESTER);
    const block = await getHomeBlocksByIdHandler({ ctx, input: { id: GATED.id } });
    expect(block.id).toBe(GATED.id);
    expect(getHomeBlockCached).toHaveBeenCalledTimes(1);
    expect(ctx.cache.skip).toBe(true);
  });

  it('refuses a clone of a gated source by its own id', async () => {
    seed(OPEN, GATED, clone(100, TESTER.id, GATED));
    await expect(
      getHomeBlocksByIdHandler({ ctx: ctxFor(STRANGER), input: { id: 100 } })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(getHomeBlockCached).not.toHaveBeenCalled();
    // control: its owner, who is flagged, is served it, and off the edge: the gate is the source's
    const ctx = ctxFor(TESTER);
    const block = await getHomeBlocksByIdHandler({ ctx, input: { id: 100 } });
    expect(block.id).toBe(100);
    expect(ctx.cache.skip).toBe(true);
  });

  it('control: an ungated row by id stays edge-cacheable for anyone', async () => {
    seed(OPEN, GATED);
    const ctx = ctxFor(STRANGER);
    const block = await getHomeBlocksByIdHandler({ ctx, input: { id: OPEN.id } });
    expect(block.id).toBe(OPEN.id);
    expect(ctx.cache.skip).toBe(false);
  });
});

describe('T5: cached by a tester, then asked for by someone else', () => {
  it('refuses the second viewer even though the shared entry is warm', async () => {
    seed(GATED);
    await getHomeBlocksByIdHandler({ ctx: ctxFor(TESTER), input: { id: GATED.id } });
    expect(state.rendered.size).toBe(1);

    await expect(
      getHomeBlocksByIdHandler({ ctx: ctxFor(STRANGER), input: { id: GATED.id } })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      getHomeBlocksByIdHandler({ ctx: ctxFor(ANON), input: { id: GATED.id } })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(state.renderedCalls).toEqual([{ id: GATED.id, hit: false }]);
  });

  it('control: a second tester is served from the warm entry', async () => {
    seed(GATED);
    await getHomeBlocksByIdHandler({ ctx: ctxFor(TESTER), input: { id: GATED.id } });
    const block = await getHomeBlocksByIdHandler({
      ctx: ctxFor(TESTER_2),
      input: { id: GATED.id },
    });
    expect(block.id).toBe(GATED.id);
    expect(state.renderedCalls).toEqual([
      { id: GATED.id, hit: false },
      { id: GATED.id, hit: true },
    ]);
  });
});

describe('T7: the domain ids path, the editor seed and the system list', () => {
  it('domain ids: a gated id is not served to a viewer the flag is off for', async () => {
    seed(OPEN, GATED);
    expect(await listIds(STRANGER, { systemHomeBlockIds: [GATED.id] })).toEqual([]);
    expect(await listIds(ANON, { systemHomeBlockIds: [GATED.id] })).toEqual([]);
  });

  it('control: domain ids serve it to a flagged viewer', async () => {
    seed(OPEN, GATED);
    expect(await listIds(TESTER, { systemHomeBlockIds: [GATED.id] })).toEqual([GATED.id]);
  });

  it('editor seed: a clone of a gated source is not offered', async () => {
    seed(OPEN, GATED, clone(100, STRANGER.id, GATED), clone(101, STRANGER.id, OPEN));
    expect(await listIds(STRANGER, { ownedOnly: true })).toEqual([101]);
  });

  it('control: the editor seed offers it to a flagged viewer', async () => {
    seed(OPEN, GATED, clone(100, TESTER.id, GATED), clone(101, TESTER.id, OPEN));
    expect(await listIds(TESTER, { ownedOnly: true })).toEqual([100, 101]);
  });

  it('system list: gated rows are not listed for a viewer the flag is off for', async () => {
    seed(OPEN, GATED, GATED_PERMANENT);
    expect(await systemIds(STRANGER)).toEqual([OPEN.id]);
    expect(await systemIds(ANON)).toEqual([OPEN.id]);
  });

  it('system list: a system row sourced off a gated row is gated by its source', async () => {
    seed(OPEN, GATED, sys({ id: 11, sourceId: GATED.id, metadata: {} }));
    expect(await systemIds(STRANGER)).toEqual([OPEN.id]);
    expect(await systemIds(TESTER)).toEqual([OPEN.id, GATED.id, 11]);
  });

  it('control: the system list includes them for a flagged viewer', async () => {
    seed(OPEN, GATED, GATED_PERMANENT);
    expect(await systemIds(TESTER)).toEqual([OPEN.id, GATED.id, GATED_PERMANENT.id]);
  });
});

describe('T8: an Event row follows the event, not only the flag', () => {
  const at = (date: Date) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(date);
  };

  it('armed (base on before the start): hidden from anonymous viewers AND testers', async () => {
    seed(OPEN, EVENT);
    at(new Date(BIRTHDAY_2026_STARTS_AT.getTime() - 60 * 60 * 1000));
    setFlag({ public: true });
    expect(await listIds(ANON)).toEqual([OPEN.id]);
    expect(await listIds(TESTER)).toEqual([OPEN.id]);
  });

  it('control: in the preview a tester sees it and an anonymous viewer does not', async () => {
    seed(OPEN, EVENT);
    at(new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() + 60 * 60 * 1000));
    expect(await listIds(TESTER)).toEqual([OPEN.id, EVENT.id]);
    expect(await listIds(ANON)).toEqual([OPEN.id]);
  });

  it('control: once open, everyone sees it', async () => {
    seed(OPEN, EVENT);
    at(new Date(BIRTHDAY_2026_STARTS_AT.getTime() + 60 * 60 * 1000));
    setFlag({ public: true });
    expect(await listIds(ANON)).toEqual([OPEN.id, EVENT.id]);
  });

  it('a flagless Event row of an ended, unflagged event stays visible to everyone', async () => {
    // The ~700 existing user-owned holiday2024 rows: 'ended' is readable, so nothing changes.
    seed(OPEN, sys({ id: 8, type: HomeBlockType.Event, metadata: { event: 'holiday2024' } }));
    expect(await listIds(ANON)).toEqual([OPEN.id, 8]);
    expect(await listIds(STRANGER)).toEqual([OPEN.id, 8]);
  });

  it('a flagless Event row of a flagged event still follows the event', async () => {
    seed(OPEN, sys({ id: 9, type: HomeBlockType.Event, metadata: { event: 'birthday2026' } }));
    at(new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() + 60 * 60 * 1000));
    expect(await listIds(ANON)).toEqual([OPEN.id]);
    expect(await listIds(STRANGER)).toEqual([OPEN.id]);
    expect(await listIds(TESTER)).toEqual([OPEN.id, 9]);
  });

  it('an Event row naming no known event is hidden from everyone', async () => {
    seed(OPEN, sys({ id: 7, type: HomeBlockType.Event, metadata: { event: 'nope' } }));
    expect(await listIds(MOD)).toEqual([OPEN.id]);
  });
});

describe('T9: an unknown flag fails closed', () => {
  it('hides the row from everyone, moderators included', async () => {
    seed(
      OPEN,
      UNKNOWN_FLAG,
      sys({ id: 10, metadata: { collection: { id: 100 }, featureFlag: null } })
    );
    setFlag({ public: true });
    for (const viewer of [ANON, STRANGER, TESTER, MOD]) {
      expect(await listIds(viewer)).toEqual([OPEN.id]);
    }
  });

  it('control: a real key shows a moderator the row', async () => {
    seed(OPEN, GATED);
    state.flags.clear(); // moderators are on without Flipt answering at all
    expect(await listIds(MOD)).toEqual([OPEN.id, GATED.id]);
  });

  it('is refused at write time by the moderator endpoints', async () => {
    await expect(
      createHomeBlockAdmin({
        type: HomeBlockType.Collection,
        metadata: { featureFlag: 'not-a-key' },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.homeBlock.create).not.toHaveBeenCalled();
  });

  it('is refused when a moderator updates a row to an unknown key', async () => {
    seed(OPEN);
    await expect(
      updateHomeBlockAdmin({ id: OPEN.id, metadata: { featureFlag: 'not-a-key' } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.homeBlock.update).not.toHaveBeenCalled();
  });

  it('control: a moderator update with a real key goes through', async () => {
    seed(OPEN);
    dbMock.dbWrite.homeBlock.update.mockResolvedValue({ ...OPEN });
    await updateHomeBlockAdmin({ id: OPEN.id, metadata: { featureFlag: 'birthday2026' } });
    const [arg] = dbMock.dbWrite.homeBlock.update.mock.calls.at(-1) as [any];
    expect(arg.data.metadata).toEqual({ featureFlag: 'birthday2026' });
  });
});

describe('saving the editor', () => {
  const removed = () =>
    dbMock.dbWrite.homeBlock.deleteMany.mock.calls.flatMap(
      ([arg]: [{ where: { id: { in: number[] } } }]) => arg.where.id.in
    );

  it('keeps a clone of a gated block the viewer was never offered', async () => {
    seed(
      OPEN,
      GATED,
      clone(100, STRANGER.id, GATED),
      clone(101, STRANGER.id, OPEN),
      clone(102, STRANGER.id, OPEN)
    );
    await setHomeBlocksOrder({
      viewer: STRANGER,
      input: { userId: STRANGER.id, homeBlocks: [{ id: 101, index: 0, userId: STRANGER.id }] },
    });
    expect(removed()).toEqual([102]);
  });

  it('control: a flagged viewer who drops it does remove it', async () => {
    seed(OPEN, GATED, clone(100, TESTER.id, GATED), clone(101, TESTER.id, OPEN));
    await setHomeBlocksOrder({
      viewer: TESTER,
      input: { userId: TESTER.id, homeBlocks: [{ id: 101, index: 0, userId: TESTER.id }] },
    });
    expect(removed()).toEqual([100]);
  });
});

describe('user writes cannot set the flag', () => {
  it('strips featureFlag from a non-moderator update of their own row', async () => {
    seed(OPEN, clone(100, STRANGER.id, OPEN));
    dbMock.dbWrite.homeBlock.update.mockResolvedValue({ id: 100, userId: STRANGER.id });
    await upsertHomeBlock({
      input: {
        id: 100,
        type: HomeBlockType.Collection,
        metadata: { collection: { id: 1, limit: 8, rows: 2 }, featureFlag: 'birthday2026' },
        userId: STRANGER.id,
      },
    });
    const [arg] = dbMock.dbWrite.homeBlock.update.mock.calls.at(-1) as [any];
    expect(arg.data.metadata).toEqual({ collection: { id: 1, limit: 8, rows: 2 } });
  });

  it('strips featureFlag from a non-moderator upsert', async () => {
    seed(OPEN, clone(100, STRANGER.id, OPEN));
    await upsertHomeBlock({
      input: {
        type: HomeBlockType.Collection,
        metadata: { collection: { id: 1, limit: 8, rows: 2 }, featureFlag: 'birthday2026' },
        userId: STRANGER.id,
      },
    });
    const [arg] = dbMock.dbWrite.homeBlock.create.mock.calls.at(-1) as [any];
    expect(arg.data.metadata).toEqual({ collection: { id: 1, limit: 8, rows: 2 } });
  });

  it('control: a moderator upsert keeps it', async () => {
    seed(OPEN, clone(100, MOD.id, OPEN));
    await upsertHomeBlock({
      input: {
        type: HomeBlockType.Collection,
        metadata: { collection: { id: 1, limit: 8, rows: 2 }, featureFlag: 'birthday2026' },
        userId: MOD.id,
        isModerator: true,
      },
    });
    const [arg] = dbMock.dbWrite.homeBlock.create.mock.calls.at(-1) as [any];
    expect(arg.data.metadata.featureFlag).toBe('birthday2026');
  });
});
