import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';

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
vi.mock('~/server/services/placement-escrow.service', () => ({
  holdPlacementEscrow,
  settlePlacement,
}));

const assertCanPlace = vi.fn(async () => undefined);
vi.mock('~/server/services/placement-moderation.service', () => ({ assertCanPlace }));

const resolvePlacementSpaceFor = vi.fn();
vi.mock('~/server/services/placement-space.service', () => ({ resolvePlacementSpaceFor }));

vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn().mockResolvedValue(undefined) }));

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
const placementFindUnique = vi.fn(async () => null as unknown);
const placementFindMany = vi.fn(async () => [] as unknown[]);
const placementUpdate = vi.fn(async () => ({}));
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
    },
  },
  dbRead: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
    placement: { findMany: placementFindMany, findUnique: placementFindUnique },
  },
}));

const {
  createRemixGallerySubmission,
  actOnRemixGallerySubmission,
  retractRemixGallerySubmission,
  setRemixGalleryPins,
  parseGalleryCursor,
} = await import('~/server/services/remix-gallery.service');

const { remixGalleryLevelAllowed, REMIX_GALLERY_MAX_PINNED } = await import(
  '~/shared/utils/remix-gallery'
);

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
}: { submission?: typeof goodSubmission | null; hostLevel?: number | null } = {}) {
  let call = 0;
  queryRaw.mockImplementation(async () => {
    call += 1;
    if (call === 1) return submission ? [submission] : [];
    if (call === 2) return hostLevel == null ? [] : [{ nsfwLevel: hostLevel }];
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
      expect(remixGalleryLevelAllowed({ rule, submissionLevel: 0, hostLevel: NsfwLevel.XXX })).toBe(
        false
      );
  });

  it('refuses a Blocked submission under both rules', () => {
    for (const rule of ['atOrBelow', 'any'] as const)
      expect(
        remixGalleryLevelAllowed({
          rule,
          submissionLevel: NsfwLevel.Blocked,
          hostLevel: NsfwLevel.XXX,
        })
      ).toBe(false);
  });

  it('compares numerically under atOrBelow', () => {
    expect(
      remixGalleryLevelAllowed({
        rule: 'atOrBelow',
        submissionLevel: NsfwLevel.R,
        hostLevel: NsfwLevel.X,
      })
    ).toBe(true);
    expect(
      remixGalleryLevelAllowed({
        rule: 'atOrBelow',
        submissionLevel: NsfwLevel.X,
        hostLevel: NsfwLevel.R,
      })
    ).toBe(false);
  });

  it('fails closed when the host itself is unrated', () => {
    expect(
      remixGalleryLevelAllowed({
        rule: 'atOrBelow',
        submissionLevel: NsfwLevel.PG,
        hostLevel: 0,
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

  it('throws when the settle claimed nothing, instead of reporting success', async () => {
    // D shipped a moderator action that appeared to work and did not: a settle
    // against a non-pending row moves no money and returns settled: false.
    placementFindUnique.mockResolvedValue(pending);
    settlePlacement.mockResolvedValue({ settled: false });
    await expect(
      actOnRemixGallerySubmission({ placementId: PLACEMENT, action: 'decline', userId: OWNER })
    ).rejects.toThrow(/already resolved/i);
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

  it('clears pins that are absent from the new set', async () => {
    placementFindMany.mockResolvedValue(entries);
    await setRemixGalleryPins({ hostImageId: HOST_IMAGE, ownerId: OWNER, placementIds: [3, 1] });

    const written = placementUpdate.mock.calls.map(([arg]) => [arg.where.id, arg.data.data]);
    expect(written).toHaveLength(entries.length);

    const byId = new Map(written);
    expect(byId.get(3)).toMatchObject({ position: 0 });
    expect(byId.get(1)).toMatchObject({ position: 1 });
    for (const id of [2, 4, 5])
      expect(byId.get(id)).toMatchObject({ pinnedAt: null, position: null });
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
