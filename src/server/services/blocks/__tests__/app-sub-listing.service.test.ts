import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetSharedMocks } from '~/__tests__/mocks';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { TRPCError } from '@trpc/server';
import { OnboardingSteps } from '~/server/common/enums';
import type * as AppListingService from '~/server/services/blocks/app-listing.service';
import type * as SharedContentSafety from '~/server/services/apps/shared-content-safety';
import type * as RateLimit from '~/server/utils/shared-storage-rate-limit';

const { mockBust, mockTextSafe, mockRateLimit, mockPoolQuery, mockGetImage } = vi.hoisted(() => ({
  mockBust: vi.fn(async () => undefined),
  mockTextSafe: vi.fn(),
  mockRateLimit: vi.fn(),
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
  checkSubListingWriteRateLimit: mockRateLimit,
}));
vi.mock('~/server/db/appsDb', () => ({ requireAppsDb: () => ({ query: mockPoolQuery }) }));
vi.mock('~/server/services/image.service', () => ({ getImage: mockGetImage }));

const {
  cleanSubListingText,
  countSubListingQueue,
  listMySubListings,
  listSubListingQueue,
  moderateSubListing,
  SubListingError,
  syncSubListingForSharedRow,
  upsertSubListing,
  withdrawSubListing,
} = await import('~/server/services/blocks/app-sub-listing.service');
const { SharedContentBlockedError } = await import('~/server/services/apps/shared-content-safety');

const AUTHOR = 42;
const PARENT = 'apl_PARENT';
const read = dbMock.dbRead;
const write = dbMock.dbWrite;

function trustedUser(over: Record<string, unknown> = {}) {
  return {
    id: AUTHOR,
    isModerator: false,
    bannedAt: null,
    muted: false,
    onboarding: OnboardingSteps.Buzz,
    emailVerified: new Date('2020-01-01'),
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    ...over,
  } as never;
}

function parentRow(over: Record<string, unknown> = {}) {
  return {
    id: PARENT,
    slug: 'custom-generators',
    contentRating: 'pg',
    appBlock: { blockId: 'custom-generators' },
    subListingParent: { enabled: true, maxPerAuthor: 20 },
    ...over,
  };
}

const VERSION = '2026-10-01T00:00:00.123Z';
const BODY = { itemKey: 'gen-1', title: 'Gen One', tagline: 'Makes things', subPath: 'g/ONE' };

function liveRow(over: Record<string, unknown> = {}) {
  return {
    id: 'asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A',
    parentListingId: PARENT,
    itemKey: 'gen-1',
    authorUserId: AUTHOR,
    title: 'Gen One',
    tagline: 'Makes things',
    imageId: null,
    subPath: 'g/ONE',
    contentRating: null,
    pendingTitle: null,
    pendingTagline: null,
    pendingImageId: null,
    pendingSubPath: null,
    pendingContentRating: null,
    pendingSubmittedAt: null,
    status: 'approved',
    approvedAt: new Date('2026-10-01'),
    updatedAt: new Date('2026-10-01T00:00:00.123Z'),
    ...over,
  };
}

const upsert = (body: Record<string, unknown> = BODY, user = trustedUser()) =>
  upsertSubListing({ appBlockId: 'apb_1', subjectUser: user, hasLinkedOAuth: false, body });

async function expectError(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(SubListingError);
  expect(err).toMatchObject({ status, code });
}

beforeEach(() => {
  resetSharedMocks();
  for (const m of [mockBust, mockTextSafe, mockRateLimit, mockPoolQuery, mockGetImage]) {
    m.mockReset();
  }
  read.appListing.findFirst.mockResolvedValue(parentRow());
  // The parent's block, for restore's check that the shared row is still live in the app.
  read.appListing.findUnique.mockResolvedValue({ appBlock: { blockId: 'custom-generators' } });
  // The pre-visibility-check read (owner only). Kept answering "yours" so a regression to an
  // ownership-only check would ACCEPT the unpublished image below rather than fail for an
  // unrelated reason.
  read.image.findUnique.mockResolvedValue({ userId: AUTHOR });
  // `getImage`'s anonymous read: a public image owned by the author.
  mockGetImage.mockResolvedValue({ id: 5, user: { id: AUTHOR } });
  write.appSubListing.findUnique.mockResolvedValue(null);
  write.appSubListing.count.mockResolvedValue(0);
  write.appSubListing.create.mockImplementation(
    async ({ data }: { data: { id: string; status: string } }) => ({
      id: data.id,
      status: data.status,
    })
  );
  write.appSubListing.update.mockResolvedValue({});
  write.appSubListing.updateMany.mockResolvedValue({ count: 1 });
  mockTextSafe.mockImplementation(async ({ title, body }: { title: string; body?: string }) => ({
    title,
    body,
  }));
  mockRateLimit.mockResolvedValue({ allowed: true });
  mockPoolQuery.mockResolvedValue({ rows: [{ author_user_id: AUTHOR, hidden: false }] });
});

describe('cleanSubListingText', () => {
  it('drops control, bidi and zero-width characters and collapses whitespace', () => {
    expect(cleanSubListingText('  Gen‮One​\n\tPro\u0007  ')).toBe('Gen One Pro');
  });
});

describe('upsertSubListing — refusals', () => {
  it('rejects an unknown body key, a missing key and a malformed subPath', async () => {
    await expectError(upsert({ ...BODY, url: 'https://x' }), 400, 'invalid_body');
    await expectError(upsert({ title: 'x', subPath: 'g/x' }), 400, 'invalid_body');
    await expectError(upsert({ ...BODY, subPath: '../x' }), 400, 'invalid_body');
  });

  it('enforces the title and tagline limits AFTER cleaning', async () => {
    await expectError(upsert({ ...BODY, title: 'a'.repeat(81) }), 400, 'invalid_body');
    await expectError(upsert({ ...BODY, title: '​ ‮' }), 400, 'invalid_body');
    await expectError(upsert({ ...BODY, tagline: 'b'.repeat(141) }), 400, 'invalid_body');
    // The limits are inclusive, and padding that cleaning removes does not count.
    await expect(
      upsert({ ...BODY, title: ` ${'a'.repeat(80)} `, tagline: 'b'.repeat(140) })
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('refuses an anonymous caller', async () => {
    await expectError(
      upsertSubListing({
        appBlockId: 'apb_1',
        subjectUser: null,
        hasLinkedOAuth: false,
        body: BODY,
      }),
      401,
      'anonymous'
    );
  });

  it('refuses an app with no parent row, or a disabled one', async () => {
    read.appListing.findFirst.mockResolvedValueOnce(parentRow({ subListingParent: null }));
    await expectError(upsert(), 403, 'not_enabled');
    read.appListing.findFirst.mockResolvedValueOnce(
      parentRow({ subListingParent: { enabled: false, maxPerAuthor: 20 } })
    );
    await expectError(upsert(), 403, 'not_enabled');
    read.appListing.findFirst.mockResolvedValueOnce(null);
    await expectError(upsert(), 403, 'not_enabled');
    expect(write.appSubListing.create).not.toHaveBeenCalled();
  });

  it('runs the shared-write trust check', async () => {
    await expectError(upsert(BODY, trustedUser({ emailVerified: null })), 403, 'untrusted');
    await expectError(upsert(BODY, trustedUser({ createdAt: new Date() })), 403, 'untrusted');
    // A linked login stands in for a verified email, as it does for shared storage.
    await expect(
      upsertSubListing({
        appBlockId: 'apb_1',
        subjectUser: trustedUser({ emailVerified: null }),
        hasLinkedOAuth: true,
        body: BODY,
      })
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('allows only an equal or stricter rating than the parent', async () => {
    await expectError(upsert({ ...BODY, contentRating: 'g' }), 400, 'rating_too_loose');
    await expect(upsert({ ...BODY, contentRating: 'pg' })).resolves.toBeTruthy();
    await expect(upsert({ ...BODY, contentRating: 'r' })).resolves.toBeTruthy();
  });

  it('honours the rate limit, with its retry hint', async () => {
    mockRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 77 });
    await expectError(upsert(), 429, 'rate_limited');
    mockRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 77 });
    await expect(upsert()).rejects.toMatchObject({ retryAfterSeconds: 77 });
    expect(mockRateLimit).toHaveBeenCalledWith(AUTHOR, PARENT);
  });

  it('requires a real, visible item that the caller authored', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await expectError(upsert(), 404, 'item_not_found');
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ author_user_id: AUTHOR, hidden: true }] });
    await expectError(upsert(), 404, 'item_not_found');
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ author_user_id: 7, hidden: false }] });
    await expectError(upsert(), 403, 'not_your_item');
    expect(mockPoolQuery.mock.calls[0][0]).toContain('"app_custom_generators".shared_kv');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['gen-1']);
  });

  it('refuses an image the caller does not own', async () => {
    mockGetImage.mockResolvedValueOnce({ id: 5, user: { id: 7 } });
    await expectError(upsert({ ...BODY, imageId: 5 }), 403, 'image_not_yours');
    await expect(upsert({ ...BODY, imageId: 5 })).resolves.toBeTruthy();
  });

  // A card shows its image to every store visitor, so the image must already be public. The
  // visibility rule is `getImage`'s anonymous read (published, non-private post, reviewed, not
  // Blocked), which answers NOT_FOUND for anything else, including the owner's own unpublished
  // image.
  it("refuses the caller's own image when it is not public (e.g. an unpublished post)", async () => {
    mockGetImage.mockRejectedValueOnce(
      new TRPCError({ code: 'NOT_FOUND', message: 'No image with id 5' })
    );
    await expectError(upsert({ ...BODY, imageId: 5 }), 400, 'image_not_public');
    expect(write.appSubListing.create).not.toHaveBeenCalled();
    expect(write.appSubListing.updateMany).not.toHaveBeenCalled();
  });

  it('asks for the image as an ANONYMOUS viewer, so owner-only visibility does not count', async () => {
    await expect(upsert({ ...BODY, imageId: 5 })).resolves.toBeTruthy();
    expect(mockGetImage).toHaveBeenCalledTimes(1);
    const [arg] = mockGetImage.mock.calls[0];
    expect(arg).toEqual({ id: 5, isModerator: false });
  });

  it.each([
    ['a plain error', new Error('db down')],
    [
      'a non-NOT_FOUND TRPCError',
      new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'db down' }),
    ],
  ])('%s from the image read surfaces instead of reading as "not public"', async (_l, err) => {
    mockGetImage.mockRejectedValueOnce(err);
    await expect(upsert({ ...BODY, imageId: 5 })).rejects.toThrow('db down');
  });

  it('runs the shared text-safety check on title and tagline, and stores its output', async () => {
    mockTextSafe.mockResolvedValueOnce({ title: 'Safe Title', body: 'Safe tagline' });
    await upsert();
    expect(mockTextSafe).toHaveBeenCalledWith({
      title: 'Gen One',
      body: 'Makes things',
      userId: AUTHOR,
      isModerator: false,
    });
    expect(write.appSubListing.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ title: 'Safe Title', tagline: 'Safe tagline' }),
      })
    );
    mockTextSafe.mockRejectedValueOnce(new SharedContentBlockedError('pattern', 'blocked'));
    await expectError(upsert(), 400, 'text_rejected');
  });

  it('answers 503 while the tables are absent, and while item storage is unreachable', async () => {
    read.appListing.findFirst.mockRejectedValueOnce(
      Object.assign(new Error('The table `public.app_sub_listing_parents` does not exist'), {
        code: 'P2021',
      })
    );
    await expectError(upsert(), 503, 'unavailable');
    mockPoolQuery.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expectError(upsert(), 503, 'unavailable');
  });

  it('caps active items per author per parent', async () => {
    write.appSubListing.count.mockResolvedValueOnce(20);
    await expectError(upsert(), 429, 'author_cap');
    expect(write.appSubListing.count).toHaveBeenCalledWith({
      where: {
        parentListingId: PARENT,
        authorUserId: AUTHOR,
        status: { in: ['pending', 'approved'] },
      },
    });
  });
});

/** The predicate a compare-and-set on `row` must use: same id and status, same millisecond. */
function unchangedSince(row: { id: string; status: string; updatedAt: Date }) {
  const ms = row.updatedAt.getTime();
  return {
    id: row.id,
    status: row.status,
    updatedAt: { gte: new Date(ms), lt: new Date(ms + 1) },
  };
}

/** The data of the single compare-and-set write a branch made. */
function casWrite(n = 0) {
  const call = write.appSubListing.updateMany.mock.calls[n]?.[0];
  if (!call) throw new Error(`no updateMany call #${n}`);
  return call as { where: Record<string, unknown>; data: Record<string, unknown> };
}

describe('upsertSubListing — status changes', () => {
  it('a new item starts pending, keyed by (parent, itemKey), and busts nothing', async () => {
    await expect(upsert()).resolves.toEqual({
      id: expect.stringMatching(/^asl_[0-9A-HJKMNP-TV-Z]{26}$/),
      status: 'pending',
      pendingEdit: false,
    });
    expect(write.appSubListing.findUnique).toHaveBeenCalledWith({
      where: { parentListingId_itemKey: { parentListingId: PARENT, itemKey: 'gen-1' } },
    });
    expect(write.appSubListing.create.mock.calls[0][0].data).toMatchObject({
      parentListingId: PARENT,
      itemKey: 'gen-1',
      authorUserId: AUTHOR,
      status: 'pending',
    });
    expect(write.appSubListing.create.mock.calls[0][0].data.approvedAt ?? null).toBeNull();
    // A pending row cannot be on the cached store page.
    expect(mockBust).not.toHaveBeenCalled();
  });

  // Moderator approval is mandatory; a stale `autoApprove` on the parent row must change nothing.
  it.each([
    ['a new item', null],
    ['a republished (withdrawn) item', 'withdrawn'],
  ] as const)('%s is always pending, whatever the parent row says', async (_label, existing) => {
    read.appListing.findFirst.mockResolvedValueOnce(
      parentRow({ subListingParent: { enabled: true, autoApprove: true, maxPerAuthor: 20 } })
    );
    if (existing)
      write.appSubListing.findUnique.mockResolvedValueOnce(liveRow({ status: existing }));
    await expect(upsert()).resolves.toMatchObject({ status: 'pending' });
    const written = existing ? casWrite().data : write.appSubListing.create.mock.calls[0][0].data;
    expect(written.status).toBe('pending');
    if (existing) {
      // The withdrawn row still carries its old approval stamp (`liveRow` sets one); the
      // republish must clear it, or a later hide + restore would skip review.
      expect(written).toHaveProperty('approvedAt', null);
    } else {
      expect(written.approvedAt ?? null).toBeNull();
    }
    expect(mockBust).not.toHaveBeenCalled();
  });

  it('an edit to a pending item stays pending', async () => {
    read.appListing.findFirst.mockResolvedValueOnce(
      parentRow({ subListingParent: { enabled: true, autoApprove: true, maxPerAuthor: 20 } })
    );
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow({ status: 'pending' }));
    await expect(upsert({ ...BODY, title: 'v2' })).resolves.toMatchObject({ status: 'pending' });
    expect(casWrite().data.status).toBeUndefined();
  });

  it('an edit to an approved item is staged, never applied live, whatever the parent row says', async () => {
    read.appListing.findFirst.mockResolvedValueOnce(
      parentRow({ subListingParent: { enabled: true, autoApprove: true, maxPerAuthor: 20 } })
    );
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow());
    await expect(upsert({ ...BODY, title: 'Gen One v2' })).resolves.toMatchObject({
      status: 'approved',
      pendingEdit: true,
    });
    expect(casWrite().data).toMatchObject({ pendingTitle: 'Gen One v2' });
    expect(casWrite().data.title).toBeUndefined();
    expect(mockBust).not.toHaveBeenCalled();
  });

  it('is idempotent: a second publish of a pending item updates it in place', async () => {
    const row = liveRow({ status: 'pending' });
    write.appSubListing.findUnique.mockResolvedValueOnce(row);
    await expect(upsert({ ...BODY, title: 'Gen One v2' })).resolves.toMatchObject({
      status: 'pending',
      pendingEdit: false,
    });
    expect(write.appSubListing.create).not.toHaveBeenCalled();
    expect(casWrite().where).toEqual(unchangedSince(row));
    expect(casWrite().data).toMatchObject({ title: 'Gen One v2', pendingSubmittedAt: null });
    expect(mockBust).not.toHaveBeenCalled();
  });

  it('a concurrent first publish that loses the insert is applied as an edit', async () => {
    write.appSubListing.create.mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: 'P2002' })
    );
    write.appSubListing.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(liveRow({ status: 'pending' }));
    await expect(upsert()).resolves.toMatchObject({ status: 'pending' });
    expect(write.appSubListing.updateMany).toHaveBeenCalledTimes(1);
  });

  it('an author write that loses a race with a moderator re-reads and re-decides', async () => {
    // Read says pending; a moderator approves before the write lands; the retry sees approved
    // and stages the edit instead of overwriting the approved version.
    write.appSubListing.findUnique
      .mockResolvedValueOnce(liveRow({ status: 'pending' }))
      .mockResolvedValueOnce(liveRow({ status: 'approved', updatedAt: new Date('2026-10-02') }));
    write.appSubListing.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(upsert({ ...BODY, title: 'Late edit' })).resolves.toMatchObject({
      status: 'approved',
      pendingEdit: true,
    });
    expect(casWrite(1).data).toMatchObject({ pendingTitle: 'Late edit' });
    expect(casWrite(1).data).not.toHaveProperty('title');
  });

  it('gives up with 409 after repeated lost races instead of looping', async () => {
    write.appSubListing.findUnique.mockResolvedValue(liveRow({ status: 'pending' }));
    write.appSubListing.updateMany.mockResolvedValue({ count: 0 });
    await expectError(upsert({ ...BODY, title: 'x' }), 409, 'conflict');
    expect(write.appSubListing.updateMany.mock.calls.length).toBeLessThan(5);
  });

  it('an edit to an APPROVED item is staged; the live columns are not written', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow());
    await expect(
      upsert({ ...BODY, title: 'Gen One v2', imageId: 9, contentRating: 'pg13' })
    ).resolves.toEqual({ id: liveRow().id, status: 'approved', pendingEdit: true });
    const { data } = casWrite();
    expect(data).toMatchObject({
      pendingTitle: 'Gen One v2',
      pendingTagline: 'Makes things',
      pendingImageId: 9,
      pendingSubPath: 'g/ONE',
      pendingContentRating: 'pg13',
      editRejectionReason: null,
    });
    expect(data.pendingSubmittedAt).toBeInstanceOf(Date);
    for (const live of ['title', 'tagline', 'imageId', 'subPath', 'contentRating', 'status']) {
      expect(data).not.toHaveProperty(live);
    }
    // The live version is unchanged, so the cached page is still right.
    expect(mockBust).not.toHaveBeenCalled();
  });

  it('a further edit overwrites the staged one', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(
      liveRow({
        pendingTitle: 'First try',
        pendingSubPath: 'g/ONE',
        pendingSubmittedAt: new Date(),
      })
    );
    await upsert({ ...BODY, title: 'Second try' });
    expect(casWrite().data).toMatchObject({ pendingTitle: 'Second try' });
  });

  it('an edit identical to the live version clears a staged edit instead of queueing one', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(
      liveRow({ pendingTitle: 'Other', pendingSubPath: 'g/ONE', pendingSubmittedAt: new Date() })
    );
    await expect(upsert()).resolves.toMatchObject({ status: 'approved', pendingEdit: false });
    expect(casWrite().data).toMatchObject({ pendingTitle: null, pendingSubmittedAt: null });
    // With nothing staged, an identical publish writes nothing at all.
    write.appSubListing.updateMany.mockClear();
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow());
    await upsert();
    expect(write.appSubListing.updateMany).not.toHaveBeenCalled();
  });

  it('the staged edit passes the same write-time checks as a new item', async () => {
    write.appSubListing.findUnique.mockResolvedValue(liveRow());
    await expectError(upsert({ ...BODY, title: 'x'.repeat(81) }), 400, 'invalid_body');
    await expectError(upsert({ ...BODY, subPath: 'g//x' }), 400, 'invalid_body');
    await expectError(upsert({ ...BODY, contentRating: 'g' }), 400, 'rating_too_loose');
    mockGetImage.mockResolvedValueOnce({ id: 3, user: { id: 7 } });
    await expectError(upsert({ ...BODY, imageId: 3 }), 403, 'image_not_yours');
    mockTextSafe.mockRejectedValueOnce(new SharedContentBlockedError('pattern', 'blocked'));
    await expectError(upsert({ ...BODY, title: 'Changed' }), 400, 'text_rejected');
    expect(write.appSubListing.updateMany).not.toHaveBeenCalled();
  });

  it('a hidden item is a moderator lock: republishing writes nothing', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow({ status: 'hidden' }));
    await expect(upsert({ ...BODY, title: 'Try again' })).resolves.toMatchObject({
      status: 'hidden',
    });
    expect(write.appSubListing.updateMany).not.toHaveBeenCalled();
  });

  it('a withdrawn item comes back as pending with the new content', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow({ status: 'withdrawn' }));
    await expect(upsert({ ...BODY, title: 'Back' })).resolves.toMatchObject({ status: 'pending' });
    expect(casWrite().where).toMatchObject({ status: 'withdrawn' });
    expect(casWrite().data).toMatchObject({
      title: 'Back',
      status: 'pending',
      approvedAt: null,
      pendingSubmittedAt: null,
    });
  });

  it("refuses to edit another author's row under the same key", async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow({ authorUserId: 7 }));
    await expectError(upsert(), 403, 'not_your_item');
  });
});

describe('the tables are absent (manual-apply migration not run)', () => {
  const missing = [
    Object.assign(new Error('missing'), { code: 'P2021' }),
    Object.assign(new Error('missing'), { code: '42P01' }),
    new Error('relation "app_sub_listings" does not exist'),
  ];

  it.each(missing)('upsert, withdraw, mine, queue and moderate answer 503 (%s)', async (err) => {
    read.appListing.findFirst.mockRejectedValue(err);
    await expectError(upsert(), 503, 'unavailable');
    await expectError(
      withdrawSubListing({ appBlockId: 'apb_1', userId: AUTHOR, body: { itemKey: 'k' } }),
      503,
      'unavailable'
    );
    await expectError(
      listMySubListings({ appBlockId: 'apb_1', userId: AUTHOR }),
      503,
      'unavailable'
    );
    read.appSubListing.findMany.mockRejectedValueOnce(err);
    await expectError(listSubListingQueue({ view: 'queue', limit: 25 }), 503, 'unavailable');
    write.appSubListing.findUnique.mockRejectedValueOnce(err);
    await expectError(
      moderateSubListing({
        input: { id: 'asl_x', action: 'approve', version: VERSION },
        moderatorId: 9,
      }),
      503,
      'unavailable'
    );
  });

  it('the queue count reads 0, but any other error still throws', async () => {
    read.appSubListing.count.mockRejectedValueOnce(missing[0]);
    await expect(countSubListingQueue()).resolves.toBe(0);
    read.appSubListing.count.mockRejectedValueOnce(new Error('connection reset'));
    await expect(countSubListingQueue()).rejects.toThrow('connection reset');
  });

  it('a missing COLUMN is not a missing table: it surfaces as itself', async () => {
    const half = new Error('column "pending_title" of relation "app_sub_listings" does not exist');
    write.appSubListing.findUnique.mockRejectedValueOnce(half);
    await expect(
      moderateSubListing({
        input: { id: 'asl_x', action: 'approve', version: VERSION },
        moderatorId: 9,
      })
    ).rejects.toBe(half);
  });

  it('the in-app hooks stay silent instead of logging an error per withdraw', async () => {
    read.appListing.findFirst.mockRejectedValueOnce(missing[0]);
    await syncSubListingForSharedRow({ appBlockId: 'apb_1', itemKey: 'k', change: 'hidden' });
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  // Before the migration `app_listings` exists and `app_sub_listings` does not, so the first
  // statement to fail is the version touch, not the parent read.
  it.each(missing)(
    'the hooks stay silent when the sub-listing table is missing (%s)',
    async (err) => {
      write.appSubListing.updateMany.mockRejectedValue(err);
      await expect(
        syncSubListingForSharedRow({ appBlockId: 'apb_1', itemKey: 'k', change: 'hidden' })
      ).resolves.toBeUndefined();
      expect(write.appSubListing.updateMany).toHaveBeenCalled();
      expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
    }
  );
});

describe('withdrawSubListing / listMySubListings', () => {
  it('withdraws only the caller’s own pending or approved row', async () => {
    await expect(
      withdrawSubListing({ appBlockId: 'apb_1', userId: AUTHOR, body: { itemKey: 'gen-1' } })
    ).resolves.toEqual({ ok: true, withdrawn: true });
    const wheres = write.appSubListing.updateMany.mock.calls.map((c) => c[0].where);
    expect(wheres).toEqual([
      { parentListingId: PARENT, itemKey: 'gen-1', authorUserId: AUTHOR, status: 'pending' },
      { parentListingId: PARENT, itemKey: 'gen-1', authorUserId: AUTHOR, status: 'approved' },
    ]);
    expect(casWrite().data).toMatchObject({ status: 'withdrawn', pendingSubmittedAt: null });
    expect(mockBust).toHaveBeenCalledTimes(1);
  });

  it('withdrawing a pending item busts nothing; withdrawing nothing reports false', async () => {
    write.appSubListing.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await expect(
      withdrawSubListing({ appBlockId: 'apb_1', userId: AUTHOR, body: { itemKey: 'gen-1' } })
    ).resolves.toEqual({ ok: true, withdrawn: true });
    expect(mockBust).not.toHaveBeenCalled();
    write.appSubListing.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      withdrawSubListing({ appBlockId: 'apb_1', userId: AUTHOR, body: { itemKey: 'gen-1' } })
    ).resolves.toEqual({ ok: true, withdrawn: false });
    await expectError(
      withdrawSubListing({ appBlockId: 'apb_1', userId: null, body: { itemKey: 'gen-1' } }),
      401,
      'anonymous'
    );
  });

  it('mine lists only the caller’s rows for this parent, with the edit flag', async () => {
    read.appSubListing.findMany.mockResolvedValueOnce([
      {
        ...liveRow(),
        pendingSubmittedAt: new Date(),
        statusReason: null,
        editRejectionReason: null,
      },
    ]);
    const { items } = await listMySubListings({ appBlockId: 'apb_1', userId: AUTHOR });
    expect(items).toEqual([expect.objectContaining({ status: 'approved', pendingEdit: true })]);
    expect(read.appSubListing.findMany.mock.calls[0][0].where).toEqual({
      parentListingId: PARENT,
      authorUserId: AUTHOR,
    });
  });
});

describe('syncSubListingForSharedRow (in-app hooks)', () => {
  it('an author withdraw withdraws only their own active item for that key', async () => {
    await syncSubListingForSharedRow({
      appBlockId: 'apb_1',
      itemKey: 'gen-1',
      change: 'withdrawn',
      authorUserId: AUTHOR,
    });
    expect(casWrite(1).where).toEqual({
      parentListingId: PARENT,
      itemKey: 'gen-1',
      authorUserId: AUTHOR,
      status: 'pending',
    });
    expect(casWrite(1).data).toMatchObject({ status: 'withdrawn' });
    expect(mockBust).toHaveBeenCalled();
  });

  it('a withdraw with no author writes nothing (an undefined filter would match every author)', async () => {
    await syncSubListingForSharedRow({
      appBlockId: 'apb_1',
      itemKey: 'gen-1',
      change: 'withdrawn',
    });
    expect(write.appSubListing.updateMany).not.toHaveBeenCalled();
  });

  it('a moderator hide hides only an active item, recording the moderator', async () => {
    await syncSubListingForSharedRow({
      appBlockId: 'apb_1',
      itemKey: 'gen-1',
      change: 'hidden',
      moderatorId: 9,
    });
    const wheres = write.appSubListing.updateMany.mock.calls.map((c) => c[0].where.status);
    // An author-withdrawn item stays withdrawn, so a republish still returns it to review.
    expect(wheres).toEqual(['hidden', 'pending', 'approved']);
    expect(casWrite(1).data).toMatchObject({ status: 'hidden', moderatedById: 9 });
  });

  // A store-side restore reads the shared row, then compare-and-sets the hidden row. Moving the
  // hidden row's version here makes a restore that read the row just before this change fail.
  it.each(['hidden', 'withdrawn'] as const)(
    'an in-app %s moves the version of a store-hidden row without changing it',
    async (change) => {
      await syncSubListingForSharedRow({
        appBlockId: 'apb_1',
        itemKey: 'gen-1',
        change,
        authorUserId: AUTHOR,
      });
      const touch = casWrite(0);
      expect(touch.where).toMatchObject({
        parentListingId: PARENT,
        itemKey: 'gen-1',
        status: 'hidden',
      });
      expect(Object.keys(touch.data)).toEqual(['updatedAt']);
      expect(touch.data.updatedAt).toBeInstanceOf(Date);
    }
  );

  it.each([
    ['the version touch', 0],
    ['the hide transition', 1],
  ])('is best-effort: a failure in %s is logged, never thrown', async (_l, failingCall) => {
    let call = 0;
    write.appSubListing.updateMany.mockImplementation(async () => {
      if (call++ === failingCall) throw new Error('db down');
      return { count: 1 };
    });
    await expect(
      syncSubListingForSharedRow({ appBlockId: 'apb_1', itemKey: 'k', change: 'hidden' })
    ).resolves.toBeUndefined();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'app-sub-listing-shared-sync-failed' })
    );
  });

  it('a failed version touch does not stop the hide', async () => {
    write.appSubListing.updateMany.mockRejectedValueOnce(new Error('db down'));
    await syncSubListingForSharedRow({ appBlockId: 'apb_1', itemKey: 'gen-1', change: 'hidden' });
    const statuses = write.appSubListing.updateMany.mock.calls.map((c) => c[0].data.status);
    expect(statuses).toEqual([undefined, 'hidden', 'hidden']);
  });

  // Against a stateful updateMany fake: a restore that read the shared row as live, then lost
  // the race to an in-app hide, must fail its compare-and-set.
  it('a restore racing an in-app hide fails its compare-and-set', async () => {
    const hidden = liveRow({ status: 'hidden' });
    let version: Date = hidden.updatedAt;
    write.appSubListing.findUnique.mockResolvedValueOnce(hidden);
    write.appSubListing.updateMany.mockImplementation(
      async (args: {
        where: { status?: string; updatedAt?: { gte: Date; lt: Date } };
        data: { updatedAt?: Date };
      }) => {
        if (args.where.status !== 'hidden') return { count: 0 };
        const w = args.where.updatedAt;
        if (w && !(version >= w.gte && version < w.lt)) return { count: 0 };
        if (args.data.updatedAt) version = args.data.updatedAt;
        return { count: 1 };
      }
    );
    mockPoolQuery.mockImplementationOnce(async () => {
      await syncSubListingForSharedRow({ appBlockId: 'apb_1', itemKey: 'gen-1', change: 'hidden' });
      return { rows: [{ author_user_id: AUTHOR, hidden: false }] };
    });
    await expectError(
      moderateSubListing({
        input: { id: hidden.id, action: 'restore', version: VERSION },
        moderatorId: 9,
      }),
      409,
      'conflict'
    );
    // Positive control: the touch moved the version.
    expect(version.getTime()).not.toBe(hidden.updatedAt.getTime());
  });
});

describe('moderateSubListing', () => {
  const mod = (input: Record<string, unknown>) =>
    moderateSubListing({ input: { version: VERSION, ...input } as never, moderatorId: 9 });

  it('the compare-and-set window is exactly the millisecond the read saw', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow({ status: 'pending' }));
    await mod({ id: 'asl_x', action: 'approve' });
    expect(casWrite().where.updatedAt).toEqual({
      gte: new Date('2026-10-01T00:00:00.123Z'),
      lt: new Date('2026-10-01T00:00:00.124Z'),
    });
  });

  it('approves a pending item, stamps the moderator and busts the catalog', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow({ status: 'pending' }));
    await mod({ id: 'asl_x', action: 'approve' });
    const { where, data } = casWrite();
    expect(where).toEqual(unchangedSince(liveRow({ status: 'pending' })));
    expect(data).toMatchObject({ status: 'approved', moderatedById: 9 });
    expect(data.moderatedAt).toBeInstanceOf(Date);
    expect(data.approvedAt).toBeInstanceOf(Date);
    expect(mockBust).toHaveBeenCalledTimes(1);
  });

  it('refuses a decision made on a different version than the row now has', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow({ status: 'pending' }));
    await expectError(
      moderateSubListing({
        input: { id: 'asl_x', action: 'approve', version: '2026-10-03T00:00:00.000Z' },
        moderatorId: 9,
      }),
      409,
      'conflict'
    );
    expect(write.appSubListing.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['approve', { status: 'pending' }],
    ['hide', { status: 'approved' }],
    ['restore', { status: 'hidden' }],
    ['reject-edit', { pendingTitle: 'x', pendingSubPath: 'g/x', pendingSubmittedAt: new Date() }],
  ] as const)('%s is a compare-and-set on the row as read', async (action, state) => {
    const row = liveRow(state);
    write.appSubListing.findUnique.mockResolvedValueOnce(row);
    await mod({ id: 'asl_x', action, reason: 'r' });
    expect(casWrite().where).toEqual(unchangedSince(row));
  });

  it('hides with a reason; restore returns an approved-before item to the store', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow());
    await mod({ id: 'asl_x', action: 'hide', reason: 'spam' });
    expect(casWrite().data).toMatchObject({
      status: 'hidden',
      statusReason: 'spam',
      moderatedById: 9,
    });
    // The approved item left the cached page.
    expect(mockBust).toHaveBeenCalledTimes(1);
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow({ status: 'hidden' }));
    await mod({ id: 'asl_x', action: 'restore' });
    expect(casWrite(1).data).toMatchObject({ status: 'approved', statusReason: null });
  });

  it('restore sends a never-approved item back to review, not into the store', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(
      liveRow({ status: 'hidden', approvedAt: null })
    );
    await expect(mod({ id: 'asl_x', action: 'restore' })).resolves.toMatchObject({
      status: 'pending',
    });
    expect(casWrite().data).toMatchObject({ status: 'pending' });
    expect(mockBust).not.toHaveBeenCalled();
  });

  // The in-app moderation sync hides a store item when its shared row is hidden or deleted in
  // the app. A store-side restore must not put that card back while the app still hides it.
  it.each([
    ['hidden in the app', { rows: [{ author_user_id: AUTHOR, hidden: true }] }],
    ['deleted in the app', { rows: [] }],
  ])('restore is refused while the shared row is %s', async (_label, shared) => {
    write.appSubListing.findUnique.mockResolvedValueOnce(
      liveRow({ status: 'hidden', statusReason: 'Hidden in the app by a moderator' })
    );
    mockPoolQuery.mockResolvedValueOnce(shared);
    await expectError(mod({ id: 'asl_x', action: 'restore' }), 409, 'invalid_transition');
    expect(write.appSubListing.updateMany).not.toHaveBeenCalled();
    expect(mockBust).not.toHaveBeenCalled();
    expect(mockPoolQuery.mock.calls[0][0]).toContain('"app_custom_generators".shared_kv');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['gen-1']);
  });

  it('restore is refused when the app reused the key for another author’s item', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow({ status: 'hidden' }));
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ author_user_id: 7, hidden: false }] });
    await expectError(mod({ id: 'asl_x', action: 'restore' }), 409, 'invalid_transition');
    expect(write.appSubListing.updateMany).not.toHaveBeenCalled();
  });

  it('restore is refused when the parent listing has no backing block', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow({ status: 'hidden' }));
    read.appListing.findUnique.mockResolvedValueOnce({ appBlock: null });
    await expectError(mod({ id: 'asl_x', action: 'restore' }), 409, 'invalid_transition');
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(write.appSubListing.updateMany).not.toHaveBeenCalled();
  });

  it('restore is allowed once the shared row is live again (positive control)', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow({ status: 'hidden' }));
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ author_user_id: AUTHOR, hidden: false }] });
    await expect(mod({ id: 'asl_x', action: 'restore' })).resolves.toMatchObject({
      status: 'approved',
    });
  });

  it('restore fails closed when the app storage cannot be read', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow({ status: 'hidden' }));
    mockPoolQuery.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expectError(mod({ id: 'asl_x', action: 'restore' }), 503, 'unavailable');
    expect(write.appSubListing.updateMany).not.toHaveBeenCalled();
  });

  it('hiding a pending item, or rejecting an edit, busts nothing (no cached row moved)', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow({ status: 'pending' }));
    await mod({ id: 'asl_x', action: 'hide', reason: 'spam' });
    write.appSubListing.findUnique.mockResolvedValueOnce(
      liveRow({ pendingTitle: 'x', pendingSubPath: 'g/x', pendingSubmittedAt: new Date() })
    );
    await mod({ id: 'asl_x', action: 'reject-edit' });
    expect(write.appSubListing.updateMany).toHaveBeenCalledTimes(2);
    expect(mockBust).not.toHaveBeenCalled();
  });

  it('will not hide an author-withdrawn item (a later restore would republish it)', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow({ status: 'withdrawn' }));
    await expectError(mod({ id: 'asl_x', action: 'hide', reason: 'x' }), 409, 'invalid_transition');
    expect(write.appSubListing.updateMany).not.toHaveBeenCalled();
  });

  it('approve-edit copies the staged snapshot onto the live columns and clears it', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(
      liveRow({
        pendingTitle: 'Gen One v2',
        pendingTagline: null,
        pendingImageId: 9,
        pendingSubPath: 'g/TWO',
        pendingContentRating: 'pg13',
        pendingSubmittedAt: new Date(),
      })
    );
    await mod({ id: 'asl_x', action: 'approve-edit' });
    expect(casWrite().data).toMatchObject({
      title: 'Gen One v2',
      tagline: null,
      imageId: 9,
      subPath: 'g/TWO',
      contentRating: 'pg13',
      pendingTitle: null,
      pendingSubmittedAt: null,
      moderatedById: 9,
    });
    expect(mockBust).toHaveBeenCalledTimes(1);
  });

  it('reject-edit clears the staged edit, keeps the item approved and records the reason', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(
      liveRow({ pendingTitle: 'Nope', pendingSubPath: 'g/ONE', pendingSubmittedAt: new Date() })
    );
    await mod({ id: 'asl_x', action: 'reject-edit', reason: 'misleading' });
    const { data } = casWrite();
    expect(data).toMatchObject({ editRejectionReason: 'misleading', pendingTitle: null });
    expect(data).not.toHaveProperty('status');
  });

  it.each([
    ['approve', { status: 'approved' }],
    ['restore', { status: 'approved' }],
    ['hide', { status: 'hidden' }],
    ['approve-edit', { status: 'approved' }],
    ['reject-edit', { status: 'approved' }],
  ])('refuses %s from the wrong state', async (action, state) => {
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow(state));
    await expectError(mod({ id: 'asl_x', action }), 409, 'invalid_transition');
    expect(write.appSubListing.updateMany).not.toHaveBeenCalled();
  });

  it('loses cleanly to a concurrent change (compare-and-set)', async () => {
    write.appSubListing.findUnique.mockResolvedValueOnce(liveRow({ status: 'pending' }));
    write.appSubListing.updateMany.mockResolvedValueOnce({ count: 0 });
    await expectError(mod({ id: 'asl_x', action: 'approve' }), 409, 'conflict');
    expect(mockBust).not.toHaveBeenCalled();
  });

  it('a missing row is 404', async () => {
    await expectError(mod({ id: 'asl_x', action: 'approve' }), 404, 'not_found');
  });
});
