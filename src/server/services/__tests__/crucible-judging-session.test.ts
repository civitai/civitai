import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CrucibleIngestionStatus,
  CrucibleStatus,
  ImageIngestionStatus,
  MediaType,
} from '~/shared/utils/prisma/enums';
import { dbMock, redisMock } from '~/__tests__/mocks';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as CrucibleEloRedis from '~/server/redis/crucible-elo.redis';
import type * as CrucibleEloService from '~/server/services/crucible-elo.service';

const processVote = vi.fn();
const getAllEntryElos = vi.fn();

vi.mock('~/server/services/crucible-elo.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEloService>()),
  processVote,
  getAllEntryElos,
}));

vi.mock('~/server/redis/crucible-elo.redis', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEloRedis>()),
  crucibleEloRedis: {
    getVoteCount: vi.fn().mockResolvedValue(0),
    getAllVoteCounts: vi.fn().mockResolvedValue({}),
    incrementVoteCount: vi.fn().mockResolvedValue(undefined),
  },
}));

// The vote's ClickHouse event, sent fire-and-forget after the vote is recorded.
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  Tracker: class {
    crucibleVote = vi.fn();
  },
}));

const { submitVote, getJudgingPair } = await import('~/server/services/crucible.service');
const { CRUCIBLE_JUDGING_DEFAULTS } = await import('~/server/services/crucible-judging-session');

const CONFIG_KEY = 'system:crucible-judging';
const MIN_VIEW_SECONDS = 6;
const DAY_SECONDS = 24 * 60 * 60;

// Hashes with TTLs on the fake clock, so a judge's per-entry vote counts expire as they do in Redis.
const hashes = new Map<string, { fields: Map<string, string>; expiresAt: number | null }>();
let config: Record<string, string> = {};

const live = (key: string) => {
  const hash = hashes.get(key);
  if (hash?.expiresAt != null && hash.expiresAt <= Date.now()) hashes.delete(key);
  return hashes.get(key);
};

const installRedisFake = () => {
  const { sysRedis } = redisMock;
  sysRedis.hGetAll.mockImplementation(async (key: string) =>
    key === CONFIG_KEY ? { ...config } : Object.fromEntries(live(key)?.fields ?? [])
  );
  sysRedis.hGet.mockImplementation(
    async (key: string, field: string) => live(key)?.fields.get(field) ?? null
  );
  sysRedis.hmGet.mockImplementation(async (key: string, fields: string[]) =>
    fields.map((field) => live(key)?.fields.get(field) ?? null)
  );
  sysRedis.hSet.mockImplementation(async (key: string, value: Record<string, string>) => {
    const hash = live(key) ?? { fields: new Map(), expiresAt: null };
    for (const [field, v] of Object.entries(value)) hash.fields.set(field, v);
    hashes.set(key, hash);
    return 1;
  });
  sysRedis.hIncrBy.mockImplementation(async (key: string, field: string, by: number) => {
    const hash = live(key) ?? { fields: new Map(), expiresAt: null };
    const next = Number(hash.fields.get(field) ?? 0) + by;
    hash.fields.set(field, String(next));
    hashes.set(key, hash);
    return next;
  });
  sysRedis.del.mockImplementation(async (key: string) => (hashes.delete(key) ? 1 : 0));
  sysRedis.expire.mockImplementation(async (key: string, seconds: number) => {
    const hash = live(key);
    if (!hash) return false;
    hash.expiresAt = Date.now() + seconds * 1000;
    return true;
  });
  // Every pair counts as served, so the served-pair claim never decides these tests.
  sysRedis.eval.mockResolvedValue(1);
  sysRedis.sAdd.mockResolvedValue(1);
};

const entryOwner = (id: number) => 100 + id;

const vote = (
  winnerEntryId: number,
  loserEntryId: number,
  winnerWatchedMs: number,
  loserWatchedMs: number
) =>
  submitVote({
    crucibleId: 1,
    winnerEntryId,
    loserEntryId,
    winnerWatchedMs,
    loserWatchedMs,
    userId: 42,
  });

const FULL = MIN_VIEW_SECONDS * 1000;
const REPEAT = CRUCIBLE_JUDGING_DEFAULTS.repeatViewSeconds * 1000;

const crucibleRow = {
  id: 1,
  userId: 999,
  status: CrucibleStatus.Active,
  endAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  contentType: MediaType.video,
  minViewSeconds: MIN_VIEW_SECONDS,
  nsfwLevel: 31,
  ingestion: CrucibleIngestionStatus.Scanned,
  image: { ingestion: ImageIngestionStatus.Scanned },
};

let clock = new Date('2026-10-03T00:00:00Z').getTime();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  // Past the config memo's TTL, so every test reads the config it sets rather than the last one.
  clock += 24 * 60 * 60 * 1000;
  vi.setSystemTime(clock);
  hashes.clear();
  config = {};
  installRedisFake();
  dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow);
  dbMock.dbRead.crucibleEntry.findUnique.mockImplementation(async ({ where }: any) => ({
    id: where.id,
    crucibleId: 1,
    userId: entryOwner(where.id),
  }));
  processVote.mockResolvedValue({ winnerElo: 1532, loserElo: 1468 });
  getAllEntryElos.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

const advanceSeconds = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000);

// A returning judge does not re-watch a clip in full. This replaced a per-visit session on purpose:
// do not bring back "leaving and coming back means watching in full again".
describe('submitVote — repeat clips across visits', () => {
  it('needs only the repeat watch for a clip voted on in an earlier visit', async () => {
    await vote(10, 20, FULL, FULL);
    advanceSeconds(DAY_SECONDS);

    await expect(vote(10, 30, REPEAT, FULL)).resolves.toMatchObject({ winnerElo: 1532 });
  });

  it('requires the full minimum for a clip the judge has never voted on', async () => {
    await expect(vote(10, 20, REPEAT, REPEAT)).rejects.toThrow(/Watch at least 6s/);
    expect(processVote).not.toHaveBeenCalled();
  });

  it('requires only the configured seconds for a clip voted on earlier', async () => {
    await vote(10, 20, FULL, FULL);

    // 10 is a repeat, 30 is new: only the repeat side gets the short watch.
    await expect(vote(10, 30, REPEAT, FULL)).resolves.toMatchObject({ winnerElo: 1532 });
    expect(processVote).toHaveBeenCalledTimes(2);
  });

  it('still requires the full minimum for the NEW clip paired with a repeat', async () => {
    await vote(10, 20, FULL, FULL);

    await expect(vote(30, 10, REPEAT, REPEAT)).rejects.toThrow(/Watch at least 6s/);
    expect(processVote).toHaveBeenCalledTimes(1);
  });

  it('does not mark clips seen on a vote the watch gate rejected', async () => {
    await expect(vote(10, 20, 0, 0)).rejects.toThrow(/6s/);

    await expect(vote(10, 20, REPEAT, REPEAT)).rejects.toThrow(/Watch at least 6s/);
  });

  it('does not mark clips seen on a vote refused because the pair was not served', async () => {
    redisMock.sysRedis.eval.mockResolvedValueOnce(0);
    await expect(vote(10, 20, FULL, FULL)).rejects.toThrow(/no longer available/);

    await expect(vote(10, 30, REPEAT, FULL)).rejects.toThrow(/Watch at least 6s/);
  });

  it('rejects a repeat watched for less than the configured seconds', async () => {
    await vote(10, 20, FULL, FULL);

    await expect(vote(10, 20 + 10, REPEAT - 1, FULL)).rejects.toThrow(/Watch at least/);
  });

  it("requires the full minimum while the judge's vote counts cannot be read", async () => {
    await vote(10, 20, FULL, FULL);
    redisMock.sysRedis.hmGet.mockRejectedValueOnce(new Error('sysRedis down'));

    await expect(vote(10, 30, REPEAT, FULL)).rejects.toThrow(/Watch at least 6s/);
  });

  it('never shortens past the crucible minimum when the configured repeat is longer', async () => {
    config = { repeatViewSeconds: '30' };
    await vote(10, 20, FULL, FULL);

    await expect(vote(10, 30, FULL, FULL)).resolves.toMatchObject({ winnerElo: 1532 });
  });
});

describe('submitVote — config change without a deploy', () => {
  it('picks up a new repeat watch from Redis once the app-side cache expires', async () => {
    config = { repeatViewSeconds: '1' };
    await vote(10, 20, FULL, FULL);
    await expect(vote(10, 30, 1000, FULL)).resolves.toBeDefined();

    config = { repeatViewSeconds: '4' };
    // Still cached on this pod.
    await expect(vote(10, 40, 1000, FULL)).resolves.toBeDefined();

    advanceSeconds(61);
    await expect(vote(10, 50, 1000, FULL)).rejects.toThrow(/Watch at least 6s/);
    await expect(vote(10, 50, 4000, FULL)).resolves.toBeDefined();
  });

  it('gives no shortening while the config cannot be read, and retries on the next call', async () => {
    await vote(10, 20, FULL, FULL);
    const realHGetAll = redisMock.sysRedis.hGetAll.getMockImplementation()!;
    redisMock.sysRedis.hGetAll.mockImplementation(async (key: string) => {
      if (key === CONFIG_KEY) throw new Error('sysRedis down');
      return realHGetAll(key);
    });
    advanceSeconds(61);

    await expect(vote(10, 30, REPEAT, FULL)).rejects.toThrow(/Watch at least 6s/);

    redisMock.sysRedis.hGetAll.mockImplementation(realHGetAll);
    await expect(vote(10, 30, REPEAT, FULL)).resolves.toBeDefined();
  });
});

describe('getJudgingPair — tells the client the same requirement the vote enforces', () => {
  const rawEntry = (id: number) => ({
    id,
    imageId: id * 10,
    userId: entryOwner(id),
    score: 1500,
    image_id: id * 10,
    image_url: `image-${id}`,
    image_width: 512,
    image_height: 512,
    image_nsfwLevel: 1,
    user_id: entryOwner(id),
    user_username: `user${id}`,
    user_deletedAt: null,
    user_image: null,
  });

  const fetchPair = () => getJudgingPair({ crucibleId: 1, userId: 42 });

  const watchByEntry = (pair: Awaited<ReturnType<typeof fetchPair>>) => ({
    [pair!.left.id]: pair!.watchSeconds.left,
    [pair!.right.id]: pair!.watchSeconds.right,
  });

  it('marks a clip voted on before as needing only the repeat watch', async () => {
    await vote(10, 20, FULL, FULL);
    dbMock.dbRead.$queryRaw.mockResolvedValue([rawEntry(10), rawEntry(30)]);

    expect(watchByEntry(await fetchPair())).toEqual({
      10: CRUCIBLE_JUDGING_DEFAULTS.repeatViewSeconds,
      30: MIN_VIEW_SECONDS,
    });
  });

  it('does not count a clip that was only served, never voted on, as seen', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([rawEntry(30), rawEntry(40)]);
    await fetchPair();

    await expect(vote(30, 40, REPEAT, REPEAT)).rejects.toThrow(/Watch at least 6s/);
  });

  it('reports no rule for a crucible without a minimum', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({ ...crucibleRow, minViewSeconds: null });
    dbMock.dbRead.$queryRaw.mockResolvedValue([rawEntry(10), rawEntry(30)]);

    expect((await fetchPair())!.watchSeconds).toEqual({ left: null, right: null });
  });
});
