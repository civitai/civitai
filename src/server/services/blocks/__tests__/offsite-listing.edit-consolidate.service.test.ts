import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OffsiteRequestError,
  getMyListingForEdit,
  updateRevisionDraft,
} from '~/server/services/blocks/offsite-listing.service';

/**
 * W13 — dual-mode edit CONSOLIDATION service tests: `getMyListingForEdit` (the
 * owner-gated prefill read: scalars + assets + status + hasPendingRevision,
 * resolving an approved parent's in-progress shadow) and `updateRevisionDraft`
 * (the scalar write to an owned draft shadow). All DB deps mocked — no real Prisma;
 * `getEdgeUrl` is stubbed so asset URLs are deterministic.
 */

const { mockRead, mockWrite } = vi.hoisted(() => {
  const makeClient = () => ({
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      update: vi.fn(async (args: { data: unknown }) => args.data),
    },
    appListingPublishRequest: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
  });
  return { mockRead: makeClient(), mockWrite: makeClient() };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/client-utils/cf-images-utils', () => ({
  getEdgeUrl: (url: string) => `edge:${url}`,
}));

/** The `editableListingSelect` shape (owner check + state). */
function ownedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'apl_parent',
    kind: 'offsite',
    slug: 'vitrine',
    status: 'draft',
    userId: 7,
    revisionOfId: null,
    name: 'Vitrine',
    tagline: 'A gallery',
    description: 'desc',
    category: 'utility',
    contentRating: 'g',
    externalUrl: 'https://vitrine.civitai.com/',
    connectClientId: null,
    iconId: 10,
    coverId: 20,
    ...overrides,
  };
}

/** The `loadListingEditView` shape (scalars + assets w/ image urls). */
function editViewRow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Vitrine',
    tagline: 'A gallery',
    description: 'desc',
    category: 'utility',
    contentRating: 'g',
    externalUrl: 'https://vitrine.civitai.com/',
    iconId: 10,
    coverId: 20,
    icon: { url: 'icon-key' },
    cover: { url: 'cover-key' },
    screenshots: [
      { id: 'ss_1', imageId: 30, order: 0, caption: 'cap', image: { url: 'shot-key' } },
    ],
    ...overrides,
  };
}

/**
 * Route the two distinct `appListing.findUnique` reads by their `select` shape:
 * the owner check (`revisionOfId` + `userId`) vs the edit-view (`icon`).
 */
function wireFindUnique(owned: unknown, view: unknown) {
  mockRead.appListing.findUnique.mockImplementation(async (args: unknown) => {
    const select = (args as { select?: Record<string, unknown> }).select ?? {};
    if ('icon' in select) return view;
    return owned;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRead.appListing.findUnique.mockResolvedValue(null);
  mockRead.appListing.findFirst.mockResolvedValue(null);
  mockRead.appListingPublishRequest.findFirst.mockResolvedValue(null);
  mockWrite.appListing.update.mockImplementation(async (args: { data: unknown }) => args.data);
});

describe('getMyListingForEdit', () => {
  it('returns parent scalars + edge-resolved assets for a DRAFT listing (no shadow)', async () => {
    wireFindUnique(ownedRow({ status: 'draft' }), editViewRow());
    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });

    expect(res.parentId).toBe('apl_parent');
    expect(res.slug).toBe('vitrine');
    expect(res.status).toBe('draft');
    expect(res.shadowId).toBeNull();
    expect(res.hasPendingRevision).toBe(false);
    expect(res.scalars.name).toBe('Vitrine');
    expect(res.assets.icon).toEqual({ imageId: 10, url: 'edge:icon-key' });
    expect(res.assets.cover).toEqual({ imageId: 20, url: 'edge:cover-key' });
    expect(res.assets.screenshots).toEqual([
      { id: 'ss_1', imageId: 30, url: 'edge:shot-key', caption: 'cap', order: 0 },
    ]);
    // A draft never resolves a shadow.
    expect(mockRead.appListing.findFirst).not.toHaveBeenCalled();
  });

  it('resolves an APPROVED parent to its in-progress shadow + flags hasPendingRevision', async () => {
    wireFindUnique(ownedRow({ status: 'approved' }), editViewRow({ name: 'Vitrine (edited)' }));
    mockRead.appListing.findFirst.mockResolvedValue({ id: 'apl_shadow' }); // existing shadow
    mockRead.appListingPublishRequest.findFirst.mockResolvedValue({ id: 'req_pending' });

    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });
    expect(res.status).toBe('approved');
    expect(res.shadowId).toBe('apl_shadow');
    expect(res.hasPendingRevision).toBe(true);
    // Prefill came from the shadow's edited state.
    expect(res.scalars.name).toBe('Vitrine (edited)');
    // The edit-view read targeted the shadow, not the parent.
    const viewCall = mockRead.appListing.findUnique.mock.calls.find(
      (c) => 'icon' in ((c[0] as { select?: object }).select ?? {})
    );
    expect((viewCall?.[0] as { where: { id: string } }).where.id).toBe('apl_shadow');
    // slug stays the PUBLIC parent slug regardless of the shadow's synthetic slug.
    expect(res.slug).toBe('vitrine');
  });

  it('APPROVED with no shadow yet → prefills from the parent, shadowId null', async () => {
    wireFindUnique(ownedRow({ status: 'approved' }), editViewRow());
    mockRead.appListing.findFirst.mockResolvedValue(null); // no shadow
    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });
    expect(res.shadowId).toBeNull();
    expect(res.hasPendingRevision).toBe(false);
    expect(res.scalars.name).toBe('Vitrine');
  });

  it('rejects a non-owner (NOT_OWNED)', async () => {
    wireFindUnique(ownedRow({ userId: 999 }), editViewRow());
    await expect(getMyListingForEdit({ listingId: 'apl_parent', userId: 7 })).rejects.toMatchObject({
      code: 'NOT_OWNED',
    });
  });

  it('rejected → MUST_RESUBMIT; removed → FORBIDDEN; a shadow → INVALID_REVISION', async () => {
    wireFindUnique(ownedRow({ status: 'rejected' }), editViewRow());
    await expect(getMyListingForEdit({ listingId: 'apl_parent', userId: 7 })).rejects.toMatchObject({
      code: 'MUST_RESUBMIT',
    });

    wireFindUnique(ownedRow({ status: 'removed' }), editViewRow());
    await expect(getMyListingForEdit({ listingId: 'apl_parent', userId: 7 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    wireFindUnique(ownedRow({ revisionOfId: 'apl_parent2' }), editViewRow());
    await expect(getMyListingForEdit({ listingId: 'apl_parent', userId: 7 })).rejects.toMatchObject({
      code: 'INVALID_REVISION',
    });
  });

  it('throws NOT_FOUND when the listing does not exist', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(null);
    await expect(getMyListingForEdit({ listingId: 'nope', userId: 7 })).rejects.toBeInstanceOf(
      OffsiteRequestError
    );
  });
});

describe('updateRevisionDraft', () => {
  it('writes the scalar patch to an owned DRAFT shadow', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      ownedRow({ id: 'apl_shadow', status: 'draft', revisionOfId: 'apl_parent' })
    );
    const res = await updateRevisionDraft({
      shadowId: 'apl_shadow',
      userId: 7,
      patch: { name: 'New name', tagline: 'New tagline' },
    });
    expect(res).toEqual({ shadowId: 'apl_shadow' });
    expect(mockWrite.appListing.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'apl_shadow' },
        data: expect.objectContaining({ name: 'New name', tagline: 'New tagline' }),
      })
    );
  });

  it('refuses a NON-shadow (top-level listing) → INVALID_REVISION, no write', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      ownedRow({ id: 'apl_parent', status: 'draft', revisionOfId: null })
    );
    await expect(
      updateRevisionDraft({ shadowId: 'apl_parent', userId: 7, patch: { name: 'x' } })
    ).rejects.toMatchObject({ code: 'INVALID_REVISION' });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('refuses a non-draft shadow → INVALID_REVISION', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      ownedRow({ id: 'apl_shadow', status: 'approved', revisionOfId: 'apl_parent' })
    );
    await expect(
      updateRevisionDraft({ shadowId: 'apl_shadow', userId: 7, patch: { name: 'x' } })
    ).rejects.toMatchObject({ code: 'INVALID_REVISION' });
  });

  it('refuses a non-owner → NOT_OWNED', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      ownedRow({ id: 'apl_shadow', status: 'draft', revisionOfId: 'apl_parent', userId: 999 })
    );
    await expect(
      updateRevisionDraft({ shadowId: 'apl_shadow', userId: 7, patch: { name: 'x' } })
    ).rejects.toMatchObject({ code: 'NOT_OWNED' });
  });
});
