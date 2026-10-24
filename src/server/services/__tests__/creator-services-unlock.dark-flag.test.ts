import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as TesterSegment from '~/server/flipt/tester-segment';
import { isFliptPublic } from '~/server/flipt/tester-segment';
import {
  buildCreatorScoreUnlocks,
  compiledCreatorScoreUnlockInputs,
  getCreatorScoreUnlocks,
} from '~/server/services/creator-score-unlocks.service';
import {
  assertCanSellServices,
  getServiceSellEligibility,
} from '~/server/services/creator-service.service';
import { clearServicesMinCreatorScoreCache } from '~/server/services/creator-service-min-score';
import {
  SERVICES_MIN_CREATOR_SCORE,
  SERVICES_MIN_CREATOR_SCORE_KEY,
} from '~/shared/constants/creator-service.constants';

vi.mock('~/server/flipt/tester-segment', async (importOriginal) => ({
  ...(await importOriginal<typeof TesterSegment>()),
  isFliptPublic: vi.fn(),
}));

const SERVICES = 'creator-services';
const keys = (unlocks: { key: string }[]) => unlocks.map((u) => u.key);

beforeEach(() => {
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null as never);
  vi.mocked(isFliptPublic).mockReset();
  clearServicesMinCreatorScoreCache();
});

const sellerWithScore = (total: number) => {
  dbMock.dbRead.user.findUnique.mockResolvedValue({
    meta: { scores: { total } },
    bannedAt: null,
    muted: false,
    deletedAt: null,
  } as never);
  dbMock.dbRead.userStrike.aggregate.mockResolvedValue({ _sum: { points: 0 } } as never);
};

// Decision (Creator Services P1): the services unlock is kept out of the registry, server-side,
// until the `creator-services` flag is on for everyone. The same list feeds the nightly score job's
// tier-reached notifications, which have no viewer to check a per-user flag against, so a UI-only
// hide would announce a dark feature to every account crossing Beacon. Don't move this check into
// the Journey component.
describe('services unlock while creatorServices is dark', () => {
  it('is absent from the live list the tier-notify job reads when the flag is off', async () => {
    vi.mocked(isFliptPublic).mockResolvedValue(false);
    expect(keys(await getCreatorScoreUnlocks())).not.toContain(SERVICES);
    expect(isFliptPublic).toHaveBeenCalledWith(SERVICES);
  });

  it('appears in that list once the flag is on for everyone', async () => {
    vi.mocked(isFliptPublic).mockResolvedValue(true);
    expect(keys(await getCreatorScoreUnlocks())).toContain(SERVICES);
  });

  it('stays absent when the flag cannot be read', async () => {
    vi.mocked(isFliptPublic).mockRejectedValue(new Error('flipt down'));
    expect(keys(await getCreatorScoreUnlocks())).not.toContain(SERVICES);
  });

  it("is absent from the job's compiled fallback list", () => {
    expect(keys(buildCreatorScoreUnlocks(compiledCreatorScoreUnlockInputs))).not.toContain(
      SERVICES
    );
  });
});

describe('services unlock threshold', () => {
  const unlock = buildCreatorScoreUnlocks({
    ...compiledCreatorScoreUnlockInputs,
    servicesEnabled: true,
  }).find((u) => u.key === SERVICES);

  const canSell = async (meta: unknown) => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      meta,
      bannedAt: null,
      muted: false,
      deletedAt: null,
    } as never);
    dbMock.dbRead.userStrike.aggregate.mockResolvedValue({ _sum: { points: 0 } } as never);
    return (await getServiceSellEligibility(1)).canSell;
  };

  it('flips the sell gate at the registry threshold', async () => {
    if (!unlock) throw new Error('no creator-services registry entry');
    expect(await canSell({ scores: { total: unlock.minScore - 1 } })).toBe(false);
    expect(await canSell({ scores: { total: unlock.minScore } })).toBe(true);
  });

  // Same number the Creator Program compares, so "same rung as the Creator Program" holds.
  it('compares the aggregate score, as the registry states', async () => {
    if (!unlock) throw new Error('no creator-services registry entry');
    expect(unlock.scoreKind).toBe('aggregate');
    expect(await canSell({ scores: { total: 0, models: unlock.minScore } })).toBe(true);
  });
});

// Justin, 2026-10-24: the minimum is a KeyValue setting so it can be lowered for testers without a
// deploy. A missing or unreadable row must fall back to the compiled minimum, never to 0, which
// would let every account sell.
describe('services minimum from KeyValue', () => {
  const LOWERED = 250;
  const withRow = (value: unknown) =>
    dbMock.dbRead.keyValue.findUnique.mockImplementation((async ({
      where,
    }: {
      where: { key: string };
    }) =>
      where.key === SERVICES_MIN_CREATOR_SCORE_KEY ? { key: where.key, value } : null) as never);
  const liveUnlockMin = async () => {
    vi.mocked(isFliptPublic).mockResolvedValue(true);
    return (await getCreatorScoreUnlocks()).find((u) => u.key === SERVICES)?.minScore;
  };
  const sellMin = async () => {
    sellerWithScore(0);
    return (await getServiceSellEligibility(1)).score.min;
  };

  it('uses the compiled minimum when the row is missing', async () => {
    expect(await sellMin()).toBe(SERVICES_MIN_CREATOR_SCORE);
    expect(await liveUnlockMin()).toBe(SERVICES_MIN_CREATOR_SCORE);
  });

  it('gates selling, the error and the Journey item on the row when it is set', async () => {
    withRow(LOWERED);
    sellerWithScore(LOWERED);
    expect((await getServiceSellEligibility(1)).canSell).toBe(true);
    sellerWithScore(LOWERED - 1);
    expect((await getServiceSellEligibility(1)).canSell).toBe(false);
    await expect(assertCanSellServices(1)).rejects.toThrow(
      `Selling services unlocks at a Creator Score of ${LOWERED.toLocaleString()}.`
    );
    expect(await liveUnlockMin()).toBe(LOWERED);
  });

  // The row is written by hand under this exact name; renaming the constant would orphan it.
  it('reads the row under the name it is written by hand', async () => {
    dbMock.dbRead.keyValue.findUnique.mockImplementation((async ({
      where,
    }: {
      where: { key: string };
    }) =>
      where.key === 'creator-services-min-creator-score'
        ? { key: where.key, value: LOWERED }
        : null) as never);
    expect(await sellMin()).toBe(LOWERED);
  });

  it('accepts the number written as a string', async () => {
    withRow(String(LOWERED));
    expect(await sellMin()).toBe(LOWERED);
  });

  it.each([['abc'], [0], [-5], [1.5], ['12abc'], [''], [{}], [[LOWERED]], [true], [null]])(
    'falls back to the compiled minimum for %j',
    async (value) => {
      withRow(value);
      expect(await sellMin()).toBe(SERVICES_MIN_CREATOR_SCORE);
      expect(await liveUnlockMin()).toBe(SERVICES_MIN_CREATOR_SCORE);
    }
  );

  it('falls back to the compiled minimum when the row cannot be read', async () => {
    dbMock.dbRead.keyValue.findUnique.mockRejectedValue(new Error('db down'));
    expect(await sellMin()).toBe(SERVICES_MIN_CREATOR_SCORE);
  });
});
