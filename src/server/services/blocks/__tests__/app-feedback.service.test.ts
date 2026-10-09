import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { BlocklistType } from '~/server/common/enums';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as BlockCheck from '~/server/services/block-check.service';
import type * as ListingVisibility from '~/server/services/blocks/app-listing-visibility.service';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as FeedbackService from '~/server/services/feedback.service';
import type * as NotificationService from '~/server/services/notification.service';
import type { SessionUser } from '~/types/session';

/**
 * Private per-app feedback — the server half.
 *
 * The real `resolveListingAccess` runs against the canonical db mock, so the shadow→seat hop, the
 * kind-aware owner and the accepted-seat lookup are exercised rather than stubbed. Fixture ids and
 * user ids are pairwise distinct, and the stale denormalized `AppListing.userId` (7777) is a value
 * no real participant has, so a gate that read it instead of the canonical owner would show.
 */

const mocks = vi.hoisted(() => ({
  isFeedbackAreaEnabled: vi.fn(),
  resolveStoreVisibilityScope: vi.fn(),
  throwIfBlockedByOwners: vi.fn(),
  throwOnBlockedCommentContent: vi.fn(),
  readListingVisibility: vi.fn(),
  readListingVisibilityMany: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('~/server/services/feedback.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeedbackService>()),
  isFeedbackAreaEnabled: mocks.isFeedbackAreaEnabled,
}));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  resolveStoreVisibilityScope: mocks.resolveStoreVisibilityScope,
}));
vi.mock('~/server/services/block-check.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockCheck>()),
  throwIfBlockedByOwners: mocks.throwIfBlockedByOwners,
}));
vi.mock('~/server/services/blocks/app-listing-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ListingVisibility>()),
  readListingVisibility: mocks.readListingVisibility,
  readListingVisibilityMany: mocks.readListingVisibilityMany,
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mocks.createNotification,
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  throwOnBlockedCommentContent: mocks.throwOnBlockedCommentContent,
}));

const {
  APP_FEEDBACK_CAP_MESSAGE,
  APP_FEEDBACK_NO_ACCESS_MESSAGE,
  APP_FEEDBACK_NOT_FOUND_MESSAGE,
  APP_FEEDBACK_SELF_MESSAGE,
  APP_FEEDBACK_STALE_MESSAGE,
  countNewAppFeedbackForMyListings,
  createAppFeedback,
  flagAppFeedbackAbusive,
  getAppFeedbackEligibility,
  listAppFeedbackForListing,
  modCountFlaggedAppFeedback,
  modListAppFeedback,
  modListConditions,
  modSetAppFeedbackHidden,
  resolveAppFeedbackTarget,
  setAppFeedbackOwnerStatus,
  toOwnerFeedbackDto,
} = await import('../app-feedback.service');

const REPORTER = 1001;
const OWNER = 2002;
const EDITOR = 3003;
const OFFSITE_OWNER = 4004;
const OFFSITE_BLOCK_APP_OWNER = 5005;
const MODERATOR = 6006;
const STALE_DENORM_OWNER = 7777;

const PARENT = 'apl_parent';
const SHADOW = 'apl_shadow';
const OFFSITE = 'apl_offsite';

type AccessRow = {
  id: string;
  userId: number;
  slug: string;
  kind: string;
  appBlockId: string | null;
  revisionOfId: string | null;
  appBlock: { app: { userId: number } } | null;
  revisionOf: unknown;
};

const PARENT_ACCESS: AccessRow = {
  id: PARENT,
  userId: STALE_DENORM_OWNER,
  slug: 'cool-app',
  kind: 'onsite',
  appBlockId: 'blk_parent',
  revisionOfId: null,
  appBlock: { app: { userId: OWNER } },
  revisionOf: null,
};

const ACCESS: Record<string, AccessRow> = {
  [PARENT]: PARENT_ACCESS,
  [SHADOW]: {
    id: SHADOW,
    userId: STALE_DENORM_OWNER,
    slug: 'rev-01hzz',
    kind: 'onsite',
    appBlockId: null,
    revisionOfId: PARENT,
    appBlock: null,
    revisionOf: {
      id: PARENT,
      slug: 'cool-app',
      userId: STALE_DENORM_OWNER,
      kind: 'onsite',
      appBlockId: 'blk_parent',
      appBlock: { app: { userId: OWNER } },
    },
  },
  // The `mapAppBlockToListing` shape: off-site WITH a backing block whose app owner is someone else.
  [OFFSITE]: {
    id: OFFSITE,
    userId: OFFSITE_OWNER,
    slug: 'far-away',
    kind: 'offsite',
    appBlockId: 'blk_offsite',
    revisionOfId: null,
    appBlock: { app: { userId: OFFSITE_BLOCK_APP_OWNER } },
    revisionOf: null,
  },
};

type StatusRow = {
  status: string;
  name: string;
  appBlock: { version: string; currentVersionSha: string | null } | null;
};
let STATUS: Record<string, StatusRow>;
let SLUGS: Record<string, { id: string; revisionOfId: string | null }>;
let BLOCK_LISTING: Record<string, string>;
let SEATS: Array<{ appListingId: string; userId: number; status: string }>;

function freshFixtures() {
  STATUS = {
    [PARENT]: {
      status: 'approved',
      name: 'Cool App',
      appBlock: { version: '1.4.2', currentVersionSha: 'sha-parent-91c' },
    },
    [SHADOW]: { status: 'draft', name: 'Cool App (draft)', appBlock: null },
    [OFFSITE]: {
      status: 'approved',
      name: 'Far Away',
      appBlock: { version: '9.9.9', currentVersionSha: 'sha-offsite-zz' },
    },
  };
  SLUGS = {
    'cool-app': { id: PARENT, revisionOfId: null },
    'rev-01hzz': { id: SHADOW, revisionOfId: PARENT },
    'far-away': { id: OFFSITE, revisionOfId: null },
  };
  BLOCK_LISTING = { blk_parent: PARENT };
  SEATS = [{ appListingId: PARENT, userId: EDITOR, status: 'accepted' }];
}

function installDb() {
  const findUnique = async (args: {
    where: Record<string, string>;
    select: Record<string, unknown>;
  }) => {
    if (args.where.appBlockId !== undefined) {
      const id = BLOCK_LISTING[args.where.appBlockId];
      return id ? { id } : null;
    }
    if (args.select.revisionOf) return ACCESS[args.where.id] ?? null;
    return STATUS[args.where.id] ?? null;
  };
  const findFirstListing = async (args: { where: { slug: string; revisionOfId?: null } }) => {
    const row = SLUGS[args.where.slug];
    if (!row) return null;
    if ('revisionOfId' in args.where && row.revisionOfId !== args.where.revisionOfId) return null;
    return { id: row.id };
  };
  const findSeat = async (args: {
    where: { appListingId: string; userId: number; status: string };
  }) =>
    SEATS.find(
      (s) =>
        s.appListingId === args.where.appListingId &&
        s.userId === args.where.userId &&
        s.status === args.where.status
    )
      ? { userId: args.where.userId }
      : null;
  for (const db of [dbMock.dbRead, dbMock.dbWrite]) {
    db.appListing.findUnique.mockImplementation(findUnique);
    db.appListing.findFirst.mockImplementation(findFirstListing);
    db.appCollaborator.findFirst.mockImplementation(findSeat);
  }
}

const user = (id: number, extra: Partial<SessionUser> = {}) =>
  ({ id, username: `u${id}`, isModerator: false, muted: false, ...extra } as SessionUser);

beforeEach(() => {
  vi.clearAllMocks();
  freshFixtures();
  installDb();
  mocks.isFeedbackAreaEnabled.mockResolvedValue(true);
  mocks.resolveStoreVisibilityScope.mockResolvedValue('full');
  mocks.throwIfBlockedByOwners.mockResolvedValue(undefined);
  mocks.throwOnBlockedCommentContent.mockResolvedValue(undefined);
  mocks.readListingVisibility.mockResolvedValue({ available: true, visibility: null });
  mocks.readListingVisibilityMany.mockResolvedValue(new Map());
  dbMock.dbWrite.feedback.count.mockResolvedValue(0);
  dbMock.dbWrite.feedback.create.mockResolvedValue({ id: 555 });
  dbMock.dbWrite.feedback.updateMany.mockResolvedValue({ count: 1 });
  mocks.createNotification.mockResolvedValue(undefined);
});

const page = { slug: 'cool-app' };

describe('resolveAppFeedbackTarget', () => {
  it('admits a stranger on an approved listing and stamps the running version', async () => {
    expect(await resolveAppFeedbackTarget(user(REPORTER), page)).toEqual({
      ok: true,
      target: {
        appListingId: PARENT,
        appName: 'Cool App',
        appBlockVersion: '1.4.2',
        appBlockSha: 'sha-parent-91c',
      },
    });
  });

  it('resolves the slot surface by AppBlock id to the same listing', async () => {
    const res = await resolveAppFeedbackTarget(user(REPORTER), { appBlockId: 'blk_parent' });
    expect(res).toMatchObject({ ok: true, target: { appListingId: PARENT } });
  });

  it('refuses a muted user', async () => {
    expect(await resolveAppFeedbackTarget(user(REPORTER, { muted: true }), page)).toEqual({
      ok: false,
      reason: 'muted',
    });
  });

  it('refuses while the area flag is off for this user, asking with the full user', async () => {
    mocks.isFeedbackAreaEnabled.mockResolvedValue(false);
    const reporter = user(REPORTER);
    expect(await resolveAppFeedbackTarget(reporter, page)).toEqual({
      ok: false,
      reason: 'flag_off',
    });
    expect(mocks.isFeedbackAreaEnabled).toHaveBeenCalledWith({ area: 'app-block', user: reporter });
  });

  it('refuses an unknown slug and an AppBlock with no listing', async () => {
    expect(await resolveAppFeedbackTarget(user(REPORTER), { slug: 'nope' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await resolveAppFeedbackTarget(user(REPORTER), { appBlockId: 'blk_none' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('never resolves a shadow revision by its synthetic slug', async () => {
    expect(await resolveAppFeedbackTarget(user(REPORTER), { slug: 'rev-01hzz' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('a target that lands on a shadow is stored under its PARENT (seat) listing', async () => {
    BLOCK_LISTING.blk_parent = SHADOW;
    const res = await resolveAppFeedbackTarget(user(REPORTER), { appBlockId: 'blk_parent' });
    expect(res).toEqual({
      ok: true,
      target: {
        appListingId: PARENT,
        appName: 'Cool App',
        appBlockVersion: '1.4.2',
        appBlockSha: 'sha-parent-91c',
      },
    });
  });

  it('refuses an on-site app to a viewer whose store scope admits off-site only', async () => {
    mocks.resolveStoreVisibilityScope.mockResolvedValue('public-external');
    expect(await resolveAppFeedbackTarget(user(REPORTER), page)).toEqual({
      ok: false,
      reason: 'scope',
    });
    // Control: the same scope admits an off-site listing.
    expect(await resolveAppFeedbackTarget(user(REPORTER), { slug: 'far-away' })).toMatchObject({
      ok: true,
    });
  });

  it('fails closed on an absent or unrecognised scope — even for an off-site listing', async () => {
    for (const raw of [undefined, 'superuser']) {
      mocks.resolveStoreVisibilityScope.mockResolvedValue(raw);
      for (const target of [page, { slug: 'far-away' }])
        expect(await resolveAppFeedbackTarget(user(REPORTER), target)).toEqual({
          ok: false,
          reason: 'scope',
        });
    }
  });

  it('refuses the canonical owner, not whoever the stale listing column names', async () => {
    expect(await resolveAppFeedbackTarget(user(OWNER), page)).toEqual({
      ok: false,
      reason: 'self',
    });
    expect(await resolveAppFeedbackTarget(user(STALE_DENORM_OWNER), page)).toMatchObject({
      ok: true,
    });
  });

  it('refuses an accepted editor, but not a pending invitee', async () => {
    expect(await resolveAppFeedbackTarget(user(EDITOR), page)).toEqual({
      ok: false,
      reason: 'self',
    });
    SEATS = [{ appListingId: PARENT, userId: EDITOR, status: 'pending' }];
    expect(await resolveAppFeedbackTarget(user(EDITOR), page)).toMatchObject({ ok: true });
  });

  // 🔴 OPERATOR DECISION (2026-10-08), not an oversight: an APPROVED app whose per-listing
  // visibility level hides it from the store (unlisted / tester-only / moderators) is still
  // runnable by slug, and its runners may send feedback. A visibility gate added to the resolver
  // reads these levels and fails here.
  it.each(['private', 'testers', 'moderators'] as const)(
    'admits a stranger on an approved listing whose visibility is %s (non-public visibility)',
    async (visibility) => {
      const read = { available: true, visibility };
      mocks.readListingVisibility.mockResolvedValue(read);
      mocks.readListingVisibilityMany.mockResolvedValue(new Map([[PARENT, read]]));
      const res = await resolveAppFeedbackTarget(user(REPORTER), page);
      expect(res).toEqual({
        ok: true,
        target: {
          appListingId: PARENT,
          appName: 'Cool App',
          appBlockVersion: '1.4.2',
          appBlockSha: 'sha-parent-91c',
        },
      });
    }
  );

  it('refuses a listing that is not approved', async () => {
    STATUS[PARENT] = { ...STATUS[PARENT], status: 'removed' };
    expect(await resolveAppFeedbackTarget(user(REPORTER), page)).toEqual({
      ok: false,
      reason: 'not_approved',
    });
  });

  it('refuses a reporter the owner has blocked, checking the canonical owner', async () => {
    mocks.throwIfBlockedByOwners.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND' }));
    expect(await resolveAppFeedbackTarget(user(REPORTER), page)).toEqual({
      ok: false,
      reason: 'blocked',
    });
    expect(mocks.throwIfBlockedByOwners).toHaveBeenCalledWith({
      userId: REPORTER,
      ownerIds: [OWNER],
      isModerator: false,
    });
  });

  it('does not swallow an unexpected error from the block check', async () => {
    mocks.throwIfBlockedByOwners.mockRejectedValue(new Error('db down'));
    await expect(resolveAppFeedbackTarget(user(REPORTER), page)).rejects.toThrow('db down');
  });

  it('resolves an off-site owner from the listing column and stamps no version', async () => {
    expect(await resolveAppFeedbackTarget(user(OFFSITE_OWNER), { slug: 'far-away' })).toEqual({
      ok: false,
      reason: 'self',
    });
    expect(await resolveAppFeedbackTarget(user(REPORTER), { slug: 'far-away' })).toEqual({
      ok: true,
      target: {
        appListingId: OFFSITE,
        appName: 'Far Away',
        appBlockVersion: null,
        appBlockSha: null,
      },
    });
  });
});

describe('getAppFeedbackEligibility', () => {
  it('says only "not eligible" on a refusal, never why', async () => {
    mocks.throwIfBlockedByOwners.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND' }));
    expect(await getAppFeedbackEligibility(user(REPORTER), page)).toEqual({ eligible: false });
  });

  it('returns what the modal shows', async () => {
    expect(await getAppFeedbackEligibility(user(REPORTER), page)).toEqual({
      eligible: true,
      appListingId: PARENT,
      appName: 'Cool App',
      appBlockVersion: '1.4.2',
    });
  });
});

describe('createAppFeedback', () => {
  const input = {
    target: page,
    message: 'the export button does nothing',
    context: { surface: 'page' as const, modelId: 4242 },
  };

  it('inserts against the seat listing with server-stamped version, returning only the id', async () => {
    await createAppFeedback({ user: user(REPORTER), input });
    expect(dbMock.dbWrite.feedback.create).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.feedback.create.mock.calls[0][0]).toEqual({
      data: {
        userId: REPORTER,
        area: 'app-block',
        message: 'the export button does nothing',
        context: { surface: 'page', modelId: 4242 },
        appListingId: PARENT,
        appBlockVersion: '1.4.2',
        appBlockSha: 'sha-parent-91c',
      },
      select: { id: true },
    });
  });

  it('omits modelId when the client sent none', async () => {
    await createAppFeedback({
      user: user(REPORTER),
      input: { ...input, context: { surface: 'slot' } },
    });
    expect(dbMock.dbWrite.feedback.create.mock.calls[0][0].data.context).toEqual({
      surface: 'slot',
    });
  });

  it('maps a hidden-kind refusal to the same NOT_FOUND as a missing app', async () => {
    mocks.resolveStoreVisibilityScope.mockResolvedValue('public-external');
    await expect(createAppFeedback({ user: user(REPORTER), input })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: APP_FEEDBACK_NOT_FOUND_MESSAGE,
    });
    expect(dbMock.dbWrite.feedback.create).not.toHaveBeenCalled();
  });

  it('refuses the owner with FORBIDDEN', async () => {
    await expect(createAppFeedback({ user: user(OWNER), input })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: APP_FEEDBACK_SELF_MESSAGE,
    });
    expect(dbMock.dbWrite.feedback.create).not.toHaveBeenCalled();
  });

  it('runs the comment content check on the message, exempting moderators like comments do', async () => {
    await createAppFeedback({ user: user(MODERATOR, { isModerator: true }), input });
    expect(mocks.throwOnBlockedCommentContent).toHaveBeenCalledWith(
      'the export button does nothing',
      expect.objectContaining({ isModerator: true })
    );
  });

  /**
   * The REAL shared filter, driven through its redis-backed lists, so the seam between it and
   * feedback's `onBlocked` wording is exercised end to end — a stub here could pass while the
   * filter never calls the hook. The domain, the pattern and the URLs are pairwise distinct, and
   * none appears in either feedback message constant.
   */
  describe('content filter refusals (real filter)', () => {
    const BLOCKED_DOMAIN = 'blocked-host.example';
    const PATTERN = 'verify your wallet';

    beforeEach(async () => {
      const actual = await vi.importActual<typeof Blocklist>('~/server/services/blocklist.service');
      mocks.throwOnBlockedCommentContent.mockImplementation(actual.throwOnBlockedCommentContent);
      redisMock.redis.get.mockImplementation(async (key: string) => {
        if (key.endsWith(`:${BlocklistType.LinkDomain}`))
          return JSON.stringify({ type: BlocklistType.LinkDomain, data: [BLOCKED_DOMAIN] });
        if (key.endsWith(`:${BlocklistType.MessagePattern}`))
          return JSON.stringify({ type: BlocklistType.MessagePattern, data: [PATTERN] });
        return null;
      });
    });
    afterEach(() => {
      redisMock.redis.get.mockImplementation(async () => null);
    });

    const submit = (message: string, extra: Partial<SessionUser> = {}) =>
      createAppFeedback({ user: user(REPORTER, extra), input: { ...input, message } }).catch(
        (e) => e
      );

    const expectNothingWritten = () => {
      expect(dbMock.dbWrite.feedback.count).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.feedback.create).not.toHaveBeenCalled();
    };

    it('admits clean text (the control the refusals are measured against)', async () => {
      expect(await submit('the export button does nothing')).toEqual({ id: 555 });
    });

    it('names every blocked URL on a link hit, in feedback wording', async () => {
      const err = await submit(
        'see https://blocked-host.example/a and //blocked-host.example/b but https://fine.example/c'
      );
      expect(err).toBeInstanceOf(TRPCError);
      expect(err.code).toBe('BAD_REQUEST');
      expect(err.message).toBe(
        'Your feedback links to a site that is not allowed: https://blocked-host.example/a, //blocked-host.example/b. Remove the link and try again.'
      );
      expect(err.message).not.toMatch(/comment|invalid urls/i);
      expect(err.message).not.toContain('fine.example');
      expectNothingWritten();
    });

    it('gives a pattern hit the generic message and never echoes the matched term', async () => {
      const err = await submit('please Verify Your Wallet now');
      expect(err).toBeInstanceOf(TRPCError);
      expect(err.code).toBe('BAD_REQUEST');
      expect(err.message).toBe(
        'Your feedback includes a link or wording that is not allowed. Remove it and try again.'
      );
      expect(err.message.toLowerCase()).not.toContain(PATTERN);
      expect(err.message).not.toMatch(/comment|invalid urls/i);
      expectNothingWritten();
    });

    it('exempts a moderator from both lists, as on comments', async () => {
      expect(
        await submit('verify your wallet at https://blocked-host.example/a', { isModerator: true })
      ).toEqual({ id: 555 });
    });
  });

  it('lets a non-refusal failure inside the content check propagate untouched', async () => {
    const boom = new Error('pattern cache unavailable');
    mocks.throwOnBlockedCommentContent.mockRejectedValue(boom);
    await expect(createAppFeedback({ user: user(REPORTER), input })).rejects.toBe(boom);
    expect(dbMock.dbWrite.feedback.create).not.toHaveBeenCalled();
  });

  it('caps a user at 3 reports per listing per 24h', async () => {
    dbMock.dbWrite.feedback.count.mockResolvedValue(3);
    await expect(createAppFeedback({ user: user(REPORTER), input })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: APP_FEEDBACK_CAP_MESSAGE,
    });
    expect(dbMock.dbWrite.feedback.create).not.toHaveBeenCalled();
  });

  it('admits the third report and counts only this user, this area, this listing, the last day', async () => {
    dbMock.dbWrite.feedback.count.mockResolvedValue(2);
    const before = Date.now();
    await createAppFeedback({ user: user(REPORTER), input });
    expect(dbMock.dbWrite.feedback.create).toHaveBeenCalledTimes(1);
    const where = dbMock.dbWrite.feedback.count.mock.calls[0][0].where;
    expect(Object.keys(where).sort()).toEqual(['appListingId', 'area', 'createdAt', 'userId']);
    expect(where).toMatchObject({ userId: REPORTER, area: 'app-block', appListingId: PARENT });
    const since = (where.createdAt.gt as Date).getTime();
    // `since` is taken after `before`, so it sits in [before - 24h, before - 24h + slack].
    expect(since - (before - 24 * 3600 * 1000)).toBeGreaterThanOrEqual(0);
    expect(since - (before - 24 * 3600 * 1000)).toBeLessThan(60_000);
  });
});

/** Collapse whitespace so a query's text can be compared literally. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const lastQuery = () => dbMock.dbRead.$queryRaw.mock.calls.at(-1)![0] as Prisma.Sql;

const FORBIDDEN_SENTINELS = {
  context: { surface: 'page', modelId: 918273, consoleErrors: ['SENTINEL_CONSOLE'] },
  status: 'SENTINEL_MOD_STATUS',
  triageNote: 'SENTINEL_TRIAGE_NOTE',
  handledById: 828282,
  handledAt: new Date('2001-02-03T04:05:06Z'),
  bugId: 737373,
  hiddenFromOwnerAt: new Date('2002-03-04T05:06:07Z'),
  userId: 515151,
  area: 'SENTINEL_AREA',
  appListingId: 'SENTINEL_LISTING',
};

const ownerRow = {
  id: 901,
  message: 'love it, but the grid jumps',
  createdAt: new Date('2026-10-01T10:00:00Z'),
  appBlockVersion: '1.4.2',
  appBlockSha: 'sha-row-77',
  surface: 'slot',
  ownerStatus: 'acknowledged',
  ownerStatusAt: new Date('2026-10-02T11:00:00Z'),
  ownerFlaggedAt: null,
  reporterId: REPORTER,
  reporterUsername: 'reporter-name',
};

describe('the owner projection', () => {
  it('has exactly the owner-visible keys', () => {
    const dto = toOwnerFeedbackDto(ownerRow);
    expect(Object.keys(dto).sort()).toEqual(
      [
        'appBlockSha',
        'appBlockVersion',
        'createdAt',
        'id',
        'message',
        'ownerFlaggedAt',
        'ownerStatus',
        'ownerStatusAt',
        'reporter',
        'surface',
      ].sort()
    );
    expect(dto.reporter).toEqual({ id: REPORTER, username: 'reporter-name' });
    expect(dto.surface).toBe('slot');
  });

  it('carries none of the moderator-only or client-claim values, even if a row held them', () => {
    const dto = toOwnerFeedbackDto({ ...ownerRow, ...FORBIDDEN_SENTINELS } as never);
    const serialized = JSON.stringify(dto);
    // Positive control: the serialisation does carry the row's own values.
    expect(serialized).toContain('love it, but the grid jumps');
    for (const value of [
      'SENTINEL_CONSOLE',
      '918273',
      'SENTINEL_MOD_STATUS',
      'SENTINEL_TRIAGE_NOTE',
      '828282',
      '2001-02-03',
      '737373',
      '2002-03-04',
      '515151',
      'SENTINEL_AREA',
      'SENTINEL_LISTING',
    ]) {
      expect(serialized).not.toContain(value);
    }
  });

  it('drops a surface outside the closed set', () => {
    expect(toOwnerFeedbackDto({ ...ownerRow, surface: 'javascript:alert(1)' }).surface).toBeNull();
  });
});

describe('listAppFeedbackForListing', () => {
  const input = { appListingId: PARENT, limit: 50 };

  it('refuses a stranger and a pending invitee with the same error as a missing listing', async () => {
    for (const [uid, id] of [
      [REPORTER, PARENT],
      [OWNER, 'apl_missing'],
    ] as const) {
      await expect(
        listAppFeedbackForListing({ userId: uid, input: { ...input, appListingId: id } })
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: APP_FEEDBACK_NO_ACCESS_MESSAGE });
    }
    SEATS = [{ appListingId: PARENT, userId: EDITOR, status: 'pending' }];
    await expect(listAppFeedbackForListing({ userId: EDITOR, input })).rejects.toMatchObject({
      message: APP_FEEDBACK_NO_ACCESS_MESSAGE,
    });
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('admits the owner and an accepted editor', async () => {
    await listAppFeedbackForListing({ userId: OWNER, input });
    await listAppFeedbackForListing({ userId: EDITOR, input });
    expect(dbMock.dbRead.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('selects exactly the owner columns — never context as a whole', async () => {
    await listAppFeedbackForListing({ userId: OWNER, input });
    const select = norm(lastQuery().sql).match(/^SELECT (.*?) FROM "Feedback" f/)![1];
    expect(select.split(', ')).toEqual([
      'f.id',
      'f.message',
      'f."createdAt"',
      'f."appBlockVersion"',
      'f."appBlockSha"',
      "f.context->>'surface' AS surface",
      'f."ownerStatus"',
      'f."ownerStatusAt"',
      'f."ownerFlaggedAt"',
      'u.id AS "reporterId"',
      'u.username AS "reporterUsername"',
    ]);
  });

  it('filters out hidden rows and banned reporters in the WHERE, keyed on the seat listing', async () => {
    await listAppFeedbackForListing({ userId: OWNER, input: { ...input, appListingId: SHADOW } });
    const q = lastQuery();
    const where = norm(q.sql).match(/WHERE (.*?) ORDER BY/)![1];
    expect(where).toBe(
      `f.area = 'app-block' AND f."hiddenFromOwnerAt" IS NULL AND u."bannedAt" IS NULL AND f."appListingId" IN (?)`
    );
    expect(norm(q.sql)).toMatch(/ORDER BY f\."createdAt" DESC, f\.id DESC LIMIT \?$/);
    expect(q.values.slice(0, 1)).toEqual([PARENT]);
  });

  it('maps the owner-status filter, `new` meaning NULL', async () => {
    await listAppFeedbackForListing({ userId: OWNER, input: { ...input, ownerStatus: 'new' } });
    expect(norm(lastQuery().sql)).toContain('AND f."ownerStatus" IS NULL ORDER BY');
    await listAppFeedbackForListing({
      userId: OWNER,
      input: { ...input, appListingId: SHADOW, ownerStatus: 'wont_fix', cursor: 77 },
    });
    expect(norm(lastQuery().sql)).toContain(
      'AND f."ownerStatus" = ? AND (f."createdAt", f.id) < (SELECT c."createdAt", c.id FROM "Feedback" c WHERE c.id = ? AND c.area = ? AND c."appListingId" = ?) ORDER BY'
    );
    expect(lastQuery().values).toEqual([PARENT, 'wont_fix', 77, 'app-block', PARENT, 51]);
  });

  it('pages with one look-ahead row', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([
      { ...ownerRow, id: 30 },
      { ...ownerRow, id: 20 },
      { ...ownerRow, id: 10 },
    ]);
    const res = await listAppFeedbackForListing({ userId: OWNER, input: { ...input, limit: 2 } });
    expect(res.items.map((i) => i.id)).toEqual([30, 20]);
    expect(res.nextCursor).toBe(20);
  });

  it('a full last page has no next cursor', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([
      { ...ownerRow, id: 30 },
      { ...ownerRow, id: 20 },
    ]);
    const res = await listAppFeedbackForListing({ userId: OWNER, input: { ...input, limit: 2 } });
    expect(res.items.map((i) => i.id)).toEqual([30, 20]);
    expect(res.nextCursor).toBeUndefined();
  });
});

describe('owner writes', () => {
  const statusInput = {
    id: 901,
    appListingId: SHADOW,
    ownerStatus: 'resolved' as const,
    expectedOwnerStatus: null,
  };

  it('setOwnerStatus writes ONLY the owner-status columns', async () => {
    await setAppFeedbackOwnerStatus({ userId: EDITOR, input: statusInput });
    const { data } = dbMock.dbWrite.feedback.updateMany.mock.calls[0][0];
    expect(Object.keys(data).sort()).toEqual(['ownerStatus', 'ownerStatusAt', 'ownerStatusById']);
    expect(data.ownerStatus).toBe('resolved');
    expect(data.ownerStatusById).toBe(EDITOR);
    expect(data.ownerStatusAt).toBeInstanceOf(Date);
  });

  it('setOwnerStatus is scoped on the seat listing, visibility and the expected status', async () => {
    await setAppFeedbackOwnerStatus({
      userId: OWNER,
      input: { ...statusInput, expectedOwnerStatus: 'acknowledged' },
    });
    expect(dbMock.dbWrite.feedback.updateMany.mock.calls[0][0].where).toEqual({
      area: 'app-block',
      appListingId: PARENT,
      hiddenFromOwnerAt: null,
      user: { bannedAt: null },
      id: 901,
      ownerStatus: 'acknowledged',
    });
  });

  it('treats 0 rows as a refusal', async () => {
    dbMock.dbWrite.feedback.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      setAppFeedbackOwnerStatus({ userId: OWNER, input: statusInput })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: APP_FEEDBACK_STALE_MESSAGE });
  });

  it('resolves write access on the primary, and refuses a stranger before writing', async () => {
    await expect(
      setAppFeedbackOwnerStatus({ userId: REPORTER, input: statusInput })
    ).rejects.toMatchObject({ message: APP_FEEDBACK_NO_ACCESS_MESSAGE });
    expect(dbMock.dbWrite.feedback.updateMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appListing.findUnique).toHaveBeenCalled();
    expect(dbMock.dbRead.appListing.findUnique).not.toHaveBeenCalled();
  });

  it('a seat revoked on the primary refuses the write even if the replica still has it', async () => {
    dbMock.dbRead.appCollaborator.findFirst.mockImplementation(async () => ({ userId: EDITOR }));
    dbMock.dbWrite.appCollaborator.findFirst.mockImplementation(async () => null);
    await expect(
      setAppFeedbackOwnerStatus({ userId: EDITOR, input: statusInput })
    ).rejects.toMatchObject({ message: APP_FEEDBACK_NO_ACCESS_MESSAGE });
    expect(dbMock.dbWrite.feedback.updateMany).not.toHaveBeenCalled();
  });

  it('flagAbusive writes ONLY ownerFlaggedAt, once', async () => {
    await flagAppFeedbackAbusive({ userId: EDITOR, input: { id: 901, appListingId: PARENT } });
    const { data, where } = dbMock.dbWrite.feedback.updateMany.mock.calls[0][0];
    expect(Object.keys(data)).toEqual(['ownerFlaggedAt']);
    expect(data.ownerFlaggedAt).toBeInstanceOf(Date);
    expect(where).toEqual({
      area: 'app-block',
      appListingId: PARENT,
      hiddenFromOwnerAt: null,
      user: { bannedAt: null },
      id: 901,
      ownerFlaggedAt: null,
    });
  });

  it('flagAbusive treats 0 rows as a refusal and refuses a stranger', async () => {
    dbMock.dbWrite.feedback.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      flagAppFeedbackAbusive({ userId: OWNER, input: { id: 901, appListingId: PARENT } })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      flagAppFeedbackAbusive({ userId: REPORTER, input: { id: 901, appListingId: PARENT } })
    ).rejects.toMatchObject({ message: APP_FEEDBACK_NO_ACCESS_MESSAGE });
  });
});

describe('reporter notification on an owner status change', () => {
  const REPORTER_ROW = { userId: REPORTER, appListing: { name: 'Cool App', slug: 'cool-app' } };
  const set = (ownerStatus: 'acknowledged' | 'resolved' | 'wont_fix') =>
    setAppFeedbackOwnerStatus({
      userId: EDITOR,
      input: { id: 901, appListingId: SHADOW, ownerStatus, expectedOwnerStatus: null },
    });

  beforeEach(() => {
    dbMock.dbWrite.feedback.findFirst.mockResolvedValue(REPORTER_ROW);
  });

  it('resolved → one notification to the reporter, keyed per (feedback, status) — literal', async () => {
    await expect(set('resolved')).resolves.toEqual({ id: 901, ownerStatus: 'resolved' });
    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
    expect(mocks.createNotification).toHaveBeenCalledWith({
      userId: REPORTER,
      category: 'Update',
      type: 'app-feedback-status',
      key: 'app-feedback-status:901:resolved',
      details: {
        feedbackId: 901,
        ownerStatus: 'resolved',
        appName: 'Cool App',
        appSlug: 'cool-app',
      },
    });
  });

  it("wont_fix → its own key, so it is not swallowed by an earlier 'resolved'", async () => {
    await set('wont_fix');
    expect(mocks.createNotification.mock.calls[0][0].key).toBe('app-feedback-status:901:wont_fix');
  });

  it('🔴 acknowledged sends nothing — and does not even look the reporter up', async () => {
    await expect(set('acknowledged')).resolves.toEqual({ id: 901, ownerStatus: 'acknowledged' });
    expect(dbMock.dbWrite.feedback.findFirst).not.toHaveBeenCalled();
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('🔴 re-reads the reporter on the primary under the owner-visibility predicate and the new status', async () => {
    // The seat listing (the editor wrote via the SHADOW id), not hidden, reporter not banned, and
    // still at the status just written. A moderator who hid the row since — or another writer who
    // moved its status on — makes this read come back empty.
    await set('resolved');
    expect(dbMock.dbWrite.feedback.findFirst).toHaveBeenCalledWith({
      where: {
        area: 'app-block',
        appListingId: PARENT,
        hiddenFromOwnerAt: null,
        user: { bannedAt: null },
        id: 901,
        ownerStatus: 'resolved',
      },
      select: { userId: true, appListing: { select: { name: true, slug: true } } },
    });
    expect(dbMock.dbRead.feedback.findFirst).not.toHaveBeenCalled();
  });

  it('🔴 a row hidden from the developer sends nothing', async () => {
    // The visibility predicate is what hides it, so the re-read finds no row.
    dbMock.dbWrite.feedback.findFirst.mockResolvedValue(null);
    await expect(set('resolved')).resolves.toEqual({ id: 901, ownerStatus: 'resolved' });
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('a refused write (0 rows — e.g. already hidden) sends nothing', async () => {
    dbMock.dbWrite.feedback.updateMany.mockResolvedValue({ count: 0 });
    await expect(set('resolved')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(dbMock.dbWrite.feedback.findFirst).not.toHaveBeenCalled();
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('a failure to notify never fails the committed status change, and is logged', async () => {
    loggingMock.logToAxiom.mockClear();
    dbMock.dbWrite.feedback.findFirst.mockRejectedValue(new Error('primary blip'));
    await expect(set('resolved')).resolves.toEqual({ id: 901, ownerStatus: 'resolved' });
    dbMock.dbWrite.feedback.findFirst.mockResolvedValue(REPORTER_ROW);
    mocks.createNotification.mockRejectedValue(new Error('notifications down'));
    await expect(set('wont_fix')).resolves.toEqual({ id: 901, ownerStatus: 'wont_fix' });
    const logged = loggingMock.logToAxiom.mock.calls
      .map(([entry]) => entry as { name?: string; details?: unknown; message?: string })
      .filter((entry) => entry.name === 'app-feedback-status-notify-failed');
    expect(logged).toEqual([
      expect.objectContaining({
        details: { feedbackId: 901, ownerStatus: 'resolved' },
        message: 'primary blip',
      }),
      expect.objectContaining({
        details: { feedbackId: 901, ownerStatus: 'wont_fix' },
        message: 'notifications down',
      }),
    ]);
  });
});

describe('countNewAppFeedbackForMyListings', () => {
  it('runs no query for a user with no listings', async () => {
    expect(await countNewAppFeedbackForMyListings(REPORTER)).toEqual({});
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('counts new, visible rows per listing the user owns or edits', async () => {
    dbMock.dbRead.appListing.findMany.mockResolvedValueOnce([{ id: PARENT }]);
    dbMock.dbRead.appCollaborator.findMany.mockResolvedValueOnce([{ appListingId: OFFSITE }]);
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([
      { appListingId: PARENT, count: 4 },
      { appListingId: OFFSITE, count: 1 },
    ]);
    expect(await countNewAppFeedbackForMyListings(OWNER)).toEqual({ [PARENT]: 4, [OFFSITE]: 1 });
    const q = lastQuery();
    expect(norm(q.sql).match(/WHERE (.*) GROUP BY/)![1]).toBe(
      `f.area = 'app-block' AND f."hiddenFromOwnerAt" IS NULL AND u."bannedAt" IS NULL AND f."appListingId" IN (?,?) AND f."ownerStatus" IS NULL`
    );
    expect(q.values).toEqual([PARENT, OFFSITE]);
  });
});

describe('moderator procedures', () => {
  const where = (input: Parameters<typeof modListConditions>[0]) =>
    modListConditions(input).map((s) => norm(s.sql));

  it('builds each filter, AND-ed onto the area', () => {
    expect(where({ hidden: 'all' })).toEqual(['f.area = ?']);
    expect(where({ hidden: 'all', listingDeleted: true })).toEqual([
      'f.area = ?',
      'f."appListingId" IS NULL',
    ]);
    expect(where({ hidden: 'all', appListingId: PARENT })).toEqual([
      'f.area = ?',
      'f."appListingId" = ?',
    ]);
    expect(where({ hidden: 'all', ownerStatus: 'new' })).toEqual([
      'f.area = ?',
      'f."ownerStatus" IS NULL',
    ]);
    expect(where({ hidden: 'all', flagged: true })).toEqual([
      'f.area = ?',
      'f."ownerFlaggedAt" IS NOT NULL',
    ]);
    expect(where({ hidden: 'hidden' })).toEqual([
      'f.area = ?',
      'f."hiddenFromOwnerAt" IS NOT NULL',
    ]);
    expect(where({ hidden: 'visible' })).toEqual(['f.area = ?', 'f."hiddenFromOwnerAt" IS NULL']);
    expect(
      where({ hidden: 'visible', appListingId: PARENT, ownerStatus: 'resolved', flagged: true })
    ).toEqual([
      'f.area = ?',
      'f."appListingId" = ?',
      'f."ownerStatus" = ?',
      'f."ownerFlaggedAt" IS NOT NULL',
      'f."hiddenFromOwnerAt" IS NULL',
    ]);
  });

  it('modCountFlagged counts flagged rows no moderator has hidden', async () => {
    await modCountFlaggedAppFeedback();
    expect(dbMock.dbRead.feedback.count).toHaveBeenCalledWith({
      where: { area: 'app-block', ownerFlaggedAt: { not: null }, hiddenFromOwnerAt: null },
    });
  });

  /** A transaction client distinct from `dbWrite`, so a write that escapes the tx shows. */
  const txStub = (count: number) => {
    const tx = {
      feedback: { updateMany: vi.fn(async () => ({ count })) },
      $executeRaw: vi.fn(async () => 1),
    };
    dbMock.dbWrite.$transaction.mockImplementationOnce(async (fn: (t: typeof tx) => unknown) =>
      fn(tx)
    );
    return tx;
  };

  it('hide writes ONLY the hidden column, scoped on "not hidden", and audits inside the tx', async () => {
    const tx = txStub(1);
    await modSetAppFeedbackHidden({ moderatorId: MODERATOR, input: { id: 901, hidden: true } });
    const { where, data } = tx.feedback.updateMany.mock.calls[0][0] as never as {
      where: unknown;
      data: Record<string, unknown>;
    };
    expect(where).toEqual({ id: 901, area: 'app-block', hiddenFromOwnerAt: null });
    expect(Object.keys(data)).toEqual(['hiddenFromOwnerAt']);
    expect(data.hiddenFromOwnerAt).toBeInstanceOf(Date);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect((tx.$executeRaw.mock.calls[0] as unknown[]).slice(1)).toEqual([
      MODERATOR,
      'feedback',
      'hideFromOwner',
      [901],
    ]);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.feedback.updateMany).not.toHaveBeenCalled();
  });

  it('unhide clears the hidden column, scoped on "hidden"', async () => {
    const tx = txStub(1);
    await modSetAppFeedbackHidden({ moderatorId: MODERATOR, input: { id: 901, hidden: false } });
    const { where, data } = tx.feedback.updateMany.mock.calls[0][0] as never as {
      where: unknown;
      data: unknown;
    };
    expect(where).toEqual({ id: 901, area: 'app-block', hiddenFromOwnerAt: { not: null } });
    expect(data).toEqual({ hiddenFromOwnerAt: null });
    expect((tx.$executeRaw.mock.calls[0] as unknown[]).slice(1)).toEqual([
      MODERATOR,
      'feedback',
      'unhideFromOwner',
      [901],
    ]);
  });

  it('treats 0 rows as a refusal and writes no audit row', async () => {
    const tx = txStub(0);
    await expect(
      modSetAppFeedbackHidden({ moderatorId: MODERATOR, input: { id: 901, hidden: true } })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: APP_FEEDBACK_STALE_MESSAGE });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  const modRow = {
    id: 801,
    message: 'the bridge drops my uploads',
    createdAt: new Date('2026-10-03T00:00:00Z'),
    status: 'new',
    triageNote: null,
    appListingId: PARENT,
    reporterId: REPORTER,
  };

  it('modList sanitises context, drops the raw column, and pages with a look-ahead', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([
      { ...modRow, context: { surface: 'page', modelId: 31337, smuggled: 'x' } },
      { ...modRow, id: 702, context: { surface: 'javascript:alert(1)', modelId: 1.5 } },
      { ...modRow, id: 603, context: null },
    ]);
    const res = await modListAppFeedback({ limit: 2, hidden: 'all', cursor: 999 });
    expect(res.items).toEqual([
      { ...modRow, surface: 'page', modelId: 31337 },
      { ...modRow, id: 702, surface: null, modelId: null },
    ]);
    expect(res.nextCursor).toBe(702);
    const q = lastQuery();
    expect(norm(q.sql)).toMatch(
      /WHERE f\.area = \? AND \(f\."createdAt", f\.id\) < \(SELECT c\."createdAt", c\.id FROM "Feedback" c WHERE c\.id = \? AND c\.area = \?\) ORDER BY f\."createdAt" DESC, f\.id DESC LIMIT \?$/
    );
    expect(q.values).toEqual(['app-block', 999, 'app-block', 3]);
    // Who hid a row comes only from the audit log, and only while it is hidden.
    expect(norm(q.sql)).toContain(
      'LEFT JOIN LATERAL ( SELECT ma."userId" FROM "ModActivity" ma WHERE ma."entityType" = \'feedback\' AND ma."entityId" = f.id AND ma.activity = \'hideFromOwner\' AND f."hiddenFromOwnerAt" IS NOT NULL ORDER BY ma."createdAt" DESC, ma.id DESC LIMIT 1 ) hid ON true LEFT JOIN "User" h ON h.id = hid."userId"'
    );
  });

  it('modList: a full last page has no next cursor', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([{ ...modRow, context: {} }]);
    expect((await modListAppFeedback({ limit: 1, hidden: 'all' })).nextCursor).toBeUndefined();
  });
});
