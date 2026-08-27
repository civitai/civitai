import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { Availability } from '~/shared/utils/prisma/enums';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type * as MetricHelpers from '~/server/utils/metric-helpers';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import type { HybridNode } from '~/__tests__/mocks/hybrid';

const updateEntityMetricDetached = vi.fn(async () => undefined);
vi.mock('~/server/utils/metric-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof MetricHelpers>()),
  updateEntityMetricDetached,
}));

/**
 * Every quantity distinct, so a value reaching the wrong place cannot pass by
 * colliding with the right one.
 */
const OWNER = 41;
const PLACER = 52;
const STRANGER = 63;
const HOST_IMAGE = 74;
const REMIX_IMAGE = 85;
const PLACEMENT = 96;
const FREE_PLACEMENT = 107;
const PRICE = 700;

const holdPlacementEscrow = vi.fn(async () => ({ fee: 210, principal: 490 }));
const settlePlacement = vi.fn(async () => ({ settled: true }));

/** What the refund tests below read back off the last settle call. */
type SettleArgs = { placementId: number; action: string };
const lastSettleArgs = () => settlePlacement.mock.calls.at(-1)?.[0] as SettleArgs | undefined;
const FEE_WAIVING_ACTIONS = ['declineByBlock', 'declineUnshowableHost'];
vi.mock('~/server/services/placement-escrow.service', () => ({
  holdPlacementEscrow,
  settlePlacement,
  // Real, not a stand-in. The refund test asserts membership of this list, so a
  // fake one would let the test pass against an action that charges the fee.
  FEE_WAIVING_ACTIONS: ['declineByBlock', 'declineUnshowableHost'],
}));

const assertCanPlace = vi.fn(async () => undefined);
vi.mock('~/server/services/placement-moderation.service', () => ({ assertCanPlace }));

// Stubbed rather than spread from the original: the real module loads
// `base.reward`, which pulls the buzz service and its whole import graph into a
// suite that mocks the escrow service precisely to keep it out. What the reward
// itself does with these arguments is its own suite's job.
const rewardApply = vi.fn(async () => undefined);
vi.mock('~/server/rewards/active/remixAccept.reward', () => ({
  remixAcceptReward: { apply: rewardApply },
}));

/**
 * The free claim is the boundary this file tests against, not through. It owns
 * an advisory-locked transaction and every refusal the paid path makes, all of
 * which are `free-placement.service`'s own tests to keep — what matters here is
 * that the free branch delegates to it with the right target instead of building
 * a row of its own.
 */
const createFreePlacement = vi.fn(async () => ({ id: FREE_PLACEMENT }));
const getFreePlacementAllowance = vi.fn(async () => ({
  used: 0,
  remaining: 1,
  resetsAt: new Date('2026-01-02'),
}));
const hasUsedFreePlacementOn = vi.fn(async () => false);
vi.mock('~/server/services/free-placement.service', () => ({
  createFreePlacement,
  getFreePlacementAllowance,
  hasUsedFreePlacementOn,
}));

const resolvePlacementSpaceFor = vi.fn();
vi.mock('~/server/services/placement-space.service', () => ({ resolvePlacementSpaceFor }));

vi.mock('~/server/services/placement.service', () => ({
  getPlacementConfig: async () => ({
    declineFeeRate: () => 0.3,
    // Not the real defaults — no test here asserts an owner payout. Anything
    // that starts to must set these, or it will read 100% to the owner.
    approvalShares: () => ({ seller: 0, platform: 0 }),
  }),
}));

/**
 * The mutation's ordering is its design — the row must exist before the escrow
 * can reference it — and that cannot be read off assertions about final state.
 */
const calls: string[] = [];

/**
 * The service reaches two members on BOTH clients — `$queryRaw` (dbRead ×10, dbWrite ×2) and
 * `placement.findMany` (dbRead ×4, dbWrite ×1) — and the assertions in this file read ONE
 * ordered call list per member, including positional reads like `.mock.calls[0][0].where`.
 * Splitting those into two lists would silently reorder them, so both canonical nodes forward
 * to a single local spy instead. The fixture this replaces aliased them the same way.
 *
 * 🔴 The consequence, stated rather than buried: a `$queryRaw` or `placement.findMany` call
 * that moved between the replica and the primary is still invisible here. Every OTHER member
 * below is single-client in the service, so those routes are pinned — bind one to the wrong
 * client and its tests stop seeing the call.
 */
type AnyFn = (...args: any[]) => any;
const forwardTo = <T extends Mock<AnyFn>>(spy: T, ...nodes: HybridNode[]) => {
  for (const node of nodes) node.mockImplementation((...args: unknown[]) => spy(...args));
  return spy;
};

const queryRaw = forwardTo(vi.fn<AnyFn>(), dbMock.dbRead.$queryRaw, dbMock.dbWrite.$queryRaw);
const placementFindMany = forwardTo(
  vi.fn<AnyFn>(async () => [] as unknown[]),
  dbMock.dbRead.placement.findMany,
  dbMock.dbWrite.placement.findMany
);

// Single-client members, bound directly. `$transaction` is left to the canonical default:
// the service only ever passes it an array, which the default resolves with `Promise.all`,
// and nothing reads what it returns.
const placementCreate = dbMock.dbWrite.placement.create;
placementCreate.mockImplementation(async () => {
  calls.push('create');
  return { id: PLACEMENT };
});
const placementCount = dbMock.dbWrite.placement.count;
const placementFindFirst = dbMock.dbWrite.placement.findFirst;
// `declineOutOfBand` re-reads each row by id, so one of the cases below answers per-placement
// rather than with a fixed row.
const placementFindUnique = dbMock.dbWrite.placement.findUnique;
const imageFindMany = dbMock.dbRead.image.findMany;

// Writes have no canonical default and the service reads what these return.
const placementUpdate = dbMock.dbWrite.placement.update;
placementUpdate.mockResolvedValue({});
const placementUpdateMany = dbMock.dbWrite.placement.updateMany;
placementUpdateMany.mockResolvedValue({ count: 1 });

dbMock.dbRead.user.findUnique.mockResolvedValue({ username: 'someone' });

const {
  createRemixGallerySubmission,
  actOnRemixGallerySubmission,
  retractRemixGallerySubmission,
  setRemixGalleryPins,
  parseGalleryCursor,
  getRemixGallery,
  getRemixGalleryCardSummaries,
  getRemixGalleryVisibility,
  getRemixGalleryFreeEligibility,
  getMyRemixGallerySubmissions,
  getPendingRemixGallerySubmissions,
  declineOutOfBandRemixGallerySubmissions,
} = await import('~/server/services/remix-gallery.service');

const {
  remixGalleryLevelAllowed,
  remixGalleryMaxSubmissionLevel,
  REMIX_GALLERY_MAX_PINNED,
  REMIX_GALLERY_REMOVAL_LOCK_HOURS,
} = await import('~/shared/utils/remix-gallery');

/**
 * Declared rather than inferred, because every test here builds its case by
 * spreading the good one and overriding a field. Inference narrowed `null`s to
 * `null` and the rating to a literal, so the overrides that make each test a
 * test — `needsReview: 'reported'`, `nsfwLevel: 0`, `publishedAt: null` — were
 * type errors against their own fixture.
 */
type SubmissionFixture = {
  id: number;
  userId: number;
  nsfwLevel: number;
  minor: boolean;
  poi: boolean;
  tosViolation: boolean;
  ingestion: string;
  needsReview: string | null;
  publishedAt: Date | null;
  remixOfId: number | null;
  sourceImageIds: number[] | null;
};

/** A submission that passes every check, so each test breaks exactly one thing. */
const goodSubmission: SubmissionFixture = {
  id: REMIX_IMAGE,
  userId: PLACER,
  nsfwLevel: NsfwLevel.PG,
  minor: false,
  poi: false,
  tosViolation: false,
  ingestion: 'Scanned',
  needsReview: null,
  publishedAt: new Date('2026-01-01'),
  remixOfId: null,
  sourceImageIds: [] as number[],
};

const openSpace = {
  ownerId: OWNER,
  mode: 'review' as const,
  setPrice: PRICE,
  price: PRICE,
  cap: 1000,
  freeSlots: 2,
  freeSlotsRemaining: 1,
  settings: {},
};

/** A submission the server itself resolved as derived from the host image. */
const verifiedSubmission: SubmissionFixture = {
  ...goodSubmission,
  sourceImageIds: [HOST_IMAGE],
};

/**
 * `loadSubmissionImage` and the host-rating lookup are two raw queries in
 * order, so the fake answers by call index rather than by inspecting SQL — SQL
 * matching would couple every test to the query text.
 */
function primeQueries({
  submission = goodSubmission,
  hostLevel = NsfwLevel.PG,
  hostMinor = false,
  hostShowable = true,
}: {
  submission?: typeof goodSubmission | null;
  hostLevel?: number | null;
  hostMinor?: boolean;
  hostShowable?: boolean;
} = {}) {
  let call = 0;
  queryRaw.mockImplementation(async () => {
    call += 1;
    if (call === 1) return submission ? [submission] : [];
    if (call === 2)
      return hostLevel == null
        ? []
        : [{ nsfwLevel: hostLevel, minor: hostMinor, showable: hostShowable }];
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  resolvePlacementSpaceFor.mockResolvedValue(openSpace);
  placementCount.mockResolvedValue(0);
  placementFindFirst.mockResolvedValue(null);
  settlePlacement.mockResolvedValue({ settled: true });
  createFreePlacement.mockResolvedValue({ id: FREE_PLACEMENT });
  hasUsedFreePlacementOn.mockResolvedValue(false);
  holdPlacementEscrow.mockImplementation(async () => {
    calls.push('hold');
    return { fee: 210, principal: 490 };
  });
  primeQueries();
});

const submit = (over: Partial<Parameters<typeof createRemixGallerySubmission>[0]> = {}) =>
  createRemixGallerySubmission({
    spendType: 'yellow',
    placerId: PLACER,
    hostImageId: HOST_IMAGE,
    imageId: REMIX_IMAGE,
    ...over,
  });

/**
 * The SQL a raw query actually carries, as one string.
 *
 * Nested `Prisma.sql` fragments arrive as VALUES rather than as part of the
 * template's string array, so flattening is what makes an assertion see a
 * predicate that lives inside a fragment at all.
 *
 * At module scope because two suites need it and both encode the same guess
 * about Prisma's internals — `strings` and `values` on a fragment. When that
 * shape changes, one copy gets fixed and the other keeps passing over SQL it can
 * no longer read.
 */
const flatten = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(flatten).join(' ');
  if (value && typeof value === 'object' && 'strings' in value)
    return [
      flatten((value as { strings: unknown }).strings),
      flatten((value as { values?: unknown }).values ?? []),
    ].join(' ');
  return typeof value === 'string' ? value : '';
};

/** The bound parameters, which `flatten` drops — it keeps only strings. */
const boundValues = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value.flatMap(boundValues);
  if (value && typeof value === 'object' && 'strings' in value)
    return boundValues((value as { values?: unknown }).values ?? []);
  return [value];
};

describe('content level rules', () => {
  it('refuses an unrated submission under BOTH rules', () => {
    // The one that reads like an edge case and is not: 0 means unscanned, not
    // safe, and admitting it under `any` is how an unscanned image lands on
    // someone else's page.
    for (const rule of ['atOrBelow', 'any'] as const)
      expect(
        remixGalleryLevelAllowed({
          rule,
          submissionLevel: 0,
          hostLevel: NsfwLevel.XXX,
          hostMinor: false,
        })
      ).toBe(false);
  });

  it('refuses a Blocked submission under both rules', () => {
    for (const rule of ['atOrBelow', 'any'] as const)
      expect(
        remixGalleryLevelAllowed({
          rule,
          submissionLevel: NsfwLevel.Blocked,
          hostLevel: NsfwLevel.XXX,
          hostMinor: false,
        })
      ).toBe(false);
  });

  it('compares numerically under atOrBelow', () => {
    expect(
      remixGalleryLevelAllowed({
        rule: 'atOrBelow',
        submissionLevel: NsfwLevel.R,
        hostLevel: NsfwLevel.X,
        hostMinor: false,
      })
    ).toBe(true);
    expect(
      remixGalleryLevelAllowed({
        rule: 'atOrBelow',
        submissionLevel: NsfwLevel.X,
        hostLevel: NsfwLevel.R,
        hostMinor: false,
      })
    ).toBe(false);
  });

  it('fails closed when the host itself is unrated', () => {
    expect(
      remixGalleryLevelAllowed({
        rule: 'atOrBelow',
        submissionLevel: NsfwLevel.PG,
        hostLevel: 0,
        hostMinor: false,
      })
    ).toBe(false);
  });

  it('refuses an over-rating submission through the mutation, not just the helper', async () => {
    primeQueries({
      submission: { ...goodSubmission, nsfwLevel: NsfwLevel.XXX },
      hostLevel: NsfwLevel.PG,
    });
    await expect(submit()).rejects.toThrow(/at or below/i);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('accepts an over-rating submission when the owner opted into any rating', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({
      ...openSpace,
      settings: { contentRule: 'any' },
    });
    primeQueries({
      submission: { ...goodSubmission, nsfwLevel: NsfwLevel.XXX },
      hostLevel: NsfwLevel.PG,
    });
    await expect(submit()).resolves.toEqual({ id: PLACEMENT });
  });
});

describe('minor-flagged host ceiling', () => {
  // The gap this closes: the submitted image's own `minor` flag was refused, the
  // host's was never read. A remix can come from an external generation, so the
  // generator's refusals are not in this path.
  const ABOVE_PG13 = [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX];

  it('refuses anything above PG-13 under BOTH content rules', () => {
    for (const rule of ['atOrBelow', 'any'] as const)
      for (const submissionLevel of ABOVE_PG13)
        expect(
          remixGalleryLevelAllowed({
            rule,
            submissionLevel,
            // An XXX host is the case that matters: `atOrBelow` alone would
            // admit every one of these.
            hostLevel: NsfwLevel.XXX,
            hostMinor: true,
          })
        ).toBe(false);
  });

  it('caps the ceiling the picker filters on, under both rules', () => {
    // The picker and the mutation have to agree, or a submitter is offered an
    // image they will then be refused for — after paying.
    expect(
      remixGalleryMaxSubmissionLevel({ rule: 'any', hostLevel: NsfwLevel.XXX, hostMinor: true })
    ).toBe(NsfwLevel.PG13);
    expect(
      remixGalleryMaxSubmissionLevel({ rule: 'atOrBelow', hostLevel: NsfwLevel.X, hostMinor: true })
    ).toBe(NsfwLevel.PG13);
    expect(
      remixGalleryMaxSubmissionLevel({ rule: 'any', hostLevel: NsfwLevel.PG, hostMinor: false })
    ).toBe(NsfwLevel.XXX);
    // Nothing is submittable to an unrated host under `atOrBelow`.
    expect(
      remixGalleryMaxSubmissionLevel({ rule: 'atOrBelow', hostLevel: 0, hostMinor: false })
    ).toBe(0);
  });

  it('still allows PG and PG-13 into a minor-flagged host', () => {
    for (const submissionLevel of [NsfwLevel.PG, NsfwLevel.PG13])
      expect(
        remixGalleryLevelAllowed({
          rule: 'any',
          submissionLevel,
          hostLevel: NsfwLevel.PG13,
          hostMinor: true,
        })
      ).toBe(true);
  });

  it('refuses through the mutation even when the owner opted into any rating', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({ ...openSpace, settings: { contentRule: 'any' } });
    primeQueries({
      submission: { ...goodSubmission, nsfwLevel: NsfwLevel.XXX },
      hostLevel: NsfwLevel.XXX,
      hostMinor: true,
    });

    await expect(submit()).rejects.toThrow(/PG-13 or below/i);
    expect(placementCreate).not.toHaveBeenCalled();
    expect(holdPlacementEscrow).not.toHaveBeenCalled();
  });

  it('refuses on approval when the host is flagged after the submission was sent', async () => {
    // Approval is the moment the entry becomes public, and a host can be flagged
    // between the two. Without the re-check the escrow settles and an XXX entry
    // goes live on a minor-flagged image.
    placementFindUnique
      .mockResolvedValueOnce({
        id: PLACEMENT,
        ownerId: OWNER,
        status: 'pending',
        surface: 'remixGallery',
        data: { imageId: REMIX_IMAGE },
        resolvedAt: null,
        createdAt: new Date('2026-01-01'),
      })
      .mockResolvedValueOnce({ targetId: HOST_IMAGE });
    primeQueries({
      submission: { ...goodSubmission, nsfwLevel: NsfwLevel.XXX },
      hostLevel: NsfwLevel.XXX,
      hostMinor: true,
    });
    resolvePlacementSpaceFor.mockResolvedValue({ ...openSpace, settings: { contentRule: 'any' } });

    await expect(
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'approve', userId: OWNER })
    ).rejects.toThrow(/PG-13 or below/i);
    expect(settlePlacement).not.toHaveBeenCalled();
  });
});

it('refuses a submission to a host that cannot show a gallery', async () => {
  // The host was never checked for anything but its rating. A blocked or
  // unscanned host is hidden from everyone but its owner, so this took Buzz for
  // a placement that could never render.
  primeQueries({ hostShowable: false });

  await expect(submit()).rejects.toThrow(/cannot show a gallery/i);
  expect(placementCreate).not.toHaveBeenCalled();
  expect(holdPlacementEscrow).not.toHaveBeenCalled();
});

describe('declining on a host that cannot show a gallery', () => {
  const pending = {
    id: PLACEMENT,
    ownerId: OWNER,
    status: 'pending',
    surface: 'remixGallery',
    targetId: HOST_IMAGE,
    data: { imageId: REMIX_IMAGE },
    resolvedAt: null,
    createdAt: new Date('2026-01-01'),
  };

  const declineWithHost = async (showable: boolean) => {
    placementFindUnique.mockResolvedValue(pending);
    // Only `loadHostImage` runs on this path, so the fake answers with the host
    // row rather than the submission-then-host pair the submit path expects.
    queryRaw.mockImplementation(async () => [{ nsfwLevel: NsfwLevel.PG, minor: false, showable }]);
    await actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'decline', userId: OWNER });
  };

  it('refunds in full instead of charging the decline fee', async () => {
    // The fee prices the owner's attention. An unshowable host refuses approval,
    // so the owner was never offered a choice — and without this the outcome
    // fair to the submitter was the one where the owner ignored their queue.
    await declineWithHost(false);

    // Asserted as a property rather than as the action name. The name is a
    // choice; "the submitter is not charged" is the thing that must hold, and an
    // assertion on the string would go green against any future action that
    // happens to be spelled the same and charges the fee.
    const call = lastSettleArgs();
    expect(FEE_WAIVING_ACTIONS).toContain(call?.action);
    expect(call?.placementId).toBe(PLACEMENT);
  });

  it('still charges the fee on a normal host', async () => {
    await declineWithHost(true);

    expect(FEE_WAIVING_ACTIONS).not.toContain(lastSettleArgs()?.action);
  });
});

describe('the ceiling is applied on read, not only on the mutation', () => {
  // Without this the display-side half is a silent revert: delete the predicate
  // from a read query and every other test in this file still passes, while
  // entries approved before a host was flagged keep rendering — and the owner
  // cannot take them down for a week.
  const sqlFrom = () => queryRaw.mock.calls.map(flatten).join(' ');

  /**
   * Asserted on rather than `minor` or `needsReview`, both of which the gallery
   * CTE already contains as filters on the *entry* — so asserting those would
   * hold with the host ceiling deleted entirely. These two strings appear only
   * inside `minorHostCeiling`.
   */
  const expectCeiling = (sql: string) => {
    expect(sql).toContain('acceptableMinor');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toMatch(/nsfwLevel"\s*<=/);
  };

  beforeEach(() => {
    queryRaw.mockImplementation(async () => []);
  });

  it('carries it in the gallery read', async () => {
    await getRemixGallery({ hostImageId: HOST_IMAGE, browsingLevel: 1 });
    expectCeiling(sqlFrom());
  });

  // Its own case, because the two readers are separate queries and the earlier
  // version of this test only reached the first. Deleting the predicate from
  // `galleryHasEntries` alone left the owner shown a card for entries the
  // gallery query will not return.
  it('carries it in the has-entries read', async () => {
    resolvePlacementSpaceFor.mockResolvedValue(openSpace);
    await getRemixGalleryVisibility({
      hostImageId: HOST_IMAGE,
      browsingLevel: 1,
      domainLevels: allBrowsingLevelsFlag,
    });
    expectCeiling(sqlFrom());
  });
});

describe('submission refusals', () => {
  it('refuses submitting an image to its own gallery', async () => {
    await expect(submit({ imageId: HOST_IMAGE })).rejects.toThrow(/its own gallery/i);
  });

  it('refuses when the gallery is off', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({ ...openSpace, mode: 'off' });
    await expect(submit()).rejects.toThrow(/not accepting/i);
  });

  it('refuses auto mode on the mutation, not by hiding the option', async () => {
    // `auto` is safe for stickers because the placed artwork comes from a
    // moderated catalog. A gallery places arbitrary user media, so a row
    // written before this rule existed must still be refused here.
    resolvePlacementSpaceFor.mockResolvedValue({ ...openSpace, mode: 'auto' });
    await expect(submit()).rejects.toThrow(/need review/i);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('refuses submitting to your own gallery', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({ ...openSpace, ownerId: PLACER });
    await expect(submit()).rejects.toThrow(/your own gallery/i);
  });

  it('refuses when the owner has not set a price', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({ ...openSpace, price: null });
    await expect(submit()).rejects.toThrow(/has not set a price/i);
  });

  it("refuses submitting someone else's image", async () => {
    primeQueries({ submission: { ...goodSubmission, userId: STRANGER } });
    await expect(submit()).rejects.toThrow(/your own images/i);
  });

  it('refuses an unpublished image', async () => {
    primeQueries({ submission: { ...goodSubmission, publishedAt: null } });
    await expect(submit()).rejects.toThrow(/publish/i);
  });

  it('refuses an image still being scanned or flagged for review', async () => {
    primeQueries({ submission: { ...goodSubmission, ingestion: 'Pending' } });
    await expect(submit()).rejects.toThrow(/still being reviewed/i);

    primeQueries({ submission: { ...goodSubmission, needsReview: 'minor' } });
    await expect(submit()).rejects.toThrow(/still being reviewed/i);
  });

  it.each(['tosViolation', 'minor', 'poi'] as const)(
    'refuses a %s image regardless of the content rule',
    async (flag) => {
      resolvePlacementSpaceFor.mockResolvedValue({
        ...openSpace,
        settings: { contentRule: 'any' },
      });
      primeQueries({ submission: { ...goodSubmission, [flag]: true } });
      await expect(submit()).rejects.toThrow(/cannot be submitted/i);
      expect(placementCreate).not.toHaveBeenCalled();
    }
  );

  it('refuses a second submission of the same image to the same gallery', async () => {
    placementFindFirst.mockResolvedValue({ id: 1 });
    await expect(submit()).rejects.toThrow(/already in this gallery/i);
  });

  it('looks for the duplicate among live entries as well as pending ones', async () => {
    // A fake that answers regardless of the `where` cannot tell a narrowed
    // status filter from a correct one, so the filter is asserted directly.
    // Without `approved` the check only stops double-submitting while the first
    // is still in the queue — the case it exists for is re-buying a slot next
    // to a picture that is already live.
    await submit();
    const where = placementFindFirst.mock.calls[0][0].where;
    expect(where.status.in).toEqual(expect.arrayContaining(['pending', 'approved']));
    expect(where.data).toEqual({ path: ['imageId'], equals: REMIX_IMAGE });
    expect(where.targetId).toBe(HOST_IMAGE);
  });

  it('refuses past the pending cap for one owner', async () => {
    placementCount.mockResolvedValue(10);
    await expect(submit()).rejects.toThrow(/maximum submissions/i);
  });

  it('counts the pending cap per placer, not across everyone', async () => {
    // The fake answers regardless of the `where`, so the count alone cannot
    // tell a per-placer cap from a per-owner one. Dropping `placerId` turns
    // this into "ten pendings from anybody", which locks every submitter out of
    // a busy creator — and nothing else in the suite would notice.
    await submit();
    expect(placementCount.mock.calls[0][0].where).toMatchObject({
      surface: 'remixGallery',
      ownerId: OWNER,
      placerId: PLACER,
      status: 'pending',
    });
  });

  it('refuses when the price moved since the submitter was shown it', async () => {
    // The client can only check affordability against the number it rendered,
    // so charging a price nobody agreed to is a spend without consent. This is
    // the half of that race only the server can close.
    await expect(submit({ expectedPrice: PRICE - 1 })).rejects.toThrow(/price changed/i);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('accepts a submission whose expected price still matches', async () => {
    await expect(submit({ expectedPrice: PRICE })).resolves.toEqual({ id: PLACEMENT });
  });

  it('refuses a blocked placer before creating anything', async () => {
    assertCanPlace.mockRejectedValueOnce(new Error('blocked'));
    await expect(submit()).rejects.toThrow('blocked');
    expect(placementCreate).not.toHaveBeenCalled();
  });

  // The arguments are not symmetric: the block half is bidirectional and
  // survives a swap, but the suspension half reads `placerId` alone, so a flip
  // asks whether the OWNER is suspended and lets a suspended placer through with
  // the refusal test above still green.
  it('asks about the placer’s suspension, not the owner’s', async () => {
    await submit();

    expect(assertCanPlace).toHaveBeenCalledTimes(1);
    expect(assertCanPlace).toHaveBeenCalledWith({ ownerId: OWNER, placerId: PLACER });
  });
});

describe('escrow ordering', () => {
  it('creates the row before taking the escrow', async () => {
    await submit();
    expect(calls).toEqual(['create', 'hold']);
  });

  // The currency is decided by the domain at the router and carried through
  // untouched. A submission that reached the escrow without it would be held —
  // and later paid out — in whatever the Buzz service defaults to.
  it('carries the caller currency into the escrow', async () => {
    await submit({ spendType: 'green' });
    expect(holdPlacementEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ spendType: 'green' })
    );
  });

  it('expires the row when the hold fails, rather than deleting it', async () => {
    holdPlacementEscrow.mockRejectedValueOnce(new Error('buzz down'));
    await expect(submit()).rejects.toThrow('buzz down');
    expect(settlePlacement).toHaveBeenCalledWith({ placementId: PLACEMENT, action: 'expire' });
  });

  it('records remixOfId when the image has one, and does not require it', async () => {
    primeQueries({ submission: { ...goodSubmission, remixOfId: 4242 } });
    await submit();
    expect(placementCreate.mock.calls[0][0].data.data).toMatchObject({
      imageId: REMIX_IMAGE,
      remixOfId: 4242,
    });
  });

  it('marks the submission as derived when the host image was an input to it', async () => {
    primeQueries({ submission: { ...goodSubmission, sourceImageIds: [HOST_IMAGE] } });
    await submit();
    expect(placementCreate.mock.calls[0][0].data.data).toMatchObject({
      derivedFromHost: true,
    });
  });

  it('leaves the mark off — never false — for a submission we cannot vouch for', async () => {
    // An off-site remix and a source we never resolved are the same state here,
    // and the owner-review UI keys off presence. `false` would read as a verdict.
    primeQueries({ submission: { ...goodSubmission, sourceImageIds: [999] } });
    await submit();
    expect(placementCreate.mock.calls[0][0].data.data).not.toHaveProperty('derivedFromHost');
  });
});

describe('owner actions', () => {
  const pending = {
    id: PLACEMENT,
    ownerId: OWNER,
    placerId: PLACER,
    status: 'pending',
    surface: 'remixGallery',
    data: { imageId: REMIX_IMAGE },
    targetId: HOST_IMAGE,
  };

  it('refuses to act on someone else’s content', async () => {
    placementFindUnique.mockResolvedValue(pending);
    await expect(
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'approve', userId: STRANGER })
    ).rejects.toThrow(/not on your content/i);
  });

  it('refuses a surface mismatch, so a sticker cannot be actioned here', async () => {
    placementFindUnique.mockResolvedValue({ ...pending, surface: 'sticker' });
    await expect(
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'approve', userId: OWNER })
    ).rejects.toThrow(/no longer exists/i);
    // The remix accept reward is scoped by this refusal and by nothing else. A
    // sticker approval that reached it would pay the remix reward on top of the
    // sticker one, which is the shape a bad merge between the two reward changes
    // would take.
    expect(rewardApply).not.toHaveBeenCalled();
  });

  it('re-checks the submission at approval, because a rating can move', async () => {
    placementFindUnique.mockResolvedValue(pending);
    primeQueries({ submission: { ...goodSubmission, needsReview: 'reported' } });
    await expect(
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'approve', userId: OWNER })
    ).rejects.toThrow(/can no longer be shown/i);
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  it('re-checks the RATING at approval, not just the flags', async () => {
    // The flags were re-checked and the rating was not, which is the one thing
    // the surrounding comment claimed. A PG submission re-rated XXX by the
    // scanner sailed through approval onto a PG host, under the very rule that
    // exists to stop it.
    placementFindUnique.mockResolvedValue(pending);
    primeQueries({
      submission: { ...goodSubmission, nsfwLevel: NsfwLevel.XXX },
      hostLevel: NsfwLevel.PG,
    });
    await expect(
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'approve', userId: OWNER })
    ).rejects.toThrow(/no longer fits/i);
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  it('re-checks an unrated image at approval too', async () => {
    placementFindUnique.mockResolvedValue(pending);
    primeQueries({ submission: { ...goodSubmission, nsfwLevel: 0 }, hostLevel: NsfwLevel.XXX });
    await expect(
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'approve', userId: OWNER })
    ).rejects.toThrow(/no longer fits/i);
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  it('throws when the settle claimed nothing, instead of reporting success', async () => {
    // D shipped a moderator action that appeared to work and did not: a settle
    // against a non-pending row moves no money and returns settled: false.
    placementFindUnique.mockResolvedValue(pending);
    settlePlacement.mockResolvedValue({ settled: false });
    await expect(
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'decline', userId: OWNER })
    ).rejects.toThrow(/already resolved/i);
  });

  describe('accept reward', () => {
    const approve = () =>
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'approve', userId: OWNER });

    beforeEach(() => {
      placementFindUnique.mockResolvedValue(pending);
    });

    it('pays the owner for the accept, crediting the submitter as the cause', async () => {
      await approve();
      // The count, not just the arguments. `toHaveBeenCalledWith` alone is
      // satisfied by a doubled call, and the double-pay this reward has to avoid
      // is a second `apply` — most plausibly a later refactor that moves the
      // reward into the shared settle and leaves this call behind. That pays 20
      // Blue Buzz twice for one accept and the argument assertion sees nothing.
      expect(rewardApply).toHaveBeenCalledTimes(1);
      expect(rewardApply).toHaveBeenCalledWith({
        placementId: PLACEMENT,
        ownerId: OWNER,
        placerId: PLACER,
      });
    });

    it('pays nothing for a decline', async () => {
      await actOnRemixGallerySubmission({
        placementId: PLACEMENT,
        action: 'decline',
        userId: OWNER,
      });
      expect(rewardApply).not.toHaveBeenCalled();
    });

    // The whole double-pay guard. `settlePlacement` claims pending → approved
    // with `WHERE status = 'pending'`, so exactly one call in a placement's life
    // returns settled: true, and the reward hangs off that. Move it above this
    // check and a re-settle re-presents a placement the reward already paid:
    // the ledger refuses it as a duplicate, no buzz moves, and the owner has
    // silently lost one of their five accepts for the day.
    it('pays nothing when the settle claimed nothing', async () => {
      settlePlacement.mockResolvedValue({ settled: false });
      await expect(approve()).rejects.toThrow(/already resolved/i);
      expect(rewardApply).not.toHaveBeenCalled();
    });

    // The approval already committed and paid out of escrow before this runs, and
    // it cannot be retried. Reporting it as failed would tell the owner their
    // accept did not happen when the entry is live in their gallery.
    it('still reports the approval when the reward fails', async () => {
      rewardApply.mockRejectedValueOnce(new Error('buzz service down'));
      await expect(approve()).resolves.toMatchObject({ settled: true });
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/reward failed/i) })
      );
    });
  });

  it('refuses to remove a live entry inside the removal lock', async () => {
    // Approval settles the money immediately, so accept-then-remove would take
    // the submitter's Buzz for an entry nobody ever saw — and it looks exactly
    // like an honest removal. Refused on the mutation, not by disabling a
    // button, because the button is a suggestion and this is money.
    placementFindUnique.mockResolvedValue({
      ...pending,
      status: 'approved',
      resolvedAt: new Date(),
    });

    await expect(
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'remove', userId: OWNER })
    ).rejects.toThrow(/can be removed from/i);
    expect(placementUpdateMany).not.toHaveBeenCalled();
  });

  it('locks an approved entry that has no resolvedAt, rather than skipping the check', async () => {
    // The guard used to be gated on the column being set, so it failed OPEN:
    // any approved row without one — a hand-seeded row, anything predating the
    // approval path writing it — could be removed instantly. Found because the
    // seeded review data has a null `resolvedAt` and showed no lock at all.
    placementFindUnique.mockResolvedValue({
      ...pending,
      status: 'approved',
      resolvedAt: null,
      createdAt: new Date(),
    });

    await expect(
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'remove', userId: OWNER })
    ).rejects.toThrow(/can be removed from/i);
    expect(placementUpdateMany).not.toHaveBeenCalled();
  });

  it('allows removal once the lock has passed', async () => {
    placementFindUnique.mockResolvedValue({
      ...pending,
      status: 'approved',
      resolvedAt: new Date(Date.now() - (REMIX_GALLERY_REMOVAL_LOCK_HOURS + 1) * 60 * 60 * 1000),
    });
    placementUpdateMany.mockResolvedValue({ count: 1 });

    await actOnRemixGallerySubmission({
      placementId: PLACEMENT,
      action: 'remove',
      userId: OWNER,
    });

    expect(placementUpdateMany).toHaveBeenCalled();
  });

  it('lets a moderator take down a locked entry', async () => {
    // The lock protects a submitter from the owner. An abusive entry is the case
    // that must not wait a week, and a takedown is a moderation record rather
    // than an owner decision.
    placementFindUnique.mockResolvedValue({
      ...pending,
      status: 'approved',
      resolvedAt: new Date(),
    });
    placementUpdateMany.mockResolvedValue({ count: 1 });

    await actOnRemixGallerySubmission({
      placementId: PLACEMENT,
      action: 'remove',
      userId: STRANGER,
      isModerator: true,
    });

    expect(placementUpdateMany.mock.calls[0][0].data).toMatchObject({ removedBy: 'moderator' });
  });

  describe('a moderator on their own gallery', () => {
    // Ownership used to decide the mode on its own, so a moderator got the
    // creator rules on their own content and could moderate every gallery
    // except their own. The mode is now asked for, and these pin both halves:
    // asking works, and not asking still gets the creator rules.
    const lockedOwnEntry = () => {
      placementFindUnique.mockResolvedValue({
        ...pending,
        status: 'approved',
        resolvedAt: new Date(),
      });
      placementUpdateMany.mockResolvedValue({ count: 1 });
    };

    it('is still held to the removal lock when they have not asked to moderate', async () => {
      // The control on the pair below. Exempting them for holding the role
      // would pass that test and silently drop the wait their own submitters
      // were promised, on every removal they ever make.
      lockedOwnEntry();

      await expect(
        actOnRemixGallerySubmission({
          placementId: PLACEMENT,
          action: 'remove',
          userId: OWNER,
          isModerator: true,
        })
      ).rejects.toThrow(/can be removed from/i);
      expect(placementUpdateMany).not.toHaveBeenCalled();
    });

    it('takes down a locked entry once they ask to act as a moderator', async () => {
      lockedOwnEntry();

      await actOnRemixGallerySubmission({
        placementId: PLACEMENT,
        action: 'remove',
        userId: OWNER,
        isModerator: true,
        asModerator: true,
      });

      // Recorded as the moderation action it is. `owner` here would say a
      // creator removed it under creator rules, which is the one thing that
      // did not happen — those rules refused it a moment ago.
      expect(placementUpdateMany.mock.calls[0][0].data).toMatchObject({
        removedBy: 'moderator',
      });
    });

    it('attributes a plain owner removal to the owner even when they claim otherwise', async () => {
      // The claim reaches the ATTRIBUTION as well as the lock, and the lock test
      // below cannot see it — that one throws before the write happens. Verified
      // by mutation: `removedBy: isModeratorTakedown || asModerator` passes every
      // other test in this file, and writes a moderation record for an ordinary
      // creator removing from their own gallery.
      //
      // Unlocked deliberately, so the write is reached at all.
      placementFindUnique.mockResolvedValue({
        ...pending,
        status: 'approved',
        resolvedAt: new Date(Date.now() - (REMIX_GALLERY_REMOVAL_LOCK_HOURS + 1) * 60 * 60 * 1000),
      });
      placementUpdateMany.mockResolvedValue({ count: 1 });

      await actOnRemixGallerySubmission({
        placementId: PLACEMENT,
        action: 'remove',
        userId: OWNER,
        asModerator: true,
      });

      expect(placementUpdateMany.mock.calls[0][0].data).toMatchObject({ removedBy: 'owner' });
    });

    it('ignores the claim from someone who is not a moderator', async () => {
      // `asModerator` chooses between two things a moderator may already do.
      // It is not where the permission comes from, and a plain owner sending it
      // must buy nothing.
      lockedOwnEntry();

      await expect(
        actOnRemixGallerySubmission({
          placementId: PLACEMENT,
          action: 'remove',
          userId: OWNER,
          asModerator: true,
        })
      ).rejects.toThrow(/can be removed from/i);
      expect(placementUpdateMany).not.toHaveBeenCalled();
    });
  });

  it('takes a live entry down with a direct write, not through settlePlacement', async () => {
    // `settlePlacement` claims with `WHERE status = 'pending'`, so routing an
    // approved row through it matched nothing and threw — owner remove was
    // broken for the whole surface, and a green suite said otherwise.
    placementFindUnique.mockResolvedValue({ ...pending, status: 'approved' });
    placementUpdateMany.mockResolvedValue({ count: 1 });

    await actOnRemixGallerySubmission({
      placementId: PLACEMENT,
      action: 'remove',
      userId: OWNER,
    });

    expect(settlePlacement).not.toHaveBeenCalled();
    const [arg] = placementUpdateMany.mock.calls[0];
    expect(arg.where).toEqual({ id: PLACEMENT, status: 'approved' });
    expect(arg.data).toMatchObject({ status: 'removed', removedBy: 'owner' });
    // Never resolvedAt: that records who approved it, and this path must not
    // destroy the approval trail.
    expect(arg.data.resolvedAt).toBeUndefined();
  });

  it('records a moderator takedown as a moderator, not as the owner', async () => {
    // The two refund differently everywhere else in this system, so recording
    // a moderator action as an owner decision misattributes it.
    placementFindUnique.mockResolvedValue({ ...pending, status: 'approved' });
    placementUpdateMany.mockResolvedValue({ count: 1 });

    await actOnRemixGallerySubmission({
      placementId: PLACEMENT,
      action: 'remove',
      userId: STRANGER,
      isModerator: true,
    });

    expect(placementUpdateMany.mock.calls[0][0].data).toMatchObject({ removedBy: 'moderator' });
  });

  it('reports a removal that claimed nothing instead of appearing to work', async () => {
    placementFindUnique.mockResolvedValue({ ...pending, status: 'approved' });
    placementUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'remove', userId: OWNER })
    ).rejects.toThrow(/already removed/i);
  });

  it('refuses to approve a submission whose payload cannot be read', async () => {
    placementFindUnique.mockResolvedValue({ ...pending, data: { nothing: true } });
    await expect(
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'approve', userId: OWNER })
    ).rejects.toThrow(/unreadable/i);
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  it('only removes a live entry', async () => {
    placementFindUnique.mockResolvedValue(pending);
    await expect(
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'remove', userId: OWNER })
    ).rejects.toThrow(/only a live entry/i);
  });
});

describe('retraction', () => {
  const pending = { id: PLACEMENT, placerId: PLACER, status: 'pending', surface: 'remixGallery' };

  it('refunds in full by settling as expiry, not as a decline', async () => {
    // A withdrawn submission never cost the owner attention, and the decline
    // fee is the price of attention — so it must not reach the decline path.
    placementFindUnique.mockResolvedValue(pending);
    await retractRemixGallerySubmission({ placementId: PLACEMENT, placerId: PLACER });
    expect(settlePlacement).toHaveBeenCalledWith({
      placementId: PLACEMENT,
      action: 'expire',
      actorId: PLACER,
    });
  });

  it('refuses to retract someone else’s submission', async () => {
    placementFindUnique.mockResolvedValue(pending);
    await expect(
      retractRemixGallerySubmission({ placementId: PLACEMENT, placerId: STRANGER })
    ).rejects.toThrow(/not yours/i);
  });

  it('refuses to retract once approved', async () => {
    placementFindUnique.mockResolvedValue({ ...pending, status: 'approved' });
    await expect(
      retractRemixGallerySubmission({ placementId: PLACEMENT, placerId: PLACER })
    ).rejects.toThrow(/already been reviewed/i);
  });

  it('throws when the settle claimed nothing', async () => {
    placementFindUnique.mockResolvedValue(pending);
    settlePlacement.mockResolvedValue({ settled: false });
    await expect(
      retractRemixGallerySubmission({ placementId: PLACEMENT, placerId: PLACER })
    ).rejects.toThrow(/already resolved/i);
  });
});

describe('pinning', () => {
  const entries = [1, 2, 3, 4, 5].map((id) => ({ id, data: { imageId: id * 10 } }));

  it('refuses more pins than the cap', async () => {
    await expect(
      setRemixGalleryPins({
        hostImageId: HOST_IMAGE,
        ownerId: OWNER,
        placementIds: [1, 2, 3, 4, 5],
      })
    ).rejects.toThrow(new RegExp(`up to ${REMIX_GALLERY_MAX_PINNED}`));
    expect(placementFindMany).not.toHaveBeenCalled();
  });

  it('refuses pinning the same entry twice', async () => {
    await expect(
      setRemixGalleryPins({ hostImageId: HOST_IMAGE, ownerId: OWNER, placementIds: [1, 1] })
    ).rejects.toThrow(/cannot be pinned twice/i);
  });

  it('refuses an entry that is not in this gallery', async () => {
    placementFindMany.mockResolvedValue(entries);
    await expect(
      setRemixGalleryPins({ hostImageId: HOST_IMAGE, ownerId: OWNER, placementIds: [99] })
    ).rejects.toThrow(/not in this gallery/i);
  });

  it('scopes the lookup to the owner, so a gallery is not pinnable by strangers', async () => {
    // `hostImageId` is caller-supplied and the fake answers regardless of the
    // `where`, so nothing else here would notice `ownerId` going missing — and
    // without it any signed-in user can pin and unpin entries in anyone's
    // gallery. The guard had no test at all.
    placementFindMany.mockResolvedValue(entries);
    await setRemixGalleryPins({ hostImageId: HOST_IMAGE, ownerId: OWNER, placementIds: [1] });

    expect(placementFindMany.mock.calls[0][0].where).toMatchObject({
      surface: 'remixGallery',
      targetType: 'image',
      targetId: HOST_IMAGE,
      ownerId: OWNER,
      status: 'approved',
    });
  });

  it('reads the incoming ids AND everything already pinned', async () => {
    // `toMatchObject` ignores keys it is not given, so the assertion above
    // passes with the whole OR deleted. Without that clause the query returns
    // only the entries being pinned, so nothing already pinned is ever read —
    // and unpinning stops working silently, because a row that is not read is
    // never cleared.
    placementFindMany.mockResolvedValue([{ id: 7, data: { imageId: 70 } }]);
    await setRemixGalleryPins({ hostImageId: HOST_IMAGE, ownerId: OWNER, placementIds: [7] });

    const { OR } = placementFindMany.mock.calls[0][0].where;
    expect(OR).toEqual([
      { id: { in: [7] } },
      { data: { path: ['pinnedAt'], not: expect.anything() } },
    ]);
  });

  it('still reads the pinned set when unpinning everything', async () => {
    // `placementIds: []` is "unpin them all". If the OR collapsed to the id
    // list alone, this would read nothing and quietly unpin nothing.
    placementFindMany.mockResolvedValue([]);
    await setRemixGalleryPins({ hostImageId: HOST_IMAGE, ownerId: OWNER, placementIds: [] });

    expect(placementFindMany.mock.calls[0][0].where.OR).toContainEqual({
      data: { path: ['pinnedAt'], not: expect.anything() },
    });
  });

  it('clears pins that are absent from the new set', async () => {
    const pinned = [
      { id: 1, data: { imageId: 10, pinnedAt: 'then', position: 0 } },
      { id: 2, data: { imageId: 20, pinnedAt: 'then', position: 1 } },
      { id: 3, data: { imageId: 30 } },
    ];
    placementFindMany.mockResolvedValue(pinned);
    await setRemixGalleryPins({ hostImageId: HOST_IMAGE, ownerId: OWNER, placementIds: [3, 1] });

    const byId = new Map(
      placementUpdate.mock.calls.map(([arg]) => [arg.where.id, arg.data.data] as const)
    );
    expect(byId.get(3)).toMatchObject({ position: 0 });
    expect(byId.get(1)).toMatchObject({ position: 1 });
    expect(byId.get(2)).toMatchObject({ pinnedAt: null, position: null });
  });

  it('does not rewrite entries whose pin state is unchanged', async () => {
    // The modal commits on every drag, and a gallery can hold thousands of
    // approved entries against a cap of four. Rewriting all of them per drag is
    // how that became one UPDATE per entry.
    placementFindMany.mockResolvedValue([
      { id: 1, data: { imageId: 10, pinnedAt: 'then', position: 0 } },
      { id: 2, data: { imageId: 20 } },
    ]);
    await setRemixGalleryPins({ hostImageId: HOST_IMAGE, ownerId: OWNER, placementIds: [1] });

    expect(placementUpdate).not.toHaveBeenCalled();
  });
});

describe('gallery cursor', () => {
  it('round-trips a well-formed cursor', () => {
    expect(parseGalleryCursor('123:1:7:456:789')).toEqual({
      seed: 123,
      pinned: 1,
      position: 7,
      sortKey: 456,
      placementId: 789,
    });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    // Four parts is the OLD cursor shape, from before `position` joined the
    // sort key. Rejecting it matters: accepting one would page with a position
    // of NaN and silently repeat the pinned entries.
    ['a pre-position cursor', '123:1:456:789'],
    ['too few parts', '123:1:456'],
    ['non-numeric', 'abc:1:7:456:789'],
  ])('treats a %s cursor as a fresh first page', (_label, cursor) => {
    // Not an error: the alternative is NaN interpolated into the ordering
    // expression, which selects a different but stable permutation and looks
    // like nothing is wrong.
    expect(parseGalleryCursor(cursor as string | undefined)).toBeNull();
  });
});

/**
 * A gallery entry is a paid placement on the host image, so it counts toward the
 * same Buzz counter a sticker does (Justin, 2026-08-12). Same rule on both
 * surfaces, because a single counter that means different things depending on
 * which surface you asked has lost the only property it needs.
 */
describe('an approved submission counts toward the host image buzz counter', () => {
  const pending = {
    id: PLACEMENT,
    ownerId: OWNER,
    placerId: PLACER,
    status: 'pending',
    surface: 'remixGallery',
    data: { imageId: REMIX_IMAGE },
    targetId: HOST_IMAGE,
    amount: PRICE,
    resolvedAt: null,
    createdAt: new Date(0),
  };

  /**
   * The settlement paths emit NOTHING. The counter is moved by
   * `placement-sweep-uncounted` reading `metricCountedAt`; an emit put back here
   * is one the sweep will emit a second time, and the counter never falls.
   */
  it('emits nothing when the owner approves', async () => {
    placementFindUnique.mockResolvedValue(pending);

    await actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'approve', userId: OWNER });

    expect(updateEntityMetricDetached).not.toHaveBeenCalled();
  });

  it('emits nothing when the owner declines, though the fee is kept', async () => {
    placementFindUnique.mockResolvedValue(pending);

    await actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'decline', userId: OWNER });

    expect(updateEntityMetricDetached).not.toHaveBeenCalled();
  });

  it('counts nothing when the settle lost the race', async () => {
    placementFindUnique.mockResolvedValue(pending);
    settlePlacement.mockResolvedValue({ settled: false });

    await expect(
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'approve', userId: OWNER })
    ).rejects.toThrow(/already resolved/i);
    expect(updateEntityMetricDetached).not.toHaveBeenCalled();
  });
});

/**
 * The review queue pages, and the escrow behind an entry it skips expires
 * without the owner ever being offered the choice — so "did we skip one" is the
 * only question these ask.
 */
describe('getPendingRemixGallerySubmissions paging', () => {
  const queueRow = (id: number, imageId: number, createdAt: string) => ({
    id,
    targetId: HOST_IMAGE,
    placerId: PLACER,
    amount: PRICE,
    data: { imageId },
    createdAt: new Date(createdAt),
    expiresAt: null,
    placer: { id: PLACER, username: 'someone', image: null },
  });

  const image = (id: number) => ({
    id,
    url: 'x',
    width: 1,
    height: 1,
    type: 'image',
    metadata: null,
    nsfwLevel: 1,
  });

  const LEVELS = allBrowsingLevelsFlag;
  const ask = (args: { limit: number; cursor?: string | null }) =>
    getPendingRemixGallerySubmissions({
      ownerId: OWNER,
      domainLevels: LEVELS,
      viewerLevels: LEVELS,
      ...args,
    });

  let queueSelects: { sql: string; values: unknown[] }[] = [];
  const lastQueueSelect = () => queueSelects.at(-1) ?? { sql: '', values: [] as unknown[] };

  /**
   * A composed statement hides its own text: an interpolated `Prisma.sql`
   * fragment arrives as a VALUE, not as part of the outer template. Reading only
   * the outer strings would make every assertion about the keyset pass whether
   * or not the keyset was there.
   */
  const isSql = (value: unknown): value is { strings: string[]; values: unknown[] } =>
    !!value && typeof value === 'object' && 'strings' in value;

  /**
   * Rebuilt in ORDER — each string, then the fragment interpolated after it.
   * Concatenating all the outer strings and then all the values reads as valid
   * SQL and is not: the `AND`/`OR` joining two fragments lives in the outer
   * strings while the fragments live in the values, so an `AND` -> `OR` flip
   * between them is invisible to any assertion made on the scrambled text.
   * Measured: that exact mutation passed 91/91 before this was interleaved.
   */
  const sqlTextOf = (value: unknown): string => {
    if (isSql(value))
      return value.strings
        .map(
          (part, index) =>
            part + (index < value.values.length ? sqlTextOf(value.values[index]) : '')
        )
        .join('');
    if (Array.isArray(value)) return value.map(sqlTextOf).join(' ');
    return typeof value === 'string' ? value : '';
  };

  /**
   * A tagged-template call arrives as `(strings, ...values)`, which is the same
   * interleaving problem one level up.
   */
  const renderCall = (args: unknown[]): string => {
    const [strings, ...values] = args as [string[], ...unknown[]];
    if (!Array.isArray(strings)) return '';
    return strings
      .map((part, index) => part + (index < values.length ? sqlTextOf(values[index]) : ''))
      .join('');
  };

  const flatValues = (value: unknown): unknown[] => {
    if (isSql(value)) return value.values.flatMap(flatValues);
    if (Array.isArray(value)) return value.flatMap(flatValues);
    return typeof value === 'string' && value.includes('SELECT') ? [] : [value];
  };

  /**
   * The page is a SQL select over `Placement`; the images are a second select
   * over `Image`. Both arrive at the same `$queryRaw` mock, so they are told
   * apart by the statement rather than by call order — the early return changes
   * that order, and call-order coupling would then feed one query's rows to the
   * other while every assertion still passed.
   */
  const respond = ({
    page,
    images,
  }: {
    page: { id: number; createdAt: Date }[];
    images: unknown[];
  }) =>
    queryRaw.mockImplementation(async (...args: unknown[]) => {
      const sql = renderCall(args);
      if (sql.includes('FROM "Placement"')) {
        queueSelects.push({ sql, values: flatValues(args) });
        return page;
      }
      return images;
    });

  beforeEach(() => {
    queueSelects = [];
    respond({ page: [], images: [] });
    placementFindMany.mockResolvedValue([]);
  });

  /**
   * Named for the decision, because the narrow select this replaced type-checked
   * fine: `UserAvatar` takes `Partial<UserWithCosmetics>`, so dropping the three
   * keys below is invisible to tsc and shows up only as a wrong-looking avatar.
   *
   * `User.image` is what the queue used to send, and it is a dead column:
   * measured 2026-08-27, 0 of the 121 distinct placers on this surface had it
   * set and 93 had a `profilePicture`. So the old select handed the avatar null
   * for every placer alive, and stripped the equipped cosmetics of 61 of them.
   * Those counts are a snapshot and nothing rechecks them; the ratio is not
   * what makes this true — a null `image` renders initials at any ratio.
   *
   * Asserted on the ARGUMENT rather than on a returned row: the Prisma mock
   * ignores `select` and hands back whatever the fixture holds, so an assertion
   * made on the result passes with any select at all.
   */
  it('sends the placer fields the avatar renders (here for the paging fixtures)', async () => {
    // A populated page, because the service returns before it ever reaches
    // `findMany` on an empty one — the default `beforeEach` state would make
    // this assert against a call that never happened.
    respond({
      page: [{ id: 1, createdAt: new Date('2026-01-01T00:00:00.000Z') }],
      images: [image(101), image(HOST_IMAGE)],
    });
    placementFindMany.mockResolvedValue([queueRow(1, 101, '2026-01-01T00:00:00.000Z')]);

    await ask({ limit: 2 });

    const placerSelect = placementFindMany.mock.calls[0][0].select.placer.select;
    // Named individually so a revert says which one went missing. `deletedAt`
    // is in here because the avatar and the username both branch on it and a
    // deleted placer would otherwise render as a live one.
    for (const field of ['profilePicture', 'cosmetics', 'deletedAt'])
      expect(placerSelect, `placer select is missing ${field}`).toHaveProperty(field);

    // The loop above is existence-only, and the mutation that actually breaks
    // the avatar keeps all three names: an inlined `cosmetics: true` returns
    // UserCosmetic scalars with no nested `cosmetic`, so every frame and badge
    // silently vanishes while `toHaveProperty` stays green. Compared against
    // the imported selector rather than a copy of its shape, so this cannot
    // drift from what production sends. `toEqual`, not `toBe`, so a spread of
    // the same selector still passes.
    expect(placerSelect).toEqual(userWithCosmeticsSelect);
  });

  it('takes the cursor from the last row of the page, not the last row it returns', async () => {
    // Three rows for a page of two: the third is the "is there more" probe. Row
    // 2 is selected but dropped afterwards for an unreadable payload — exactly
    // the case where a cursor built from what was RETURNED says row 1 and the
    // next page serves row 2 a second time.
    respond({
      page: [
        { id: 1, createdAt: new Date('2026-01-01T00:00:00.000Z') },
        { id: 2, createdAt: new Date('2026-01-02T00:00:00.000Z') },
        { id: 3, createdAt: new Date('2026-01-03T00:00:00.000Z') },
      ],
      images: [image(101), image(HOST_IMAGE)],
    });
    placementFindMany.mockResolvedValue([
      queueRow(1, 101, '2026-01-01T00:00:00.000Z'),
      { ...queueRow(2, 0, '2026-01-02T00:00:00.000Z'), data: { nonsense: true } },
    ]);

    const result = await ask({ limit: 2 });

    expect(result.items.map((item) => item.id)).toEqual([1]);
    expect(result.nextCursor).toBe(`${new Date('2026-01-02T00:00:00.000Z').getTime()}:2`);
  });

  it('selects only renderable rows, so a page is full rows or the end of the queue', async () => {
    // The bug this replaced: the page was fetched and THEN filtered, so a queue
    // of 66 whose first 50 were unrenderable returned 4 items with a cursor —
    // "4+" over a page size of 50, and "load more" then produced 2. Both images
    // are tested, the submission and the host it sits on.
    await ask({ limit: 2 });

    const { sql } = lastQueueSelect();
    expect(sql).toContain(`data ->> 'imageId'`);
    expect(sql).toContain('pl."targetId"');
    // Named individually. `toContain('publishedAt')` alone survives deleting any
    // of the other four, and a queue that stopped filtering `tosViolation` would
    // read as covered.
    for (const clause of ['publishedAt', `ingestion = 'Scanned'`, 'tosViolation', 'minor', 'poi'])
      expect(sql, `${clause} is not in the select`).toContain(clause);

    // Both images, ANDed. An `OR` here passes every assertion above while
    // relisting exactly what the count excludes — badge and list disagree again,
    // which is the bug this shares one fragment to prevent.
    const [, betweenTheTwoTests] = sql.split('EXISTS');
    expect(sql.match(/EXISTS/g)).toHaveLength(2);
    expect(betweenTheTwoTests).toContain('AND');
    expect(betweenTheTwoTests).not.toContain('OR');
  });

  it('hands back a cursor when every row it selected was dropped afterwards', async () => {
    // The unreadable-payload filter is the one drop left after selection, and
    // returning `null` here tells the owner "nothing is waiting" over a queue
    // with entries behind it — the original bug, one layer up.
    respond({
      page: [
        { id: 1, createdAt: new Date('2026-01-01T00:00:00.000Z') },
        { id: 2, createdAt: new Date('2026-01-02T00:00:00.000Z') },
        { id: 3, createdAt: new Date('2026-01-03T00:00:00.000Z') },
      ],
      images: [],
    });
    placementFindMany.mockResolvedValue([
      { ...queueRow(1, 0, '2026-01-01T00:00:00.000Z'), data: { nonsense: true } },
      { ...queueRow(2, 0, '2026-01-02T00:00:00.000Z'), data: { nonsense: true } },
    ]);

    const result = await ask({ limit: 2 });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBe(`${new Date('2026-01-02T00:00:00.000Z').getTime()}:2`);
  });

  it('reports no next page when the queue ends inside the page', async () => {
    respond({
      page: [{ id: 1, createdAt: new Date('2026-01-01T00:00:00.000Z') }],
      images: [image(101), image(HOST_IMAGE)],
    });
    placementFindMany.mockResolvedValue([queueRow(1, 101, '2026-01-01T00:00:00.000Z')]);

    const result = await ask({ limit: 2 });

    expect(result.items.map((item) => item.id)).toEqual([1]);
    expect(result.nextCursor).toBeNull();
  });

  it('resumes strictly after the cursor row, including its same-millisecond twin', async () => {
    const createdAt = new Date('2026-01-02T00:00:00.000Z');

    await ask({ limit: 2, cursor: `${createdAt.getTime()}:2` });

    const { sql, values } = lastQueueSelect();
    // Two placements can share a millisecond. Without the id tie-break one of
    // them is stepped over and its escrow expires unreviewed.
    expect(sql).toMatch(/createdAt"\s*>/);
    expect(sql).toMatch(/pl\.id\s*>/);
    expect(sql).toMatch(/ORDER BY[\s\S]*createdAt/);
    expect(values).toContain(2);
    expect(
      values.some((value) => value instanceof Date && value.getTime() === createdAt.getTime())
    ).toBe(true);
    // limit + 1: the extra row is what says whether another page exists.
    expect(values).toContain(3);
  });

  it('reports no next page when the queue ends exactly on the page boundary', async () => {
    // The case the old `truncated = rows.length >= limit` got wrong. The select
    // takes limit + 1, so a queue of exactly `limit` has nothing behind it — a
    // cursor here sends the owner to an empty page.
    respond({
      page: [
        { id: 1, createdAt: new Date('2026-01-01T00:00:00.000Z') },
        { id: 2, createdAt: new Date('2026-01-02T00:00:00.000Z') },
      ],
      images: [image(101), image(102), image(HOST_IMAGE)],
    });
    placementFindMany.mockResolvedValue([
      queueRow(1, 101, '2026-01-01T00:00:00.000Z'),
      queueRow(2, 102, '2026-01-02T00:00:00.000Z'),
    ]);

    const result = await ask({ limit: 2 });

    expect(result.nextCursor).toBeNull();
  });

  it('starts a fresh page rather than a bad value in a query when the cursor is malformed', async () => {
    const wellFormed = `${new Date('2026-01-02T00:00:00.000Z').getTime()}:2`;

    // The positive control. Without it this test passes with the keyset removed
    // entirely, because then no cursor ever produces the clause.
    await ask({ limit: 2, cursor: wellFormed });
    expect(lastQueueSelect().sql).toMatch(/pl\.id\s*>/);

    for (const cursor of ['nonsense', '1e21:1', '1700000000000:1.5', '1:2:3', '-1:2', ':']) {
      await ask({ limit: 2, cursor });

      expect(lastQueueSelect().sql, `cursor ${cursor} reached the query`).not.toMatch(/pl\.id\s*>/);
    }
  });
});

/**
 * What the SFW domain is SENT, which is a different question from what it
 * paints. Blur is built from the viewer's own settings and never reads the
 * domain, and these queues carry no browsing level by design — so the payload is
 * the only control, and it needs a test that fails when it is removed rather
 * than a suite that passes either way.
 */
describe('getPendingRemixGallerySubmissions domain ceiling', () => {
  const SUBMITTED = 301;

  const rated = (id: number, nsfwLevel: number) => ({
    id,
    url: `asset-${id}`,
    width: 1,
    height: 1,
    type: 'image',
    metadata: { hash: `h-${id}` },
    nsfwLevel,
  });

  const queueRow = (imageId: number) => ({
    id: 1,
    targetId: HOST_IMAGE,
    placerId: PLACER,
    amount: PRICE,
    data: { imageId },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: null,
    placer: { id: PLACER, username: 'someone', image: null },
  });

  const ask = ({
    submittedLevel,
    hostLevel = NsfwLevel.PG,
    domainLevels,
    viewerLevels = allBrowsingLevelsFlag,
  }: {
    submittedLevel: number;
    hostLevel?: number;
    domainLevels: number;
    viewerLevels?: number;
  }) => {
    queryRaw.mockImplementation(async (...args: unknown[]) => {
      const [template] = args as [{ strings?: string[] }];
      const sql = (template?.strings ?? []).join(' ');
      if (sql.includes('FROM "Placement"'))
        return [{ id: 1, createdAt: new Date('2026-01-01T00:00:00.000Z') }];
      return [rated(SUBMITTED, submittedLevel), rated(HOST_IMAGE, hostLevel)];
    });
    placementFindMany.mockResolvedValue([queueRow(SUBMITTED)]);

    return getPendingRemixGallerySubmissions({
      ownerId: OWNER,
      limit: 10,
      domainLevels,
      viewerLevels,
    });
  };

  it('sends the asset when the image is inside the ceiling', async () => {
    // The positive control. Without it, every assertion below passes against a
    // query that withholds everything — including the vacuous case where
    // `domainLevels` arrives undefined and `level & undefined` is 0.
    const { items } = await ask({
      submittedLevel: NsfwLevel.PG,
      domainLevels: sfwBrowsingLevelsFlag,
    });

    expect(items).toHaveLength(1);
    expect(items[0].image).toMatchObject({ viewable: true, url: `asset-${SUBMITTED}` });
  });

  it('withholds the asset for a submission above the ceiling, keeping the row actionable', async () => {
    const { items } = await ask({
      submittedLevel: NsfwLevel.X,
      domainLevels: sfwBrowsingLevelsFlag,
    });

    expect(items).toHaveLength(1);
    const { image } = items[0];
    expect(image).toEqual({ viewable: false, id: SUBMITTED, nsfwLevel: NsfwLevel.X });
    // Asserted as absence of the FIELDS, not just of `viewable`. A branch that
    // set the flag and spread the row anyway would pass an `image.viewable`
    // check while shipping the bytes it claims to withhold.
    for (const field of ['url', 'metadata', 'width', 'height', 'type'])
      expect(image, `${field} was sent to a domain that may not serve it`).not.toHaveProperty(
        field
      );
    // Still reviewable: the escrow behind it expires if the owner cannot act.
    expect(items[0].earnings.approve).toBeGreaterThan(0);
  });

  it('withholds the host image by the same rule', async () => {
    const { items } = await ask({
      submittedLevel: NsfwLevel.PG,
      hostLevel: NsfwLevel.XXX,
      domainLevels: sfwBrowsingLevelsFlag,
    });

    expect(items[0].targetImage).toEqual({
      viewable: false,
      id: HOST_IMAGE,
      nsfwLevel: NsfwLevel.XXX,
    });
    expect(items[0].targetImage).not.toHaveProperty('url');
  });

  it('sends an above-ceiling asset on a domain that may serve it', async () => {
    // The other half of the control: withholding on green has to be the domain
    // deciding, not the queue refusing X everywhere.
    const { items } = await ask({
      submittedLevel: NsfwLevel.X,
      domainLevels: allBrowsingLevelsFlag,
    });

    expect(items[0].image).toMatchObject({ viewable: true, url: `asset-${SUBMITTED}` });
  });

  it('marks what is outside the viewer band without withholding it', async () => {
    // The viewer's own band is a preference, not a delivery rule — an owner has
    // to be able to widen it and act. Withholding here would be indistinguishable
    // from the domain case, which is the distinction the UI turns on.
    const { items } = await ask({
      submittedLevel: NsfwLevel.R,
      domainLevels: allBrowsingLevelsFlag,
      viewerLevels: sfwBrowsingLevelsFlag,
    });

    expect(items[0].image).toMatchObject({
      viewable: true,
      withinViewerLevel: false,
      url: `asset-${SUBMITTED}`,
    });
  });

  it('withholds an unrated image rather than defaulting it in', async () => {
    // `0 & mask` is 0, so this passes today by arithmetic. Pinned because the
    // failure mode is silent: an unscanned image would ship its asset to green.
    const { items } = await ask({ submittedLevel: 0, domainLevels: sfwBrowsingLevelsFlag });

    expect(items[0].image).toMatchObject({ viewable: false });
  });
});

describe('declining everything out of band', () => {
  const IN_BAND = 201;
  const OUT_OF_BAND = 202;
  const UNRATED = 203;

  /**
   * Host at PG-13 under `atOrBelow`, so the band is PG-13 and only the R row is
   * out of it. The unrated row is the one worth keeping in the fixture: it is
   * inadmissible for approval and must still not be swept up here, because
   * charging a decline fee for an image with no rating yet answers a question
   * nobody asked.
   */
  const arrange = () => {
    resolvePlacementSpaceFor.mockResolvedValue({
      ownerId: OWNER,
      mode: 'review',
      price: PRICE,
      settings: { contentRule: 'atOrBelow' },
    });
    queryRaw.mockImplementation(async () => [
      { nsfwLevel: NsfwLevel.PG13, minor: false, showable: true },
    ]);
    placementFindMany.mockResolvedValue([
      { id: IN_BAND, data: { imageId: 1 } },
      { id: OUT_OF_BAND, data: { imageId: 2 } },
      { id: UNRATED, data: { imageId: 3 } },
    ]);
    imageFindMany.mockResolvedValue([
      { id: 1, nsfwLevel: NsfwLevel.PG },
      { id: 2, nsfwLevel: NsfwLevel.R },
      { id: 3, nsfwLevel: 0 },
    ]);
    // Each row re-reads itself through the single-placement path.
    placementFindUnique.mockImplementation(async ({ where }: { where: { id: number } }) => ({
      id: where.id,
      ownerId: OWNER,
      status: 'pending',
      surface: 'remixGallery',
      targetId: HOST_IMAGE,
      data: { imageId: where.id === OUT_OF_BAND ? 2 : 1 },
      resolvedAt: null,
      createdAt: new Date('2026-01-01'),
    }));
  };

  it('settles only the rows above the band, and reports what it did', async () => {
    arrange();

    const result = await declineOutOfBandRemixGallerySubmissions({
      hostImageId: HOST_IMAGE,
      userId: OWNER,
    });

    expect(result).toEqual({ considered: 1, settled: 1 });
    // The identity matters more than the count: a guard that declined the whole
    // queue also settles once when the queue holds one out-of-band row.
    expect(settlePlacement).toHaveBeenCalledTimes(1);
    expect(lastSettleArgs()?.placementId).toBe(OUT_OF_BAND);
  });

  it('counts a row that fails to settle without abandoning the rest', async () => {
    arrange();
    imageFindMany.mockResolvedValue([
      { id: 1, nsfwLevel: NsfwLevel.X },
      { id: 2, nsfwLevel: NsfwLevel.R },
      { id: 3, nsfwLevel: 0 },
    ]);
    settlePlacement.mockRejectedValueOnce(new Error('payout leg is down'));

    const result = await declineOutOfBandRemixGallerySubmissions({
      hostImageId: HOST_IMAGE,
      userId: OWNER,
    });

    // Two were out of band, one throw: the second must still have been tried,
    // and the caller must be told the difference rather than shown a success.
    expect(result).toEqual({ considered: 2, settled: 1 });
    expect(settlePlacement).toHaveBeenCalledTimes(2);
  });

  it('refuses someone else’s gallery before touching anything', async () => {
    arrange();

    await expect(
      declineOutOfBandRemixGallerySubmissions({ hostImageId: HOST_IMAGE, userId: STRANGER })
    ).rejects.toThrow();

    expect(settlePlacement).not.toHaveBeenCalled();
  });
});

describe('free submissions', () => {
  const submitFree = (over: Partial<Parameters<typeof createRemixGallerySubmission>[0]> = {}) =>
    submit({ free: true, ...over });

  it('refuses a remix the server did not resolve as derived from the host', async () => {
    // The gate the whole surface rests on. `sourceImageIds` is empty on the
    // default fixture, which is what an off-site remix looks like — a real remix
    // carrying no signal, which is why the refusal names paying as the
    // alternative rather than calling it not a remix.
    await expect(submitFree()).rejects.toThrow(/made from this image on-site/i);
    expect(createFreePlacement).not.toHaveBeenCalled();
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('refuses when the host is not among the inputs, only some other image', async () => {
    // Derivation is membership, not "this generation had inputs at all". A remix
    // built entirely from someone else's image would otherwise buy a free slot
    // in a queue it has nothing to do with.
    primeQueries({ submission: { ...goodSubmission, sourceImageIds: [STRANGER] } });
    await expect(submitFree()).rejects.toThrow(/made from this image on-site/i);
    expect(createFreePlacement).not.toHaveBeenCalled();
  });

  it('claims through the free primitive rather than writing its own row', async () => {
    primeQueries({ submission: verifiedSubmission });

    const result = await submitFree();

    expect(result).toEqual({ id: FREE_PLACEMENT });
    // No row of its own and no escrow: the three refusals the free tier adds
    // have to hold together under the claim's lock, in the same transaction as
    // its insert, and a row built here would be a second creation route.
    expect(placementCreate).not.toHaveBeenCalled();
    expect(holdPlacementEscrow).not.toHaveBeenCalled();

    expect(createFreePlacement).toHaveBeenCalledWith({
      surface: 'remixGallery',
      targetType: 'image',
      targetId: HOST_IMAGE,
      placerId: PLACER,
      data: { imageId: REMIX_IMAGE, remixOfId: null, derivedFromHost: true },
    });
  });

  it('hands the claim the host image, never the submitted one', async () => {
    // Both ids are in scope at the call site and swapping them is a one-token
    // edit that type-checks: the placement would land on the submitter's own
    // image, attributed to themselves, holding a slot on the wrong creator.
    primeQueries({ submission: verifiedSubmission });
    await submitFree();

    const claim = createFreePlacement.mock.calls[0][0] as { targetId: number; placerId: number };
    expect(claim.targetId).toBe(HOST_IMAGE);
    expect(claim.targetId).not.toBe(REMIX_IMAGE);
    expect(claim.placerId).toBe(PLACER);
  });

  it('does not let a free submission skip the one-per-gallery duplicate check', async () => {
    // `createFreePlacement` bounds free rows per placer and per target, which is
    // a different question from "is this picture already in this gallery" — a
    // paid entry followed by a free one would otherwise put the same image in
    // twice and defeat the rotation.
    primeQueries({ submission: verifiedSubmission });
    placementFindFirst.mockResolvedValue({ id: 1 });

    await expect(submitFree()).rejects.toThrow(/already in this gallery/i);
    expect(createFreePlacement).not.toHaveBeenCalled();
  });

  it.each([
    ['off', /not accepting/i],
    ['auto', /need review/i],
  ] as const)('refuses a free submission to a %s gallery', async (mode, message) => {
    primeQueries({ submission: verifiedSubmission });
    resolvePlacementSpaceFor.mockResolvedValue({ ...openSpace, mode });

    await expect(submitFree()).rejects.toThrow(message);
    expect(createFreePlacement).not.toHaveBeenCalled();
  });

  it('refuses a free submission to your own gallery', async () => {
    primeQueries({ submission: verifiedSubmission });
    resolvePlacementSpaceFor.mockResolvedValue({ ...openSpace, ownerId: PLACER });

    await expect(submitFree()).rejects.toThrow(/your own gallery/i);
    expect(createFreePlacement).not.toHaveBeenCalled();
  });

  it('applies every content rule to a free submission', async () => {
    // Free is placement that costs no Buzz, not a lighter kind of placement.
    // These are the checks a free path is most tempting to skip, because nobody
    // is being charged for the refusal.
    resolvePlacementSpaceFor.mockResolvedValue({ ...openSpace, settings: { contentRule: 'any' } });
    primeQueries({ submission: { ...verifiedSubmission, tosViolation: true } });
    await expect(submitFree()).rejects.toThrow(/cannot be submitted/i);

    resolvePlacementSpaceFor.mockResolvedValue(openSpace);
    primeQueries({ submission: { ...verifiedSubmission, nsfwLevel: NsfwLevel.XXX } });
    await expect(submitFree()).rejects.toThrow(/rating/i);

    primeQueries({ submission: verifiedSubmission, hostShowable: false });
    await expect(submitFree()).rejects.toThrow(/cannot show a gallery/i);

    expect(createFreePlacement).not.toHaveBeenCalled();
  });

  it.each([
    ['unpriced', null],
    ['priced below the floor', 10],
  ] as const)('accepts a free submission to a %s gallery', async (_label, price) => {
    // The price is the PAID path's spam gate — nothing verifies that a paid
    // submission is really a remix. A free one is gated on the server having
    // verified exactly that, so refusing it over a price it does not pay would
    // refuse it for a reason that does not apply.
    primeQueries({ submission: verifiedSubmission });
    resolvePlacementSpaceFor.mockResolvedValue({ ...openSpace, price, setPrice: price });

    await expect(submitFree()).resolves.toEqual({ id: FREE_PLACEMENT });
    expect(createFreePlacement).toHaveBeenCalledTimes(1);
  });

  it('still refuses a PAID submission to those same galleries', async () => {
    // The other half of the pair above, which would also pass if the price
    // checks had been deleted rather than moved onto the paid path.
    // Re-primed between the two, because the raw-query fake answers by call
    // index: without it the second submission reads the host row as its
    // submission and fails on the wrong thing entirely.
    primeQueries();
    resolvePlacementSpaceFor.mockResolvedValue({ ...openSpace, price: null, setPrice: null });
    await expect(submit()).rejects.toThrow(/has not set a price/i);

    primeQueries();
    resolvePlacementSpaceFor.mockResolvedValue({ ...openSpace, price: 10, setPrice: 10 });
    await expect(submit()).rejects.toThrow(/not priced for submissions/i);
  });

  it('ignores expectedPrice on the free path instead of refusing on it', async () => {
    // A client that keeps sending the price it rendered must not have a stale
    // one turn a free submission into a refusal about money it is not spending.
    primeQueries({ submission: verifiedSubmission });

    await expect(submitFree({ expectedPrice: PRICE + 1 })).resolves.toEqual({ id: FREE_PLACEMENT });
  });
});

describe('what the public visibility query says about free capacity', () => {
  const visibility = (viewerId?: number) => {
    // One row satisfying every raw read this path makes. The host has to come
    // back SHOWABLE: an unresolvable host fails closed, which would make the
    // withheld cases below pass for the wrong reason.
    queryRaw.mockImplementation(async () => [
      { exists: false, count: 0, nsfwLevel: NsfwLevel.PG, minor: false, showable: true },
    ]);
    return getRemixGalleryVisibility({
      hostImageId: HOST_IMAGE,
      browsingLevel: allBrowsingLevelsFlag,
      viewerId,
      domainLevels: allBrowsingLevelsFlag,
    });
  };

  it('publishes what the creator accepts', async () => {
    // Their own setting on their own image, the same standing as `price`, and
    // the only half a signed-out viewer needs: whether free is a thing here.
    await expect(visibility()).resolves.toMatchObject({ freeSlots: openSpace.freeSlots });
  });

  it.each([
    ['signed out', undefined],
    ['the owner', OWNER],
  ] as const)('withholds how many are currently HELD from %s', async (_who, viewerId) => {
    // A count of pending and approved submissions on someone's image — the same
    // fact `pendingCount` is owner-only to protect. Public, it would let anyone
    // watch a creator's queue fill by polling an id.
    await expect(visibility(viewerId)).resolves.toMatchObject({ freeSlotsRemaining: null });
  });

  it('gives it to the one viewer who has to act on it', async () => {
    await expect(visibility(PLACER)).resolves.toMatchObject({
      freeSlotsRemaining: openSpace.freeSlotsRemaining,
    });
  });

  it('withholds it on a closed gallery even from a would-be submitter', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({ ...openSpace, mode: 'off' });
    await expect(visibility(PLACER)).resolves.toMatchObject({ freeSlotsRemaining: null });
  });
});

describe('what the owner’s review queue says a free submission is worth', () => {
  const queueRow = (free: boolean) => ({
    id: PLACEMENT,
    targetId: HOST_IMAGE,
    placerId: PLACER,
    amount: free ? 0 : PRICE,
    free,
    data: { imageId: REMIX_IMAGE },
    createdAt: new Date('2026-01-01'),
    expiresAt: new Date('2026-01-03'),
    placer: { id: PLACER, username: 'someone', image: null },
  });

  const queue = async (free: boolean) => {
    // The listable-ids query first, then the images fetch; the rows come from
    // `findMany`, which is a separate mock.
    let call = 0;
    queryRaw.mockImplementation(async () => {
      call += 1;
      if (call === 1) return [{ id: PLACEMENT, createdAt: new Date('2026-01-01') }];
      return [
        {
          id: REMIX_IMAGE,
          url: 'a',
          width: 1,
          height: 1,
          type: 'image',
          metadata: {},
          nsfwLevel: 1,
        },
        {
          id: HOST_IMAGE,
          url: 'b',
          width: 1,
          height: 1,
          type: 'image',
          metadata: {},
          nsfwLevel: 1,
        },
      ];
    });
    placementFindMany.mockResolvedValue([queueRow(free)]);

    const { items } = await getPendingRemixGallerySubmissions({
      ownerId: OWNER,
      domainLevels: allBrowsingLevelsFlag,
      viewerLevels: allBrowsingLevelsFlag,
    });
    return items[0];
  };

  it('selects `free`, so the queue can tell the two kinds apart at all', async () => {
    await queue(true);

    // Omitted from the select, the client cannot branch however it renders — and
    // the row would show as a paid one with its earnings missing.
    expect(placementFindMany.mock.calls[0][0].select).toMatchObject({ free: true });
  });

  it('quotes no earnings on a free row, rather than quoting zero', async () => {
    // 🔴 Both numbers derive from `amount`, and a free row's is 0 by DB
    // constraint. Rendered, that is "+0 Buzz" on Approve AND Decline: the
    // decision surface for the whole free tier telling a creator they earn
    // nothing, on a row the free notification just called a gift.
    const row = await queue(true);

    expect(row.free).toBe(true);
    expect(row.earnings).toBeNull();
  });

  it('still quotes both numbers on a paid row', async () => {
    const row = await queue(false);

    expect(row.earnings).toMatchObject({ approve: expect.any(Number) });
    expect(row.earnings!.approve).toBeGreaterThan(0);
    expect(row.earnings!.decline).toBeGreaterThan(0);
  });
});

/**
 * 🔴 Every `placement.findMany` ANY test in this file makes, checked after it
 * runs: if the select asks for `amount`, it must also ask for `free`.
 *
 * `amount` is 0 on a free row by DB constraint, so a consumer that renders it
 * without knowing the row is free shows "0 Buzz" — and the copy around it ("your
 * Buzz is on its way back") is false outright. The owner queue was found by
 * review; two more were found only by sweeping.
 *
 * An `afterEach` rather than one `it` per named function, and the difference is
 * the point: a per-function test retires the worry for the functions somebody
 * remembered to list, and a third select added tomorrow is looked at by neither.
 * It also has to loop rather than `.find(...)` — first-match-wins would skip a
 * second amount-carrying select inside the SAME function and stay green, which
 * is this repo's catalogued hazard reproduced inside the guard written to close
 * a sweep.
 *
 * ⚠️ What it still cannot see: a read no test in this file exercises. It is a
 * guard over exercised reads, not over the service.
 */
afterEach(() => {
  for (const [args] of placementFindMany.mock.calls as { select?: Record<string, unknown> }[][])
    if (args?.select?.amount)
      expect(args.select.free, 'a read carrying `amount` must also carry `free`').toBe(true);
});

describe('the reads a Buzz figure is rendered from', () => {
  it('the submitter’s own submissions list', async () => {
    placementFindMany.mockResolvedValue([]);
    await getMyRemixGallerySubmissions({
      placerId: PLACER,
      domainLevels: allBrowsingLevelsFlag,
      viewerLevels: allBrowsingLevelsFlag,
    });

    // The real assertion is the `afterEach` above, which inspects every select
    // this call made. This only proves the read happened, so the hook has
    // something to inspect — deleting it as pointless removes the guard's
    // anchor with nothing turning red.
    expect(placementFindMany).toHaveBeenCalled();
  });

  /**
   * 🔴 Named for the decision, because the clauses look like padding next to the
   * five that were already there and read like an obvious tidy-up to delete.
   *
   * The host on this list belongs to somebody else. Every clause below admitted
   * a host the submitter could still see after its owner had stopped showing it
   * to anyone else, and none is implied by the `ingestion = 'Scanned'` beside
   * them — a moderator flag leaves `ingestion` untouched, and a scheduled post
   * carries a non-null FUTURE `publishedAt`.
   *
   * Asserted on the ONE read that joins `Post`. The joined text of every
   * `queryRaw` call would pass if a clause landed in the submitter's own-image
   * read instead, which is a different question about a different person's
   * picture.
   */
  it('fetches the host under the full public rules, not published-only', async () => {
    placementFindMany.mockResolvedValue([
      { id: 1, targetId: HOST_IMAGE, ownerId: OWNER, data: { imageId: REMIX_IMAGE } },
    ]);

    await getMyRemixGallerySubmissions({
      placerId: PLACER,
      domainLevels: allBrowsingLevelsFlag,
      viewerLevels: allBrowsingLevelsFlag,
    });

    const hostReads = queryRaw.mock.calls.filter((call) => flatten(call).includes('JOIN "Post"'));
    // Exactly one, so the assertions below cannot be satisfied by some other
    // read that happens to carry the same words.
    expect(hostReads).toHaveLength(1);
    const sql = flatten(hostReads[0]);

    // 🔴 The leading `AND` is part of every assertion, and that is the whole
    // point of them. Matching the fragment alone pins the spelling of a clause
    // without pinning how it JOINS the others — measured: flipping one `AND` to
    // `OR` left all five green while making the entire WHERE permissive, which
    // is worse than deleting any single clause.
    expect(sql).toContain('AND p."availability" !=');
    expect(boundValues(hostReads[0])).toContain(Availability.Private);
    // `IS NOT NULL` alone served a scheduled post ahead of its own publish time.
    expect(sql).toContain('AND p."publishedAt" < now()');
    expect(sql).toContain('AND i."needsReview" IS NULL');
    expect(sql).toContain('AND NOT i."acceptableMinor"');
    expect(sql).not.toContain('OR ');
  });

  /**
   * 🔴 The withholding above must never become a disappearance. This list is the
   * submitter's own record of where their Buzz went, and the withdraw button
   * beside each row is the only route back to an escrow that otherwise sits
   * until expiry.
   *
   * So a host the nine clauses exclude has to come back as `targetImage: null`
   * on a row that is still there — not as a filtered-out row. The owner's
   * received queue deliberately does the opposite (`:1861` filters on
   * `row.image && row.targetImage`), and copying that one line into this
   * function is a plausible tidy-up that passes every other test in this file
   * while vanishing a pending row and its withdraw.
   */
  it('keeps the row when the host is withheld, so the withdraw survives', async () => {
    placementFindMany.mockResolvedValue([
      {
        id: 1,
        targetId: HOST_IMAGE,
        ownerId: OWNER,
        status: 'pending',
        data: { imageId: REMIX_IMAGE },
      },
    ]);
    // What the filtered read returns once the host stops meeting the rules.
    queryRaw.mockImplementation(async () => []);

    const rows = await getMyRemixGallerySubmissions({
      placerId: PLACER,
      domainLevels: allBrowsingLevelsFlag,
      viewerLevels: allBrowsingLevelsFlag,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect(rows[0].targetImage).toBeNull();
  });

  it('the submitter’s pending rows on the image detail card', async () => {
    queryRaw.mockImplementation(async () => [
      { exists: false, count: 0, nsfwLevel: NsfwLevel.PG, minor: false, showable: true },
    ]);
    placementFindMany.mockResolvedValue([]);

    await getRemixGalleryVisibility({
      hostImageId: HOST_IMAGE,
      browsingLevel: allBrowsingLevelsFlag,
      viewerId: PLACER,
      domainLevels: allBrowsingLevelsFlag,
    });

    // Same as above: the `afterEach` holds the assertion. This is the anchor.
    expect(placementFindMany).toHaveBeenCalled();
  });
});

describe('the free eligibility listing', () => {
  const eligibility = () =>
    getRemixGalleryFreeEligibility({
      hostImageId: HOST_IMAGE,
      placerId: PLACER,
      imageIds: [REMIX_IMAGE],
    });

  beforeEach(() => queryRaw.mockResolvedValue([{ id: REMIX_IMAGE }]));

  it('answers only for the viewer’s OWN images', async () => {
    // The predicate this asserts is the whole reason the endpoint is not an
    // oracle: without it, anyone could ask whether any image was generated from
    // any other, which is a fact about someone else's generation inputs. Delete
    // it and nothing else in this file notices.
    await eligibility();

    const sql = queryRaw.mock.calls.map(flatten).join(' ');
    expect(sql).toContain('i."userId" =');
    expect(boundValues(queryRaw.mock.calls)).toContain(PLACER);
  });

  it('reads derivation through the shared expression, not a containment test', async () => {
    // `@>` on the raw JSON is NOT the same predicate — scalar containment is
    // equality, so a non-array value would read as a match where this yields an
    // empty array, and an array of strings goes the other way. The picker must
    // offer exactly what the claim accepts, so both go through one expression.
    await eligibility();

    const sql = queryRaw.mock.calls.map(flatten).join(' ');
    expect(sql).toContain('jsonb_array_elements');
    expect(sql).toMatch(/jsonb_typeof\([\s\S]*'array'/);
    expect(sql).toContain('= ANY(');
    expect(sql).not.toContain('@>');
    expect(boundValues(queryRaw.mock.calls)).toContain(HOST_IMAGE);
  });

  it('asks only about the candidates it was given', async () => {
    // The `IN` list is the only thing bounding the work: a jsonb containment
    // test runs per row, so without it the query answers for every image the
    // placer owns. Delete the clause and the `userId` scope still holds — this
    // is about cost and about answering a question nobody asked, not a leak.
    await getRemixGalleryFreeEligibility({
      hostImageId: HOST_IMAGE,
      placerId: PLACER,
      imageIds: [REMIX_IMAGE, REMIX_IMAGE + 1],
    });

    const sql = queryRaw.mock.calls.map(flatten).join(' ');
    expect(sql).toContain('i.id IN (');
    expect(boundValues(queryRaw.mock.calls)).toEqual(
      expect.arrayContaining([REMIX_IMAGE, REMIX_IMAGE + 1])
    );
  });

  it('scopes to the SESSION placer, never a caller-supplied one', async () => {
    // Same two-mechanism defence as the submit path — the schema has no
    // `placerId` and the router passes `ctx.user.id` — and the same reason it is
    // asserted at the outcome: this endpoint answers a question about somebody's
    // generation inputs, so a caller-chosen id would read another user's
    // library. The submit path had this test; this one did not.
    await getRemixGalleryFreeEligibility({
      hostImageId: HOST_IMAGE,
      placerId: PLACER,
      imageIds: [REMIX_IMAGE],
    });

    expect(boundValues(queryRaw.mock.calls)).toContain(PLACER);
    expect(boundValues(queryRaw.mock.calls)).not.toContain(STRANGER);
    expect(hasUsedFreePlacementOn).toHaveBeenCalledWith(
      expect.objectContaining({ placerId: PLACER })
    );
    expect(getFreePlacementAllowance).toHaveBeenCalledWith({ placerId: PLACER });
  });

  it('runs no query at all for an empty candidate list', async () => {
    // `IN ()` is a syntax error, not an empty result, so the short-circuit is
    // load-bearing rather than an optimisation — and the picker asks with
    // nothing selected on every open.
    const result = await getRemixGalleryFreeEligibility({
      hostImageId: HOST_IMAGE,
      placerId: PLACER,
      imageIds: [],
    });

    expect(queryRaw).not.toHaveBeenCalled();
    expect(result.verifiedImageIds).toEqual([]);
  });

  it('carries the allowance and the never-twice answer through unchanged', async () => {
    getFreePlacementAllowance.mockResolvedValue({
      used: 1,
      remaining: 0,
      resetsAt: new Date('2026-03-04'),
    });
    hasUsedFreePlacementOn.mockResolvedValue(true);

    await expect(eligibility()).resolves.toEqual({
      allowance: { used: 1, remaining: 0, resetsAt: new Date('2026-03-04') },
      usedHere: true,
      verifiedImageIds: [REMIX_IMAGE],
    });
  });

  it('asks the never-twice question about THIS surface and THIS host', async () => {
    // Free is scoped per surface and per target. Widen either and a placer who
    // stickered an image is told they cannot submit a remix to it.
    await eligibility();

    expect(hasUsedFreePlacementOn).toHaveBeenCalledWith({
      placerId: PLACER,
      surface: 'remixGallery',
      targetType: 'image',
      targetId: HOST_IMAGE,
    });
  });
});

describe('the removal cooldown on a free entry', () => {
  const approvedAt = new Date(Date.now() - 60 * 60 * 1000);

  const arrangeApproved = (free: boolean) =>
    placementFindUnique.mockResolvedValue({
      id: PLACEMENT,
      ownerId: OWNER,
      placerId: PLACER,
      targetId: HOST_IMAGE,
      amount: free ? 0 : PRICE,
      status: 'approved',
      surface: 'remixGallery',
      free,
      data: { imageId: REMIX_IMAGE },
      resolvedAt: approvedAt,
      createdAt: approvedAt,
    });

  it('keeps the full week on a free entry, exactly as on a paid one', async () => {
    // Justin's call, and asserted rather than assumed because both agents who
    // looked at it recommended waiving it. Accepting a free remix therefore also
    // holds one of the creator's free slots for the whole week — intended, not
    // an oversight.
    for (const free of [true, false]) {
      arrangeApproved(free);
      await expect(
        actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'remove', userId: OWNER })
      ).rejects.toThrow(/can be removed from/i);
    }
    expect(placementUpdateMany).not.toHaveBeenCalled();
  });

  it('does not tell a creator that someone paid for a free entry', async () => {
    // The copy is the whole change here, so it is the thing asserted. Left
    // alone, the refusal justifies the week with a payment that never happened.
    arrangeApproved(true);
    await expect(
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'remove', userId: OWNER })
    ).rejects.toThrow(/week-long commitment/i);

    arrangeApproved(false);
    await expect(
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'remove', userId: OWNER })
    ).rejects.toThrow(/someone paid/i);
  });

  it('lets a moderator take a free entry down inside the week', async () => {
    arrangeApproved(true);
    placementUpdateMany.mockResolvedValue({ count: 1 });
    await expect(
      actOnRemixGallerySubmission({
        placementId: PLACEMENT,
        action: 'remove',
        userId: STRANGER,
        isModerator: true,
      })
    ).resolves.toMatchObject({ removed: true });
  });
});

/**
 * Every `Availability` value bound into raw SQL carries its `::"Availability"` cast.
 *
 * 🔴 This is a REGRESSION guard, not a style rule. Prisma binds an interpolated
 * string as a `text` parameter, and Postgres has no `"Availability" <> text`
 * operator, so an uncast comparison does not filter fewer rows — it aborts the
 * whole statement at parse time with SQLSTATE 42883 (`operator does not exist`).
 * Every read composing the predicate then 500s deterministically, whatever the
 * data looks like. That is exactly what happened when the shared entry predicate
 * gained its private-post guard: `placement.getRemixGalleryCardSummaries`,
 * `getRemixGalleryVisibility`, `getRemixGallery` and
 * `getMyRemixGallerySubmissions` all failed together.
 *
 * ⚠️ What this cannot do: with no database in this suite it asserts on the SQL
 * the service COMPOSES, so it proves the cast is written, not that Postgres
 * accepts the statement. It is aimed at the one failure mode that has actually
 * shipped — the cast being absent.
 *
 * Deliberately NOT a search for the literal `::"Availability"` anywhere in the
 * query. That passes while a *second*, different comparison in the same
 * statement is still uncast, which is the whole shape of this defect: three
 * queries shared one broken fragment. The guard walks every bound parameter
 * instead, so it is as wide as the class.
 */
describe('Availability parameters are cast to the enum, not bound as text', () => {
  // Identified BY VALUE, because a Prisma tagged template hands the test bare
  // scalars with no type information attached. Deliberately over-inclusive: a
  // future unrelated parameter whose value happens to be the string 'Public' or
  // 'Private' would be required to carry the cast too. That direction is the
  // safe one — it can demand a cast that is not needed, never miss one that is —
  // and the failure message names the route and the placeholder, so a false
  // positive is a minute's work rather than a mystery.
  const AVAILABILITY_VALUES = new Set<unknown>(Object.values(Availability));

  type SqlLike = { strings: readonly string[]; values: readonly unknown[] };

  /**
   * Duck-typed rather than `instanceof Prisma.Sql`. Not because the class is
   * unavailable — this suite mocks neither `@prisma/client` nor the Prisma
   * namespace, and takes `Availability` from `~/shared/utils/prisma/enums` — but
   * because the recursion below only ever reads `.strings` and `.values`, so the
   * shape is the whole contract and `instanceof` would narrow on more than is
   * used. It also keeps the guard working on a plain object fixture.
   */
  const isSql = (value: unknown): value is SqlLike =>
    !!value &&
    typeof value === 'object' &&
    Array.isArray((value as SqlLike).strings) &&
    Array.isArray((value as SqlLike).values);

  /**
   * The statement Prisma would send, with each scalar replaced by the `$N`
   * placeholder it is bound to — nested fragments spliced inline and numbered
   * left to right, which is Prisma's own rule. `flatten` above cannot serve
   * here: it drops the values entirely, so the text it returns has nothing
   * where the parameter goes and cannot say what follows one.
   *
   * 🔴 Comments are stripped BEFORE any assertion reads this — BOTH `--` to
   * end-of-line AND slash-star … star-slash blocks. (Spelled out: the closing
   * delimiter would end this very comment.) The service explains this cast in a
   * comment beside the clause, so a naive substring check would be satisfied by
   * the prose whether or not the cast is in the SQL.
   *
   * 🔴 The block-comment half is not symmetry for its own sake: a clause wrapped
   * in a block comment is DEAD SQL whose text and bound parameter both survive
   * untouched, so every per-parameter assertion below still sees a correctly
   * cast `Availability` while Postgres is handed a WHERE with the private-post
   * guard missing. Measured: commenting out the `getMyRemixGallerySubmissions`
   * clause that way passed this entire file before this strip existed.
   *
   * One `replace` with an alternation, not two passes: a single left-to-right
   * scan lets whichever opener appears FIRST win, which is what a SQL lexer
   * does. Stripping one kind and then the other lets a `--` inside a block
   * comment (or a block opener inside a line comment) eat the other's
   * delimiter. Postgres block comments nest and this does not — a nested one
   * leaves a stray closing delimiter behind, which the whole-clause pins below
   * fail on, so it is caught rather than waved through.
   */
  function render(call: unknown[]) {
    const [strings, ...values] = call as [readonly string[], ...unknown[]];
    const params: unknown[] = [];
    const expand = (parts: readonly string[], vals: readonly unknown[]): string =>
      parts.reduce((out, part, i) => {
        if (i >= vals.length) return out + part;
        const value = vals[i];
        if (isSql(value)) return out + part + expand(value.strings, value.values);
        params.push(value);
        return `${out}${part}$${params.length}`;
      }, '');
    const sql = expand(strings, values)
      .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { sql, params };
  }

  /** Every placeholder an Availability member is bound to, with the text that follows it. */
  const availabilityBindings = () =>
    queryRaw.mock.calls.flatMap((call) => {
      const { sql, params } = render(call as unknown[]);
      return params.flatMap((param, index) => {
        if (!AVAILABILITY_VALUES.has(param)) return [];
        const placeholder = `$${index + 1}`;
        // `(?!\d)` so `$1` does not match inside `$12`.
        const at = sql.search(new RegExp(`\\${placeholder}(?!\\d)`));
        return [
          {
            param,
            placeholder,
            follows: at < 0 ? null : sql.slice(at + placeholder.length),
          },
        ];
      });
    });

  const expectEveryBindingCast = (route: string) => {
    const bindings = availabilityBindings();
    // 🔴 Positive control. A read that stopped comparing availability at all
    // binds nothing, and the loop below would then assert over an empty list and
    // pass — the reassuring zero this repo keeps getting caught by. Naming the
    // route makes the failure say which read went quiet.
    expect(
      bindings.length,
      `${route} bound no Availability parameter at all — the guard has nothing to check`
    ).toBeGreaterThan(0);
    for (const binding of bindings) {
      // 🔴 Its own assertion, ahead of the cast check. A parameter that is bound
      // but whose placeholder appears NOWHERE in the rendered statement means the
      // clause using it was commented out — the binding survives, the SQL does
      // not, and the comparison is not made at all. Without this case
      // `toMatch(null)` throws `expects to receive a string, but got object`,
      // which fails (so nothing passes vacuously) but reads as a broken harness
      // instead of naming the defect, and the message below never renders.
      expect(
        binding.follows,
        `${route}: ${binding.placeholder} (${String(binding.param)}) is bound, but its ` +
          'placeholder appears nowhere in the statement — the clause using it is ' +
          'commented out, so availability is not being compared at all'
      ).not.toBeNull();
      expect(
        binding.follows,
        `${route}: ${binding.placeholder} (${String(binding.param)}) is bound as text; ` +
          'append ::"Availability" or Postgres rejects the statement with 42883'
      ).toMatch(/^::"Availability"/);
    }
  };

  beforeEach(() => {
    queryRaw.mockImplementation(async () => []);
  });

  it('in the batched card-summary read', async () => {
    await getRemixGalleryCardSummaries({
      imageIds: [HOST_IMAGE],
      browsingLevel: sfwBrowsingLevelsFlag,
    });
    expectEveryBindingCast('getRemixGalleryCardSummaries');
  });

  it('in the gallery ordering read', async () => {
    await getRemixGallery({ hostImageId: HOST_IMAGE, browsingLevel: sfwBrowsingLevelsFlag });
    expectEveryBindingCast('getRemixGallery');
  });

  // Its own case rather than folded into the one above: `galleryHasEntries` is a
  // separate statement that composes the same fragment, and it runs on every
  // image detail view.
  it('in the has-entries read behind the visibility card', async () => {
    resolvePlacementSpaceFor.mockResolvedValue(openSpace);
    await getRemixGalleryVisibility({
      hostImageId: HOST_IMAGE,
      browsingLevel: sfwBrowsingLevelsFlag,
      domainLevels: allBrowsingLevelsFlag,
    });
    expectEveryBindingCast('getRemixGalleryVisibility');
  });

  // The second copy of the clause, written out inline rather than composed from
  // the shared fragment — so fixing the fragment does not fix this one.
  it("in the submitter's own-submissions host read", async () => {
    placementFindMany.mockResolvedValue([
      { id: 1, targetId: HOST_IMAGE, ownerId: OWNER, data: { imageId: REMIX_IMAGE } },
    ]);
    await getMyRemixGallerySubmissions({
      placerId: PLACER,
      domainLevels: allBrowsingLevelsFlag,
      viewerLevels: allBrowsingLevelsFlag,
    });
    expectEveryBindingCast('getMyRemixGallerySubmissions');
  });

  /**
   * The whole clause, its cast and both of its neighbours, as one normalised
   * string — not a substring of it.
   *
   * The leading and trailing `AND`s are load-bearing for the same reason the
   * host-read test above says they are: pinning the fragment alone pins the
   * spelling of a predicate without pinning how it joins the others, and
   * flipping one `AND` to `OR` makes the entire WHERE permissive while every
   * fragment-shaped assertion stays green.
   */
  it('pins the shared entry predicate as a whole, cast included', async () => {
    await getRemixGalleryCardSummaries({
      imageIds: [HOST_IMAGE],
      browsingLevel: sfwBrowsingLevelsFlag,
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const { sql, params } = render(queryRaw.mock.calls[0] as unknown[]);
    const n = params.indexOf(Availability.Private) + 1;
    expect(n, 'Availability.Private is not bound by this read').toBeGreaterThan(0);
    expect(sql).toContain(
      `AND p."publishedAt" < now() AND p."availability" != $${n}::"Availability" ` +
        `AND i.ingestion = 'Scanned'`
    );
  });

  /**
   * The same whole-clause pin for the second copy of the predicate.
   *
   * 🔴 This is the guard that gives the block-comment strip in `render` teeth.
   * `getMyRemixGallerySubmissions` writes the clause out inline instead of
   * composing `entryIsVisible`, so the pin above cannot reach it — and a
   * per-parameter assertion cannot tell a live clause from a commented-out one,
   * because commenting it out changes neither the text nor the binding. With
   * only the per-parameter checks, that mutant passed all 141 tests here.
   */
  it("pins the submitter's own-submissions host clause as a whole, cast included", async () => {
    placementFindMany.mockResolvedValue([
      { id: 1, targetId: HOST_IMAGE, ownerId: OWNER, data: { imageId: REMIX_IMAGE } },
    ]);
    await getMyRemixGallerySubmissions({
      placerId: PLACER,
      domainLevels: allBrowsingLevelsFlag,
      viewerLevels: allBrowsingLevelsFlag,
    });
    // Two raw reads run here — the submitter's own images by id, then the host
    // read under the visibility filter. Only the host read binds Availability,
    // so selecting by that is what identifies it, and asserting exactly one
    // match is the positive control: a read that stopped comparing availability
    // lands here as 0, not as a vacuous pass.
    const bound = queryRaw.mock.calls
      .map((call) => render(call as unknown[]))
      .filter(({ params }) => params.includes(Availability.Private));
    expect(
      bound,
      'exactly one read in getMyRemixGallerySubmissions should bind Availability.Private'
    ).toHaveLength(1);
    const { sql, params } = bound[0];
    const n = params.indexOf(Availability.Private) + 1;
    expect(sql).toContain(
      `AND p."publishedAt" < now() AND p."availability" != $${n}::"Availability" ` +
        `AND i.ingestion = 'Scanned'`
    );
  });
});
