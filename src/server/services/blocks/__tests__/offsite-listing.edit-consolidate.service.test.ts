import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OffsiteRequestError,
  getMyListingForEdit,
  updateRevisionDraft,
} from '~/server/services/blocks/offsite-listing.service';

/**
 * W13 — dual-mode edit CONSOLIDATION service tests: `getMyListingForEdit` (the
 * owner-gated prefill read: scalars + assets + status + hasPendingRevision) and
 * `updateRevisionDraft` (the scalar write to an owned draft shadow).
 *
 * 🔴 SECURITY (audit #3010): for an APPROVED listing, `getMyListingForEdit` resolves
 * the SHADOW server-side (idempotent `beginListingRevision`) and returns
 * `effectiveId = shadowId` + the SHADOW's asset rows — NEVER the live parent's row
 * ids. These tests pin BOTH the reuse (existing shadow) and the create (no prior
 * shadow — the removal-bypass bug case) paths, asserting the edit-view read targets
 * the shadow and the returned screenshot rows are the shadow's. All DB deps mocked;
 * `getEdgeUrl` + the id gens are stubbed.
 */

const { mockRead, mockWrite, seq } = vi.hoisted(() => {
  const makeClient = () => ({
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (args: { data: unknown }) => args.data),
      update: vi.fn(async (args: { data: unknown }) => args.data),
    },
    appListingScreenshot: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      createMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
    },
    appListingPublishRequest: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    oauthClient: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
  });
  const mockRead = makeClient();
  const mockWrite = makeClient() as ReturnType<typeof makeClient> & {
    $transaction: ReturnType<typeof vi.fn>;
  };
  mockWrite.$transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));
  return { mockRead, mockWrite, seq: { n: 0 } };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (url: string) => `edge:${url}` }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_new_${++seq.n}`,
  newAppListingPublishRequestId: () => `alpr_new_${++seq.n}`,
  newAppListingScreenshotId: () => `apls_new_${++seq.n}`,
  newUlid: () => `ULID${++seq.n}`,
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

/** The `loadListingEditView` shape (scalars + assets w/ image urls). `ssRowId` marks
 *  which listing's screenshot rows these are (parent vs shadow) so tests can assert. */
function editViewRow(ssRowId: string, overrides: Record<string, unknown> = {}) {
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
    screenshots: [{ id: ssRowId, imageId: 30, order: 0, caption: 'cap', image: { url: 'shot-key' } }],
    ...overrides,
  };
}

/**
 * Route `appListing.findUnique` by `select` shape (owner check vs edit-view) and, for
 * the edit-view, by `where.id` so the shadow's view carries shadow row ids.
 */
function wireFindUnique(owned: unknown, viewByListingId: Record<string, unknown>) {
  mockRead.appListing.findUnique.mockImplementation(async (args: unknown) => {
    const a = args as { select?: Record<string, unknown>; where?: { id?: string } };
    if ('icon' in (a.select ?? {})) return viewByListingId[a.where?.id ?? ''] ?? null;
    return owned;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seq.n = 0;
  mockRead.appListing.findUnique.mockResolvedValue(null);
  mockRead.appListing.findFirst.mockResolvedValue(null);
  mockRead.appListingScreenshot.findMany.mockResolvedValue([]);
  mockRead.appListingPublishRequest.findFirst.mockResolvedValue(null);
  mockRead.oauthClient.findUnique.mockResolvedValue(null);
  mockWrite.appListing.findFirst.mockResolvedValue(null);
  mockWrite.appListing.update.mockImplementation(async (args: { data: unknown }) => args.data);
  mockWrite.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));
});

describe('getMyListingForEdit', () => {
  it('returns parent scalars + edge-resolved assets for a DRAFT listing (no shadow, no begin)', async () => {
    wireFindUnique(ownedRow({ status: 'draft' }), { apl_parent: editViewRow('ss_parent') });
    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });

    expect(res.parentId).toBe('apl_parent');
    expect(res.slug).toBe('vitrine');
    expect(res.status).toBe('draft');
    expect(res.shadowId).toBeNull();
    expect(res.hasPendingRevision).toBe(false);
    expect(res.scalars.name).toBe('Vitrine');
    expect(res.assets.icon).toEqual({ imageId: 10, url: 'edge:icon-key' });
    expect(res.assets.screenshots[0].id).toBe('ss_parent');
    // A draft never touches the revision machinery.
    expect(mockRead.appListing.findFirst).not.toHaveBeenCalled();
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('returns the connect scope disclosure: CURRENT client allowedScopes (derived set) + STORED snapshot/justifications', async () => {
    wireFindUnique(ownedRow({ status: 'draft', connectClientId: 'oauth-1' }), {
      apl_parent: editViewRow('ss_parent', {
        connectRequestedScopes: 4,
        connectScopeJustifications: { ModelsRead: 'reason' },
      }),
    });
    // The client's allowedScopes drifted to 13 since the stored snapshot (4).
    mockRead.oauthClient.findUnique.mockResolvedValue({ allowedScopes: 13 });

    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });
    expect(res.connectClientId).toBe('oauth-1');
    expect(res.connectAllowedScopes).toBe(13); // derived = client's CURRENT allowedScopes
    expect(res.connectRequestedScopes).toBe(4); // stored snapshot (drift detectable)
    expect(res.connectScopeJustifications).toEqual({ ModelsRead: 'reason' });
  });

  it('a listing with no connect client → null connect fields, no client lookup', async () => {
    wireFindUnique(ownedRow({ status: 'draft', connectClientId: null }), {
      apl_parent: editViewRow('ss_parent'),
    });
    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });
    expect(res.connectClientId).toBeNull();
    expect(res.connectAllowedScopes).toBeNull();
    expect(mockRead.oauthClient.findUnique).not.toHaveBeenCalled();
  });

  it('APPROVED with an existing shadow → reuses it; prefill + row ids come from the SHADOW', async () => {
    wireFindUnique(ownedRow({ status: 'approved' }), {
      apl_shadow_existing: editViewRow('ss_shadow', { name: 'Vitrine (edited)' }),
    });
    // beginListingRevision reuses the existing shadow (dbRead.findFirst hit → early return).
    mockRead.appListing.findFirst.mockResolvedValue({ id: 'apl_shadow_existing' });
    mockRead.appListingPublishRequest.findFirst.mockResolvedValue({ id: 'req_pending' });

    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });
    expect(res.status).toBe('approved');
    expect(res.shadowId).toBe('apl_shadow_existing');
    expect(res.hasPendingRevision).toBe(true);
    expect(res.scalars.name).toBe('Vitrine (edited)');
    // 🔴 the edit-view read targeted the SHADOW, and the screenshot rows are the shadow's.
    const viewCall = mockRead.appListing.findUnique.mock.calls.find(
      (c) => 'icon' in ((c[0] as { select?: object }).select ?? {})
    );
    expect((viewCall?.[0] as { where: { id: string } }).where.id).toBe('apl_shadow_existing');
    expect(res.assets.screenshots[0].id).toBe('ss_shadow');
    // slug stays the PUBLIC parent slug.
    expect(res.slug).toBe('vitrine');
    // Reuse path never creates a new shadow.
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('🔴 APPROVED with NO prior shadow → CREATES one server-side; prefill row ids are the SHADOW copies (never the parent)', async () => {
    wireFindUnique(ownedRow({ status: 'approved' }), {
      apl_shadow_created: editViewRow('ss_shadow_new'),
    });
    // No existing shadow → begin creates. `dbWrite.appListing.findFirst` is used
    // twice: the IN-TX race check (must be null so create runs) then the post-tx
    // winner re-read (returns the created shadow).
    mockRead.appListing.findFirst.mockResolvedValue(null);
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'apl_shadow_created' });
    // The parent has a screenshot to clone onto the shadow (exercises the copy path).
    mockWrite.appListingScreenshot.findMany.mockResolvedValue([
      { imageId: 30, order: 0, caption: 'cap' },
    ]);

    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });
    expect(res.shadowId).toBe('apl_shadow_created');
    // A shadow was actually created (begin ran its tx create).
    expect(mockWrite.appListing.create).toHaveBeenCalled();
    // 🔴 the returned asset rows are the SHADOW's copies — a removal would target these,
    // never the live parent's row ids.
    const viewCall = mockRead.appListing.findUnique.mock.calls.find(
      (c) => 'icon' in ((c[0] as { select?: object }).select ?? {})
    );
    expect((viewCall?.[0] as { where: { id: string } }).where.id).toBe('apl_shadow_created');
    expect(res.assets.screenshots[0].id).toBe('ss_shadow_new');
  });

  it('rejects a non-owner (NOT_OWNED)', async () => {
    wireFindUnique(ownedRow({ userId: 999 }), { apl_parent: editViewRow('ss_parent') });
    await expect(getMyListingForEdit({ listingId: 'apl_parent', userId: 7 })).rejects.toMatchObject({
      code: 'NOT_OWNED',
    });
  });

  it('rejected → MUST_RESUBMIT; removed → FORBIDDEN; a shadow → INVALID_REVISION', async () => {
    wireFindUnique(ownedRow({ status: 'rejected' }), {});
    await expect(getMyListingForEdit({ listingId: 'apl_parent', userId: 7 })).rejects.toMatchObject({
      code: 'MUST_RESUBMIT',
    });

    wireFindUnique(ownedRow({ status: 'removed' }), {});
    await expect(getMyListingForEdit({ listingId: 'apl_parent', userId: 7 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    wireFindUnique(ownedRow({ revisionOfId: 'apl_parent2' }), {});
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

  it('SNAPSHOTS requestedScopes from the client when the shadow patch edits scopes (form value ignored)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      ownedRow({
        id: 'apl_shadow',
        status: 'draft',
        revisionOfId: 'apl_parent',
        connectClientId: 'oauth-1',
      })
    );
    // Client allowedScopes = 13 (UserRead|ModelsRead|ModelsWrite); the form's bogus
    // requestedScopes:4 must be ignored and the derived 13 snapshotted.
    mockRead.oauthClient.findUnique.mockResolvedValue({ userId: 7, allowedScopes: 13 });
    await updateRevisionDraft({
      shadowId: 'apl_shadow',
      userId: 7,
      patch: { requestedScopes: 4, scopeJustifications: { ModelsRead: 'reason' } },
    });
    const data = mockWrite.appListing.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.connectRequestedScopes).toBe(13);
    expect(data.connectScopeJustifications).toEqual({ ModelsRead: 'reason' });
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
