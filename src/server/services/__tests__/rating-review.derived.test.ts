import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DerivedLevelModule from '~/server/services/text-scan/derived-level';
import type * as ArticleHelpers from '~/server/services/article-rating-review.helpers';
import type {
  RatingReviewScan,
  RatingReviewSubject,
} from '~/server/services/rating-review.entities';

vi.mock('~/server/services/text-scan/derived-level', async (importOriginal) => ({
  ...(await importOriginal<typeof DerivedLevelModule>()),
  computeRatedEntityDerivedNsfwLevel: vi.fn(),
}));
vi.mock('~/server/services/article-rating-review.helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ArticleHelpers>()),
  computeArticleDerivedNsfwLevel: vi.fn(),
}));

const { computeDerivedNsfwLevel, evaluateOverrideAutoApprove, getStaleOverrideSignal } =
  await import('~/server/services/rating-review.derived');
const { computeRatedEntityDerivedNsfwLevel } = await import(
  '~/server/services/text-scan/derived-level'
);
const { computeArticleDerivedNsfwLevel } = await import(
  '~/server/services/article-rating-review.helpers'
);

const subject = (over: Partial<RatingReviewSubject> = {}): RatingReviewSubject => ({
  ownerId: 3,
  currentLevel: 8,
  updatedAt: null,
  title: 't',
  parentId: null,
  override: 8,
  overrideBasis: 8,
  ...over,
});
const scan = (over: Partial<RatingReviewScan> = {}): RatingReviewScan => ({
  raised: true,
  level: 4,
  reason: null,
  textHash: 'h',
  pending: false,
  ...over,
});
const derived = (value: number | null) =>
  vi.mocked(computeRatedEntityDerivedNsfwLevel).mockResolvedValue(value);

beforeEach(() => {
  vi.clearAllMocks();
  derived(2);
  dbMock.dbRead.image.count.mockResolvedValue(0);
  dbMock.dbRead.imageConnection.count.mockResolvedValue(0);
});

describe('computeDerivedNsfwLevel', () => {
  it("dispatches to plan 02's helpers and writes no SQL of its own", async () => {
    await computeDerivedNsfwLevel('Bounty', 4);
    expect(computeRatedEntityDerivedNsfwLevel).toHaveBeenCalledWith('Bounty', 4);
    vi.mocked(computeArticleDerivedNsfwLevel).mockResolvedValue(8);
    expect(await computeDerivedNsfwLevel('Article', 5)).toBe(8);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('getStaleOverrideSignal', () => {
  it('flags an override whose content has since dropped below its basis, comparing highest bits', async () => {
    derived(1 | 2);
    expect(await getStaleOverrideSignal('Post', 1, { override: 8, overrideBasis: 4 | 8 })).toEqual({
      derivedLevel: 3,
      derivedRatingDroppedBelowOverride: true,
    });
    derived(8);
    expect(
      (await getStaleOverrideSignal('Post', 1, { override: 8, overrideBasis: 8 }))
        .derivedRatingDroppedBelowOverride
    ).toBe(false);
  });

  it('reads nothing when there is no override, and fails closed on a null basis', async () => {
    expect(
      await getStaleOverrideSignal('Bounty', 1, { override: null, overrideBasis: null })
    ).toEqual({
      derivedLevel: null,
      derivedRatingDroppedBelowOverride: false,
    });
    expect(computeRatedEntityDerivedNsfwLevel).not.toHaveBeenCalled();
    expect(
      (await getStaleOverrideSignal('Bounty', 1, { override: 8, overrideBasis: null }))
        .derivedRatingDroppedBelowOverride
    ).toBe(false);
  });

  it.each([
    ['Challenge', 2],
    ['Crucible', 2],
    ['Collection', 1],
  ] as const)('never flags a %s, which only a moderator resolves', async (entityType, override) => {
    derived(1);
    expect(await getStaleOverrideSignal(entityType, 1, { override, overrideBasis: 4 })).toEqual({
      derivedLevel: null,
      derivedRatingDroppedBelowOverride: false,
    });
    expect(computeRatedEntityDerivedNsfwLevel).not.toHaveBeenCalled();
  });
});

describe('evaluateOverrideAutoApprove', () => {
  const run = (over: Partial<Parameters<typeof evaluateOverrideAutoApprove>[0]> = {}) =>
    evaluateOverrideAutoApprove({
      entityType: 'Post',
      entityId: 1,
      subject: subject(),
      scan: scan(),
      suggestedLevel: 2,
      ...over,
    });

  it('approves when content dropped below the basis and agrees with the suggestion', async () => {
    await expect(run()).resolves.toEqual({ eligible: true, derivedLevel: 2 });
  });

  it('refuses each failed condition with its reason', async () => {
    expect(await run({ subject: subject({ override: null }) })).toMatchObject({
      reason: 'no-override',
    });
    expect(await run({ subject: subject({ override: 32 }) })).toMatchObject({
      reason: 'override-blocked',
    });
    expect(await run({ suggestedLevel: 8 })).toMatchObject({ reason: 'not-down-direction' });
    for (const entityType of ['Challenge', 'Crucible', 'Collection'] as const)
      expect(await run({ entityType })).toMatchObject({ reason: 'moderator-only' });
    expect(await run({ scan: scan({ pending: true }) })).toMatchObject({
      reason: 'text-scan-pending',
    });
    dbMock.dbRead.image.count.mockResolvedValueOnce(1);
    expect(await run()).toMatchObject({ reason: 'images-not-clean' });
    derived(0);
    expect(await run()).toMatchObject({ reason: 'no-derivable-signal' });
    derived(4);
    expect(await run()).toMatchObject({ reason: 'derived-exceeds-suggested' });
    derived(2);
    expect(await run({ subject: subject({ overrideBasis: null }) })).toMatchObject({
      reason: 'no-override-basis',
    });
    expect(await run({ subject: subject({ overrideBasis: 2 }) })).toMatchObject({
      reason: 'content-not-dropped-since-override',
    });
  });

  it("checks a bounty entry's images through ImageConnection, not Image.postId", async () => {
    await run({ entityType: 'BountyEntry' });
    expect(dbMock.dbRead.imageConnection.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entityType: 'BountyEntry', entityId: 1 }),
      })
    );
    expect(dbMock.dbRead.image.count).not.toHaveBeenCalled();
  });
});
