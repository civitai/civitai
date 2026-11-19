import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY } from '~/shared/constants/crucible.constants';
import {
  CrucibleIngestionStatus,
  CrucibleStatus,
  ImageIngestionStatus,
  MediaType,
} from '~/shared/utils/prisma/enums';
import { dbMock, loggingMock, redisMock } from '~/__tests__/mocks';
import { DEL_IF_VALUE_SCRIPT } from '~/server/redis/atomic';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { dismissJudgingPairSchema, submitVoteSchema } from '~/server/schema/crucible.schema';
import type * as CrucibleEloRedis from '~/server/redis/crucible-elo.redis';
import type * as CrucibleEloService from '~/server/services/crucible-elo.service';
import { rejectCrossSlot } from '~/__tests__/cluster-slots';

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

const {
  dismissJudgingPair,
  DISMISS_SERVED_PAIR_SCRIPT,
  getJudgingPair,
  getJudgingProgress,
  RECORD_VOTED_PAIR_SCRIPT,
  submitVote,
  VOTE_OUTCOMES_SYS_FALLBACK_UNTIL,
} = await import('~/server/services/crucible.service');
const {
  getAnchorVotesKey,
  getDismissedPairsKey,
  getJudgesKey,
  getVoteOutcomesKey,
  getVotedPairsKey,
} = await import('~/server/services/crucible-redis-keys');
const { MAX_CLOSURE_VOTES } = await import('~/server/services/crucible-judge-closure');

const JUDGE = 42;
const JUDGE_ENTRY_VOTES_KEY = `${REDIS_SYS_KEYS.CRUCIBLE.JUDGE_ENTRY_VOTES}:1:${JUDGE}`;
const vote = (winnerEntryId = 10, loserEntryId = 20) =>
  submitVote({ crucibleId: 1, winnerEntryId, loserEntryId, userId: JUDGE });

/** Set commands with Redis semantics over `sets`, installed on one client's mock. */
const fakeSetCommands = (client: typeof redisMock.sysRedis, sets: Map<string, Set<string>>) => {
  client.sAdd.mockImplementation(async (key: string, value: string) => {
    const set = sets.get(key) ?? new Set<string>();
    sets.set(key, set);
    if (set.has(value)) return 0;
    set.add(value);
    return 1;
  });
  client.sRem.mockImplementation(async (key: string, value: string) =>
    sets.get(key)?.delete(value) ? 1 : 0
  );
  client.sMembers.mockImplementation(async (key: string) => [...(sets.get(key) ?? [])]);
  client.sCard.mockImplementation(async (key: string) => sets.get(key)?.size ?? 0);
};

/**
 * In-memory stand-in for the Redis commands the vote path uses, with Redis semantics. The cache
 * cluster (`redis`) gets its own sets and hashes, so a key written to one client is never read
 * from the other, and it refuses a script whose keys are not in one slot (CROSSSLOT).
 */
const useFakeRedis = () => {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Map<string, number>>();
  const clusterHashes = new Map<string, Map<string, string>>();
  const { sysRedis } = redisMock;
  const clusterSets = new Map<string, Set<string>>();
  fakeSetCommands(redisMock.redis, clusterSets);
  redisMock.redis.hGetAll.mockImplementation(async (key: string) =>
    Object.fromEntries(clusterHashes.get(key) ?? [])
  );
  redisMock.redis.eval.mockImplementation(
    async (script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) => {
      rejectCrossSlot(keys);
      if (script !== RECORD_VOTED_PAIR_SCRIPT) throw new Error('unexpected cluster script');
      // The voted record: SADD the pair, and only when added, HSET its anchor.
      const set = clusterSets.get(keys[0]) ?? new Set<string>();
      clusterSets.set(keys[0], set);
      if (set.has(args[0])) return 0;
      set.add(args[0]);
      if (args[1]) {
        const hash = clusterHashes.get(keys[1]) ?? new Map<string, string>();
        clusterHashes.set(keys[1], hash);
        hash.set(args[0], args[1]);
      }
      return 1;
    }
  );
  sysRedis.set.mockImplementation(async (key: string, value: string) => {
    sets.delete(key);
    strings.set(key, value);
    return 'OK';
  });
  sysRedis.eval.mockImplementation(
    async (script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) => {
      // The dismissal: claims the served pair (with or without its anchor) into the dismissed set.
      if (script === DISMISS_SERVED_PAIR_SCRIPT) {
        const served = strings.get(keys[0]);
        if (served === undefined || (served !== args[0] && !served.startsWith(`${args[0]}|`)))
          return 0;
        strings.delete(keys[0]);
        const set = sets.get(keys[1]) ?? new Set<string>();
        sets.set(keys[1], set);
        set.add(args[0]);
        return 1;
      }
      // The served-pair claim: deletes the key only while it still holds this pair.
      if (strings.get(keys[0]) !== args[0]) return 0;
      strings.delete(keys[0]);
      return 1;
    }
  );
  fakeSetCommands(sysRedis, sets);
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
        blockedCreatorIds: [500],
      })
    ).rejects.toThrow('Crucible not found');
    expect(processVote).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.eval).not.toHaveBeenCalled();
    expect(redisMock.redis.eval).not.toHaveBeenCalled();
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

    expect(redisMock.sysRedis.eval).toHaveBeenCalledWith(DEL_IF_VALUE_SCRIPT, {
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
    expect(redisMock.redis.eval, 'voted record').not.toHaveBeenCalled();
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
    expect(redisMock.redis.eval).not.toHaveBeenCalled();
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

      expect(redisMock.sysRedis.eval).toHaveBeenCalledWith(DEL_IF_VALUE_SCRIPT, {
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
    // The served-pair claim succeeds; the voted record finds the pair already there.
    redisMock.sysRedis.eval.mockResolvedValue(1);
    await redisMock.redis.sAdd(getVotedPairsKey(1, JUDGE), '10:20');

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

describe('judge-side skip — pairs this judge’s own votes already decide', () => {
  const rawEntry = (id: number) => ({
    id,
    crucibleId: 1,
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
  const withEntries = (...entryIds: number[]) =>
    dbMock.dbRead.$queryRaw.mockResolvedValue(entryIds.map(rawEntry));
  const serve = async () => {
    const pair = await getJudgingPair({ crucibleId: 1, userId: JUDGE });
    return pair ? [pair.left.id, pair.right.id].sort((a, b) => a - b) : null;
  };
  /** Serves the judge `winner`-`loser`, then votes `winner` the better. */
  const judge = async (winner: number, loser: number) => {
    await redisMock.sysRedis.set(
      `${REDIS_SYS_KEYS.CRUCIBLE.SERVED_PAIR}:1:${JUDGE}`,
      `${Math.min(winner, loser)}:${Math.max(winner, loser)}`
    );
    await vote(winner, loser);
  };

  const activeCrucible = () =>
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
  /** Sets the clock (Date only; timers stay real) to `at` for the rest of the test. */
  const atTime = (at: number) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    onTestFinished(() => {
      vi.useRealTimers();
    });
    activeCrucible();
  };

  beforeEach(() => {
    activeCrucible();
    useFakeRedis();
  });

  it('never serves A-C to a judge who voted A>B and B>C', async () => {
    withEntries(10, 20, 30);
    await judge(10, 20);
    await judge(20, 30);

    // 10-30 is the only pair left unvoted, and the two votes already answer it.
    expect(await serve(), 'pair served after A>B, B>C').toBeNull();
    const progress = await getJudgingProgress({ crucibleId: 1, userId: JUDGE });
    expect(progress, 'progress agrees nothing is left').toMatchObject({
      remainingPairs: 0,
      // Two votes, two judged pairs: the settled 10-30 comes off the total, not onto judged.
      judgedPairs: 2,
      totalPairs: 2,
      votesUsedUp: true,
    });
  });

  it('skips every pair a longer chain decides: A>B>C>D skips A-C, B-D and A-D', async () => {
    withEntries(10, 20, 30, 40);
    await judge(10, 20);
    await judge(20, 30);
    await judge(30, 40);

    expect(await serve(), 'pair served after A>B>C>D').toBeNull();
  });

  it('still serves a pair the judge’s votes point both ways on', async () => {
    // A>B>C>D>A: every unvoted pair (A-C, B-D) is reached in both directions.
    withEntries(10, 20, 30, 40);
    await judge(10, 20);
    await judge(20, 30);
    await judge(30, 40);
    await judge(40, 10);

    expect([['10', '30'].join(), ['20', '40'].join()]).toContain(String(await serve()));
  });

  const outcomes = () => redisMock.redis.sMembers(getVoteOutcomesKey(1, JUDGE));

  it('records no outcome for a vote that was refused or failed', async () => {
    withEntries(10, 20, 30);
    // Refused: 10-30 was never served.
    await redisMock.sysRedis.set(`${REDIS_SYS_KEYS.CRUCIBLE.SERVED_PAIR}:1:${JUDGE}`, '10:20');
    await expect(vote(10, 30)).rejects.toThrow('no longer available');
    // Failed: the rating update throws.
    processVote.mockRejectedValueOnce(new Error('redis down'));
    await expect(judge(10, 20)).rejects.toThrow('redis down');

    expect(await outcomes(), 'outcomes after a refused and a failed vote').toEqual([]);
    await judge(20, 30);
    expect(await outcomes(), 'outcomes after a counted vote').toEqual(['20>30']);
  });

  it('still accepts a vote whose outcome could not be stored', async () => {
    withEntries(10, 20, 30);
    redisMock.redis.sAdd.mockRejectedValue(new Error('redis down'));

    await expect(judge(10, 20)).resolves.toBeUndefined();
    expect(processVote).toHaveBeenCalledTimes(1);
  });

  it('keeps the outcomes on the cache cluster, never on sysRedis', async () => {
    withEntries(10, 20, 30);
    await judge(10, 20);

    expect(await outcomes(), 'outcomes on the cache cluster').toEqual(['10>20']);
    const { sysRedis } = redisMock;
    const sysOutcomeCalls = Object.entries({
      sAdd: sysRedis.sAdd,
      sCard: sysRedis.sCard,
      sMembers: sysRedis.sMembers,
      expire: sysRedis.expire,
    }).flatMap(([command, fn]) =>
      fn.mock.calls.filter(([key]) => key === getVoteOutcomesKey(1, JUDGE)).map(() => command)
    );
    expect(sysOutcomeCalls, 'sysRedis commands on the outcomes key').toEqual([]);
    expect(redisMock.redis.expire, 'TTL on the cache cluster').toHaveBeenCalledWith(
      getVoteOutcomesKey(1, JUDGE),
      30 * 24 * 60 * 60
    );
  });

  it('skips a pair from outcomes read off the cache cluster', async () => {
    withEntries(10, 20, 30);
    // Voted 10-20 and 20-30, with both outcomes on the cache cluster.
    await redisMock.redis.sAdd(getVotedPairsKey(1, JUDGE), '10:20');
    await redisMock.redis.sAdd(getVotedPairsKey(1, JUDGE), '20:30');
    await redisMock.redis.sAdd(getVoteOutcomesKey(1, JUDGE), '10>20');
    await redisMock.redis.sAdd(getVoteOutcomesKey(1, JUDGE), '20>30');

    expect(await serve(), 'pair served after A>B, B>C').toBeNull();
  });

  const sysOutcomesKey = `${REDIS_SYS_KEYS.CRUCIBLE.VOTE_OUTCOMES}:1:${JUDGE}`;
  const beforeCutoff = () => atTime(VOTE_OUTCOMES_SYS_FALLBACK_UNTIL.getTime() - 1);
  /** Voted 10-20 and 20-30, with both outcomes on sysRedis and none on the cache cluster. */
  const withSysOnlyOutcomes = async () => {
    await redisMock.redis.sAdd(getVotedPairsKey(1, JUDGE), '10:20');
    await redisMock.redis.sAdd(getVotedPairsKey(1, JUDGE), '20:30');
    await redisMock.sysRedis.sAdd(sysOutcomesKey, '10>20');
    await redisMock.sysRedis.sAdd(sysOutcomesKey, '20>30');
  };
  const sysOutcomeReads = () =>
    [redisMock.sysRedis.sCard, redisMock.sysRedis.sMembers].flatMap((fn) =>
      fn.mock.calls.filter(([key]) => key === sysOutcomesKey)
    );

  it('skips a pair from outcomes found only on sysRedis', async () => {
    beforeCutoff();
    withEntries(10, 20, 30);
    await withSysOnlyOutcomes();

    expect(await serve(), 'pair served after A>B, B>C').toBeNull();
  });

  it('skips a pair from outcomes split between sysRedis and the cache cluster', async () => {
    beforeCutoff();
    withEntries(10, 20, 30);
    // Voted 10-20 with its outcome on sysRedis, and 20-30 with its outcome on the cache cluster.
    await redisMock.redis.sAdd(getVotedPairsKey(1, JUDGE), '10:20');
    await redisMock.redis.sAdd(getVotedPairsKey(1, JUDGE), '20:30');
    await redisMock.sysRedis.sAdd(sysOutcomesKey, '10>20');
    await redisMock.redis.sAdd(getVoteOutcomesKey(1, JUDGE), '20>30');

    expect(await serve(), 'pair served after A>B, B>C').toBeNull();
    const progress = await getJudgingProgress({ crucibleId: 1, userId: JUDGE });
    expect(progress, 'progress agrees nothing is left').toMatchObject({ remainingPairs: 0 });
  });

  it('reads no outcomes from sysRedis from the cutoff on', async () => {
    atTime(VOTE_OUTCOMES_SYS_FALLBACK_UNTIL.getTime());
    withEntries(10, 20, 30);
    await withSysOnlyOutcomes();

    expect(await serve(), 'pair served without the sysRedis outcomes').toEqual([10, 30]);
    expect(sysOutcomeReads(), 'sysRedis outcome reads').toEqual([]);
  });

  it('reads no outcomes from sysRedis while the cache cluster has them all', async () => {
    beforeCutoff();
    withEntries(10, 20, 30);
    await judge(10, 20);
    await judge(20, 30);

    expect(await serve(), 'pair served after A>B, B>C').toBeNull();
    expect(sysOutcomeReads(), 'sysRedis outcome reads').toEqual([]);
  });

  it('counts an outcome on both sysRedis and the cache cluster once', async () => {
    beforeCutoff();
    withEntries(10, 20, 30, 40);
    // Voted A>B>C>D>A; D>A's outcome is on neither, and A>B is on both. Counted twice, A>B would
    // make the set look whole and the chain would decide A-C and B-D, which the cycle leaves open.
    for (const pair of ['10:20', '20:30', '30:40', '10:40'])
      await redisMock.redis.sAdd(getVotedPairsKey(1, JUDGE), pair);
    for (const outcome of ['10>20', '20>30', '30>40'])
      await redisMock.redis.sAdd(getVoteOutcomesKey(1, JUDGE), outcome);
    await redisMock.sysRedis.sAdd(sysOutcomesKey, '10>20');

    expect([['10', '30'].join(), ['20', '40'].join()]).toContain(String(await serve()));
    expect(sysOutcomeReads().length, 'sysRedis outcome reads').toBeGreaterThan(0);
  });

  it('still serves pairs, and logs a warning, when sysRedis outcomes cannot be read', async () => {
    beforeCutoff();
    withEntries(10, 20, 30);
    await withSysOnlyOutcomes();
    const sCard = redisMock.sysRedis.sCard.getMockImplementation()!;
    redisMock.sysRedis.sCard.mockImplementation(async (key: string) =>
      key === sysOutcomesKey ? Promise.reject(new Error('sysRedis down')) : sCard(key)
    );

    expect(await serve(), 'pair served without the sysRedis outcomes').toEqual([10, 30]);
    const warnings = loggingMock.logToAxiom.mock.calls.filter(([entry]) => {
      const { name, type, message } = entry as { name?: string; type?: string; message?: string };
      return (
        name === 'crucible-vote-outcomes' && type === 'warning' && !!message?.includes('sysRedis')
      );
    });
    expect(warnings, 'sysRedis read-failure warnings').toHaveLength(1);
  });

  it('still serves pairs when the sysRedis outcomes read never answers', async () => {
    beforeCutoff();
    withEntries(10, 20, 30);
    await withSysOnlyOutcomes();
    const sCard = redisMock.sysRedis.sCard.getMockImplementation()!;
    redisMock.sysRedis.sCard.mockImplementation(async (key: string) =>
      key === sysOutcomesKey ? new Promise<number>(() => undefined) : sCard(key)
    );
    // The real deadline, shortened: only it answers the hung read.
    const deadline = redisMock.withSysReadDeadline.getMockImplementation()!;
    redisMock.withSysReadDeadline.mockImplementation((p: Promise<unknown>) => deadline(p, 20));
    onTestFinished(() => {
      redisMock.withSysReadDeadline.mockImplementation(deadline);
    });

    expect(await serve(), 'pair served without the sysRedis outcomes').toEqual([10, 30]);
  });

  it('ignores an outcomes set that lost a vote, so a broken cycle decides nothing', async () => {
    withEntries(10, 20, 30, 40);
    // Voted A>B>C>D>A, but D>A's outcome is missing (written before the key moved, or evicted).
    // The full set is a cycle that leaves A-C and B-D open; the partial chain would decide them.
    for (const pair of ['10:20', '20:30', '30:40', '10:40'])
      await redisMock.redis.sAdd(getVotedPairsKey(1, JUDGE), pair);
    for (const outcome of ['10>20', '20>30', '30>40'])
      await redisMock.redis.sAdd(getVoteOutcomesKey(1, JUDGE), outcome);

    expect([['10', '30'].join(), ['20', '40'].join()]).toContain(String(await serve()));
  });

  it('logs a warning when the outcomes cannot be read', async () => {
    withEntries(10, 20, 30);
    redisMock.redis.sCard.mockRejectedValue(new Error('redis down'));
    await serve();

    const warnings = loggingMock.logToAxiom.mock.calls.filter(([entry]) => {
      const { name, type } = entry as { name?: string; type?: string };
      return name === 'crucible-vote-outcomes' && type === 'warning';
    });
    expect(warnings.length, 'read-failure warnings').toBeGreaterThan(0);
  });

  it('still serves pairs when the outcomes cannot be read', async () => {
    withEntries(10, 20, 30);
    await judge(10, 20);
    await judge(20, 30);
    redisMock.redis.sCard.mockRejectedValue(new Error('redis down'));
    // Only the outcomes: the voted pairs are read from the same client.
    const sMembers = redisMock.redis.sMembers.getMockImplementation()!;
    redisMock.redis.sMembers.mockImplementation(async (key: string) =>
      key === getVoteOutcomesKey(1, JUDGE) ? Promise.reject(new Error('redis down')) : sMembers(key)
    );

    // Without the outcomes nothing is decided, so the one unvoted pair is served again.
    expect(await serve(), 'pair served without outcomes').toEqual([10, 30]);
    expect(await getJudgingProgress({ crucibleId: 1, userId: JUDGE })).toMatchObject({
      remainingPairs: 1,
      judgedPairs: 2,
    });
  });

  it('decides only from this judge’s votes, never another judge’s', async () => {
    withEntries(10, 20, 30);
    await redisMock.redis.sAdd(getVoteOutcomesKey(1, JUDGE + 1), '10>20');
    await redisMock.redis.sAdd(getVoteOutcomesKey(1, JUDGE + 1), '20>30');
    await judge(10, 20);

    expect(await serve(), 'next pair for this judge').not.toBeNull();
  });

  it('progress reaches zero exactly when the next serve is empty, judging 8 entries', async () => {
    const ids = [10, 20, 30, 40, 50, 60, 70, 80];
    withEntries(...ids);
    let votes = 0;
    for (;;) {
      const { remainingPairs } = await getJudgingProgress({ crucibleId: 1, userId: JUDGE });
      const pair = await serve();
      expect(remainingPairs === 0, `remaining ${remainingPairs}, served ${pair}`).toBe(
        pair === null
      );
      if (!pair) break;
      // A consistent judge: the lower id is always the better entry. The pair just served is the
      // one voted, anchor and all.
      await vote(pair[0], pair[1]);
      votes++;
      if (votes > 28) throw new Error('served more pairs than 8 entries have');
    }
    // No assertion on votes: the per-entry cap alone stops a judge near 21, which overlaps the
    // skip's spread, so a count would be flaky.
  });

  it('records as the anchor exactly the side Elo froze, vote for vote', async () => {
    const ids = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
    withEntries(...ids);
    // Pairing draws from Math.random; a seeded sequence makes this run the same every time.
    let seed = 7; // a seed whose run judges anchor votes; the first expect below checks it does
    const random = vi
      .spyOn(Math, 'random')
      .mockImplementation(() => (seed = (seed * 16807) % 2147483647) / 2147483647);
    onTestFinished(() => random.mockRestore());
    const cast: [number, number][] = [];
    // An intransitive judge, so cycles keep pairs servable until entries reach the cap; a
    // consistent one is sorted by the skip before any entry does.
    for (let pair = await serve(); pair; pair = await serve()) {
      const [winner, loser] = ((pair[0] + pair[1]) / 10) % 2 ? pair : [pair[1], pair[0]];
      await vote(winner, loser);
      cast.push([winner, loser]);
      if (cast.length > 66) throw new Error('served more pairs than 12 entries have');
    }
    const eloFrozen = processVote.mock.calls.map((call) => call[4]);
    expect(eloFrozen.filter(Boolean).length, 'anchor votes judged').toBeGreaterThan(0);
    const recorded = await redisMock.redis.hGetAll(getAnchorVotesKey(1, JUDGE));
    const recordedFrozen = cast.map(([winner, loser]) => {
      const anchor = recorded[`${Math.min(winner, loser)}:${Math.max(winner, loser)}`];
      return anchor === String(winner) ? 'winner' : anchor === String(loser) ? 'loser' : undefined;
    });
    expect(recordedFrozen).toEqual(eloFrozen);
  });

  it('logs once when a judge passes the closure cap, then stops loading their outcomes', async () => {
    withEntries(10, 20, 30);
    const outcomesKey = getVoteOutcomesKey(1, JUDGE);
    for (let i = 0; i < MAX_CLOSURE_VOTES; i++)
      await redisMock.redis.sAdd(outcomesKey, `${1000 + i}>${2000 + i}`);
    await judge(10, 20); // the 201st outcome
    await judge(10, 30);
    expect(processVote).toHaveBeenCalledTimes(2);

    const capLogs = loggingMock.logToAxiom.mock.calls.filter(
      ([entry]) => (entry as { name?: string }).name === 'crucible-closure-cap'
    );
    expect(capLogs, 'closure-cap logs').toHaveLength(1);
    redisMock.redis.sMembers.mockClear();
    await serve();
    const outcomeReads = redisMock.redis.sMembers.mock.calls.filter(([key]) => key === outcomesKey);
    expect(outcomeReads, 'outcome set reads past the cap').toHaveLength(0);
  });

  it('writes the voted-pairs and judges keys the Bradley-Terry guard counts', async () => {
    withEntries(10, 20, 30);
    await judge(10, 20);
    await judge(30, 20);

    // The guard reads these same helpers (pinned on its side in crucible-bradley-terry.test).
    expect(await redisMock.redis.sCard(getVotedPairsKey(1, JUDGE))).toBe(2);
    expect(await redisMock.sysRedis.sMembers(getJudgesKey(1))).toEqual([String(JUDGE)]);
  });

  it('records the anchor under the key the fit reads, in the same script as the voted pair', async () => {
    withEntries(10, 20);
    await redisMock.sysRedis.hIncrBy(
      JUDGE_ENTRY_VOTES_KEY,
      '20',
      CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY
    );
    await redisMock.sysRedis.set(
      `${REDIS_SYS_KEYS.CRUCIBLE.SERVED_PAIR}:1:${JUDGE}`,
      '10:20|anchor:20'
    );
    await vote(10, 20);

    expect(processVote.mock.calls[0][4], 'Elo froze').toBe('loser');
    expect(await redisMock.redis.hGetAll(getAnchorVotesKey(1, JUDGE))).toEqual({
      '10:20': '20',
    });
  });

  it('keeps the voted pairs and anchors on the cache cluster, never on sysRedis', async () => {
    withEntries(10, 20);
    await redisMock.sysRedis.hIncrBy(
      JUDGE_ENTRY_VOTES_KEY,
      '20',
      CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY
    );
    await redisMock.sysRedis.set(
      `${REDIS_SYS_KEYS.CRUCIBLE.SERVED_PAIR}:1:${JUDGE}`,
      '10:20|anchor:20'
    );
    await vote(10, 20);
    await serve();

    const judgeKeys = [getVotedPairsKey(1, JUDGE), getAnchorVotesKey(1, JUDGE)];
    /** Commands on `client` whose arguments name either key, as the command names. */
    const callsNaming = (client: typeof redisMock.sysRedis) =>
      Object.entries({
        eval: client.eval,
        sAdd: client.sAdd,
        sCard: client.sCard,
        sMembers: client.sMembers,
        hGetAll: client.hGetAll,
        hSet: client.hSet,
        expire: client.expire,
      }).flatMap(([command, fn]) =>
        fn.mock.calls
          .filter((args: unknown[]) => judgeKeys.some((key) => JSON.stringify(args).includes(key)))
          .map(() => command)
      );
    // The cluster side shows the filter sees the vote's write and the serve's read, so the empty
    // sysRedis side means none went there.
    expect(callsNaming(redisMock.redis), 'cache cluster commands').toEqual(
      expect.arrayContaining(['eval', 'sMembers'])
    );
    expect(callsNaming(redisMock.sysRedis), 'sysRedis commands').toEqual([]);
    expect(await redisMock.redis.sMembers(judgeKeys[0]), 'voted on the cluster').toEqual(['10:20']);
    expect(await redisMock.redis.hGetAll(judgeKeys[1]), 'anchor on the cluster').toEqual({
      '10:20': '20',
    });
  });

  describe("Don't show again", () => {
    const dismiss = (a: number, b: number) =>
      dismissJudgingPair({ crucibleId: 1, entryIds: [a, b], userId: JUDGE });

    it('rejects a pair of one entry twice at the schema; two entries parse', () => {
      expect(
        dismissJudgingPairSchema.safeParse({ crucibleId: 1, entryIds: [10, 10] }).success
      ).toBe(false);
      expect(
        dismissJudgingPairSchema.safeParse({ crucibleId: 1, entryIds: [10, 20] }).success
      ).toBe(true);
    });

    it('never serves a dismissed pair again; without the dismissal it comes back', async () => {
      withEntries(10, 20);
      expect(await serve()).toEqual([10, 20]);
      expect(await serve(), 'control: an undismissed pair is served again').toEqual([10, 20]);

      await dismiss(20, 10);
      expect(await serve(), 'served after dismissal').toBeNull();
    });

    it('keeps dismissed pairs out alongside the pairs the judge’s votes decide', async () => {
      withEntries(10, 20, 30);
      await judge(10, 20); // one outcome: the closure is computed, not skipped
      const dismissServed = async () => {
        const [a, b] = (await serve())!;
        await dismiss(a, b);
      };
      await dismissServed();
      await dismissServed();
      expect(await serve(), 'served once both remaining pairs are dismissed').toBeNull();
    });

    it('refuses a vote on the pair once it is dismissed; without the dismissal the vote counts', async () => {
      withEntries(10, 20);
      await serve();
      await vote(10, 20);
      expect(processVote, 'control: the served pair takes a vote').toHaveBeenCalledTimes(1);

      withEntries(10, 30);
      await serve();
      await dismiss(10, 30);
      await expect(vote(10, 30)).rejects.toThrow('This pair is no longer available');
      expect(processVote, 'votes counted after the dismissal').toHaveBeenCalledTimes(1);
    });

    it('dismisses only the pair on screen', async () => {
      withEntries(10, 20);
      await serve();
      await expect(dismiss(10, 30)).rejects.toThrow('This pair is no longer available');
      await vote(10, 20);
      expect(processVote, 'the served pair is still votable').toHaveBeenCalledTimes(1);
    });

    it('takes the pair off what is left without counting it as judged', async () => {
      withEntries(10, 20, 30);
      const before = await getJudgingProgress({ crucibleId: 1, userId: JUDGE });
      const [a, b] = (await serve())!;
      await dismiss(a, b);
      const after = await getJudgingProgress({ crucibleId: 1, userId: JUDGE });
      expect(after.judgedPairs, 'judged').toBe(before.judgedPairs);
      expect(after.remainingPairs, 'pairs left').toBe(before.remainingPairs - 1);
      expect(await redisMock.redis.sCard(getVotedPairsKey(1, JUDGE)), 'voted set').toBe(0);
    });

    it('still keeps a dismissed pair out past the closure cap', async () => {
      withEntries(10, 20);
      const outcomesKey = getVoteOutcomesKey(1, JUDGE);
      for (let i = 0; i <= MAX_CLOSURE_VOTES; i++)
        await redisMock.redis.sAdd(outcomesKey, `${1000 + i}>${2000 + i}`);
      await serve();
      await dismiss(10, 20);

      redisMock.redis.sMembers.mockClear();
      expect(await serve(), 'served after dismissal past the cap').toBeNull();
      const outcomeReads = redisMock.redis.sMembers.mock.calls.filter(
        ([key]) => key === outcomesKey
      );
      expect(outcomeReads, 'the cap path was taken: outcomes not loaded').toHaveLength(0);
    });

    describe('the dismissed set expires with the crucible', () => {
      const dismissTtl = () =>
        Number(
          redisMock.sysRedis.eval.mock.calls.find(
            ([script]) => script === DISMISS_SERVED_PAIR_SCRIPT
          )?.[1]?.arguments?.[1]
        );
      const withEndAt = async (endAt: Date | null) => {
        const crucible = await dbMock.dbRead.crucible.findUnique();
        dbMock.dbRead.crucible.findUnique.mockResolvedValue({ ...crucible, endAt });
      };

      it('sets the TTL to the time left until the crucible ends', async () => {
        await withEndAt(new Date(Date.now() + 2 * 60 * 60 * 1000));
        withEntries(10, 20);
        await serve();
        await dismiss(10, 20);
        expect(Math.abs(dismissTtl() - 2 * 60 * 60), 'seconds off two hours').toBeLessThan(5);
      });

      it('falls back to the judge-key TTL for a crucible with no end', async () => {
        await withEndAt(null);
        withEntries(10, 20);
        await serve();
        await dismiss(10, 20);
        expect(dismissTtl()).toBe(30 * 24 * 60 * 60);
      });

      it('refuses a dismissal once the crucible has ended', async () => {
        withEntries(10, 20);
        await serve();
        await withEndAt(new Date(Date.now() - 1000));
        await expect(dismiss(10, 20)).rejects.toThrow('not currently active for judging');
        expect(await redisMock.sysRedis.sCard(getDismissedPairsKey(1, JUDGE)), 'dismissed').toBe(0);
      });
    });
  });
});
