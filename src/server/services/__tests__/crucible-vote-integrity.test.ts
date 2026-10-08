import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY } from '~/shared/constants/crucible.constants';
import {
  CrucibleIngestionStatus,
  CrucibleStatus,
  ImageIngestionStatus,
  MediaType,
} from '~/shared/utils/prisma/enums';
import { dbMock, redisMock } from '~/__tests__/mocks';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { submitVoteSchema } from '~/server/schema/crucible.schema';
import type * as CrucibleEloRedis from '~/server/redis/crucible-elo.redis';
import type * as CrucibleEloService from '~/server/services/crucible-elo.service';

const processVote = vi.fn();

vi.mock('~/server/services/crucible-elo.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEloService>()),
  processVote,
}));

vi.mock('~/server/redis/crucible-elo.redis', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEloRedis>()),
  crucibleEloRedis: {
    getAllElos: vi.fn().mockResolvedValue({}),
    getAllVoteCounts: vi.fn().mockResolvedValue({}),
    getVoteCount: vi.fn().mockResolvedValue(0),
    incrementVoteCount: vi.fn().mockResolvedValue(undefined),
    processVoteAtomic: vi.fn(),
  },
}));

const { getJudgingPair, submitVote } = await import('~/server/services/crucible.service');

const JUDGE = 42;
const JUDGE_ENTRY_VOTES_KEY = `${REDIS_SYS_KEYS.CRUCIBLE.JUDGE_ENTRY_VOTES}:1:${JUDGE}`;
const vote = (winnerEntryId = 10, loserEntryId = 20) =>
  submitVote({ crucibleId: 1, winnerEntryId, loserEntryId, userId: JUDGE });

/** In-memory stand-in for the sysRedis commands the vote path uses, with Redis semantics. */
const useFakeRedis = () => {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Map<string, number>>();
  const { sysRedis } = redisMock;
  sysRedis.set.mockImplementation(async (key: string, value: string) => {
    sets.delete(key);
    strings.set(key, value);
    return 'OK';
  });
  // The served-pair claim: deletes the key only while it still holds this pair.
  sysRedis.eval.mockImplementation(
    async (_script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) => {
      if (strings.get(keys[0]) !== args[0]) return 0;
      strings.delete(keys[0]);
      return 1;
    }
  );
  sysRedis.sAdd.mockImplementation(async (key: string, value: string) => {
    const set = sets.get(key) ?? new Set<string>();
    sets.set(key, set);
    if (set.has(value)) return 0;
    set.add(value);
    return 1;
  });
  sysRedis.sRem.mockImplementation(async (key: string, value: string) =>
    sets.get(key)?.delete(value) ? 1 : 0
  );
  sysRedis.sMembers.mockImplementation(async (key: string) => [...(sets.get(key) ?? [])]);
  sysRedis.hIncrBy.mockImplementation(async (key: string, field: string, by: number) => {
    const hash = hashes.get(key) ?? new Map<string, number>();
    hashes.set(key, hash);
    hash.set(field, (hash.get(field) ?? 0) + by);
    return hash.get(field);
  });
  sysRedis.hGet.mockImplementation(async (key: string, field: string) => {
    const count = hashes.get(key)?.get(field);
    return count === undefined ? null : String(count);
  });
  sysRedis.hGetAll.mockImplementation(async (key: string) =>
    Object.fromEntries([...(hashes.get(key) ?? [])].map(([field, n]) => [field, String(n)]))
  );
  const judgeVotes = (field: string) => hashes.get(JUDGE_ENTRY_VOTES_KEY)?.get(field) ?? 0;
  return { judgeVotes };
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // File-wide: every vote tracks to ClickHouse, and an unstubbed send retries into a later test.
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
  vi.stubGlobal('fetch', fetchMock);
  dbMock.dbRead.crucible.findUnique.mockResolvedValue({
    id: 1,
    userId: 500,
    status: CrucibleStatus.Active,
    endAt: new Date(Date.now() + 60_000),
    contentType: MediaType.image,
    minViewSeconds: null,
  });
  dbMock.dbRead.crucibleEntry.findUnique.mockImplementation(async ({ where }: any) => ({
    id: where.id,
    crucibleId: 1,
    userId: where.id + 1000,
    score: 1500 + where.id,
    voteCount: where.id,
  }));
  processVote.mockResolvedValue({ winnerElo: 1516, loserElo: 1484 });
  useFakeRedis();
  // Every pair counts as served unless a test says otherwise.
  redisMock.sysRedis.eval.mockResolvedValue(1);
});
afterEach(() => vi.unstubAllGlobals());

describe('submitVote — a vote needs two different entries', () => {
  it('is refused by the input schema', () => {
    const parsed = submitVoteSchema.safeParse({
      crucibleId: 1,
      winnerEntryId: 10,
      loserEntryId: 10,
    });
    expect(parsed.success).toBe(false);
  });

  it('is refused by the service before any rating moves', async () => {
    await expect(vote(10, 10)).rejects.toThrow('two different entries');
    expect(processVote).not.toHaveBeenCalled();
  });
});

describe('submitVote — a creator who blocked the judge', () => {
  it('refuses the vote before any rating moves', async () => {
    await expect(
      submitVote({
        crucibleId: 1,
        winnerEntryId: 10,
        loserEntryId: 20,
        userId: JUDGE,
        blockedByUserIds: [500],
      })
    ).rejects.toThrow('Crucible not found');
    expect(processVote).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.eval).not.toHaveBeenCalled();
  });
});

describe('submitVote — after a Redis wipe', () => {
  it("gives the rating script each entry's last synced score and vote count", async () => {
    await vote(20, 10);

    expect(processVote).toHaveBeenCalledWith(
      1,
      20,
      10,
      {
        winner: expect.objectContaining({ score: 1520, voteCount: 20 }),
        loser: expect.objectContaining({ score: 1510, voteCount: 10 }),
      },
      undefined
    );
  });
});

describe('submitVote — only a pair this judge was served', () => {
  it('claims the served pair for this judge and crucible', async () => {
    await vote(20, 10);

    // No test executes Lua, so the script is pinned whole.
    const compareThenDelete =
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";
    expect(redisMock.sysRedis.eval).toHaveBeenCalledWith(compareThenDelete, {
      keys: [expect.stringMatching(new RegExp(`served-pair:1:${JUDGE}$`))],
      arguments: ['10:20'],
    });
    expect(processVote).toHaveBeenCalledTimes(1);
  });

  it('refuses a pair that was never served, or was already claimed', async () => {
    redisMock.sysRedis.eval.mockResolvedValue(0);

    await expect(vote()).rejects.toThrow('no longer available');
    expect(processVote).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.sAdd).not.toHaveBeenCalled();
  });
});

describe('submitVote — only the pair served most recently', () => {
  const rawEntry = (id: number) => ({
    id,
    imageId: id * 10,
    userId: id + 1000,
    score: 1500,
    image_id: id * 10,
    image_url: `image-${id}`,
    image_width: 512,
    image_height: 512,
    image_nsfwLevel: 1,
    user_id: id + 1000,
    user_username: `user${id}`,
    user_deletedAt: null,
    user_image: null,
  });
  const serve = async (...entryIds: number[]) => {
    dbMock.dbRead.$queryRaw.mockResolvedValue(entryIds.map(rawEntry));
    const pair = await getJudgingPair({ crucibleId: 1, userId: JUDGE });
    if (!pair) throw new Error('no pair served');
    return [pair.left.id, pair.right.id] as const;
  };

  beforeEach(() => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      id: 1,
      userId: 500,
      status: CrucibleStatus.Active,
      endAt: new Date(Date.now() + 60_000),
      nsfwLevel: 31,
      textNsfw: false,
      ingestion: CrucibleIngestionStatus.Scanned,
      image: { ingestion: ImageIngestionStatus.Scanned },
      minViewSeconds: null,
    });
    useFakeRedis();
  });

  // Deliberate, including for a judge with two tabs open: the older tab's vote is refused and it
  // loads a fresh pair. Do not widen this back to every pair ever served.
  it('refuses a pair once a newer one has been served to the judge', async () => {
    const [olderA, olderB] = await serve(10, 20);
    const [newerA, newerB] = await serve(30, 40);

    await expect(vote(olderA, olderB), 'the older pair').rejects.toThrow('no longer available');
    await expect(vote(newerA, newerB), 'the newer pair').resolves.toMatchObject({
      winnerEntryId: newerA,
    });
    expect(processVote).toHaveBeenCalledTimes(1);
  });

  it('accepts the served pair only once', async () => {
    const [a, b] = await serve(10, 20);

    await vote(a, b);
    await expect(vote(a, b)).rejects.toThrow('no longer available');
    expect(processVote).toHaveBeenCalledTimes(1);
  });
});

describe('submitVote — rating update', () => {
  it('leaves the vote counts to the atomic rating script instead of a second round-trip', async () => {
    const { crucibleEloRedis } = await import('~/server/redis/crucible-elo.redis');

    await vote(10, 20);

    expect(processVote).toHaveBeenCalledWith(1, 10, 20, expect.any(Object), undefined);
    expect(crucibleEloRedis.getVoteCount).not.toHaveBeenCalled();
    expect(crucibleEloRedis.incrementVoteCount).not.toHaveBeenCalled();
  });
});

describe('submitVote — per-judge cap on each entry', () => {
  it('refuses once the judge has voted on both entries as often as allowed', async () => {
    const { judgeVotes } = useFakeRedis();
    redisMock.sysRedis.eval.mockResolvedValue(1);
    for (const field of ['10', '20'])
      await redisMock.sysRedis.hIncrBy(
        JUDGE_ENTRY_VOTES_KEY,
        field,
        CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY
      );

    await expect(vote()).rejects.toThrow('as many times as allowed');
    expect(processVote).not.toHaveBeenCalled();
    // Refused before the served pair is claimed, so it is not burned.
    expect(redisMock.sysRedis.eval).not.toHaveBeenCalled();
    expect([judgeVotes('10'), judgeVotes('20')], 'counts after the refusal').toEqual([
      CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY,
      CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY,
    ]);
  });

  it.each([
    ['loser', 20],
    ['winner', 10],
  ] as const)(
    'takes a vote against an entry at the cap as an anchor vote that leaves the %s as it is',
    async (side, anchorId) => {
      const { judgeVotes } = useFakeRedis();
      redisMock.sysRedis.eval.mockResolvedValue(1);
      await redisMock.sysRedis.hIncrBy(
        JUDGE_ENTRY_VOTES_KEY,
        String(anchorId),
        CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY
      );

      await vote(10, 20);

      expect(redisMock.sysRedis.eval).toHaveBeenCalledWith(expect.any(String), {
        keys: [expect.stringMatching(/served-pair:1:42$/)],
        arguments: [`10:20|anchor:${anchorId}`],
      });
      expect(processVote).toHaveBeenCalledWith(1, 10, 20, expect.any(Object), side);
      const other = anchorId === 10 ? 20 : 10;
      expect(
        [judgeVotes(String(anchorId)), judgeVotes(String(other))],
        'the anchor is not charged; the other entry is'
      ).toEqual([CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY, 1]);
    }
  );

  it('refuses a vote whose anchor is not the one served, without using up the pair', async () => {
    const { judgeVotes } = useFakeRedis();
    const SERVED_KEY = `${REDIS_SYS_KEYS.CRUCIBLE.SERVED_PAIR}:1:${JUDGE}`;
    await redisMock.sysRedis.set(SERVED_KEY, '10:20');
    // A concurrent submit naming entry 10 holds its last vote for a moment.
    await redisMock.sysRedis.hIncrBy(
      JUDGE_ENTRY_VOTES_KEY,
      '10',
      CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY
    );

    await expect(vote(10, 20)).rejects.toThrow('no longer available');
    expect(processVote).not.toHaveBeenCalled();
    expect(judgeVotes('20'), 'count given back').toBe(0);

    // The other submit fails its own served check and gives the vote back; the real one goes through.
    await redisMock.sysRedis.hIncrBy(JUDGE_ENTRY_VOTES_KEY, '10', -1);
    await vote(10, 20);
    expect(processVote).toHaveBeenCalledWith(1, 10, 20, expect.any(Object), undefined);
  });

  it('accepts an anchor vote on the pair served with that anchor', async () => {
    useFakeRedis();
    await redisMock.sysRedis.set(
      `${REDIS_SYS_KEYS.CRUCIBLE.SERVED_PAIR}:1:${JUDGE}`,
      '10:20|anchor:20'
    );
    await redisMock.sysRedis.hIncrBy(
      JUDGE_ENTRY_VOTES_KEY,
      '20',
      CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY
    );

    await vote(10, 20);

    expect(processVote).toHaveBeenCalledWith(1, 10, 20, expect.any(Object), 'loser');
  });

  it('hands the frozen side through to the rating script', async () => {
    const { crucibleEloRedis } = await import('~/server/redis/crucible-elo.redis');
    const actual = await vi.importActual<typeof CrucibleEloService>(
      '~/server/services/crucible-elo.service'
    );
    vi.mocked(crucibleEloRedis.processVoteAtomic).mockResolvedValue({
      winnerElo: 1530,
      loserElo: 1500,
      winnerOldElo: 1500,
      loserOldElo: 1500,
      winnerChange: 0,
      loserChange: 0,
    });
    processVote.mockImplementationOnce(actual.processVote);
    useFakeRedis();
    redisMock.sysRedis.eval.mockResolvedValue(1);
    await redisMock.sysRedis.hIncrBy(
      JUDGE_ENTRY_VOTES_KEY,
      '10',
      CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY
    );

    await vote(10, 20);

    expect(crucibleEloRedis.processVoteAtomic).toHaveBeenCalledWith(
      1,
      10,
      20,
      expect.any(Object),
      expect.any(Object),
      'winner'
    );
  });

  it('gives back only the counted entry when an anchor vote fails', async () => {
    const { judgeVotes } = useFakeRedis();
    redisMock.sysRedis.eval.mockResolvedValue(1);
    await redisMock.sysRedis.hIncrBy(
      JUDGE_ENTRY_VOTES_KEY,
      '20',
      CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY
    );
    processVote.mockRejectedValueOnce(new Error('rating script failed'));

    await expect(vote(10, 20)).rejects.toThrow('rating script failed');

    expect([judgeVotes('10'), judgeVotes('20')]).toEqual([
      0,
      CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY,
    ]);
  });

  it('counts both entries toward the judge on an accepted vote', async () => {
    const { judgeVotes } = useFakeRedis();
    redisMock.sysRedis.eval.mockResolvedValue(1);

    await vote();

    expect([judgeVotes('10'), judgeVotes('20')]).toEqual([1, 1]);
    expect(redisMock.sysRedis.expire).toHaveBeenCalledWith(
      JUDGE_ENTRY_VOTES_KEY,
      expect.any(Number)
    );
  });

  it('lets only one of two concurrent votes count against an entry at its last vote', async () => {
    const { judgeVotes } = useFakeRedis();
    redisMock.sysRedis.eval.mockResolvedValue(1);
    await redisMock.sysRedis.hIncrBy(
      JUDGE_ENTRY_VOTES_KEY,
      '10',
      CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY - 1
    );

    await Promise.all([vote(10, 20), vote(10, 30)]);

    // The vote that lost the race takes 10 as its anchor and leaves its rating alone.
    const frozenSides = processVote.mock.calls.map((call) => call[4]);
    expect(frozenSides.sort(), 'frozen side of each vote').toEqual(['winner', undefined]);
    expect(judgeVotes('10'), 'count on the shared entry').toBe(
      CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY
    );
    expect(judgeVotes('20') + judgeVotes('30'), 'counts on the other entries').toBe(2);
  });

  it('gives the counts back when the pair is no longer served', async () => {
    const { judgeVotes } = useFakeRedis();
    redisMock.sysRedis.eval.mockResolvedValue(0);

    await expect(vote()).rejects.toThrow('no longer available');

    expect([judgeVotes('10'), judgeVotes('20')]).toEqual([0, 0]);
  });

  it('gives the counts back when the pair was already voted', async () => {
    const { judgeVotes } = useFakeRedis();
    redisMock.sysRedis.eval.mockResolvedValue(1);
    redisMock.sysRedis.sAdd.mockResolvedValueOnce(0);

    await expect(vote()).rejects.toThrow('already voted');

    expect([judgeVotes('10'), judgeVotes('20')]).toEqual([0, 0]);
  });

  it('gives the counts back when the rating update fails', async () => {
    const { judgeVotes } = useFakeRedis();
    redisMock.sysRedis.eval.mockResolvedValue(1);
    processVote.mockRejectedValueOnce(new Error('rating script failed'));

    await expect(vote()).rejects.toThrow('rating script failed');

    expect([judgeVotes('10'), judgeVotes('20')]).toEqual([0, 0]);
  });
});

describe('submitVote — the ClickHouse vote row', () => {
  // The vote path builds its Tracker without a request or session, so the voter has to be
  // passed in: the actor's userId on such a Tracker is 0, and every row read 0 until it was.
  it('records the judge who voted, not the anonymous actor', async () => {
    await vote(10, 20);
    await new Promise((r) => setImmediate(r));

    const rows = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/track/crucible_votes'))
      .map(([, init]) => JSON.parse((init as { body: string }).body));
    expect(rows, 'crucible_votes rows sent').toHaveLength(1);
    expect(rows[0], 'crucible_votes row').toMatchObject({
      userId: JUDGE,
      crucibleId: 1,
      winnerEntryId: 10,
      loserEntryId: 20,
    });
  });
});
