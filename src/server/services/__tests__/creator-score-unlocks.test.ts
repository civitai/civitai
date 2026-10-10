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
import {
  assertUserInGoodStanding,
  buildCreateEligibility,
} from '~/server/services/challenge-eligibility.service';
import { getCrucibleJudgeEligibility } from '~/server/services/crucible-eligibility.service';
import {
  buildCreatorScoreUnlocks,
  compiledCreatorScoreUnlockInputs,
  getCreatorScoreUnlocks,
} from '~/server/services/creator-score-unlocks.service';
import {
  nextCreatorScoreUnlocks,
  type CreatorScoreKind,
  type CreatorScoreUnlock,
} from '~/shared/utils/creator-score-unlocks';
import {
  getMaxEarlyAccessDays,
  getMaxEarlyAccessModels,
} from '~/server/utils/early-access-helpers';
import { placementFreeSlotCap, placementPriceCap } from '~/shared/utils/placement';
import type { SessionUser } from '~/types/session';
import type * as CreatorProgramService from '~/server/services/creator-program.service';
import {
  getCreatorRequirements,
  joinCreatorsProgram,
} from '~/server/services/creator-program.service';
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
// that disagrees with the gate it describes then fails here, whichever side moved.

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

const labelNumber = (label: string, pattern: RegExp) => {
  const value = Number(label.match(pattern)?.[1]);
  if (!(value > 0)) throw new Error(`label "${label}" no longer matches ${pattern}`);
  return value;
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

  // The kind is what a journey page or refusal compares the viewer's score against. Sales read the stored
  // total (the studio's resolveTotalScore), not the aggregate the Creator Program and announcements use.
  it('states the score each gate actually compares', () => {
    const kindByGate: Record<string, CreatorScoreKind> = {
      'crucible-judge': 'total',
      'daily-posts': 'total',
      'comment-rate-limit': 'total',
      'reaction-rate-limit': 'total',
      'daily-articles': 'total',
      'challenge-create': 'total',
      'monetize-pricing': 'total',
      'monetize-sales': 'total',
      'early-access-days': 'total',
      'early-access-quantity': 'total',
      announcements: 'aggregate',
      'placement-price-cap': 'total',
      'placement-free-slots': 'total',
      'creator-program': 'aggregate',
    };
    expect(compiled.map((u) => [u.key, u.scoreKind])).toEqual(
      compiled.map((u) => [u.key, kindByGate[u.key.split(':')[0]]])
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

  it('crucible creation flips at the challenge threshold', () => {
    const { minScore } = unlock('challenge-create');
    const scoreMet = (scoreTotal: number) =>
      buildCreateEligibility({
        standing: { scoreTotal, bannedAt: null, muted: false, deletedAt: null, activePoints: 0 },
        recentCount: 0,
        activeCount: 0,
      }).requirements.find((r) => r.key === 'score')?.met;
    expect(scoreMet(minScore - 1)).toBe(false);
    expect(scoreMet(minScore)).toBe(true);
  });

  it('joining the Creator Program flips at the registry threshold', async () => {
    const { minScore } = unlock('creator-program');
    const scoreRefusal = 'User does not meet the minimum creator score';
    const joinError = async (score: number) => {
      dbMock.dbWrite.$queryRaw.mockResolvedValue([
        { score, membership: 'gold', onboarding: 0 },
      ] as never);
      dbMock.dbWrite.user.findFirstOrThrow.mockResolvedValue({ onboarding: 0 } as never);
      return joinCreatorsProgram(1).then(
        () => null,
        (e: Error) => e.message
      );
    };
    expect(await joinError(minScore - 1)).toBe(scoreRefusal);
    expect(await joinError(minScore)).not.toBe(scoreRefusal);
  });

  it('each daily post tier takes effect at its registry threshold, for members too', () => {
    const tiers = withPrefix('daily-posts:');
    expect(tiers).toHaveLength(2);
    for (const { key, minScore, label } of tiers) {
      const limit = labelNumber(label, /Post up to (\d+) times/);
      const memberLimit = labelNumber(label, /\((\d+) as a member\)/);
      const day = (user: SessionUser) => effectiveLimit(postRateLimits, CacheTTL.day, user);
      expect(day(sessionUser({ total: minScore - 1 })), key).toBeLessThan(limit);
      expect(day(sessionUser({ total: minScore })), key).toBe(limit);
      expect(day(sessionUser({ total: minScore }, 'gold')), key).toBe(memberLimit);
    }
  });

  it.each([
    ['comment-rate-limit', commentRateLimits],
    ['reaction-rate-limit', reactionRateLimits],
  ])('every %s rule switches on at the registry threshold and not before', (key, rules) => {
    const { minScore } = unlock(key);
    const gated = rules.filter((r) => r.userReq);
    expect(gated.length).toBeGreaterThan(0);
    for (const rule of gated) {
      const where = `${key} rule ${rule.limit}/${rule.period}s`;
      expect(rule.userReq?.(sessionUser({ total: minScore - 1 })), where).toBe(false);
      expect(rule.userReq?.(sessionUser({ total: minScore })), where).toBe(true);
    }
  });

  // A product decision, not an oversight: article limits were keyed on the articles category score and
  // were moved onto the total so every Creator Score gate compares the number the user can see.
  it('each daily article tier takes effect at its registry threshold, on the total, not the articles score', () => {
    for (const { key, minScore, label } of withPrefix('daily-articles:')) {
      const limit = labelNumber(label, /up to (\d+) articles/);
      const day = (user: SessionUser) => effectiveLimit(articleRateLimits, CacheTTL.day, user);
      expect(day(sessionUser({ total: minScore - 1, articles: 10_000_000 })), key).toBeLessThan(
        limit
      );
      expect(day(sessionUser({ total: minScore })), key).toBe(limit);
      expect(
        day(sessionUser({ total: String(minScore * 10) as unknown as number })),
        `${key} string total`
      ).toBeLessThan(limit);
    }
  });

  it('pricing eligibility flips at the registry threshold', () => {
    const { minScore } = unlock('monetize-pricing');
    expect(pricingEligibility(minScore - 1).eligible).toBe(false);
    expect(pricingEligibility(minScore).eligible).toBe(true);
  });

  it('every early access rung takes effect at its registry threshold', () => {
    const userMeta = (total: number) => ({ scores: { total } } as never);
    for (const { key, minScore, label } of withPrefix('early-access-days:')) {
      const days = labelNumber(label, /up to (\d+) days/);
      expect(getMaxEarlyAccessDays({ userMeta: userMeta(minScore - 1) }), key).toBeLessThan(days);
      expect(getMaxEarlyAccessDays({ userMeta: userMeta(minScore) }), key).toBe(days);
    }
    for (const { key, minScore, label } of withPrefix('early-access-quantity:')) {
      const count = label.startsWith('One ') ? 1 : labelNumber(label, /^(\d+) versions/);
      expect(getMaxEarlyAccessModels({ userMeta: userMeta(minScore - 1) }), key).toBeLessThan(
        count
      );
      expect(getMaxEarlyAccessModels({ userMeta: userMeta(minScore) }), key).toBe(count);
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
  const challenge = unlock('challenge-create').minScore;
  const creatorProgram = unlock('creator-program').minScore;

  it('returns every unlock at the nearest unreached threshold, and none already reached', () => {
    const next = nextCreatorScoreUnlocks(compiled, { total: challenge - 1 });
    expect(new Set(next.map((u) => u.minScore))).toEqual(new Set([challenge]));
    expect(next.map((u) => u.key)).toContain('challenge-create');

    expect(
      nextCreatorScoreUnlocks(compiled, { total: challenge }).every((u) => u.minScore > challenge)
    ).toBe(true);
  });

  it('judges each gate against its own kind of score', () => {
    const gates = [unlock('creator-program'), unlock('placement-price-cap:sticker:100000')];
    const pending = (aggregate?: number) =>
      gates
        .flatMap((u) => nextCreatorScoreUnlocks([u], { total: creatorProgram - 1, aggregate }))
        .map((u) => u.key);

    expect(pending(1e12)).toEqual(['placement-price-cap:sticker:100000']);
    expect(pending()).toEqual(['creator-program', 'placement-price-cap:sticker:100000']);
  });

  it('points a total just short of a daily article tier at that tier', () => {
    for (const { key, minScore } of withPrefix('daily-articles:')) {
      const next = nextCreatorScoreUnlocks(compiled, { total: minScore - 1 }).map((u) => u.key);
      expect(next, key).toContain(key);
    }
  });

  it('is empty when everything is reached', () => {
    const top = Math.max(...compiled.map((u) => u.minScore));
    expect(nextCreatorScoreUnlocks(compiled, { total: top })).toEqual([]);
  });
});

describe('live values', () => {
  // The studio's sale FORM check. Its scheduleSale action compares separately (sales/+page.server.ts) and is
  // not driven from here.
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

  it('reads the sale floor from the sale-limits row, as the studio sale form does', async () => {
    keyValueRows({ 'sale-limits': { minCreatorScore: 22_000 } });
    const { minScore } = unlock('monetize-sales', await getCreatorScoreUnlocks());

    expect(minScore).toBe(22_000);
    expect(saleBlocked(minScore - 1, 22_000)).toBe(true);
    expect(saleBlocked(minScore, 22_000)).toBe(false);
  });

  it('falls back to the compiled sale floor when the row is absent or malformed, as the studio sale form does', async () => {
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

  it('reads both placement tables from placement:config, per surface', async () => {
    const caps = { free: 1, bronze: 1, silver: 1, gold: 1 };
    keyValueRows({
      'placement:config': {
        priceCapTiersBySurface: {
          sticker: [
            { minScore: 0, caps },
            { minScore: 42_000, caps },
          ],
        },
        freeSlotTiersBySurface: {
          remixGallery: [
            { minScore: 0, caps },
            { minScore: 43_000, caps },
          ],
        },
      },
    });
    const unlocks = await getCreatorScoreUnlocks();
    const bands = (prefix: string, list = unlocks) =>
      withPrefix(prefix, list).map((u) => u.minScore);

    expect(bands('placement-price-cap:sticker:')).toEqual([42_000]);
    expect(bands('placement-price-cap:remixGallery:')).toEqual(
      bands('placement-price-cap:remixGallery:', compiled)
    );
    expect(bands('placement-free-slots:remixGallery:')).toEqual([43_000]);
    expect(bands('placement-free-slots:sticker:')).toEqual(
      bands('placement-free-slots:sticker:', compiled)
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
