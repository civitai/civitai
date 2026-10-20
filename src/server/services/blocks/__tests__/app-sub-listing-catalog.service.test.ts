import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetSharedMocks } from '~/__tests__/mocks';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { OnboardingSteps } from '~/server/common/enums';
import type * as AppListingService from '~/server/services/blocks/app-listing.service';
import type * as SharedContentSafety from '~/server/services/apps/shared-content-safety';
import type * as RateLimit from '~/server/utils/shared-storage-rate-limit';

/**
 * Catalog sync onto an off-site parent: an OAuth client publishing its platform's items as
 * store cards. The parent comes from the caller (resolved from the token, see the auth helper);
 * these tests pin what the write path does with it.
 */

const {
  mockBust,
  mockTextSafe,
  mockSyncRate,
  mockWriteRate,
  mockGetSessionUser,
  mockPoolQuery,
  mockGetImage,
} = vi.hoisted(() => ({
  mockBust: vi.fn(async () => undefined),
  mockTextSafe: vi.fn(),
  mockSyncRate: vi.fn(),
  mockWriteRate: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockPoolQuery: vi.fn(),
  mockGetImage: vi.fn(),
}));

vi.mock('~/server/services/blocks/app-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppListingService>()),
  bustAppListingCatalogCache: mockBust,
}));
vi.mock('~/server/services/apps/shared-content-safety', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedContentSafety>()),
  assertSharedTextSafe: mockTextSafe,
}));
vi.mock('~/server/utils/shared-storage-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimit>()),
  checkSubListingSyncRateLimit: mockSyncRate,
  checkSubListingWriteRateLimit: mockWriteRate,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (id: number) => mockGetSessionUser(id) },
}));
vi.mock('~/server/db/appsDb', () => ({ requireAppsDb: () => ({ query: mockPoolQuery }) }));
vi.mock('~/server/services/image.service', () => ({ getImage: mockGetImage }));

const {
  listCatalogSubListings,
  listSubListingQueue,
  moderateSubListing,
  SubListingError,
  upsertCatalogSubListing,
  withdrawCatalogSubListing,
} = await import('~/server/services/blocks/app-sub-listing.service');
const { SharedContentBlockedError } = await import('~/server/services/apps/shared-content-safety');

const OWNER = 12;
const CREATOR = 3202;
const CLIENT = 'client-games';
const PARENT = 'apl_GAMES';
const TEMPLATE = 'https://games.example.com/?game={id}';
const ROW_ID = 'asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A';
const VERSION = '2026-10-01T00:00:00.123Z';
const read = dbMock.dbRead;
const write = dbMock.dbWrite;

function user(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    isModerator: false,
    bannedAt: null,
    muted: false,
    onboarding: OnboardingSteps.Buzz,
    emailVerified: new Date('2020-01-01'),
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    ...over,
  };
}

function catalogParent(over: Record<string, unknown> = {}) {
  return {
    id: PARENT,
    userId: OWNER,
    contentRating: 'pg',
    subListingParent: { maxPerAuthor: 20, linkTemplate: TEMPLATE },
    ...over,
  };
}

function itemRow(over: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    parentListingId: PARENT,
    itemKey: 'neon-drift',
    authorUserId: OWNER,
    title: 'Neon Drift',
    tagline: 'Arcade racer',
    imageId: null,
    subPath: 'neon-drift',
    contentRating: null,
    pendingTitle: null,
    pendingTagline: null,
    pendingImageId: null,
    pendingSubPath: null,
    pendingContentRating: null,
    pendingSubmittedAt: null,
    status: 'approved',
    approvedAt: new Date('2026-10-01'),
    updatedAt: new Date(VERSION),
    ...over,
  };
}

const BODY = { title: 'Neon Drift', tagline: 'Arcade racer' };

/** Public images and their uploaders: 51 is the owner's, 52 and 53 the creator's. */
const OWNER_IMAGE = 51;
const CREATOR_IMAGE = 52;
const CREATOR_IMAGE_2 = 53;
const IMAGE_OWNERS: Record<number, number> = {
  [OWNER_IMAGE]: OWNER,
  [CREATOR_IMAGE]: CREATOR,
  [CREATOR_IMAGE_2]: CREATOR,
};
const notPublic = () => new TRPCError({ code: 'NOT_FOUND', message: 'No image' });

const put = (body: Record<string, unknown> = BODY, externalId = 'neon-drift') =>
  upsertCatalogSubListing({ parentListingId: PARENT, clientId: CLIENT, externalId, body });

async function expectError(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(SubListingError);
  expect(err).toMatchObject({ status, code });
}

const nothingWritten = () => {
  expect(write.appSubListing.create).not.toHaveBeenCalled();
  expect(write.appSubListing.updateMany).not.toHaveBeenCalled();
};

beforeEach(() => {
  resetSharedMocks();
  for (const m of [
    mockBust,
    mockTextSafe,
    mockSyncRate,
    mockWriteRate,
    mockGetSessionUser,
    mockGetImage,
  ]) {
    m.mockReset();
  }
  mockPoolQuery.mockReset();
  read.appListing.findFirst.mockResolvedValue(catalogParent());
  write.oauthConsent.findUnique.mockResolvedValue(null);
  read.account.count.mockResolvedValue(0);
  mockGetSessionUser.mockImplementation(async (id: number) => user(id));
  write.appSubListing.findUnique.mockResolvedValue(null);
  write.appSubListing.count.mockResolvedValue(0);
  write.appSubListing.create.mockImplementation(
    async ({ data }: { data: { id: string; status: string } }) => ({
      id: data.id,
      status: data.status,
    })
  );
  write.appSubListing.updateMany.mockResolvedValue({ count: 1 });
  mockTextSafe.mockImplementation(async ({ title, body }: { title: string; body?: string }) => ({
    title,
    body,
  }));
  mockSyncRate.mockResolvedValue({ allowed: true });
  // `getImage`'s anonymous read: a public image uploaded by whoever the test names.
  mockGetImage.mockImplementation(async ({ id }: { id: number }) => ({
    id,
    user: { id: IMAGE_OWNERS[id] ?? -1 },
  }));
  // `isImageInPublicPost`: every image above is in a published, non-private post.
  read.$queryRaw.mockImplementation(async (q: { values: unknown[] }) =>
    IMAGE_OWNERS[q.values[0] as number] ? [{ id: q.values[0] }] : []
  );
});

describe('upsertCatalogSubListing — new items', () => {
  it('queues a new item for review, authored by the listing owner, keyed and linked by its id', async () => {
    await expect(put()).resolves.toMatchObject({
      status: 'pending',
      pendingEdit: false,
      href: 'https://games.example.com/?game=neon-drift',
    });
    expect(write.appSubListing.create.mock.calls[0][0].data).toMatchObject({
      parentListingId: PARENT,
      itemKey: 'neon-drift',
      subPath: 'neon-drift',
      authorUserId: OWNER,
      title: 'Neon Drift',
      tagline: 'Arcade racer',
      imageId: null,
      status: 'pending',
    });
    // The parent is re-read with the caller's client, never trusted from the argument alone.
    expect(read.appListing.findFirst.mock.calls[0][0].where).toMatchObject({
      id: PARENT,
      connectClientId: CLIENT,
      kind: 'offsite',
      revisionOfId: null,
      status: 'approved',
      subListingParent: { is: { enabled: true, linkTemplate: { not: null } } },
    });
    expect(mockBust).not.toHaveBeenCalled();
  });

  it('runs the text check as a non-moderator, for the author, even when the owner is a moderator', async () => {
    mockGetSessionUser.mockImplementation(async (id: number) => user(id, { isModerator: true }));
    await put();
    expect(mockTextSafe).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER, isModerator: false })
    );
  });

  it('stores the title and tagline the text check returns, not the raw input', async () => {
    mockTextSafe.mockResolvedValueOnce({ title: 'Neon Drift (clean)', body: 'Arcade (clean)' });
    await put();
    expect(write.appSubListing.create.mock.calls[0][0].data).toMatchObject({
      title: 'Neon Drift (clean)',
      tagline: 'Arcade (clean)',
    });
  });

  it('refuses when the client has no enabled parent', async () => {
    read.appListing.findFirst.mockResolvedValueOnce(null);
    await expectError(put(), 403, 'not_enabled');
    nothingWritten();
  });

  it.each(['a/b', 'a.b', 'a%2F', '', 'x'.repeat(65), 'a b'])(
    'refuses the item id %j',
    async (externalId) => {
      await expectError(put(BODY, externalId), 400, 'invalid_body');
      nothingWritten();
    }
  );

  it.each([
    ['an unknown key', { ...BODY, subPath: 'neon-drift' }],
    ['a non-integer imageId', { ...BODY, imageId: 5.5 }],
    ['a missing title', { tagline: 'x' }],
    ['a blank title', { title: '   ' }],
    ['a long tagline', { title: 'T', tagline: 'x'.repeat(141) }],
  ])('refuses a body with %s', async (_label, body) => {
    await expectError(put(body), 400, 'invalid_body');
    nothingWritten();
  });

  it('refuses a rating less mature than the parent', async () => {
    read.appListing.findFirst.mockResolvedValueOnce(catalogParent({ contentRating: 'pg13' }));
    await expectError(put({ ...BODY, contentRating: 'pg' }), 400, 'rating_too_loose');
    nothingWritten();
  });

  it('accepts a rating as mature as the parent or more (positive control)', async () => {
    read.appListing.findFirst.mockResolvedValueOnce(catalogParent({ contentRating: 'pg13' }));
    await expect(put({ ...BODY, contentRating: 'r' })).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('refuses text the safety check blocks', async () => {
    mockTextSafe.mockRejectedValueOnce(new SharedContentBlockedError('audit', 'blocked'));
    await expectError(put(), 400, 'text_rejected');
    nothingWritten();
  });

  it('answers 429 with a retry hint when the parent is over its sync limit', async () => {
    mockSyncRate.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 120 });
    const err = await put().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: 120 });
    expect(mockSyncRate).toHaveBeenCalledWith(PARENT);
    nothingWritten();
  });

  it('applies the per-author cap', async () => {
    write.appSubListing.count.mockResolvedValueOnce(20);
    await expectError(put(), 429, 'author_cap');
  });
});

describe('upsertCatalogSubListing — creator attribution', () => {
  const asCreator = () => put({ ...BODY, creatorUserId: CREATOR });

  it('attributes the item to a creator who consented to the same client', async () => {
    write.oauthConsent.findUnique.mockResolvedValueOnce({ id: 1 });
    await asCreator();
    expect(write.oauthConsent.findUnique.mock.calls[0][0].where).toEqual({
      userId_clientId: { userId: CREATOR, clientId: CLIENT },
    });
    expect(write.appSubListing.create.mock.calls[0][0].data.authorUserId).toBe(CREATOR);
    expect(mockTextSafe).toHaveBeenCalledWith(expect.objectContaining({ userId: CREATOR }));
  });

  it('refuses a creator without a consent to the client', async () => {
    await expectError(asCreator(), 403, 'creator_not_linked');
    expect(mockGetSessionUser).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('refuses a creator whose account is gone', async () => {
    write.oauthConsent.findUnique.mockResolvedValueOnce({ id: 1 });
    mockGetSessionUser.mockResolvedValueOnce(null);
    await expectError(asCreator(), 404, 'creator_not_found');
    nothingWritten();
  });

  it.each([
    ['banned', { bannedAt: new Date() }],
    ['muted', { muted: true }],
    ['not onboarded', { onboarding: 0 }],
    ['unverified with no linked account', { emailVerified: null }],
  ])('refuses a %s creator', async (_label, over) => {
    write.oauthConsent.findUnique.mockResolvedValueOnce({ id: 1 });
    mockGetSessionUser.mockResolvedValueOnce(user(CREATOR, over));
    await expectError(asCreator(), 403, 'untrusted');
    nothingWritten();
  });

  it('needs no consent for the listing owner named explicitly', async () => {
    await put({ ...BODY, creatorUserId: OWNER });
    expect(write.oauthConsent.findUnique).not.toHaveBeenCalled();
    expect(write.appSubListing.create.mock.calls[0][0].data.authorUserId).toBe(OWNER);
  });

  it('reports author_mismatch when another creator’s row appears while saving', async () => {
    write.appSubListing.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(itemRow({ authorUserId: 99 }));
    await expectError(put(), 409, 'author_mismatch');
    nothingWritten();
  });

  it('never re-attributes an existing item to another creator', async () => {
    write.oauthConsent.findUnique.mockResolvedValueOnce({ id: 1 });
    write.appSubListing.findUnique.mockResolvedValueOnce(itemRow({ authorUserId: OWNER }));
    await expectError(asCreator(), 409, 'author_mismatch');
    expect(mockSyncRate).not.toHaveBeenCalled();
    nothingWritten();
  });
});

describe('upsertCatalogSubListing — existing items', () => {
  it('an identical re-sync of an approved item writes nothing and is not rate limited', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(itemRow());
    await expect(put()).resolves.toEqual({
      id: ROW_ID,
      status: 'approved',
      pendingEdit: false,
      href: 'https://games.example.com/?game=neon-drift',
    });
    expect(mockSyncRate).not.toHaveBeenCalled();
    expect(mockTextSafe).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('an identical re-sync of a pending item writes nothing either', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(itemRow({ status: 'pending' }));
    await expect(put()).resolves.toMatchObject({ status: 'pending', pendingEdit: false });
    expect(mockSyncRate).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('re-syncing the live content of an approved item clears its staged edit', async () => {
    write.appSubListing.findUnique.mockResolvedValue(
      itemRow({
        pendingTitle: 'Neon Drift 2',
        pendingSubPath: 'neon-drift',
        pendingSubmittedAt: new Date(VERSION),
      })
    );
    await expect(put()).resolves.toMatchObject({ status: 'approved', pendingEdit: false });
    expect(write.appSubListing.updateMany.mock.calls[0][0].data).toMatchObject({
      pendingTitle: null,
      pendingSubmittedAt: null,
    });
    expect(mockSyncRate).toHaveBeenCalledTimes(1);
  });

  it('a changed approved item stages the edit and keeps the live card', async () => {
    write.appSubListing.findUnique.mockResolvedValue(itemRow());
    await expect(put({ ...BODY, title: 'Neon Drift 2' })).resolves.toMatchObject({
      status: 'approved',
      pendingEdit: true,
    });
    const { data } = write.appSubListing.updateMany.mock.calls[0][0];
    expect(data).toMatchObject({ pendingTitle: 'Neon Drift 2', pendingSubPath: 'neon-drift' });
    expect(data).not.toHaveProperty('title');
    expect(data).not.toHaveProperty('status');
    expect(mockSyncRate).toHaveBeenCalledTimes(1);
  });

  it('a pending item is edited in place', async () => {
    write.appSubListing.findUnique.mockResolvedValue(itemRow({ status: 'pending' }));
    await put({ ...BODY, title: 'Neon Drift 2' });
    expect(write.appSubListing.updateMany.mock.calls[0][0].data).toMatchObject({
      title: 'Neon Drift 2',
    });
  });

  it('a withdrawn item goes back to review', async () => {
    write.appSubListing.findUnique.mockResolvedValue(itemRow({ status: 'withdrawn' }));
    await expect(put()).resolves.toMatchObject({ status: 'pending' });
    expect(write.appSubListing.updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'pending',
      approvedAt: null,
    });
  });

  it('a hidden item is a lock: 200 hidden, nothing written, whatever the content', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(itemRow({ status: 'hidden' }));
    await expect(put({ ...BODY, title: 'Something else' })).resolves.toMatchObject({
      status: 'hidden',
      pendingEdit: false,
    });
    expect(mockSyncRate).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('a 503 while the link_template column is not applied', async () => {
    read.appListing.findFirst.mockRejectedValueOnce(
      Object.assign(new Error('column does not exist'), { code: 'P2022' })
    );
    await expectError(put(), 503, 'unavailable');
  });
});

describe('upsertCatalogSubListing — item images', () => {
  const asCreator = (body: Record<string, unknown>) => {
    write.oauthConsent.findUnique.mockResolvedValueOnce({ id: 1 });
    return put({ ...body, creatorUserId: CREATOR });
  };

  it('stores a public image the listing owner uploaded, read as an anonymous viewer', async () => {
    await expect(put({ ...BODY, imageId: OWNER_IMAGE })).resolves.toMatchObject({
      status: 'pending',
    });
    expect(write.appSubListing.create.mock.calls[0][0].data.imageId).toBe(OWNER_IMAGE);
    expect(mockGetImage).toHaveBeenCalledWith({ id: OWNER_IMAGE, isModerator: false });
  });

  it('checks ownership against the attributed creator, not the listing owner', async () => {
    await expect(asCreator({ ...BODY, imageId: CREATOR_IMAGE })).resolves.toMatchObject({
      status: 'pending',
    });
    expect(write.appSubListing.create.mock.calls[0][0].data).toMatchObject({
      authorUserId: CREATOR,
      imageId: CREATOR_IMAGE,
    });
  });

  it('refuses an image the author did not upload, even the listing owner’s', async () => {
    await expectError(asCreator({ ...BODY, imageId: OWNER_IMAGE }), 403, 'image_not_yours');
    await expectError(put({ ...BODY, imageId: CREATOR_IMAGE }), 403, 'image_not_yours');
    nothingWritten();
  });

  it('refuses an image that is not public', async () => {
    mockGetImage.mockRejectedValueOnce(notPublic());
    await expectError(put({ ...BODY, imageId: OWNER_IMAGE }), 400, 'image_not_public');
    nothingWritten();
  });

  it('a changed image on an approved item is staged; the live image keeps serving', async () => {
    write.oauthConsent.findUnique.mockResolvedValue({ id: 1 });
    write.appSubListing.findUnique.mockResolvedValue(
      itemRow({ authorUserId: CREATOR, imageId: CREATOR_IMAGE })
    );
    await expect(
      put({ ...BODY, imageId: CREATOR_IMAGE_2, creatorUserId: CREATOR })
    ).resolves.toMatchObject({ status: 'approved', pendingEdit: true });
    const { data } = write.appSubListing.updateMany.mock.calls[0][0];
    expect(data).toMatchObject({ pendingImageId: CREATOR_IMAGE_2, pendingTitle: 'Neon Drift' });
    expect(data).not.toHaveProperty('imageId');
    expect(data).not.toHaveProperty('status');
  });

  it('a staged image goes through the same checks as a new one', async () => {
    write.appSubListing.findUnique.mockResolvedValue(itemRow({ imageId: OWNER_IMAGE }));
    await expectError(put({ ...BODY, imageId: CREATOR_IMAGE }), 403, 'image_not_yours');
    mockGetImage.mockRejectedValueOnce(notPublic());
    await expectError(put({ ...BODY, imageId: 54 }), 400, 'image_not_public');
    nothingWritten();
  });

  it('a PUT without imageId removes the image, as a staged edit of an approved item', async () => {
    write.appSubListing.findUnique.mockResolvedValue(itemRow({ imageId: OWNER_IMAGE }));
    await expect(put()).resolves.toMatchObject({ status: 'approved', pendingEdit: true });
    const { data } = write.appSubListing.updateMany.mock.calls[0][0];
    expect(data).toMatchObject({ pendingImageId: null, pendingSubmittedAt: expect.any(Date) });
    expect(mockGetImage).not.toHaveBeenCalled();
  });

  it('a withdrawn item republished with an image is checked, then goes back to review with it', async () => {
    write.appSubListing.findUnique.mockResolvedValue(itemRow({ status: 'withdrawn' }));
    await expectError(put({ ...BODY, imageId: CREATOR_IMAGE }), 403, 'image_not_yours');
    nothingWritten();
    await expect(put({ ...BODY, imageId: OWNER_IMAGE })).resolves.toMatchObject({
      status: 'pending',
    });
    expect(write.appSubListing.updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'pending',
      imageId: OWNER_IMAGE,
    });
  });

  it('a hidden item stays locked: a new image is neither checked nor written', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(itemRow({ status: 'hidden' }));
    await expect(put({ ...BODY, imageId: CREATOR_IMAGE })).resolves.toMatchObject({
      status: 'hidden',
      pendingEdit: false,
    });
    expect(mockGetImage).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('a rate-limited PUT does not read the image', async () => {
    mockSyncRate.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60 });
    await expectError(put({ ...BODY, imageId: OWNER_IMAGE }), 429, 'rate_limited');
    expect(mockGetImage).not.toHaveBeenCalled();
    // Positive control: the same PUT under the limit does read it.
    await put({ ...BODY, imageId: OWNER_IMAGE });
    expect(mockGetImage).toHaveBeenCalledTimes(1);
  });

  it.each(['approved', 'pending'])(
    'an identical re-sync of a %s item with an image writes nothing and checks nothing',
    async (status) => {
      write.appSubListing.findUnique.mockResolvedValueOnce(
        itemRow({ status, imageId: OWNER_IMAGE })
      );
      await expect(put({ ...BODY, imageId: OWNER_IMAGE })).resolves.toEqual({
        id: ROW_ID,
        status,
        pendingEdit: false,
        href: 'https://games.example.com/?game=neon-drift',
      });
      expect(mockGetImage).not.toHaveBeenCalled();
      expect(mockSyncRate).not.toHaveBeenCalled();
      nothingWritten();
    }
  );
});

describe('withdrawCatalogSubListing', () => {
  const del = (externalId = 'neon-drift') =>
    withdrawCatalogSubListing({ parentListingId: PARENT, externalId });

  it('withdraws the item whoever authored it, pending or approved only', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(itemRow({ authorUserId: CREATOR }));
    await expect(del()).resolves.toEqual({ ok: true, withdrawn: true });
    const wheres = write.appSubListing.updateMany.mock.calls.map(
      (c: [{ where: Record<string, unknown> }]) => c[0].where
    );
    expect(wheres).toEqual([
      { parentListingId: PARENT, itemKey: 'neon-drift', status: 'pending' },
      { parentListingId: PARENT, itemKey: 'neon-drift', status: 'approved' },
    ]);
    expect(write.appSubListing.updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'withdrawn',
    });
    expect(mockSyncRate).toHaveBeenCalledWith(PARENT);
  });

  it.each([
    ['unknown', null],
    ['already withdrawn', itemRow({ status: 'withdrawn' })],
    ['hidden and never approved', itemRow({ status: 'hidden', approvedAt: null })],
  ])('an %s item changes nothing and is not rate limited', async (_label, row) => {
    write.appSubListing.findUnique.mockResolvedValueOnce(row);
    await expect(del()).resolves.toEqual({ ok: true, withdrawn: false });
    expect(mockSyncRate).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('a hidden, once-approved item stays hidden but can then only be restored to review', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(itemRow({ status: 'hidden' }));
    await expect(del()).resolves.toEqual({ ok: true, withdrawn: false });
    expect(write.appSubListing.updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = write.appSubListing.updateMany.mock.calls[0][0];
    expect(where).toEqual({
      parentListingId: PARENT,
      itemKey: 'neon-drift',
      status: 'hidden',
      approvedAt: { not: null },
    });
    expect(data).toMatchObject({ approvedAt: null });
    expect(data.updatedAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty('status');

    // The restore that follows sends it back to review, not into the store.
    write.appSubListing.findUnique.mockResolvedValueOnce(
      itemRow({ status: 'hidden', approvedAt: null })
    );
    read.appListing.findUnique.mockResolvedValueOnce({ kind: 'offsite', appBlock: null });
    await expect(
      moderateSubListing({
        input: { id: ROW_ID, action: 'restore', version: VERSION },
        moderatorId: 9,
      })
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('re-dispatches when a moderator hid the item between the read and the write', async () => {
    write.appSubListing.findUnique
      .mockResolvedValueOnce(itemRow())
      .mockResolvedValueOnce(itemRow({ status: 'hidden' }));
    write.appSubListing.updateMany
      .mockResolvedValueOnce({ count: 0 }) // pending
      .mockResolvedValueOnce({ count: 0 }) // approved: lost to the hide
      .mockResolvedValueOnce({ count: 1 }); // the hidden branch
    await expect(del()).resolves.toEqual({ ok: true, withdrawn: false });
    expect(write.appSubListing.updateMany.mock.calls[2][0].data).toMatchObject({
      approvedAt: null,
    });
    expect(mockSyncRate).toHaveBeenCalledTimes(1);
  });

  it('re-dispatches when a moderator restored the item between the read and the write', async () => {
    write.appSubListing.findUnique
      .mockResolvedValueOnce(itemRow({ status: 'hidden' }))
      .mockResolvedValueOnce(itemRow());
    write.appSubListing.updateMany
      .mockResolvedValueOnce({ count: 0 }) // the hidden branch: lost to the restore
      .mockResolvedValueOnce({ count: 0 }) // pending
      .mockResolvedValueOnce({ count: 1 }); // approved
    await expect(del()).resolves.toEqual({ ok: true, withdrawn: true });
  });

  it('gives up with 409 conflict when the item keeps changing', async () => {
    write.appSubListing.findUnique.mockResolvedValue(itemRow({ status: 'hidden' }));
    write.appSubListing.updateMany.mockResolvedValue({ count: 0 });
    await expectError(del(), 409, 'conflict');
    expect(write.appSubListing.updateMany).toHaveBeenCalledTimes(3);
  });

  it('refuses a malformed id and is rate limited per parent', async () => {
    await expectError(del('../x'), 400, 'invalid_body');
    write.appSubListing.findUnique.mockResolvedValueOnce(itemRow());
    mockSyncRate.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 5 });
    await expectError(del(), 429, 'rate_limited');
    expect(write.appSubListing.updateMany).not.toHaveBeenCalled();
  });
});

describe('listCatalogSubListings', () => {
  it('lists the parent’s items with their external ids and a cursor', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      id: `asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z${String(i)
        .padStart(2, '0')
        .replace(/[ILOU]/g, 'A')}`,
      itemKey: `game-${i}`,
      status: 'approved',
      title: `Game ${i}`,
      authorUserId: CREATOR,
      pendingSubmittedAt: i === 0 ? new Date() : null,
      statusReason: null,
      editRejectionReason: null,
      updatedAt: new Date(VERSION),
    }));
    read.appSubListing.findMany.mockResolvedValueOnce(rows);
    const res = await listCatalogSubListings({ parentListingId: PARENT });
    expect(res.items).toHaveLength(100);
    expect(res.items[0]).toEqual({
      externalId: 'game-0',
      id: rows[0].id,
      status: 'approved',
      title: 'Game 0',
      creatorUserId: CREATOR,
      pendingEdit: true,
      statusReason: null,
      editRejectionReason: null,
      updatedAt: new Date(VERSION),
    });
    expect(res.nextCursor).toBe(rows[99].id);
    expect(read.appSubListing.findMany.mock.calls[0][0].where).toEqual({
      parentListingId: PARENT,
    });
  });

  it('resumes after a valid cursor, in id order, and ends on a short page', async () => {
    read.appSubListing.findMany.mockResolvedValueOnce([]);
    const res = await listCatalogSubListings({ parentListingId: PARENT, cursor: ROW_ID });
    expect(res).toEqual({ items: [], nextCursor: null });
    expect(read.appSubListing.findMany.mock.calls[0][0]).toMatchObject({
      where: { parentListingId: PARENT },
      orderBy: { id: 'asc' },
      take: 101,
      cursor: { id: ROW_ID },
      skip: 1,
    });
  });

  it('has no next page when exactly a full page remains', async () => {
    read.appSubListing.findMany.mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, i) => ({
        id: `asl_${i}`,
        itemKey: `game-${i}`,
        status: 'approved',
        title: 'G',
        authorUserId: OWNER,
        pendingSubmittedAt: null,
        statusReason: null,
        editRejectionReason: null,
        updatedAt: new Date(VERSION),
      }))
    );
    const res = await listCatalogSubListings({ parentListingId: PARENT });
    expect(res.items).toHaveLength(100);
    expect(res.nextCursor).toBeNull();
  });

  it('refuses a cursor that is not a store item id', async () => {
    await expectError(
      listCatalogSubListings({ parentListingId: PARENT, cursor: 'nope' }),
      400,
      'invalid_body'
    );
  });
});

describe('moderation of an off-site parent’s items', () => {
  it('restore does not consult app storage for an off-site parent', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(itemRow({ status: 'hidden' }));
    read.appListing.findUnique.mockResolvedValueOnce({ kind: 'offsite', appBlock: null });
    await expect(
      moderateSubListing({
        input: { id: ROW_ID, action: 'restore', version: VERSION },
        moderatorId: 9,
      })
    ).resolves.toMatchObject({ status: 'approved' });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('restore still refuses an on-site parent without a block (positive control)', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(itemRow({ status: 'hidden' }));
    read.appListing.findUnique.mockResolvedValueOnce({ kind: 'onsite', appBlock: null });
    await expectError(
      moderateSubListing({
        input: { id: ROW_ID, action: 'restore', version: VERSION },
        moderatorId: 9,
      }),
      409,
      'invalid_transition'
    );
  });

  it('the queue shows the external link for an off-site parent and none for an on-site one', async () => {
    const queueRow = (id: string, parent: Record<string, unknown>) => ({
      ...itemRow({ id, status: 'pending' }),
      image: null,
      pendingImage: null,
      createdAt: new Date(VERSION),
      moderatedAt: null,
      parentListing: parent,
      author: { id: OWNER, username: 'owner', image: null },
    });
    read.appSubListing.findMany.mockResolvedValueOnce([
      queueRow(ROW_ID, { id: PARENT, slug: 'civitai-games', name: 'Games', kind: 'offsite' }),
      queueRow('asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2B', {
        id: 'apl_ONSITE',
        slug: 'custom-generators',
        name: 'Gens',
        kind: 'onsite',
      }),
    ]);
    // A template on the on-site parent too, so only the kind check keeps its link off.
    read.$queryRaw.mockResolvedValueOnce([
      { id: PARENT, link_template: TEMPLATE },
      { id: 'apl_ONSITE', link_template: TEMPLATE },
    ]);
    const { items } = await listSubListingQueue({ view: 'queue', limit: 50 });
    expect(items.map((i) => i.externalHref)).toEqual([
      'https://games.example.com/?game=neon-drift',
      null,
    ]);
    expect(items[0].parent).toEqual({ id: PARENT, slug: 'civitai-games', name: 'Games' });
  });

  // The review's click-to-reveal decides on each image's level, so the queue must carry the
  // level of the LIVE image and of the PROPOSED one separately — they are different images.
  it('🔴 the queue carries the live and the proposed image’s own levels', async () => {
    read.appSubListing.findMany.mockResolvedValueOnce([
      {
        ...itemRow({
          imageId: CREATOR_IMAGE,
          pendingTitle: 'Neon Drift 2',
          pendingSubPath: 'neon-drift',
          pendingImageId: CREATOR_IMAGE_2,
          pendingSubmittedAt: new Date(VERSION),
        }),
        image: { url: 'live-key', nsfwLevel: 2 },
        pendingImage: { url: 'proposed-key', nsfwLevel: 16 },
        createdAt: new Date(VERSION),
        moderatedAt: null,
        parentListing: {
          id: 'apl_ONSITE',
          slug: 'custom-generators',
          name: 'Gens',
          kind: 'onsite',
        },
        author: { id: OWNER, username: 'owner', image: null },
      },
    ]);
    const { items } = await listSubListingQueue({ view: 'queue', limit: 50 });
    expect(items[0].live).toMatchObject({
      imageId: CREATOR_IMAGE,
      imageUrl: 'live-key',
      imageNsfwLevel: 2,
    });
    expect(items[0].pending).toMatchObject({
      imageId: CREATOR_IMAGE_2,
      imageUrl: 'proposed-key',
      imageNsfwLevel: 16,
    });
    // The level reaches the row only because the read asks for it — a mocked row would carry it
    // either way, so the select is the half that proves the column is read.
    const select = read.appSubListing.findMany.mock.calls.at(-1)?.[0]?.select;
    expect(select?.image).toEqual({ select: { url: true, nsfwLevel: true } });
    expect(select?.pendingImage).toEqual({ select: { url: true, nsfwLevel: true } });
  });

  it('a queue row without an image carries no level', async () => {
    read.appSubListing.findMany.mockResolvedValueOnce([
      {
        ...itemRow({ status: 'pending' }),
        image: null,
        pendingImage: null,
        createdAt: new Date(VERSION),
        moderatedAt: null,
        parentListing: {
          id: 'apl_ONSITE',
          slug: 'custom-generators',
          name: 'Gens',
          kind: 'onsite',
        },
        author: { id: OWNER, username: 'owner', image: null },
      },
    ]);
    const { items } = await listSubListingQueue({ view: 'queue', limit: 50 });
    expect(items[0].live.imageNsfwLevel).toBeNull();
    expect(items[0].pending).toBeNull();
  });
});
