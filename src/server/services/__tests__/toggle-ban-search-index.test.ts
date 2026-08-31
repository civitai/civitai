import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * BANNING REMOVES AN ACCOUNT FROM USER SEARCH — SO LIFTING A BAN HAS TO PUT IT BACK.
 *
 * Nothing else would. The incremental user-index sync scans on `createdAt`, so it never revisits
 * an existing row, and the nightly reconciler only ever deletes. Without an explicit enqueue on
 * the unban branch the exclusion is a ONE-WAY DOOR: the account is restored everywhere except
 * search, indefinitely, and no signal says so.
 */

const {
  mockQueueUpdate,
  mockRemoveContent,
  mockInvalidateSession,
  mockCacheRefresh,
  mockSettingsBust,
  mockSendModerationEmail,
} = vi.hoisted(() => ({
  mockQueueUpdate: vi.fn(async () => undefined),
  mockRemoveContent: vi.fn(async () => undefined),
  mockInvalidateSession: vi.fn(async () => undefined),
  mockCacheRefresh: vi.fn(async () => undefined),
  mockSettingsBust: vi.fn(async () => undefined),
  mockSendModerationEmail: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('~/server/email/templates', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, moderationActionEmail: { send: mockSendModerationEmail } };
});

vi.mock('~/server/search-index', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, usersSearchIndex: { queueUpdate: mockQueueUpdate } };
});
vi.mock('~/server/meilisearch/util', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, removeUserContentFromSearchIndex: mockRemoveContent };
});
vi.mock('~/server/auth/session-invalidation', () => ({
  invalidateSession: mockInvalidateSession,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    userBasicCache: { refresh: mockCacheRefresh },
    userSettingsCache: () => ({ bust: mockSettingsBust }),
  };
});
vi.mock('~/server/services/subscriptions.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    cancelSubscription: vi.fn(async () => undefined),
    reinstateSubscription: vi.fn(async () => undefined),
  };
});

const { toggleBan } = await import('~/server/services/user.service');
const { BanReasonCode } = await import('~/server/common/enums');

const USER_ID = 5501;
const ACTOR_ID = 5502;
const ALREADY_BANNED_AT = new Date('2026-01-02T03:04:05.000Z');

// `getUserById` reads the REPLICA; `updateUserById` writes the PRIMARY. Named separately so a
// write cannot satisfy a read assertion.
const userFindUnique = dbMock.dbRead.user.findUnique;
const userUpdate = dbMock.dbWrite.user.update;
const userFindFirst = dbMock.dbWrite.user.findFirst;
// The ban branch fans out to these and chains `.catch` on each; the canonical mock has no
// default for a write verb, so an undeclared one returns `undefined` and the fan-out throws.
const userLinkDeleteMany = dbMock.dbWrite.userLink.deleteMany;
const imageUpdateMany = dbMock.dbWrite.image.updateMany;
const commentUpdateMany = dbMock.dbWrite.comment.updateMany;
const commentV2UpdateMany = dbMock.dbWrite.commentV2.updateMany;

const call = () =>
  toggleBan({
    id: USER_ID,
    reasonCode: BanReasonCode.Other,
    userId: ACTOR_ID,
    isModerator: true,
  } as Parameters<typeof toggleBan>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  userUpdate.mockResolvedValue({ id: USER_ID, paddleCustomerId: null });
  userFindFirst.mockResolvedValue(null);
  userLinkDeleteMany.mockResolvedValue({ count: 0 });
  imageUpdateMany.mockResolvedValue({ count: 0 });
  commentUpdateMany.mockResolvedValue({ count: 0 });
  commentV2UpdateMany.mockResolvedValue({ count: 0 });
});

describe('toggleBan -> user search index', () => {
  it('UNBANNING puts the account back in user search', async () => {
    // An account that is currently banned — so this call is the LIFT.
    userFindUnique.mockResolvedValue({
      bannedAt: ALREADY_BANNED_AT,
      meta: {},
      username: 'someone',
      email: null,
    });

    await call();

    expect(mockQueueUpdate).toHaveBeenCalledTimes(1);
    const [items] = mockQueueUpdate.mock.calls[0] as unknown as [
      Array<{ id: number; action: string }>
    ];
    expect(items).toEqual([{ id: USER_ID, action: 'Update' }]);
  });

  /**
   * 🔴 A REDIS BLIP MUST NOT BREAK THE UNBAN. `queueUpdate` is a Redis write placed AFTER the
   * unban has committed and BEFORE the `account-unbanned` email; unguarded, its rejection
   * propagates and the user is never told their ban was lifted, while the moderator sees a 500
   * for an action that in fact succeeded.
   */
  it('survives a failing search-index enqueue and still sends the unban email', async () => {
    userFindUnique.mockResolvedValue({
      bannedAt: ALREADY_BANNED_AT,
      meta: {},
      username: 'someone',
      email: 'someone@example.com',
    });
    mockQueueUpdate.mockRejectedValueOnce(new Error('redis is down'));

    await expect(call()).resolves.toEqual({ id: USER_ID, paddleCustomerId: null });

    expect(mockSendModerationEmail).toHaveBeenCalledTimes(1);
    expect(mockSendModerationEmail.mock.calls[0]?.[0]).toMatchObject({
      kind: 'account-unbanned',
      to: 'someone@example.com',
    });
  });

  /**
   * The other arm. Banning must NOT enqueue a refresh — a refresh would re-write the very
   * document the ban is removing. Removal goes through the content-removal path instead, which
   * is asserted here so "nothing happened" cannot pass for "the right thing happened".
   */
  it('BANNING removes instead — no refresh enqueued', async () => {
    userFindUnique.mockResolvedValue({
      bannedAt: null,
      meta: {},
      username: 'someone',
      email: null,
    });

    await call();

    expect(mockRemoveContent).toHaveBeenCalledTimes(1);
    expect(mockRemoveContent).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }));
    expect(mockQueueUpdate).not.toHaveBeenCalled();
  });
});

/**
 * A ban can flag the account's comments in both tables — the ToS flag, not `hidden`; see
 * `commentsv2.service.ts` for why the flag is what removes a comment and `hidden` is not.
 */
describe('toggleBan -> removeComments', () => {
  const ban = (removeComments?: boolean) =>
    toggleBan({
      id: USER_ID,
      reasonCode: BanReasonCode.Other,
      userId: ACTOR_ID,
      isModerator: true,
      removeComments,
    } as Parameters<typeof toggleBan>[0]);

  beforeEach(() => {
    userFindUnique.mockResolvedValue({
      bannedAt: null,
      meta: {},
      username: 'someone',
      email: null,
    });
  });

  it('flags both comment tables when asked, and does not touch the author-owned hide', async () => {
    await ban(true);

    for (const updateMany of [commentUpdateMany, commentV2UpdateMany]) {
      expect(updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, tosViolation: false },
        data: { tosViolation: true },
      });
    }
  });

  it('leaves comments alone otherwise — it is opt-in, like removeMedia', async () => {
    await ban();

    expect(commentUpdateMany).not.toHaveBeenCalled();
    expect(commentV2UpdateMany).not.toHaveBeenCalled();
  });
});
