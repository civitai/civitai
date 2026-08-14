import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type * as MetricHelpers from '~/server/utils/metric-helpers';

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

const resolvePlacementSpaceFor = vi.fn();
vi.mock('~/server/services/placement-space.service', () => ({ resolvePlacementSpaceFor }));

vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn().mockResolvedValue(undefined) }));

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

const queryRaw = vi.fn();
const placementCreate = vi.fn(async () => {
  calls.push('create');
  return { id: PLACEMENT };
});
const placementCount = vi.fn(async () => 0);
const placementFindFirst = vi.fn(async () => null as unknown);
// Typed with its argument because `declineOutOfBand` re-reads each row by id, so
// one of its fakes has to answer per-placement rather than with a fixed row.
const placementFindUnique = vi.fn<(args: { where: { id: number } }) => Promise<unknown>>(
  async () => null
);
const placementFindMany = vi.fn(async () => [] as unknown[]);
const imageFindMany = vi.fn(async () => [] as unknown[]);
const placementUpdate = vi.fn(async () => ({}));
const placementUpdateMany = vi.fn(async () => ({ count: 1 }));
const dbTransaction = vi.fn(async (ops: unknown) => (Array.isArray(ops) ? ops : []));

vi.mock('~/server/db/client', () => ({
  dbWrite: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
    $transaction: (ops: unknown) => dbTransaction(ops),
    placement: {
      create: placementCreate,
      count: placementCount,
      findFirst: placementFindFirst,
      findUnique: placementFindUnique,
      findMany: placementFindMany,
      update: placementUpdate,
      updateMany: placementUpdateMany,
    },
  },
  dbRead: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
    placement: {
      findMany: placementFindMany,
      findUnique: placementFindUnique,
      count: placementCount,
    },
    image: { findMany: imageFindMany },
    user: { findUnique: async () => ({ username: 'someone' }) },
  },
}));

const {
  createRemixGallerySubmission,
  actOnRemixGallerySubmission,
  retractRemixGallerySubmission,
  setRemixGalleryPins,
  parseGalleryCursor,
  getRemixGallery,
  getRemixGalleryVisibility,
  getPendingRemixGallerySubmissions,
  declineOutOfBandRemixGallerySubmissions,
} = await import('~/server/services/remix-gallery.service');

const {
  remixGalleryLevelAllowed,
  remixGalleryMaxSubmissionLevel,
  REMIX_GALLERY_MAX_PINNED,
  REMIX_GALLERY_REMOVAL_LOCK_HOURS,
} = await import('~/shared/utils/remix-gallery');

/** A submission that passes every check, so each test breaks exactly one thing. */
const goodSubmission = {
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
  settings: {},
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
  holdPlacementEscrow.mockImplementation(async () => {
    calls.push('hold');
    return { fee: 210, principal: 490 };
  });
  primeQueries();
});

const submit = (over: Partial<Parameters<typeof createRemixGallerySubmission>[0]> = {}) =>
  createRemixGallerySubmission({
    placerId: PLACER,
    hostImageId: HOST_IMAGE,
    imageId: REMIX_IMAGE,
    ...over,
  });

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
  //
  // Nested `Prisma.sql` fragments arrive as VALUES rather than as part of the
  // template's string array, so flattening them is what makes this see the
  // predicate at all.
  const flatten = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(flatten).join(' ');
    if (value && typeof value === 'object' && 'strings' in value)
      return [
        flatten((value as { strings: unknown }).strings),
        flatten((value as { values?: unknown }).values ?? []),
      ].join(' ');
    return typeof value === 'string' ? value : '';
  };

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
});

describe('escrow ordering', () => {
  it('creates the row before taking the escrow', async () => {
    await submit();
    expect(calls).toEqual(['create', 'hold']);
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
