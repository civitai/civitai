import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pricingEligibility } from '@civitai/buzz';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { RateLimit } from '~/server/middleware.trpc';
import { articleRateLimits } from '~/server/schema/article.schema';
import { commentRateLimits } from '~/server/schema/comment.schema';
import { postRateLimits } from '~/server/schema/post.schema';
import { reactionRateLimits } from '~/server/schema/reaction.schema';
import { CacheTTL, EARLY_ACCESS_CONFIG } from '~/server/common/constants';
import { getAnnouncementAllowance } from '~/server/services/announcement-allowance.service';
import { assertUserInGoodStanding } from '~/server/services/challenge-eligibility.service';
import { getCrucibleJudgeEligibility } from '~/server/services/crucible-eligibility.service';
import {
  buildCreatorScoreUnlocks,
  compiledCreatorScoreUnlockInputs,
  getCreatorScoreUnlocks,
  nextCreatorScoreUnlocks,
  type CreatorScoreUnlock,
} from '~/server/services/creator-score-unlocks.service';
import {
  getMaxEarlyAccessDays,
  getMaxEarlyAccessModels,
} from '~/server/utils/early-access-helpers';
import { placementFreeSlotCap, placementPriceCap } from '~/shared/utils/placement';
import type { SessionUser } from '~/types/session';
import type * as CreatorProgramService from '~/server/services/creator-program.service';
import { getCreatorRequirements } from '~/server/services/creator-program.service';
import {
  EARLY_ACCESS_QUANTITY_UNLOCK,
  EARLY_ACCESS_SCORE_UNLOCK,
} from '../../../../apps/creator-studio/src/lib/monetization/paid-access';
import { resolveSaleEligibility } from '../../../../apps/creator-studio/src/lib/monetization/sales';

vi.mock('~/server/services/creator-program.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorProgramService>()),
  getCreatorRequirements: vi.fn(),
}));

// Each gate is driven at one below and exactly at the threshold the registry states. A registry entry
// that disagrees with the gate it describes then fails here naming both numbers, whichever side moved.

const compiled = buildCreatorScoreUnlocks(compiledCreatorScoreUnlockInputs);

const unlock = (key: string, list: CreatorScoreUnlock[] = compiled) => {
  const found = list.find((u) => u.key === key);
  if (!found) throw new Error(`no registry entry ${key}`);
  return found;
};
const withPrefix = (prefix: string, list: CreatorScoreUnlock[] = compiled) => {
  const found = list.filter((u) => u.key.startsWith(prefix));
  if (found.length === 0) throw new Error(`no registry entries under ${prefix}`);
  return found;
};

const sessionUser = (scores: { total?: number; articles?: number }, tier?: string) =>
  ({ id: 1, tier, meta: { scores } } as unknown as SessionUser);

// The rate-limit middleware keeps the HIGHEST limit among the rules that apply for a period.
const effectiveLimit = (rules: RateLimit[], period: number, user: SessionUser) =>
  Math.max(
    ...rules
      .filter((r) => r.period === period && (!r.userReq || r.userReq(user)))
      .map((r) => r.limit)
  );

const keyValueRows = (rows: Record<string, unknown>) =>
  dbMock.dbRead.keyValue.findUnique.mockImplementation((async (args: { where: { key: string } }) =>
    args.where.key in rows ? { key: args.where.key, value: rows[args.where.key] } : null) as never);

beforeEach(() => {
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null as never);
});

describe('creator score unlock registry', () => {
  it('lists each privilege once, lowest threshold first, with no zero-score entries', () => {
    const keys = compiled.map((u) => u.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(compiled.every((u) => u.minScore > 0)).toBe(true);
    expect(compiled.map((u) => u.minScore)).toEqual(
      [...compiled.map((u) => u.minScore)].sort((a, b) => a - b)
    );
  });

  it('crucible judging flips at the registry threshold', async () => {
    const { minScore } = unlock('crucible-judge');
    const judge = async (total: number) => {
      dbMock.dbRead.user.findUnique.mockResolvedValue({ meta: { scores: { total } } } as never);
      return (await getCrucibleJudgeEligibility({ userId: 1 })).canJudge;
    };
    expect(await judge(minScore - 1)).toBe(false);
    expect(await judge(minScore)).toBe(true);
  });

  it('challenge creation flips at the registry threshold', async () => {
    const { minScore } = unlock('challenge-create');
    const create = async (total: number) => {
      dbMock.dbRead.user.findUnique.mockResolvedValue({
        meta: { scores: { total } },
        bannedAt: null,
        muted: false,
        deletedAt: null,
      } as never);
      dbMock.dbRead.userStrike.aggregate.mockResolvedValue({ _sum: { points: 0 } } as never);
      return assertUserInGoodStanding(1).then(
        () => true,
        () => false
      );
    };
    expect(await create(minScore - 1)).toBe(false);
    expect(await create(minScore)).toBe(true);
  });

  it('each daily post tier takes effect at its registry threshold, for members too', () => {
    const tiers = withPrefix('daily-posts:');
    expect(tiers).toHaveLength(2);
    for (const { minScore, label } of tiers) {
      const limit = Number(label.match(/Post up to (\d+) times/)?.[1]);
      expect(
        effectiveLimit(postRateLimits, CacheTTL.day, sessionUser({ total: minScore - 1 }))
      ).toBeLessThan(limit);
      expect(effectiveLimit(postRateLimits, CacheTTL.day, sessionUser({ total: minScore }))).toBe(
        limit
      );
      const memberLimit = Number(label.match(/\((\d+) as a member\)/)?.[1]);
      expect(
        effectiveLimit(postRateLimits, CacheTTL.day, sessionUser({ total: minScore }, 'gold'))
      ).toBe(memberLimit);
    }
  });

  it.each([
    ['comment-rate-limit', commentRateLimits],
    ['reaction-rate-limit', reactionRateLimits],
  ])('%s raises a limit at the registry threshold and not before', (key, rules) => {
    const { minScore } = unlock(key);
    const periods = [...new Set(rules.map((r) => r.period))];
    const raised = periods.filter(
      (p) =>
        effectiveLimit(rules, p, sessionUser({ total: minScore })) >
        effectiveLimit(rules, p, sessionUser({ total: minScore - 1 }))
    );
    expect(raised.length).toBeGreaterThan(0);
    for (const rule of rules.filter((r) => r.userReq)) {
      expect(rule.userReq?.(sessionUser({ total: minScore - 1 }))).toBe(false);
    }
  });

  it('each daily article tier takes effect at its registry threshold, on the articles score', () => {
    for (const { minScore, label } of withPrefix('daily-articles:')) {
      const limit = Number(label.match(/up to (\d+) articles/)?.[1]);
      const below = sessionUser({ total: 10_000_000, articles: minScore - 1 });
      expect(effectiveLimit(articleRateLimits, CacheTTL.day, below)).toBeLessThan(limit);
      expect(
        effectiveLimit(articleRateLimits, CacheTTL.day, sessionUser({ articles: minScore }))
      ).toBe(limit);
    }
  });

  it('pricing eligibility flips at the registry threshold', () => {
    const { minScore } = unlock('monetize-pricing');
    expect(pricingEligibility(minScore - 1).eligible).toBe(false);
    expect(pricingEligibility(minScore).eligible).toBe(true);
  });

  it('every early access rung takes effect at its registry threshold', () => {
    const userMeta = (total: number) => ({ scores: { total } } as never);
    for (const { minScore, label } of withPrefix('early-access-days:')) {
      const days = Number(label.match(/up to (\d+) days/)?.[1]);
      expect(getMaxEarlyAccessDays({ userMeta: userMeta(minScore - 1) })).toBeLessThan(days);
      expect(getMaxEarlyAccessDays({ userMeta: userMeta(minScore) })).toBe(days);
    }
    for (const { minScore } of withPrefix('early-access-quantity:')) {
      expect(getMaxEarlyAccessModels({ userMeta: userMeta(minScore) })).toBeGreaterThan(
        getMaxEarlyAccessModels({ userMeta: userMeta(minScore - 1) })
      );
    }
  });

  it('every placement band takes effect at its registry threshold', () => {
    for (const { key, minScore } of withPrefix('placement-price-cap:')) {
      expect(placementPriceCap(minScore, 'free'), key).toBeGreaterThan(
        placementPriceCap(minScore - 1, 'free')
      );
    }
    for (const { key, minScore } of withPrefix('placement-free-slots:')) {
      expect(placementFreeSlotCap(minScore, 'free'), key).toBeGreaterThan(
        placementFreeSlotCap(minScore - 1, 'free')
      );
    }
  });
});

describe('nextCreatorScoreUnlocks', () => {
  it('returns every unlock at the nearest threshold above the score, and none at or below it', () => {
    const next = nextCreatorScoreUnlocks(compiled, 4_999);
    expect(new Set(next.map((u) => u.minScore))).toEqual(new Set([5_000]));
    expect(next.map((u) => u.key)).toEqual(
      expect.arrayContaining(['challenge-create', 'daily-posts:5000'])
    );
    expect(next.some((u) => u.scoreKind === 'articles')).toBe(false);

    expect(nextCreatorScoreUnlocks(compiled, 5_000).every((u) => u.minScore > 5_000)).toBe(true);
  });

  it('measures the articles tiers only against an articles score', () => {
    expect(nextCreatorScoreUnlocks(compiled, 1_500, 'articles').map((u) => u.key)).toEqual([
      'daily-articles:5000',
    ]);
  });

  it('is empty past the top rung', () => {
    const top = Math.max(...compiled.map((u) => u.minScore));
    expect(nextCreatorScoreUnlocks(compiled, top)).toEqual([]);
  });
});

describe('live values', () => {
  const saleBlocked = (creatorScore: number, minCreatorScore?: number) =>
    resolveSaleEligibility({
      selectedCount: 1,
      eligibleCount: 1,
      earlyAccessCount: 0,
      unpricedCount: 0,
      creatorScore,
      tier: 'free',
      daysUsedInMonth: 0,
      draftDays: 1,
      amount: 10,
      type: 'Percent',
      minCoveredPrice: 100,
      overrides: minCreatorScore == null ? undefined : { minCreatorScore },
      startsAt: new Date('2026-01-02'),
      now: new Date('2026-01-01'),
      resolving: false,
    }).blockedReason?.startsWith('Sales unlock') ?? false;

  it('reads the sale floor from the sale-limits row, as the studio gate does', async () => {
    keyValueRows({ 'sale-limits': { minCreatorScore: 22_000 } });
    const { minScore } = unlock('monetize-sales', await getCreatorScoreUnlocks());

    expect(minScore).toBe(22_000);
    expect(saleBlocked(minScore - 1, 22_000)).toBe(true);
    expect(saleBlocked(minScore, 22_000)).toBe(false);
  });

  it('falls back to the compiled sale floor when the row is absent or malformed, as the studio does', async () => {
    const { minScore } = unlock('monetize-sales', await getCreatorScoreUnlocks());
    expect(saleBlocked(minScore - 1)).toBe(true);
    expect(saleBlocked(minScore)).toBe(false);

    keyValueRows({ 'sale-limits': { minCreatorScore: -5 } });
    expect(unlock('monetize-sales', await getCreatorScoreUnlocks()).minScore).toBe(minScore);
  });

  it('reads the announcement floor the allowance enforces', async () => {
    keyValueRows({ 'announcements:config': { minScore: 33_000 } });
    const { minScore } = unlock('announcements', await getCreatorScoreUnlocks());
    expect(minScore).toBe(33_000);

    dbMock.dbRead.announcementSpend.findMany.mockResolvedValue([] as never);
    const eligible = async (current: number) => {
      vi.mocked(getCreatorRequirements).mockResolvedValue({ score: { min: 0, current } } as never);
      return (await getAnnouncementAllowance(1)).eligible;
    };
    expect(await eligible(minScore - 1)).toBe(false);
    expect(await eligible(minScore)).toBe(true);
  });

  it('reads the placement bands from placement:config, per surface', async () => {
    const caps = { free: 1, bronze: 1, silver: 1, gold: 1 };
    keyValueRows({
      'placement:config': {
        priceCapTiersBySurface: {
          sticker: [
            { minScore: 0, caps },
            { minScore: 42_000, caps },
          ],
        },
      },
    });
    const unlocks = await getCreatorScoreUnlocks();

    expect(withPrefix('placement-price-cap:sticker:', unlocks).map((u) => u.minScore)).toEqual([
      42_000,
    ]);
    expect(withPrefix('placement-price-cap:remixGallery:', unlocks).map((u) => u.minScore)).toEqual(
      withPrefix('placement-price-cap:remixGallery:').map((u) => u.minScore)
    );
  });
});

describe('creator-studio copies', () => {
  // The studio cannot import EARLY_ACCESS_CONFIG: it lives in the main app's server constants and carries
  // a feature-flag rung the studio has no access to. So its copy of the numeric rungs is pinned instead.
  const numeric = (rungs: (typeof EARLY_ACCESS_CONFIG)['scoreTimeFrameUnlock']) =>
    rungs.filter(([score]) => typeof score === 'number');

  it('the studio early access ladders match the main app', () => {
    expect(EARLY_ACCESS_SCORE_UNLOCK).toEqual(numeric(EARLY_ACCESS_CONFIG.scoreTimeFrameUnlock));
    expect(EARLY_ACCESS_QUANTITY_UNLOCK).toEqual(numeric(EARLY_ACCESS_CONFIG.scoreQuantityUnlock));
  });
});
