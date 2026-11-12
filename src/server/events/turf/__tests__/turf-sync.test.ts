import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as TurfWatch from '~/server/events/turf/turf-watch';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';

const START = new Date('2026-11-01T00:00:00Z');
const EVENT = {
  name: 'e',
  startDate: START,
  endDate: new Date('2026-12-01T00:00:00Z'),
  teams: ['Blue', 'Pink'],
  scoring: { finalizeAfterMs: 0 },
  turf: {
    mode: 'live',
    testerFlag: 'e-turf',
    supply: [{ from: START, perHour: 5, cap: 50 }],
    creditedPlayers: [{ from: START, players: 25 }],
    renderLimit: 12,
    mapMaxEntries: 10,
  },
  getUserTeam: async () => 'Blue',
  getTeamCosmetic: async (team: string) => (team === 'Blue' ? 11 : 12),
};
vi.mock('~/server/events/load-events', () => ({ loadEvents: async () => [EVENT] }));
const pushTurfCounts = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('~/server/events/turf/turf-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof TurfWatch>()),
  pushTurfCounts,
}));

const {
  getTurfEvent,
  syncTurfImages,
  requestTurfSync,
  TURF_SYNC_TIMEOUT_MS,
  reconcileTurf,
  pickFeedStickers,
  getTurfStickersForImages,
} = await import('~/server/events/turf/turf.service');
const { computeImageTurf, turfKeys } = await import('~/server/events/turf/turf-map');

const NOW = new Date('2026-11-05T12:00:00Z');
const sticker = (imageId: number, userId: number, team: string) => ({
  imageId,
  id: BigInt(userId),
  data: { x: 0.5, y: 0.5 },
  drawable: true,
  userId,
  team,
  cosmeticId: team === 'Blue' ? 11 : 12,
  eligible: true,
  createdAt: new Date('2026-11-05T11:00:00Z'),
});

const KEYS = turfKeys('e');
// sysRedis's EVAL run for real (the write's Lua), and tickets handed out in order.
function realWrite(hashes: Record<string, Record<string, string>> = {}) {
  const lua = createLuaRedis(0);
  for (const [key, fields] of Object.entries(hashes)) lua.setHash(key, fields);
  redisMock.sysRedis.eval.mockReset().mockImplementation(lua.eval as never);
  let ticket = 0;
  redisMock.sysRedis.incr.mockReset().mockImplementation(async () => ++ticket);
  redisMock.sysRedis.hGetAll
    .mockReset()
    .mockImplementation((async (key: string) => lua.hash(key) ?? {}) as never);
  pushTurfCounts.mockClear();
  dbMock.dbWrite.$queryRaw.mockReset();
  return lua;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const countsOf = (rows: ReturnType<typeof sticker>[]) =>
  JSON.stringify(
    computeImageTurf(
      rows,
      () => 25,
      (t) => (t === 'Blue' ? 11 : 12)
    ).counts
  );

describe('syncTurfImages', () => {
  it('pushes counts only for the images whose counts changed', async () => {
    const event = (await getTurfEvent('e', NOW))!;
    const unchanged = sticker(900, 5, 'Blue');
    realWrite({ [KEYS.counts]: { 'Image:900': countsOf([unchanged]) } });
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([unchanged, sticker(901, 6, 'Pink')]);

    await syncTurfImages(event, [900, 901], NOW);

    // Every place and remove syncs; an unchanged image must not wake its watchers.
    expect(pushTurfCounts).toHaveBeenCalledTimes(1);
    const [, pushed] = pushTurfCounts.mock.calls[0] as unknown as [string, { imageId: number }[]];
    expect(pushed.map((p) => p.imageId)).toEqual([901]);
  });

  // Two pods sync one image at once and the older read finishes last. Without the ticket check the
  // older read overwrites the newer, and the image shows a stale count until the next reconcile.
  it('never lets an older read overwrite a newer one (stale-count race)', async () => {
    const event = (await getTurfEvent('e', NOW))!;
    const lua = realWrite();
    const oldRows = [sticker(900, 5, 'Blue')];
    const newRows = [sticker(900, 5, 'Blue'), sticker(900, 6, 'Pink'), sticker(900, 7, 'Pink')];
    const slowRead = deferred<typeof oldRows>();
    dbMock.dbWrite.$queryRaw
      .mockImplementationOnce((() => slowRead.promise) as never)
      .mockResolvedValueOnce(newRows);

    const older = syncTurfImages(event, [900], NOW); // ticket 1, its read held
    await vi.waitFor(() => expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1));
    await syncTurfImages(event, [900], NOW); // ticket 2, reads and writes first
    slowRead.resolve(oldRows);
    await older;

    expect(lua.hash(KEYS.counts)?.['Image:900']).toBe(countsOf(newRows));
    expect(lua.hash(KEYS.stamp)?.['Image:900']).toBe('2');
    // The stale write is dropped whole: no push of the old counts to viewers either.
    expect(pushTurfCounts).toHaveBeenCalledTimes(2);
    const [, lastPush] = pushTurfCounts.mock.calls[1] as unknown as [string, unknown[]];
    expect(lastPush).toEqual([]);
    expect(lua.errors).toEqual([]);
  });
});

describe('requestTurfSync', () => {
  it('still re-runs for a request that arrived during a run that failed', async () => {
    const event = (await getTurfEvent('e', NOW))!;
    const lua = realWrite();
    const rows = [sticker(960, 5, 'Blue')];
    let rejectRead!: (e: Error) => void;
    dbMock.dbWrite.$queryRaw
      .mockImplementationOnce((() => new Promise((_, reject) => (rejectRead = reject))) as never)
      .mockResolvedValue(rows);

    const first = requestTurfSync(event, 960).catch(() => 'first failed');
    await vi.waitFor(() => expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1));
    const second = requestTurfSync(event, 960); // a placement committed during the failing read
    rejectRead(new Error('connection reset'));
    await Promise.all([first, second]);

    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(2);
    expect(lua.hash(KEYS.counts)?.['Image:960']).toBe(countsOf(rows));
  });

  it('rejects to its caller when a run fails with no request waiting, and frees the image', async () => {
    const event = (await getTurfEvent('e', NOW))!;
    realWrite();
    dbMock.dbWrite.$queryRaw
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue([sticker(965, 5, 'Blue')]);

    await expect(requestTurfSync(event, 965)).rejects.toThrow('connection reset');
    await requestTurfSync(event, 965); // a fresh sync, not the failed one again
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('gives up on a hung run, so the next request for the image starts a fresh sync', async () => {
    const event = (await getTurfEvent('e', NOW))!;
    const lua = realWrite();
    const rows = [sticker(970, 5, 'Blue')];
    dbMock.dbWrite.$queryRaw
      .mockImplementationOnce((() => new Promise(() => undefined)) as never) // never settles
      .mockResolvedValue(rows);
    vi.useFakeTimers();
    try {
      let outcome: string | undefined;
      requestTurfSync(event, 970).catch((e: Error) => (outcome = e.message));
      await vi.advanceTimersByTimeAsync(TURF_SYNC_TIMEOUT_MS);
      expect(outcome).toBe('turf sync timed out');

      await requestTurfSync(event, 970);
      expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(2);
      expect(lua.hash(KEYS.counts)?.['Image:970']).toBe(countsOf(rows));
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces concurrent syncs of one image into one read plus one re-run', async () => {
    const event = (await getTurfEvent('e', NOW))!;
    realWrite();
    const rows = [sticker(950, 5, 'Blue')];
    const firstRead = deferred<typeof rows>();
    dbMock.dbWrite.$queryRaw
      .mockImplementationOnce((() => firstRead.promise) as never)
      .mockResolvedValue(rows);

    const first = requestTurfSync(event, 950);
    await vi.waitFor(() => expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1));
    // 49 more placements land while the first read is out.
    const rest = Array.from({ length: 49 }, () => requestTurfSync(event, 950));
    firstRead.resolve(rows);
    await Promise.all([first, ...rest]);

    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(2);
    // Done means done: a later request starts a fresh sync rather than joining a finished one.
    await requestTurfSync(event, 950);
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(3);
  });
});

const visibleOf = (sql: string) =>
  sql.slice(sql.indexOf(' p."publishedAt"'), sql.indexOf('"blockedFor" IS NULL'));
// The whole contestEntry fragment: the contest check and the running flag Crucible check.
const contestOf = (sql: string) => {
  const at = sql.indexOf('(EXISTS ( SELECT 1 FROM "CollectionItem"');
  if (at < 0) return '';
  let depth = 0;
  for (let i = at; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')' && --depth === 0) return sql.slice(at, i + 1);
  }
  return '';
};
const OWNER_ALLOWS_TURF =
  'EXISTS (SELECT 1 FROM "User" ow WHERE ow.id = i."userId" AND ow."bannedAt" IS NULL AND ow."deletedAt" IS NULL AND (ow.settings -> ? ->> ?) IS DISTINCT FROM \'true\')';
const sqlOf = (call: unknown[]) => {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(strings, ...values).sql.replace(/\s+/g, ' ');
};

// A push carries pickFeedStickers' pick in place of a viewer reading getTurfStickersForImages, so
// the two must pick the same hats. Parity is pinned by this fixture and the SQL text, not a database.
describe('the stickers a turf push carries', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 10, 5, h));
  const row = (id: number, team: string, hour: number, drawable = true) => ({
    id: BigInt(id),
    userId: 100 + id,
    team,
    cosmeticId: team === 'Blue' ? 11 : 12,
    data: { x: 0.1 * id, y: 0.5 },
    art: null,
    createdAt: at(hour),
    drawable,
  });
  // Oldest first, as liveStickers returns them.
  const rows = [
    row(7, 'Blue', 0),
    row(1, 'Blue', 1),
    row(4, 'Pink', 1),
    row(2, 'Blue', 2),
    row(3, 'Blue', 3),
    row(6, 'Blue', 3),
    row(5, 'Pink', 4, false), // a banned or deleted placer: never drawn
  ];

  it('picks each team’s newest first, then the next newest, drawable only, five at most', () => {
    // teamRank 1: Blue 6 (newest, id beats 3 at the same time), Pink 4; then Blue 3, 2, 1; Blue 7 is
    // sixth. Pink 5 is newest of all but not drawable.
    expect(pickFeedStickers(rows).map((s) => s.id)).toEqual(['6', '4', '3', '2', '1']);
    expect(pickFeedStickers(rows)[0]).toEqual({
      id: '6',
      userId: 106,
      team: 'Blue',
      cosmeticId: 11,
      data: { x: 0.1 * 6, y: 0.5 },
      art: null,
      // Carried so a pushed card reveals in placement order, as a read does.
      createdAt: at(3),
    });
  });

  it('ranks and filters in the same SQL the feed read uses', async () => {
    const event = (await getTurfEvent('e', NOW))!;
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([]);
    await getTurfStickersForImages(event.name, [900], 5);
    const read = sqlOf(dbMock.dbRead.$queryRaw.mock.calls.at(-1)!);
    expect(read).toContain(
      'row_number() OVER (PARTITION BY s."imageId", s.team ORDER BY s."createdAt" DESC, s.id DESC)'
    );
    expect(read).toContain('PARTITION BY "imageId" ORDER BY "teamRank", "createdAt" DESC, id DESC');
    // The whole filter, so a rule added to the read alone (which a push would not apply) fails here.
    const where = read.slice(read.indexOf(' WHERE s.event'), read.indexOf(' ), picked'));
    expect(where).toBe(
      ' WHERE s.event = ? AND s."imageId" = ANY(?::int[]) AND s."removedAt" IS NULL AND' +
        visibleOf(read) +
        '"blockedFor" IS NULL AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL AND NOT ' +
        contestOf(read) +
        ' AND ' +
        OWNER_ALLOWS_TURF
    );

    realWrite();
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([]);
    await syncTurfImages(event, [900], NOW);
    const live = sqlOf(dbMock.dbWrite.$queryRaw.mock.calls.at(-1)!);
    expect(live).toContain('(u."bannedAt" IS NULL AND u."deletedAt" IS NULL) AS drawable');
    expect(live).toContain('s."removedAt" IS NULL');
    // The same image visibility rule on both reads.
    expect(visibleOf(live)).not.toBe('');
    expect(visibleOf(live)).toBe(visibleOf(read));
    // The push reads the contest rule too, and carries nothing for an entry (turf-contest.pglite).
    expect(contestOf(read)).not.toBe('');
    expect(live).toContain(`${contestOf(read)} AS contest`);
    // The owner's switch on both reads (turf-owner-off.pglite).
    expect(live).toContain(`AND ${OWNER_ALLOWS_TURF}`);
  });

  it('rides on the push a placement sends, with no extra read', async () => {
    const event = (await getTurfEvent('e', NOW))!;
    realWrite();
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(
      rows.map((r) => ({ ...r, imageId: 900, eligible: true }))
    );

    await syncTurfImages(event, [900], NOW);

    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    const [, pushed] = pushTurfCounts.mock.calls[0] as unknown as [
      string,
      { imageId: number; stickers: { id: string }[] }[]
    ];
    expect(pushed[0].stickers.map((s) => s.id)).toEqual(['6', '4', '3', '2', '1']);
  });
});

describe('reconcileTurf', () => {
  it('carries stickers for changed images, and null for any it did not pick', async () => {
    const event = (await getTurfEvent('e', NOW))!;
    const a = { ...sticker(900, 5, 'Blue'), eligible: true };
    const b = { ...sticker(901, 6, 'Pink'), eligible: true };
    const bCounts = JSON.stringify(
      computeImageTurf(
        [b],
        () => 25,
        () => 12
      ).counts
    );
    // After the snapshot, an older sync moved 901: the write differs for both, so both are pushed.
    realWrite({ [KEYS.counts]: { 'Image:901': 'moved since' } });
    redisMock.sysRedis.hGetAll.mockResolvedValueOnce({ 'Image:901': bCounts }); // 900 changed, 901 not
    dbMock.dbRead.$queryRaw
      .mockResolvedValueOnce([{ imageId: 900 }, { imageId: 901 }])
      .mockResolvedValueOnce([a, b])
      .mockResolvedValueOnce([]);

    await reconcileTurf(event, NOW);

    const [, pushed] = pushTurfCounts.mock.calls[0] as unknown as [
      string,
      { imageId: number; stickers: { id: string }[] | null }[]
    ];
    const byId = Object.fromEntries(pushed.map((p) => [p.imageId, p]));
    expect(byId[900].stickers?.map((s) => s.id)).toEqual(['5']);
    // null, never []: [] would draw an image that has hats as having none.
    expect(byId[901]).toBeDefined();
    expect(byId[901].stickers).toBeNull();
  });

  // Reconcile runs while a placement syncs: the sync started first, then a ban took the sticker
  // off. Only reconcile applies bans, so its later read must win over the sync's earlier one.
  async function reconcileAfterSync(syncRows: ReturnType<typeof sticker>[]) {
    const event = (await getTurfEvent('e', NOW))!;
    const lua = realWrite();
    const snapshot = deferred<Record<string, string>>();
    redisMock.sysRedis.hGetAll.mockImplementationOnce((() => snapshot.promise) as never);
    dbMock.dbRead.$queryRaw.mockReset();
    const reconcile = reconcileTurf(event, NOW); // held at its snapshot, before any read
    await vi.waitFor(() => expect(redisMock.sysRedis.hGetAll).toHaveBeenCalledTimes(1));
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(syncRows);
    await syncTurfImages(event, [syncRows[0].imageId], NOW);
    return { lua, reconcile, snapshot };
  }

  it('applies a ban over a sync that read before it (reconcile reads after its ticket)', async () => {
    const banned = sticker(900, 5, 'Blue');
    const kept = sticker(900, 6, 'Pink');
    const { lua, reconcile, snapshot } = await reconcileAfterSync([banned, kept]);
    dbMock.dbRead.$queryRaw
      .mockResolvedValueOnce([{ imageId: 900 }])
      .mockResolvedValueOnce([kept]) // the ban is in: 5's sticker no longer counts
      .mockResolvedValueOnce([]);
    snapshot.resolve({});
    await reconcile;

    expect(lua.hash(KEYS.counts)?.['Image:900']).toBe(countsOf([kept]));
  });

  it('clears an image a sync added after its snapshot, once it has no live stickers', async () => {
    const { lua, reconcile, snapshot } = await reconcileAfterSync([sticker(910, 5, 'Blue')]);
    expect(lua.hash(KEYS.counts)?.['Image:910']).toBeDefined();
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([]); // hidden since: no live stickers anywhere
    snapshot.resolve({});
    await reconcile;

    expect(lua.hash(KEYS.counts)?.['Image:910']).toBeUndefined();
    expect(lua.hash(KEYS.map)?.['Image:910']).toBeUndefined();
    // The stamp outlives the clear, so a sync that read before it cannot bring the image back.
    const stamp = Number(lua.hash(KEYS.stamp)?.['Image:910']);
    expect(stamp).toBeGreaterThan(0);
    redisMock.sysRedis.incr.mockResolvedValueOnce(stamp - 1);
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([sticker(910, 5, 'Blue')]);
    await syncTurfImages((await getTurfEvent('e', NOW))!, [910], NOW);
    expect(lua.hash(KEYS.counts)?.['Image:910']).toBeUndefined();
  });
});
