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

const { getJudgingPair, getJudgingProgress, RECORD_VOTED_PAIR_SCRIPT, submitVote } = await import(
  '~/server/services/crucible.service'
);
const { getAnchorVotesKey, getJudgesKey, getVoteOutcomesKey, getVotedPairsKey } = await import(
  '~/server/services/crucible-redis-keys'
);
const { MAX_CLOSURE_VOTES } = await import('~/server/services/crucible-judge-closure');

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
  sysRedis.eval.mockImplementation(
    async (script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) => {
      // The voted record: SADD the pair, and only when added, HSET its anchor.
      if (script === RECORD_VOTED_PAIR_SCRIPT) {
        const set = sets.get(keys[0]) ?? new Set<string>();
        sets.set(keys[0], set);
        if (set.has(args[0])) return 0;
        set.add(args[0]);
        if (args[1]) {
          const hash = hashes.get(keys[1]) ?? new Map<string, number>();
          hashes.set(keys[1], hash);
          hash.set(args[0], Number(args[1]));
        }
        return 1;
      }
      // The served-pair claim: deletes the key only while it still holds this pair.
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
  sysRedis.sCard.mockImplementation(async (key: string) => sets.get(key)?.size ?? 0);
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
    redisMock.sysRedis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

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

  const outcomes = () =>
    redisMock.sysRedis.sMembers(`${REDIS_SYS_KEYS.CRUCIBLE.VOTE_OUTCOMES}:1:${JUDGE}`);

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
    const sAdd = redisMock.sysRedis.sAdd.getMockImplementation()!;
    redisMock.sysRedis.sAdd.mockImplementation(async (key: string, value: string) => {
      if (key.startsWith(REDIS_SYS_KEYS.CRUCIBLE.VOTE_OUTCOMES)) throw new Error('redis down');
      return sAdd(key, value);
    });

    await expect(judge(10, 20)).resolves.toBeUndefined();
    expect(processVote).toHaveBeenCalledTimes(1);
  });

  it('decides only from this judge’s votes, never another judge’s', async () => {
    withEntries(10, 20, 30);
    await redisMock.sysRedis.sAdd(
      `${REDIS_SYS_KEYS.CRUCIBLE.VOTE_OUTCOMES}:1:${JUDGE + 1}`,
      '10>20'
    );
    await redisMock.sysRedis.sAdd(
      `${REDIS_SYS_KEYS.CRUCIBLE.VOTE_OUTCOMES}:1:${JUDGE + 1}`,
      '20>30'
    );
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
    const recorded = await redisMock.sysRedis.hGetAll(getAnchorVotesKey(1, JUDGE));
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
      await redisMock.sysRedis.sAdd(outcomesKey, `${1000 + i}>${2000 + i}`);
    await judge(10, 20); // the 201st outcome
    await judge(10, 30);
    expect(processVote).toHaveBeenCalledTimes(2);

    const capLogs = loggingMock.logToAxiom.mock.calls.filter(
      ([entry]) => (entry as { name?: string }).name === 'crucible-closure-cap'
    );
    expect(capLogs, 'closure-cap logs').toHaveLength(1);
    redisMock.sysRedis.sMembers.mockClear();
    await serve();
    const outcomeReads = redisMock.sysRedis.sMembers.mock.calls.filter(
      ([key]) => key === outcomesKey
    );
    expect(outcomeReads, 'outcome set reads past the cap').toHaveLength(0);
  });

  it('writes the voted-pairs and judges keys the Bradley-Terry guard counts', async () => {
    withEntries(10, 20, 30);
    await judge(10, 20);
    await judge(30, 20);

    // The guard reads these same helpers (pinned on its side in crucible-bradley-terry.test).
    expect(await redisMock.sysRedis.sCard(getVotedPairsKey(1, JUDGE))).toBe(2);
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
    expect(await redisMock.sysRedis.hGetAll(getAnchorVotesKey(1, JUDGE))).toEqual({
      '10:20': '20',
    });
  });
});
