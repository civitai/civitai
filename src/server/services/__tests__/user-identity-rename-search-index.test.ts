import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * A MODERATOR-FORCED RENAME HAS TO REACH USER SEARCH.
 *
 * Nothing else takes it there. The incremental user-index sync scans on `createdAt`, so it never
 * revisits an existing row, and the nightly reconciler only decides whether an id still belongs —
 * it never refreshes a field. Without an explicit enqueue here, user search keeps serving the
 * account's OLD name for as long as the document lives, which is how a renamed account goes on
 * being found under the name it was renamed away from.
 *
 * The self-serve profile save has always enqueued this. This is the moderator path.
 */

const { mockCacheRefresh, mockQueueUpdate, mockInvalidateSession, mockQueueOwnedContent } =
  vi.hoisted(() => ({
    mockCacheRefresh: vi.fn(async () => undefined),
    mockQueueUpdate: vi.fn(async () => undefined),
    mockInvalidateSession: vi.fn(async () => undefined),
    mockQueueOwnedContent: vi.fn(async () => undefined),
  }));

vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, userBasicCache: { refresh: mockCacheRefresh } };
});
vi.mock('~/server/search-index', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, usersSearchIndex: { queueUpdate: mockQueueUpdate } };
});
vi.mock('~/server/auth/session-invalidation', () => ({
  invalidateSession: mockInvalidateSession,
}));
vi.mock('~/server/search-index/user-content-reindex', () => ({
  queueOwnedContentUpdate: mockQueueOwnedContent,
}));

const { forceUpdateUserIdentity, updateUserById } = await import('~/server/services/user.service');

const USER_ID = 8317;

/** The moderator write goes to the PRIMARY. */
const userUpdate = dbMock.dbWrite.user.update;

beforeEach(() => {
  vi.clearAllMocks();
  userUpdate.mockResolvedValue({ id: USER_ID });
});

describe('forceUpdateUserIdentity -> user search index', () => {
  it('enqueues a search-index refresh when a moderator changes the username', async () => {
    await forceUpdateUserIdentity({ userId: USER_ID, username: 'renamed-by-a-moderator' });

    expect(mockQueueUpdate).toHaveBeenCalledTimes(1);
    const [items] = mockQueueUpdate.mock.calls[0] as unknown as [
      Array<{ id: number; action: string }>
    ];
    expect(items).toEqual([{ id: USER_ID, action: 'Update' }]);
  });

  it('enqueues a refresh when the display name changes', async () => {
    await forceUpdateUserIdentity({ userId: USER_ID, name: 'New Display Name' });

    expect(mockQueueUpdate).toHaveBeenCalledTimes(1);
  });

  /**
   * The negative half. Without it, a mutant that enqueues unconditionally passes both tests
   * above, and an email-only correction would churn the index for nothing.
   */
  it('does NOT enqueue when only the email changes — no searchable field moved', async () => {
    await forceUpdateUserIdentity({ userId: USER_ID, email: 'new@example.com' });

    expect(userUpdate).toHaveBeenCalledTimes(1);
    expect(mockQueueUpdate).not.toHaveBeenCalled();
  });

  /**
   * 🔴 A REDIS BLIP MUST NOT BREAK THE RENAME. `queueUpdate` is a Redis write and the rename has
   * already committed by the time it runs; unguarded, its rejection propagates BEFORE
   * `invalidateSession`, so the account is renamed and its old session stays live while the
   * moderator sees a 500. A stale search document is by far the smaller failure.
   */
  it('survives a failing search-index enqueue and still invalidates the session', async () => {
    mockQueueUpdate.mockRejectedValueOnce(new Error('redis is down'));

    await expect(
      forceUpdateUserIdentity({ userId: USER_ID, username: 'renamed-anyway' })
    ).resolves.toEqual({ updated: true, user: { id: USER_ID } });

    // The step that used to be skipped by the unguarded throw.
    expect(mockInvalidateSession).toHaveBeenCalledWith(USER_ID, 'moderation');
  });

  it('does nothing at all when there is nothing to change', async () => {
    await expect(forceUpdateUserIdentity({ userId: USER_ID })).resolves.toEqual({
      updated: false,
    });
    expect(userUpdate).not.toHaveBeenCalled();
    expect(mockQueueUpdate).not.toHaveBeenCalled();
  });
});

/**
 * Every model, article, collection, bounty and comic document embeds the owner's username, and
 * search filters and matches on it inside Meilisearch. A rename must re-queue them, or the old
 * name stays findable and the new one misses the older content.
 */
describe('a rename -> owned content documents', () => {
  it('a moderator rename re-queues the owned content', async () => {
    await forceUpdateUserIdentity({ userId: USER_ID, username: 'renamed-by-a-moderator' });

    expect(mockQueueOwnedContent).toHaveBeenCalledTimes(1);
    expect(mockQueueOwnedContent).toHaveBeenCalledWith(USER_ID);
  });

  it('a moderator save that resends the current username does not', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValueOnce({ username: 'unchanged' });

    await forceUpdateUserIdentity({ userId: USER_ID, username: 'unchanged', email: 'a@b.test' });

    expect(mockQueueOwnedContent).not.toHaveBeenCalled();
  });

  it('a moderator display-name change does not — content documents do not carry it', async () => {
    await forceUpdateUserIdentity({ userId: USER_ID, name: 'New Display Name' });

    expect(mockQueueOwnedContent).not.toHaveBeenCalled();
  });

  it('a profile save that changes the username re-queues the owned content', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValueOnce({ username: 'luisa_pinguin' });

    await updateUserById({ id: USER_ID, data: { username: 'luisa_caotica' } });

    expect(mockQueueOwnedContent).toHaveBeenCalledTimes(1);
    expect(mockQueueOwnedContent).toHaveBeenCalledWith(USER_ID);
  });

  /** The account form sends the username on every save; only a real rename is worth a scan. */
  it('a profile save that resends the same username does not', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValueOnce({ username: 'luisa_caotica' });

    await updateUserById({ id: USER_ID, data: { username: 'luisa_caotica' } });

    expect(mockQueueOwnedContent).not.toHaveBeenCalled();
  });
});
