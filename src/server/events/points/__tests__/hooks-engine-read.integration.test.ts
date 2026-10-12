import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * Every hooked action type, from the real hook through the real engine (loaded from the registered
 * birthday2026 config, not a fixture) to the ledger and back out through the real read path. The
 * engine and hook suites each fake the other side; this is where they meet. sysRedis is a small
 * stateful fake with real set, hash and stream semantics.
 */

const ch = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
// The engine's kill switch is on here; enabled.test.ts covers it off.
vi.mock('~/server/events/points/enabled', () => ({
  isEventPointsEnabled: async () => true,
  isEventPointsEnabledSync: () => true,
  onEventPointsSwitchOn: () => () => undefined,
}));
// The engine's self-heal runs the reconcile and settle: tested in self-heal.test.ts, not here.
vi.mock('~/server/events/points/self-heal', () => ({ healEventPoints: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    insert: async ({ values }: { values: Record<string, unknown>[] }) =>
      void ch.rows.push(...values),
    query: vi.fn(),
  },
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  getAccountSummary: vi.fn(),
  getTopContributors: vi.fn(async () => ({})),
  getUserBuzzAccount: vi.fn(async () => [{ balance: 0 }]),
}));
vi.mock('~/server/services/user.service', () => ({ updateLeaderboardRank: vi.fn() }));
vi.mock('~/server/integrations/discord', () => ({ discord: {} }));
const push = vi.hoisted(() => ({ markEventPointsDirty: vi.fn() }));
vi.mock('~/server/events/points/push', () => push);

const hooks = await import('~/server/events/points/hooks');
const { getHatTotals, getTeamPoints, getOwnerPoints } = await import('~/server/events/points/read');
const { COUNT_BASE_MARK, encodeHat, eventPointKeys, eventPointSeason, eventSeasonKeys, hatField } =
  await import('~/server/events/points/keys');
const { birthday2026 } = await import('~/server/events/birthday2026.event');

const NOW = new Date('2026-11-05T12:00:00.000Z');
const OWNER = 10;
const IMAGE = 100;
const MODEL = 200;
const HAT = { ownerId: OWNER, cosmeticId: 7, claimKey: 'claimed', team: 'Blue' };

function installRedis() {
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Map<string, string>>();
  const strings = new Map<string, string>();
  const sys = redisMock.sysRedis;
  sys.isReady = true;
  sys.sAdd.mockImplementation(async (key: string, members: string | string[]) => {
    const set = sets.get(key) ?? new Set<string>();
    sets.set(key, set);
    let added = 0;
    for (const m of [members].flat()) if (!set.has(m)) set.add(m), added++;
    return added;
  });
  sys.sRem.mockImplementation(async (key: string, member: string) =>
    Number(!!sets.get(key)?.delete(member))
  );
  sys.sPop.mockImplementation(async (key: string, count: number) => {
    const set = sets.get(key) ?? new Set<string>();
    const taken = [...set].slice(0, count);
    taken.forEach((m) => set.delete(m));
    return taken;
  });
  sys.hIncrBy.mockImplementation(async (key: string, field: string, by: number) => {
    const hash = hashes.get(key) ?? new Map<string, string>();
    hashes.set(key, hash);
    const next = Number(hash.get(field) ?? 0) + by;
    hash.set(field, String(next));
    return next;
  });
  sys.hSet.mockImplementation(async (key: string, field: string, value: string) => {
    const hash = hashes.get(key) ?? new Map<string, string>();
    hashes.set(key, hash);
    hash.set(field, value);
    return 1;
  });
  sys.hGetAll.mockImplementation(async (key: string) => Object.fromEntries(hashes.get(key) ?? []));
  sys.hmGet.mockImplementation(async (key: string, fields: string[]) =>
    fields.map((f) => hashes.get(key)?.get(f) ?? null)
  );
  sys.get.mockImplementation(async (key: string) => strings.get(key) ?? null);
  sys.xRange.mockResolvedValue([]);
  sys.xRevRange.mockResolvedValue([]);
  sys.expire.mockResolvedValue(true);
  sys.expireAt.mockResolvedValue(true);
  return { sets };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  installRedis();
  const keys = eventPointKeys(birthday2026.name);
  await redisMock.sysRedis.hSet(keys.hats, `Image:${IMAGE}`, encodeHat(HAT));
  await redisMock.sysRedis.hSet(keys.hats, `Model:${MODEL}`, encodeHat(HAT));
  // Importing the event registry takes longer than waitFor's default second; do it up front.
  await (await import('~/server/events/load-events')).loadEvents();
  // The engine loads its hat map on first use; until then every hook skips.
  hooks.hattedImpressionEntities([]);
  await vi.waitFor(async () => {
    const { isHattedEntity } = await import('~/server/events/points/award');
    expect(isHattedEntity('Image', IMAGE)).toBe(true);
  });
});

afterAll(() => {
  vi.useRealTimers();
});

const ledgerTypes = () => ch.rows.map((r) => `${r.op}:${r.type}:${r.actorId}`);

describe('hook -> engine -> ledger -> read, on the registered birthday2026 config', () => {
  it('earns every hooked type at its configured weight, readable per hat, team and owner', async () => {
    const weights = birthday2026.scoring!.types;
    push.markEventPointsDirty.mockClear();
    await hooks.onReactionCreated({ entityType: 'image', entityId: IMAGE, userId: 1 });
    await hooks.onCommentCreated({ userId: 2, entityType: 'image', entityId: IMAGE, threadId: 0 });
    await hooks.onPlacementApproved({
      surface: 'sticker',
      targetType: 'image',
      targetId: IMAGE,
      placerId: 3,
    });
    await hooks.onPlacementApproved({
      surface: 'remixGallery',
      targetType: 'image',
      targetId: IMAGE,
      placerId: 4,
    });
    dbMock.dbWrite.resourceReview.count.mockResolvedValueOnce(1);
    await hooks.onModelReviewsChanged([{ modelId: MODEL, userId: 5 }]);
    await hooks.awardViewPoints(
      async () =>
        ({ user: { id: 6, createdAt: '2025-01-01T00:00:00.000Z', bannedAt: null } } as never),
      [{ entityType: 'Image', entityId: IMAGE }]
    );

    expect(ledgerTypes()).toEqual([
      'add:reaction:1',
      'add:comment:2',
      'add:sticker:3',
      'add:remix:4',
      'add:modelLike:5',
      'add:view:6',
    ]);
    // The referee scores from these rows alone: each must carry the hat and the pairing key.
    const hatColumns = { ownerId: OWNER, cosmeticId: 7, claimKey: 'claimed', team: 'Blue' };
    expect(ch.rows).toEqual([
      expect.objectContaining({
        ...hatColumns,
        entityType: 'Image',
        entityId: IMAGE,
        sourceId: 'ImageReaction:100:1',
      }),
      expect.objectContaining({
        ...hatColumns,
        entityType: 'Image',
        entityId: IMAGE,
        sourceId: 'CommentV2:Image:100:2',
      }),
      expect.objectContaining({
        ...hatColumns,
        entityType: 'Image',
        entityId: IMAGE,
        sourceId: 'Placement:sticker:100:3',
      }),
      expect.objectContaining({
        ...hatColumns,
        entityType: 'Image',
        entityId: IMAGE,
        sourceId: 'Placement:remix:100:4',
      }),
      expect.objectContaining({
        ...hatColumns,
        entityType: 'Model',
        entityId: MODEL,
        sourceId: 'ResourceReview:200:5',
      }),
      expect.objectContaining({ ...hatColumns, entityType: 'Image', entityId: IMAGE }),
    ]);
    const expected =
      weights.reaction!.weight +
      weights.comment!.weight +
      weights.sticker!.weight +
      weights.remix!.weight +
      weights.modelLike!.weight +
      weights.view!.weight;
    expect(expected).toBe(51);
    const event = { name: birthday2026.name, startDate: birthday2026.startDate };
    // No count base yet: the points are live, the counts are left to the snapshot.
    expect((await getHatTotals(event, [HAT], NOW)).counts).toBeNull();
    const seasonKeys = eventSeasonKeys(event.name, eventPointSeason(event.startDate, NOW));
    await redisMock.sysRedis.hIncrBy(seasonKeys.base('count'), COUNT_BASE_MARK, 1);
    // One of each way earned, counted live beside the points (modelLike is not a shown count).
    expect(await getHatTotals(event, [HAT], NOW)).toEqual({
      points: { [hatField(HAT)]: expected },
      counts: {
        [hatField(HAT)]: { impressions: 1, reactions: 1, comments: 1, stickers: 1, remixes: 1 },
      },
    });
    expect((await getTeamPoints({ ...event, teams: birthday2026.teams }, NOW)).Blue).toBe(expected);
    expect(await getOwnerPoints(event, [OWNER], NOW)).toEqual({ [String(OWNER)]: expected });
    // Every grant marks the hat for a live push, with the event's teams for the team push, and its
    // preview start, from which the pusher takes marks.
    expect(birthday2026.previewFrom).toBeInstanceOf(Date);
    expect(push.markEventPointsDirty).toHaveBeenCalledTimes(6);
    for (const [event, hat] of push.markEventPointsDirty.mock.calls) {
      expect(event).toEqual(
        expect.objectContaining({
          name: birthday2026.name,
          teams: birthday2026.teams,
          previewFrom: birthday2026.previewFrom,
        })
      );
      expect(hat).toEqual(HAT);
    }
  });

  it('takes a removal through to the ledger and lets the person earn again', async () => {
    dbMock.dbWrite.imageReaction.count.mockResolvedValueOnce(0);
    await hooks.onReactionRemoved({ entityType: 'image', entityId: IMAGE, userId: 1 });
    await hooks.onReactionCreated({ entityType: 'image', entityId: IMAGE, userId: 1 });
    expect(ledgerTypes().slice(-2)).toEqual(['remove:reaction:1', 'add:reaction:1']);
    // The removal nets out the add only if both carry the same source id.
    expect(new Set(ch.rows.filter((r) => r.actorId === 1).map((r) => r.sourceId))).toEqual(
      new Set(['ImageReaction:100:1'])
    );
  });

  it('ignores the hat owner acting on their own content', async () => {
    const before = ch.rows.length;
    await hooks.onReactionCreated({ entityType: 'image', entityId: IMAGE, userId: OWNER });
    expect(ch.rows.length).toBe(before);
  });
});
