import { beforeEach, describe, expect, it, vi } from 'vitest';

const chQuery = vi.hoisted(() => vi.fn());
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: { query: chQuery },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import {
  buildActivityProgress,
  buildSecretMilestones,
  getCreatorJourney,
  getCreatorScoreLadder,
  getFirstPublishCard,
  maskUnearnedMilestone,
} from '~/server/services/creator-journey.service';
import { FIRST_PUBLISH_CARD_DAYS } from '~/shared/constants/creator-journey.constants';
import {
  judgeVoteCountSql,
  ledgerWinCountSql,
} from '~/server/services/creator-milestone-detectors';

const definition = (overrides: Partial<Parameters<typeof maskUnearnedMilestone>[0]> = {}) => ({
  key: 'hidden:remix',
  track: 'hidden',
  threshold: null,
  hidden: true,
  hint: 'Someone builds on your work',
  name: 'Remixed',
  description: 'Someone remixed your model.',
  ...overrides,
});

describe('maskUnearnedMilestone', () => {
  it('masks a hidden milestone the viewer has not earned, keeping only its hint', () => {
    expect(maskUnearnedMilestone(definition(), false, 'slot-3')).toMatchObject({
      key: 'hidden:slot-3',
      name: '???',
      description: null,
      hint: 'Someone builds on your work',
    });
  });

  it('reveals it once earned', () => {
    expect(maskUnearnedMilestone(definition(), true, 'slot').name).toBe('Remixed');
  });

  // The `hidden` TRACK is a grouping label; only the per-row flag masks.
  it('does not mask a row in the hidden track whose flag is off', () => {
    expect(maskUnearnedMilestone(definition({ hidden: false }), false, 'slot').name).toBe(
      'Remixed'
    );
  });

  it('masks a flagged row in any track', () => {
    expect(
      maskUnearnedMilestone(definition({ track: 'score', threshold: 500 }), false, 'slot').name
    ).toBe('???');
  });
});

describe('getCreatorJourney', () => {
  it('tolerates zero milestone rows and a user with no scores', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({ meta: {} } as never);

    const journey = await getCreatorJourney(1);

    expect(journey.scores).toBeNull();
    expect(journey.tiers).toEqual([]);
    expect(journey.earned).toEqual([]);
    expect(journey.unlocks.length).toBeGreaterThan(0);
  });

  it('reads only the viewer’s own achievements', async () => {
    await getCreatorJourney(42);

    expect(dbMock.dbRead.userCreatorMilestone.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 42 } })
    );
    expect(dbMock.dbRead.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 42 } })
    );
  });

  it('compares aggregate gates against the larger of the category sum and the total', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      meta: { scores: { total: 100, models: 300, images: 50, reportsAgainst: -20 } },
    } as never);

    const { scores } = await getCreatorJourney(1);

    expect(scores).toMatchObject({ total: 100, aggregate: 330 });
  });

  it('keeps the total when the categories sum to less', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      meta: { scores: { total: 900, models: 300 } },
    } as never);

    expect((await getCreatorJourney(1)).scores).toMatchObject({ total: 900, aggregate: 900 });
  });

  it('reads only score-track tiers that have a threshold', async () => {
    dbMock.dbRead.creatorMilestone.findMany.mockClear();
    await getCreatorJourney(1);
    await getCreatorScoreLadder();

    const calls = dbMock.dbRead.creatorMilestone.findMany.mock.calls.map(([args]) => args);
    const tierCalls = calls.filter((args) => !('key' in (args?.where ?? {})));
    expect(tierCalls).toHaveLength(2);
    for (const args of tierCalls)
      expect(args).toMatchObject({ where: { track: 'score', threshold: { not: null } } });
  });

  it('masks an unearned hidden tier and reveals an earned one', async () => {
    const hiddenTier = { ...definition({ key: 'score:secret', track: 'score', threshold: 777 }) };
    dbMock.dbRead.creatorMilestone.findMany.mockResolvedValue([hiddenTier] as never);

    expect((await getCreatorJourney(1)).tiers[0].name).toBe('???');

    dbMock.dbRead.userCreatorMilestone.findMany.mockResolvedValue([
      { achievedAt: new Date('2026-10-01'), milestone: hiddenTier },
    ] as never);

    const journey = await getCreatorJourney(1);
    expect(journey.tiers[0].name).toBe('Remixed');
    expect(journey.earned).toEqual([
      expect.objectContaining({ key: 'score:secret', achievedAt: new Date('2026-10-01') }),
    ]);
  });
});

describe('earned dates', () => {
  // A silent grant with no moment of its own stamps achievedAt and seenAt together.
  it('withholds the date of a grant whose moment was never observed', async () => {
    const at = new Date('2026-10-07T01:20:00Z');
    const followers = definition({
      key: 'reach:followers-100',
      track: 'reach',
      threshold: 100,
      hidden: false,
    });
    dbMock.dbRead.creatorMilestone.findMany.mockImplementation((async (args: {
      where?: { key?: unknown };
    }) => (args?.where?.key ? [followers] : [])) as never);
    dbMock.dbRead.userCreatorMilestone.findMany.mockClear();
    dbMock.dbRead.userCreatorMilestone.findMany.mockResolvedValue([
      { achievedAt: at, seenAt: at, milestone: followers },
      {
        achievedAt: new Date('2026-01-05'),
        seenAt: at,
        milestone: definition({ key: 'create:models-5' }),
      },
    ] as never);

    const { earned, activity } = await getCreatorJourney(1);
    expect(earned.map((badge) => [badge.key, badge.achievedAt])).toEqual([
      ['reach:followers-100', null],
      ['create:models-5', new Date('2026-01-05')],
    ]);
    expect(activity.milestones).toEqual([
      expect.objectContaining({ key: 'reach:followers-100', earned: true, achievedAt: null }),
    ]);
    // The mock returns seenAt whatever is selected; without it every row reads as observed.
    expect(dbMock.dbRead.userCreatorMilestone.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ seenAt: true }) })
    );
  });
});

describe('getCreatorScoreLadder', () => {
  it('masks every hidden tier, since nobody has earned anything here', async () => {
    dbMock.dbRead.creatorMilestone.findMany.mockResolvedValue([
      definition({ key: 'score:secret', track: 'score', threshold: 777 }),
    ] as never);

    // The key carries the name by convention (`score:spark` is Spark), so it is masked too.
    expect((await getCreatorScoreLadder()).tiers).toEqual([
      {
        key: 'hidden:tier-0',
        name: '???',
        threshold: 777,
        hint: 'Someone builds on your work',
        badgeUrl: null,
      },
    ]);
  });
});

describe('tier badge art', () => {
  const spark = {
    ...definition({ key: 'score:spark', track: 'score', threshold: 500, hidden: false }),
    name: 'Spark',
    cosmetic: { data: { url: 'spark-image-id' } },
  };

  // The achievements query selects no cosmetic, so the earned row carries none: its art has to
  // come from the tier query.
  const { cosmetic: _, ...sparkAsAchievement } = spark;

  it('carries the cosmetic image onto the tier and onto the earned badge', async () => {
    dbMock.dbRead.creatorMilestone.findMany.mockResolvedValue([spark] as never);
    dbMock.dbRead.userCreatorMilestone.findMany.mockResolvedValue([
      { achievedAt: new Date('2026-10-01'), milestone: sparkAsAchievement },
    ] as never);

    const journey = await getCreatorJourney(1);

    expect(journey.tiers[0].badgeUrl).toBe('spark-image-id');
    expect(journey.earned[0]).toMatchObject({ badgeUrl: 'spark-image-id', threshold: 500 });
  });

  it('reads the art through the tier query, not a separate cosmetic lookup', async () => {
    dbMock.dbRead.creatorMilestone.findMany.mockClear();
    dbMock.dbRead.cosmetic.findMany.mockClear();
    await getCreatorJourney(1);

    expect(dbMock.dbRead.cosmetic.findMany).not.toHaveBeenCalled();
    const tierCalls = dbMock.dbRead.creatorMilestone.findMany.mock.calls.filter(
      ([args]) => args?.where?.track === 'score'
    );
    expect(tierCalls).toHaveLength(1);
    expect(tierCalls[0][0]).toMatchObject({ select: { cosmetic: { select: { data: true } } } });
  });

  // The art identifies the tier as surely as its name does, so an unearned hidden tier shows neither.
  it('withholds the art of a hidden tier the viewer has not earned', async () => {
    dbMock.dbRead.creatorMilestone.findMany.mockResolvedValue([
      { ...spark, hidden: true },
    ] as never);
    dbMock.dbRead.userCreatorMilestone.findMany.mockResolvedValue([] as never);

    expect((await getCreatorJourney(1)).tiers[0]).toMatchObject({ name: '???', badgeUrl: null });
  });

  it('shows the art of a hidden tier once the viewer has earned it', async () => {
    const hiddenSpark = { ...spark, hidden: true };
    const { cosmetic: _, ...hiddenSparkAsAchievement } = hiddenSpark;
    dbMock.dbRead.creatorMilestone.findMany.mockResolvedValue([hiddenSpark] as never);
    dbMock.dbRead.userCreatorMilestone.findMany.mockResolvedValue([
      { achievedAt: new Date('2026-10-01'), milestone: hiddenSparkAsAchievement },
    ] as never);

    const journey = await getCreatorJourney(1);
    expect(journey.tiers[0]).toMatchObject({ name: 'Spark', badgeUrl: 'spark-image-id' });
    expect(journey.earned[0].badgeUrl).toBe('spark-image-id');
  });

  it('is null when the tier has no cosmetic attached', async () => {
    dbMock.dbRead.creatorMilestone.findMany.mockResolvedValue([
      { ...spark, cosmetic: null },
    ] as never);

    expect((await getCreatorJourney(1)).tiers[0].badgeUrl).toBeNull();
  });
});

// Badge art is attached later by setting cosmeticId; the page must pick it up with no code change.
describe('activity badge art', () => {
  const firstModel = {
    ...definition({ key: 'create:models-1', track: 'create', threshold: 1, hidden: false }),
    name: 'First Model',
    cosmetic: { data: { url: 'first-model-art' } },
  };
  const { cosmetic: _, ...firstModelAsAchievement } = firstModel;

  const serveDefinitions = (activity: unknown[]) =>
    dbMock.dbRead.creatorMilestone.findMany.mockImplementation((async (args: {
      where?: { key?: unknown };
    }) => (args?.where?.key ? activity : [])) as never);

  it('carries a milestone cosmetic onto its tile and onto the earned badge', async () => {
    serveDefinitions([firstModel]);
    dbMock.dbRead.userCreatorMilestone.findMany.mockResolvedValue([
      {
        achievedAt: new Date('2026-01-01'),
        seenAt: null,
        milestone: firstModelAsAchievement,
      },
    ] as never);

    const journey = await getCreatorJourney(1);
    expect(journey.activity.milestones[0]).toMatchObject({ badgeUrl: 'first-model-art' });
    expect(journey.earned[0]).toMatchObject({
      key: 'create:models-1',
      badgeUrl: 'first-model-art',
    });
  });

  it('withholds the art of a hidden milestone the viewer has not earned', async () => {
    serveDefinitions([{ ...firstModel, hidden: true, hint: 'Ship something' }]);
    dbMock.dbRead.userCreatorMilestone.findMany.mockResolvedValue([] as never);

    const [tile] = (await getCreatorJourney(1)).activity.milestones;
    expect(tile).toMatchObject({ name: '???', badgeUrl: null });
  });

  it('selects the art through the definitions query', async () => {
    dbMock.dbRead.creatorMilestone.findMany.mockClear();
    serveDefinitions([]);
    await getCreatorJourney(1);
    const activityCall = dbMock.dbRead.creatorMilestone.findMany.mock.calls.find(
      ([args]) => args?.where?.key
    );
    expect(activityCall?.[0]).toMatchObject({ select: { cosmetic: { select: { data: true } } } });
  });
});

describe('hidden milestones', () => {
  const secret = {
    ...definition({ key: 'test:opaque1', threshold: 42, hint: 'Look up' }),
    name: 'Stargazer',
    cosmetic: { data: { url: 'stargazer-art' } },
    // Whatever a read hands back, the masked shape is built field by field.
    detector: { type: 'query', sql: 'SELECT 1' },
  };

  it('shows an unearned one as its hint and nothing that tells it apart', () => {
    expect(buildSecretMilestones([secret, secret], new Map())).toEqual([
      {
        key: 'hidden:secret-0',
        name: '???',
        description: null,
        hint: 'Look up',
        badgeUrl: null,
        earned: false,
        achievedAt: null,
      },
      expect.objectContaining({ key: 'hidden:secret-1', name: '???' }),
    ]);
  });

  it('reveals an earned one', () => {
    const at = new Date('2026-10-01');
    expect(buildSecretMilestones([secret], new Map([['test:opaque1', at]]))).toEqual([
      {
        key: 'test:opaque1',
        name: 'Stargazer',
        description: 'Someone remixed your model.',
        hint: 'Look up',
        badgeUrl: 'stargazer-art',
        earned: true,
        achievedAt: at,
      },
    ]);
  });

  it('reads hidden rows outside the score and activity sections, with the shared select', async () => {
    dbMock.dbRead.creatorMilestone.findMany.mockClear();
    await getCreatorJourney(1);
    const secretCall = dbMock.dbRead.creatorMilestone.findMany.mock.calls.find(
      ([args]) => args?.where?.hidden === true
    )?.[0];
    expect(secretCall?.where).toMatchObject({
      track: { not: 'score' },
      key: { notIn: expect.arrayContaining(['create:models-1', 'reach:followers-100']) },
    });
    expect(Object.keys(secretCall?.select ?? {}).sort()).toEqual(
      ['cosmetic', 'description', 'hidden', 'hint', 'key', 'name', 'threshold', 'track'].sort()
    );
  });
});

describe('getFirstPublishCard', () => {
  const owner = 7;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
  type Row = { id: number; userId: number; status: string; publishedAt: Date | null };

  type FirstWhere = {
    userId: number;
    id: { not: number };
    publishedAt: { lt: Date };
    status?: { not: string };
  };
  const UNDERSTOOD_KEYS = ['userId', 'id', 'publishedAt', 'status'];

  // A tiny in-memory table that honours the where clauses the service sends, so a case reads as data.
  // The exact clause is pinned separately below; this fake only interprets it.
  function seed(entity: 'model' | 'article', rows: Row[]) {
    const client = dbMock.dbWrite[entity];
    client.findUnique.mockImplementation(
      (async ({ where }: { where: { id: number } }) =>
        rows.find((r) => r.id === where.id) ?? null) as never
    );
    client.findFirst.mockImplementation((async ({ where }: { where: FirstWhere }) => {
      // Refuse a clause it does not understand, so it cannot agree with an added filter.
      const unknown = Object.keys(where).filter((k) => !UNDERSTOOD_KEYS.includes(k));
      if (unknown.length) throw new Error(`seed() cannot interpret where.${unknown.join(', ')}`);
      const shapeOf = (value: unknown) => Object.keys(value ?? {}).join(',');
      if (shapeOf(where.id) !== 'not' || shapeOf(where.publishedAt) !== 'lt')
        throw new Error('seed() reads only id.not and publishedAt.lt');
      if (where.status != null && shapeOf(where.status) !== 'not')
        throw new Error('seed() reads only status.not');
      return (
        rows.find(
          (r) =>
            r.userId === where.userId &&
            r.id !== where.id.not &&
            r.publishedAt != null &&
            r.publishedAt < where.publishedAt.lt &&
            (where.status == null || r.status !== where.status.not)
        ) ?? null
      );
    }) as never);
  }
  const row = (overrides: Partial<Row> = {}): Row => ({
    id: 1,
    userId: owner,
    status: 'Published',
    publishedAt: daysAgo(1),
    ...overrides,
  });
  const card = (entityType: 'model' | 'article', id: number) =>
    getFirstPublishCard({ userId: owner, entityType, id });

  beforeEach(() => vi.resetAllMocks());

  describe.each(['model', 'article'] as const)('%s', (entity) => {
    it("shows on the owner's only published one", async () => {
      seed(entity, [row()]);
      await expect(card(entity, 1)).resolves.toEqual({ show: true });
    });

    it('shows on the earlier of two published the same week, and not on the later', async () => {
      seed(entity, [
        row({ id: 1, publishedAt: daysAgo(5) }),
        row({ id: 2, publishedAt: daysAgo(2) }),
      ]);
      await expect(card(entity, 1)).resolves.toEqual({ show: true });
      await expect(card(entity, 2)).resolves.toEqual({ show: false });
    });

    it('is not blocked by one scheduled to go live later', async () => {
      seed(entity, [
        row({ id: 1 }),
        row({ id: 2, status: 'Scheduled', publishedAt: new Date(Date.now() + DAY_MS) }),
      ]);
      await expect(card(entity, 1)).resolves.toEqual({ show: true });
    });

    it('is blocked by an earlier one in any status', async () => {
      seed(entity, [
        row({ id: 1 }),
        row({ id: 2, status: 'Unpublished', publishedAt: daysAgo(30) }),
      ]);
      await expect(card(entity, 1)).resolves.toEqual({ show: false });
    });

    it('still shows on the last day of the window', async () => {
      seed(entity, [row({ publishedAt: daysAgo(FIRST_PUBLISH_CARD_DAYS - 0.5) })]);
      await expect(card(entity, 1)).resolves.toEqual({ show: true });
    });

    it.each([
      ['someone else', { userId: owner + 1 }],
      ['an unpublished one', { status: 'Unpublished' }],
      ['a draft', { publishedAt: null }],
      ['one past the window', { publishedAt: daysAgo(FIRST_PUBLISH_CARD_DAYS + 0.5) }],
    ])('refuses %s before looking for earlier ones', async (_label, overrides) => {
      seed(entity, [row(overrides)]);
      await expect(card(entity, 1)).resolves.toEqual({ show: false });
      expect(dbMock.dbWrite[entity].findFirst).not.toHaveBeenCalled();
    });

    // A replica can still show it unpublished right after publish, and the client keeps the first
    // answer for the session, so a lagged "no" would hide the card for good.
    it('reads the primary, never a replica, with the earlier-than clause', async () => {
      const publishedAt = daysAgo(1);
      seed(entity, [row({ publishedAt })]);
      await card(entity, 1);
      expect(dbMock.dbRead[entity].findUnique).not.toHaveBeenCalled();
      expect(dbMock.dbRead[entity].findFirst).not.toHaveBeenCalled();
      expect(dbMock.dbWrite[entity].findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: owner,
            id: { not: 1 },
            publishedAt: { lt: publishedAt },
            ...(entity === 'model' ? { status: { not: 'Scheduled' } } : {}),
          },
        })
      );
    });
  });

  it('is not blocked by a model still Scheduled past its slot, which never went live', async () => {
    seed('model', [row({ id: 1 }), row({ id: 2, status: 'Scheduled', publishedAt: daysAgo(3) })]);
    await expect(card('model', 1)).resolves.toEqual({ show: true });
  });

  // Models soft-delete and keep publishedAt, so an earlier deleted model still makes this not the first.
  it('is blocked by an earlier model that was deleted', async () => {
    seed('model', [row({ id: 1 }), row({ id: 2, status: 'Deleted', publishedAt: daysAgo(40) })]);
    await expect(card('model', 1)).resolves.toEqual({ show: false });
  });

  it('checks the table for its own entity type', async () => {
    seed('article', [row()]);
    await card('article', 1);
    expect(dbMock.dbWrite.model.findUnique).not.toHaveBeenCalled();
  });
});

describe('buildActivityProgress', () => {
  const activity = (key: string, threshold: number) =>
    definition({ key, track: key.split(':')[0], threshold, hidden: false, name: key, hint: null });
  // Out of threshold order: the definitions query has no orderBy.
  const definitions = [
    activity('create:models-5', 5),
    activity('create:models-1', 1),
    activity('create:articles-1', 1),
    activity('reach:followers-1000', 1000),
    activity('reach:followers-100', 100),
    activity('reach:reactions-1000', 1000),
    activity('score:spark', 500),
  ];
  const values = { models: 3, articles: 0, downloads: 0, followers: 87, reactions: 400 };

  it('picks the unearned milestone nearest to done, one per measure', () => {
    const held = new Map([['create:models-1', new Date('2026-01-01')]]);
    const { milestones, closestNext } = buildActivityProgress(definitions, held, values);

    expect(closestNext).toMatchObject({ key: 'reach:followers-100', current: 87, threshold: 100 });
    expect(milestones.map((m) => m.key)).not.toContain('score:spark');
    expect(milestones.find((m) => m.key === 'create:models-1')).toMatchObject({
      earned: true,
      achievedAt: new Date('2026-01-01'),
    });
  });

  // The nightly job grants it; until then the next one up is the real target.
  it('skips a milestone already reached but not yet granted', () => {
    const { closestNext } = buildActivityProgress(definitions, new Map(), {
      ...values,
      followers: 150,
    });
    expect(closestNext).toMatchObject({ key: 'create:models-5', current: 3 });
  });

  it('leaves an undated grant undated', () => {
    const held = new Map<string, Date | null>([['create:models-1', null]]);
    const { milestones } = buildActivityProgress(definitions, held, values);
    expect(milestones.find((m) => m.key === 'create:models-1')).toMatchObject({
      earned: true,
      achievedAt: null,
    });
  });

  it('has no closest next once everything is earned', () => {
    const held = new Map(definitions.map((d) => [d.key, null]));
    expect(buildActivityProgress(definitions, held, values).closestNext).toBeNull();
  });
});

describe('judge votes', () => {
  const judgeRank = (threshold: number) => ({
    ...definition({
      key: `community:crucible-votes-${threshold}`,
      track: 'community',
      threshold,
      hidden: false,
      hint: null,
    }),
    name: `${threshold} Votes`,
    cosmetic: null,
  });

  beforeEach(() => {
    chQuery.mockReset();
    dbMock.dbRead.$queryRawUnsafe.mockResolvedValue([] as never);
    dbMock.dbRead.userCreatorMilestone.findMany.mockResolvedValue([] as never);
    dbMock.dbRead.creatorMilestone.findMany.mockImplementation((async (args: {
      where?: { key?: unknown };
    }) => (args?.where?.key ? [judgeRank(5000), judgeRank(500), judgeRank(1000)] : [])) as never);
  });

  it("shows the viewer's own Crucible vote count against every judge rank", async () => {
    chQuery.mockImplementation(async ({ query }: { query: string }) => ({
      json: async () => (query === judgeVoteCountSql ? [{ votes: '640' }] : [{ wins: '0' }]),
    }));

    const { activity } = await getCreatorJourney(42);

    expect(chQuery).toHaveBeenCalledTimes(2);
    expect(chQuery).toHaveBeenCalledWith({
      query: judgeVoteCountSql,
      query_params: { userId: 42 },
      format: 'JSONEachRow',
      abort_signal: expect.any(AbortSignal),
      clickhouse_settings: { max_execution_time: 5 },
    });
    expect(
      activity.milestones.map(({ key, measure, current }) => ({ key, measure, current }))
    ).toEqual([
      { key: 'community:crucible-votes-500', measure: 'votes', current: 640 },
      { key: 'community:crucible-votes-1000', measure: 'votes', current: 640 },
      { key: 'community:crucible-votes-5000', measure: 'votes', current: 640 },
    ]);
    // 640 has passed 500, which the nightly job has not granted yet, so 1k is the target.
    expect(activity.closestNext).toMatchObject({ key: 'community:crucible-votes-1000' });
  });

  // The mock answers any SQL, and a failed query reads as zero votes, so the text is what pins it.
  it("counts only the viewer's own attributed votes, bound by the parameter it sends", () => {
    expect(judgeVoteCountSql).toBe(`SELECT count() AS votes FROM crucible_votes
  WHERE userId = {userId:UInt32}`);
  });

  // ClickHouse is a second store behind one page; its outage must not take the page down.
  it('still loads, at zero votes, when ClickHouse fails', async () => {
    chQuery.mockRejectedValue(new Error('ClickHouse unavailable'));
    loggingMock.logToAxiom.mockClear();

    const { activity } = await getCreatorJourney(42);

    expect(activity.milestones.map((m) => m.current)).toEqual([0, 0, 0]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'creator-journey-judge-votes' })
    );
  });

  // The shared client would otherwise wait minutes on a stalled connection, holding the page.
  it('gives up on a stalled ClickHouse after six seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      chQuery.mockImplementation(
        ({ abort_signal }: { abort_signal: AbortSignal }) =>
          new Promise((_, reject) =>
            abort_signal.addEventListener('abort', () => reject(new Error('aborted')))
          )
      );
      const journey = getCreatorJourney(42);
      await vi.advanceTimersByTimeAsync(5_999);
      expect(chQuery.mock.calls[0][0].abort_signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      // Asserted before awaiting, so a longer deadline fails here instead of hanging the test.
      expect(chQuery.mock.calls[0][0].abort_signal.aborted).toBe(true);
      const { activity } = await journey;
      expect(activity.milestones.map((m) => m.current)).toEqual([0, 0, 0]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('compete wins', () => {
  const winRung = (threshold: number) => ({
    ...definition({
      key: `compete:wins-${threshold}`,
      track: 'compete',
      threshold,
      hidden: false,
      hint: null,
    }),
    name: `${threshold} Wins`,
    cosmetic: null,
  });

  beforeEach(() => {
    chQuery.mockReset();
    dbMock.dbRead.$queryRawUnsafe.mockResolvedValue([{ wins: 3, crucibleWins: 1 }] as never);
    dbMock.dbRead.userCreatorMilestone.findMany.mockResolvedValue([] as never);
    dbMock.dbRead.creatorMilestone.findMany.mockImplementation((async (args: {
      where?: { key?: unknown };
    }) => (args?.where?.key ? [winRung(1), winRung(5), winRung(10)] : [])) as never);
  });

  // Wins before the winners table exist only in the ledger; without them a veteran reads as new.
  it("adds the viewer's ledger wins to the wins in Postgres", async () => {
    chQuery.mockImplementation(async ({ query }: { query: string }) => ({
      json: async () => (query === ledgerWinCountSql ? [{ wins: '4' }] : [{ votes: '0' }]),
    }));

    const { activity } = await getCreatorJourney(42);

    expect(chQuery).toHaveBeenCalledWith({
      query: ledgerWinCountSql,
      query_params: { userId: 42 },
      format: 'JSONEachRow',
      abort_signal: expect.any(AbortSignal),
      clickhouse_settings: { max_execution_time: 5 },
    });
    expect(
      activity.milestones.map(({ key, measure, current }) => ({ key, measure, current }))
    ).toEqual([
      { key: 'compete:wins-1', measure: 'wins', current: 7 },
      { key: 'compete:wins-5', measure: 'wins', current: 7 },
      { key: 'compete:wins-10', measure: 'wins', current: 7 },
    ]);
    // Every ledger win is a daily challenge: 2 challenge wins in Postgres plus 4 from the ledger.
    expect(activity.winBreakdown).toEqual({ challenges: 6, crucibles: 1 });
  });

  it('still loads, counting the Postgres wins, when the ledger read fails', async () => {
    chQuery.mockRejectedValue(new Error('ClickHouse unavailable'));
    loggingMock.logToAxiom.mockClear();

    const { activity } = await getCreatorJourney(42);

    expect(activity.milestones.map((m) => m.current)).toEqual([3, 3, 3]);
    expect(activity.winBreakdown).toEqual({ challenges: 2, crucibles: 1 });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'creator-journey-ledger-wins' })
    );
  });
});
