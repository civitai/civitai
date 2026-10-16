import { describe, expect, it } from 'vitest';
import {
  backfillExemptionParams,
  exemptionReason,
  isPolicyChangeRemoval,
  policyChangeCandidatesQuery,
  previewTierUps,
  type PolicyChangeRule,
  type RemovalHistory,
} from '~/server/services/removal-score-exemption.service';

const CUTOFF = new Date('2025-05-22T22:02:27Z');
const CUTOFF_S = CUTOFF.getTime() / 1000;
const DAY = 86_400;
const rule: PolicyChangeRule = {
  cutoff: CUTOFF,
  maxImageId: 1000,
  ratings: ['None'],
  requireFirstRemovalAfterCutoff: true,
};
const withEarlierRemovals: PolicyChangeRule = { ...rule, requireFirstRemovalAfterCutoff: false };
const POI_VERSION = 77;
const poiVersions = new Set([POI_VERSION]);

// Posted before the rule, removed once after it by a bulk pass with no reason, rated PG, made with a
// POI resource: the case the exemption exists for.
const policyChange: RemovalHistory = {
  ownerId: 1,
  imageId: 900,
  removedAt: CUTOFF_S + 3 * DAY,
  firstRemovedAt: CUTOFF_S + 3 * DAY,
  firstNsfw: 'None',
  firstReason: '',
  lastReason: '',
  resourceIds: [POI_VERSION],
  minorRemovals: 0,
};
// First removed before the rule by a moderator, as POI, rated PG.
const earlierPoiRemoval: RemovalHistory = {
  ...policyChange,
  firstRemovedAt: CUTOFF_S - 30 * DAY,
  firstReason: 'poi',
};

describe('isPolicyChangeRemoval', () => {
  it('exempts a PG POI image posted before the rule and first removed after it', () => {
    expect(isPolicyChangeRemoval(policyChange, rule, poiVersions)).toBe(true);
  });

  it('does not exempt one a moderator first removed before the rule, though it was removed again after', () => {
    const removedUnderTheOldRule = {
      ...policyChange,
      firstRemovedAt: CUTOFF_S - 30 * DAY,
      firstNsfw: 'Mature',
      firstReason: 'poi',
    };
    expect(isPolicyChangeRemoval(removedUnderTheOldRule, rule, poiVersions)).toBe(false);
    // PG too: the date alone rejects it.
    expect(
      isPolicyChangeRemoval({ ...removedUnderTheOldRule, firstNsfw: 'None' }, rule, poiVersions)
    ).toBe(false);
  });

  it('counts a removal at the cutoff itself as after the rule', () => {
    const atCutoff = { ...policyChange, firstRemovedAt: CUTOFF_S };
    expect(isPolicyChangeRemoval(atCutoff, rule, poiVersions)).toBe(true);
    expect(
      isPolicyChangeRemoval({ ...atCutoff, firstRemovedAt: CUTOFF_S - 1 }, rule, poiVersions)
    ).toBe(false);
  });

  it('does not exempt an image posted after the rule', () => {
    expect(isPolicyChangeRemoval({ ...policyChange, imageId: 1001 }, rule, poiVersions)).toBe(
      false
    );
    expect(isPolicyChangeRemoval({ ...policyChange, imageId: 1000 }, rule, poiVersions)).toBe(true);
  });

  it('needs the first removal rated one of the given ratings', () => {
    const soft = { ...policyChange, firstNsfw: 'Soft' };
    expect(isPolicyChangeRemoval(soft, rule, poiVersions)).toBe(false);
    const sfw: PolicyChangeRule = { ...rule, ratings: ['None', 'Soft'] };
    expect(isPolicyChangeRemoval(soft, sfw, poiVersions)).toBe(true);
    expect(isPolicyChangeRemoval({ ...soft, firstNsfw: 'Mature' }, sfw, poiVersions)).toBe(false);
  });

  it('never exempts an image ever removed as minor', () => {
    expect(isPolicyChangeRemoval({ ...policyChange, minorRemovals: 1 }, rule, poiVersions)).toBe(
      false
    );
    const earlierMinor = { ...earlierPoiRemoval, minorRemovals: 1 };
    expect(isPolicyChangeRemoval(earlierMinor, withEarlierRemovals, poiVersions)).toBe(false);
  });

  it('exempts a PG removal made as POI before the rule only with requireFirstRemovalAfterCutoff off', () => {
    expect(isPolicyChangeRemoval(earlierPoiRemoval, rule, poiVersions)).toBe(false);
    expect(isPolicyChangeRemoval(earlierPoiRemoval, withEarlierRemovals, poiVersions)).toBe(true);
  });

  it('exempts a PG removal reported before the rule, restored, then removed as POI, only with the switch off', () => {
    const removedAgainAsPoi = { ...earlierPoiRemoval, firstReason: 'reported', lastReason: 'poi' };
    expect(isPolicyChangeRemoval(removedAgainAsPoi, rule, poiVersions)).toBe(false);
    expect(isPolicyChangeRemoval(removedAgainAsPoi, withEarlierRemovals, poiVersions)).toBe(true);
  });

  it('with requireFirstRemovalAfterCutoff off, still needs a removal before the rule to be PG and reasoned poi', () => {
    // The negative twin: a Mature image a moderator removed as POI under the old rule.
    const mature = { ...earlierPoiRemoval, firstNsfw: 'Mature' };
    expect(isPolicyChangeRemoval(mature, withEarlierRemovals, poiVersions)).toBe(false);
    // A POI resource is not enough before the rule.
    const reported = { ...earlierPoiRemoval, firstReason: 'reported', lastReason: 'reported' };
    expect(isPolicyChangeRemoval(reported, withEarlierRemovals, poiVersions)).toBe(false);
  });

  it('needs a POI link: a poi reason on the first or latest removal, or a POI resource', () => {
    const unlinked = { ...policyChange, resourceIds: [5] };
    expect(isPolicyChangeRemoval(unlinked, rule, poiVersions)).toBe(false);
    expect(isPolicyChangeRemoval({ ...unlinked, firstReason: 'poi' }, rule, poiVersions)).toBe(
      true
    );
    expect(isPolicyChangeRemoval({ ...unlinked, lastReason: 'poi' }, rule, poiVersions)).toBe(true);
    expect(isPolicyChangeRemoval({ ...unlinked, lastReason: 'reported' }, rule, poiVersions)).toBe(
      false
    );
  });
});

describe('policyChangeCandidatesQuery', () => {
  const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

  it('narrows by the rule inputs it is given, not by fixed values', () => {
    const earlier: PolicyChangeRule = {
      cutoff: new Date('2024-01-01T00:00:00Z'),
      maxImageId: 123,
      ratings: ['None', 'Soft'],
      requireFirstRemovalAfterCutoff: true,
    };
    const sql = flat(policyChangeCandidatesQuery(earlier));

    expect(sql).toContain('AND imageId <= 123 GROUP BY');
    expect(sql).toMatch(/AND firstRemovedAt >= 1704067200 AND firstNsfw IN \('None', 'Soft'\)$/);
    expect(flat(policyChangeCandidatesQuery(rule))).toMatch(
      new RegExp(`AND firstRemovedAt >= ${CUTOFF_S} AND firstNsfw IN \\('None'\\)$`)
    );
  });

  it('leaves the first-removal date to the rule when removals before the cutoff are covered', () => {
    const sql = flat(policyChangeCandidatesQuery(withEarlierRemovals));

    expect(sql).not.toContain('firstRemovedAt >=');
    expect(sql).toMatch(/maxIf\(time, type = 'Restore'\)\) AND firstNsfw IN \('None'\)$/);
  });
});

describe('exemptionReason', () => {
  it('records the rule inputs that created the row', () => {
    expect(exemptionReason(rule, 'poi-policy')).toBe(
      'poi-policy cutoff=2025-05-22T22:02:27.000Z maxImageId=1000 ratings=None requireFirstRemovalAfterCutoff=true'
    );
  });
});

describe('ClickHouse values as strings', () => {
  it('reads 64-bit values ClickHouse returns as strings', () => {
    const asStrings = {
      ...policyChange,
      imageId: '900',
      firstRemovedAt: String(CUTOFF_S + DAY),
      resourceIds: [String(POI_VERSION)],
      minorRemovals: '0',
    } as unknown as RemovalHistory;
    expect(isPolicyChangeRemoval(asStrings, rule, poiVersions)).toBe(true);
    expect(
      isPolicyChangeRemoval({ ...asStrings, minorRemovals: '1' } as never, rule, poiVersions)
    ).toBe(false);
  });
});

describe('previewTierUps', () => {
  // Lowest first, so the highest tier reached is picked by the code, not by the query's order.
  const TIERS = [
    { name: 'Kindle', threshold: 1_000 },
    { name: 'Flame', threshold: 5_000 },
    { name: 'Blaze', threshold: 10_000 },
  ];
  const fakePg = (totals: { id: number; total: number | null }[]) =>
    ({
      cancellableQuery: async (sql: string) => ({
        result: async () => (sql.includes('"CreatorMilestone"') ? TIERS : totals),
      }),
    } as never);

  it('counts each owner once, at the highest tier newly reached, with the boundary inclusive', async () => {
    const pg = fakePg([
      { id: 1, total: 900 }, // +9,100 reaches exactly Blaze, passing Kindle and Flame
      { id: 2, total: 4_000 }, // +1,000 reaches exactly Flame
      { id: 3, total: 1_000 }, // already Kindle, +1,000 reaches nothing
      { id: 4, total: null }, // no score yet, +1,000 reaches Kindle
    ]);
    const removals = new Map([
      [1, 91],
      [2, 10],
      [3, 10],
      [4, 10],
    ]);

    expect(await previewTierUps(pg, removals, 100)).toEqual({
      owners: 3,
      byTier: { Blaze: 1, Flame: 1, Kindle: 1 },
    });
  });

  it('does not count a tier the owner already held', async () => {
    const pg = fakePg([{ id: 1, total: 5_000 }]);
    expect(await previewTierUps(pg, new Map([[1, 1]]), 100)).toEqual({ owners: 0, byTier: {} });
  });
});

describe('backfillExemptionParams', () => {
  it('is a dry run of the article rule, PG only, unless told otherwise', () => {
    expect(backfillExemptionParams.parse({})).toEqual({
      cutoff: new Date('2025-05-22T22:02:27Z'),
      maxImageId: 77_895_843,
      requireFirstRemovalAfterCutoff: true,
      ratings: ['None'],
      label: 'poi-policy',
      dryRun: true,
    });
    expect(backfillExemptionParams.parse({ dryRun: 'false' }).dryRun).toBe(false);
  });

  it('reads comma lists, and refuses an empty or unknown rating', () => {
    const parsed = backfillExemptionParams.parse({ ratings: 'None,Soft', probe: '1,2' });
    expect(parsed.ratings).toEqual(['None', 'Soft']);
    expect(parsed.probe).toEqual([1, 2]);
    expect(backfillExemptionParams.safeParse({ ratings: '' }).success).toBe(false);
    expect(backfillExemptionParams.safeParse({ ratings: 'Blocked' }).success).toBe(false);
  });

  it('takes an explicit label of word characters and dashes, and refuses anything else', () => {
    expect(backfillExemptionParams.parse({ label: 'poi-policy-2' }).label).toBe('poi-policy-2');
    expect(backfillExemptionParams.safeParse({ label: 'poi policy' }).success).toBe(false);
    expect(backfillExemptionParams.safeParse({ label: 'x'.repeat(41) }).success).toBe(false);
  });
});
