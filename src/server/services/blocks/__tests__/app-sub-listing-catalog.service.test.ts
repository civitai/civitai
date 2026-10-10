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

const { mockBust, mockTextSafe, mockSyncRate, mockWriteRate, mockGetSessionUser, mockPoolQuery } =
  vi.hoisted(() => ({
    mockBust: vi.fn(async () => undefined),
    mockTextSafe: vi.fn(),
    mockSyncRate: vi.fn(),
    mockWriteRate: vi.fn(),
    mockGetSessionUser: vi.fn(),
    mockPoolQuery: vi.fn(),
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
  for (const m of [mockBust, mockTextSafe, mockSyncRate, mockWriteRate, mockGetSessionUser]) {
    m.mockReset();
  }
  mockPoolQuery.mockReset();
  read.appListing.findFirst.mockResolvedValue(catalogParent());
  read.oauthConsent.findUnique.mockResolvedValue(null);
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
    ['an unknown key', { ...BODY, imageId: 5 }],
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
    read.oauthConsent.findUnique.mockResolvedValueOnce({ id: 1 });
    await asCreator();
    expect(read.oauthConsent.findUnique.mock.calls[0][0].where).toEqual({
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
    read.oauthConsent.findUnique.mockResolvedValueOnce({ id: 1 });
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
    read.oauthConsent.findUnique.mockResolvedValueOnce({ id: 1 });
    mockGetSessionUser.mockResolvedValueOnce(user(CREATOR, over));
    await expectError(asCreator(), 403, 'untrusted');
    nothingWritten();
  });

  it('needs no consent for the listing owner named explicitly', async () => {
    await put({ ...BODY, creatorUserId: OWNER });
    expect(read.oauthConsent.findUnique).not.toHaveBeenCalled();
    expect(write.appSubListing.create.mock.calls[0][0].data.authorUserId).toBe(OWNER);
  });

  it('never re-attributes an existing item to another creator', async () => {
    read.oauthConsent.findUnique.mockResolvedValueOnce({ id: 1 });
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

describe('withdrawCatalogSubListing', () => {
  it('withdraws the item whoever authored it, pending or approved only', async () => {
    await expect(
      withdrawCatalogSubListing({ parentListingId: PARENT, externalId: 'neon-drift' })
    ).resolves.toEqual({ ok: true, withdrawn: true });
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
  });

  it('reports withdrawn:false for an unknown, hidden or already withdrawn item', async () => {
    write.appSubListing.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      withdrawCatalogSubListing({ parentListingId: PARENT, externalId: 'gone' })
    ).resolves.toEqual({ ok: true, withdrawn: false });
  });

  it('refuses a malformed id and is rate limited per parent', async () => {
    await expectError(
      withdrawCatalogSubListing({ parentListingId: PARENT, externalId: '../x' }),
      400,
      'invalid_body'
    );
    mockSyncRate.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 5 });
    await expectError(
      withdrawCatalogSubListing({ parentListingId: PARENT, externalId: 'x' }),
      429,
      'rate_limited'
    );
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
    read.$queryRaw.mockResolvedValueOnce([{ id: PARENT, link_template: TEMPLATE }]);
    const { items } = await listSubListingQueue({ view: 'queue', limit: 50 });
    expect(items.map((i) => i.externalHref)).toEqual([
      'https://games.example.com/?game=neon-drift',
      null,
    ]);
    expect(items[0].parent).toEqual({ id: PARENT, slug: 'civitai-games', name: 'Games' });
  });
});
