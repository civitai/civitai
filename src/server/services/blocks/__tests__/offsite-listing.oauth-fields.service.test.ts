import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildListingPatchData,
  submitExternalListing,
  updateListing,
} from '~/server/services/blocks/offsite-listing.service';
import type { SubmitExternalListingInput } from '~/server/schema/blocks/offsite-listing.schema';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * App Store Listings (W13) — external-app submission SERVICE tests: the OAuth-client (connect) aspects of the MERGED submitExternalListing (re-homed from the standalone connect path).
 *
 * Covers `submitExternalListing` (DRAFT AppListing + pending request in one tx with
 * the connect fields; owner-binding; app-block-client exclude; scope subset +
 * justification validation; slug/cap reuse) plus the edit path re-validation
 * (`buildListingPatchData` + `updateListing`). DB deps are mocked — no real Prisma.
 */

const { mockRead, mockWrite, ids } = vi.hoisted(() => {
  const makeClient = () => ({
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (args: { data: unknown }) => args.data),
      update: vi.fn(async (args: { data: unknown }) => args.data),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    appBlock: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    appListingScreenshot: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      createMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
    },
    appListingPublishRequest: {
      count: vi.fn(async (..._a: unknown[]) => 0),
      create: vi.fn(async (args: { data: unknown }) => args.data),
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
  return { mockRead, mockWrite, ids: { n: 0 } };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_test_${++ids.n}`,
  newAppListingPublishRequestId: () => `alpr_test_${++ids.n}`,
  newAppListingModerationEventId: () => `alme_test_${++ids.n}`,
  newAppListingScreenshotId: () => `als_test_${++ids.n}`,
  newUlid: () => `ulid_${++ids.n}`,
}));

const CALLER = 42;
const OTHER = 99;
const CLIENT_ID = 'oauth-client-1';
// Ceiling: UserRead(1) | ModelsRead(4) | ModelsWrite(8) = 13.
const CEILING = TokenScope.UserRead | TokenScope.ModelsRead | TokenScope.ModelsWrite;

const baseInput: SubmitExternalListingInput = {
  slug: 'connect-app',
  name: 'Connect App',
  connectClientId: CLIENT_ID,
  requestedScopes: TokenScope.ModelsRead, // 4, ⊆ ceiling
  scopeJustifications: { ModelsRead: 'We download models to run them.' },
  contentRating: 'g',
};

function ownedClient(overrides: Partial<{ id: string; userId: number; allowedScopes: number }> = {}) {
  return { id: CLIENT_ID, userId: CALLER, allowedScopes: CEILING, ...overrides };
}

beforeEach(() => {
  ids.n = 0;
  for (const c of [mockRead, mockWrite]) {
    c.appListing.findUnique.mockReset().mockResolvedValue(null);
    c.appListing.create.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
    c.appListing.update.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
    c.appListing.updateMany.mockReset().mockResolvedValue({ count: 1 });
    c.appListing.findFirst.mockReset().mockResolvedValue(null);
    c.appBlock.findFirst.mockReset().mockResolvedValue(null);
    c.appListingScreenshot.findMany.mockReset().mockResolvedValue([]);
    c.appListingScreenshot.createMany.mockReset().mockResolvedValue({ count: 0 });
    c.appListingPublishRequest.count.mockReset().mockResolvedValue(0);
    c.appListingPublishRequest.create
      .mockReset()
      .mockImplementation(async (a: { data: unknown }) => a.data);
    c.oauthClient.findUnique.mockReset().mockResolvedValue(null);
  }
  mockRead.oauthClient.findUnique.mockResolvedValue(ownedClient());
  mockWrite.$transaction
    .mockReset()
    .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));
});

describe('submitExternalListing', () => {
  it('happy path: creates a DRAFT connect AppListing + a pending request with the connect fields', async () => {
    const res = await submitExternalListing({ input: baseInput, userId: CALLER });

    expect(res.slug).toBe('connect-app');
    expect(res.listingId).toMatch(/^apl_test_/);
    expect(res.publishRequestId).toMatch(/^alpr_test_/);

    const listingData = mockWrite.appListing.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(listingData).toMatchObject({
      kind: 'offsite',
      status: 'draft',
      slug: 'connect-app',
      externalUrl: null,
      connectClientId: CLIENT_ID,
      // SERVER-DERIVED from the client's allowedScopes (= CEILING), NOT the form's
      // requestedScopes (ModelsRead in baseInput).
      connectRequestedScopes: CEILING,
      connectScopeJustifications: { ModelsRead: 'We download models to run them.' },
      appBlockId: null,
      userId: CALLER,
    });

    const reqData = mockWrite.appListingPublishRequest.create.mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(reqData).toMatchObject({
      kind: 'offsite',
      status: 'pending',
      slug: 'connect-app',
      appListingId: res.listingId,
      submittedByUserId: CALLER,
    });
    expect(mockWrite.$transaction).toHaveBeenCalledTimes(1);
  });

  it('IDOR: the created rows carry the AUTHENTICATED caller as owner/submitter', async () => {
    mockRead.oauthClient.findUnique.mockResolvedValue(ownedClient({ userId: OTHER }));
    // caller OTHER owns the client → allowed; rows carry OTHER.
    await submitExternalListing({ input: baseInput, userId: OTHER });
    const listingData = mockWrite.appListing.create.mock.calls[0][0].data as { userId: number };
    const reqData = mockWrite.appListingPublishRequest.create.mock.calls[0][0]
      .data as { submittedByUserId: number };
    expect(listingData.userId).toBe(OTHER);
    expect(reqData.submittedByUserId).toBe(OTHER);
  });

  it('ownership failure: a client owned by someone else → FORBIDDEN, no write', async () => {
    mockRead.oauthClient.findUnique.mockResolvedValue(ownedClient({ userId: OTHER }));
    await expect(submitExternalListing({ input: baseInput, userId: CALLER })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('client not found → NOT_FOUND, no write', async () => {
    mockRead.oauthClient.findUnique.mockResolvedValue(null);
    await expect(submitExternalListing({ input: baseInput, userId: CALLER })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('app-block client → BAD_REQUEST (excluded up-front, no client lookup)', async () => {
    await expect(
      submitExternalListing({
        input: { ...baseInput, connectClientId: 'appblk-abc123' },
        userId: CALLER,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('App Block') });
    expect(mockRead.oauthClient.findUnique).not.toHaveBeenCalled();
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('IGNORES the form-supplied requestedScopes and snapshots the client allowedScopes', async () => {
    // A bogus form mask (MediaWrite, outside the client ceiling) must NOT reach the
    // stored row — the service derives the disclosed set from the client instead.
    await submitExternalListing({
      input: { ...baseInput, requestedScopes: TokenScope.MediaWrite, scopeJustifications: {} },
      userId: CALLER,
    });
    const listingData = mockWrite.appListing.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(listingData.connectRequestedScopes).toBe(CEILING);
  });

  it('a justification for a scope OUTSIDE the client allowedScopes → BAD_REQUEST, no write', async () => {
    // The derived set is CEILING (13); MediaWrite (64) is not in it, so its
    // justification is rejected (keys must be ⊆ the derived/requested scopes).
    await expect(
      submitExternalListing({
        input: { ...baseInput, scopeJustifications: { MediaWrite: 'why' } },
        userId: CALLER,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown-scope key', { requestedScopes: TokenScope.ModelsRead, scopeJustifications: { NotAScope: 'x' } }],
    [
      'value > max length',
      {
        requestedScopes: TokenScope.ModelsRead,
        scopeJustifications: { ModelsRead: 'x'.repeat(501) },
      },
    ],
    [
      'empty value',
      { requestedScopes: TokenScope.ModelsRead, scopeJustifications: { ModelsRead: '' } },
    ],
    [
      'key not among the derived (client) scopes',
      {
        // MediaWrite (64) is outside the client ceiling (CEILING=13), so it is not in
        // the derived requested set → its justification is rejected.
        scopeJustifications: { MediaWrite: 'not in the client scopes' },
      },
    ],
  ])('bad justification (%s) → BAD_REQUEST, no write', async (_label, patch) => {
    await expect(
      submitExternalListing({ input: { ...baseInput, ...patch }, userId: CALLER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('empty justification map ({}) is accepted (disclosure-only)', async () => {
    await expect(
      submitExternalListing({
        input: { ...baseInput, scopeJustifications: {} },
        userId: CALLER,
      })
    ).resolves.toMatchObject({ slug: 'connect-app' });
  });

  it('slug already taken → friendly BAD_REQUEST, no tx', async () => {
    mockRead.appListing.findUnique.mockResolvedValue({ id: 'apl_existing' });
    await expect(submitExternalListing({ input: baseInput, userId: CALLER })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('already taken'),
    });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('per-user pending cap → TOO_MANY_REQUESTS, no tx', async () => {
    mockRead.appListingPublishRequest.count.mockResolvedValue(10);
    await expect(submitExternalListing({ input: baseInput, userId: CALLER })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });
});

describe('buildListingPatchData (connect scope edit)', () => {
  it('valid scope patch writes connectRequestedScopes + connectScopeJustifications', () => {
    const data = buildListingPatchData(
      {
        requestedScopes: TokenScope.ModelsRead,
        scopeJustifications: { ModelsRead: 'reason' },
      },
      { connectAllowedScopes: CEILING }
    );
    expect(data.connectRequestedScopes).toBe(TokenScope.ModelsRead);
    expect(data.connectScopeJustifications).toEqual({ ModelsRead: 'reason' });
  });

  it('scope patch with NO ceiling (non-connect listing) → BAD_REQUEST', () => {
    expect(() =>
      buildListingPatchData(
        { requestedScopes: TokenScope.ModelsRead, scopeJustifications: {} },
        { connectAllowedScopes: null }
      )
    ).toThrow(/no OAuth client/);
  });

  it('scopeJustifications without requestedScopes → BAD_REQUEST', () => {
    expect(() =>
      buildListingPatchData(
        { scopeJustifications: { ModelsRead: 'reason' } },
        { connectAllowedScopes: CEILING }
      )
    ).toThrow(/requestedScopes is required/);
  });

  it('scope patch exceeding the ceiling → BAD_REQUEST', () => {
    expect(() =>
      buildListingPatchData(
        { requestedScopes: TokenScope.MediaWrite, scopeJustifications: {} },
        { connectAllowedScopes: CEILING }
      )
    ).toThrow(/exceed/);
  });
});

describe('updateListing (connect scope edit re-validation)', () => {
  const approvedConnectListing = {
    id: 'apl_live',
    kind: 'offsite',
    slug: 'connect-app',
    status: 'approved',
    userId: CALLER,
    revisionOfId: null,
    name: 'Connect App',
    tagline: null,
    description: null,
    category: null,
    contentRating: 'g',
    externalUrl: null,
    connectClientId: CLIENT_ID,
    connectRequestedScopes: TokenScope.ModelsRead,
    connectScopeJustifications: { ModelsRead: 'reason' },
    iconId: 1,
    coverId: 2,
  };

  it('rejects a justification for a scope OUTSIDE the client ceiling on edit → BAD_REQUEST', async () => {
    // The form can no longer request a scope beyond the ceiling (the mask is derived),
    // but a justification for a scope the client doesn't allow is still rejected.
    mockRead.appListing.findUnique.mockResolvedValue(approvedConnectListing);
    mockRead.oauthClient.findUnique.mockResolvedValue(ownedClient());
    await expect(
      updateListing({
        listingId: 'apl_live',
        userId: CALLER,
        patch: { scopeJustifications: { MediaWrite: 'why' } },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('SNAPSHOTS requestedScopes from the client on a pending-listing scope edit (form value ignored)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue({
      ...approvedConnectListing,
      status: 'pending',
    });
    mockRead.oauthClient.findUnique.mockResolvedValue(ownedClient()); // allowedScopes = CEILING
    await updateListing({
      listingId: 'apl_live',
      userId: CALLER,
      // A bogus form mask is supplied; the service must ignore it and snapshot CEILING.
      patch: { requestedScopes: TokenScope.ModelsRead, scopeJustifications: { ModelsRead: 'reason' } },
    });
    const data = mockWrite.appListing.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.connectRequestedScopes).toBe(CEILING);
  });

  it('re-asserts client OWNERSHIP on edit: a client transferred to another user → FORBIDDEN, no shadow write', async () => {
    // The listing is owned by CALLER, but the OAuth client now belongs to OTHER
    // (transferred after submit). A scope edit must be refused before any shadow.
    mockRead.appListing.findUnique.mockResolvedValue(approvedConnectListing);
    mockRead.oauthClient.findUnique.mockResolvedValue(ownedClient({ userId: OTHER }));
    await expect(
      updateListing({
        listingId: 'apl_live',
        userId: CALLER,
        patch: { requestedScopes: TokenScope.ModelsRead, scopeJustifications: {} },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('a valid scope change on an approved listing is MATERIAL → stages a shadow (requiresReview)', async () => {
    // loadOwnedEditableListing reads the live parent; beginListingRevision then
    // reads it again (approved, no existing shadow) and creates the shadow.
    mockRead.appListing.findUnique.mockResolvedValue(approvedConnectListing);
    mockRead.oauthClient.findUnique.mockResolvedValue(ownedClient());
    mockRead.appListing.findFirst.mockResolvedValue(null); // no existing shadow
    mockWrite.appListing.findFirst.mockResolvedValue({ id: 'apl_shadow' }); // winner re-read

    const res = await updateListing({
      listingId: 'apl_live',
      userId: CALLER,
      patch: {
        requestedScopes: TokenScope.UserRead | TokenScope.ModelsRead,
        scopeJustifications: { UserRead: 'profile', ModelsRead: 'reason' },
      },
    });
    expect(res.requiresReview).toBe(true);
    expect(res.shadowId).toBeTruthy();
  });
});
