import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as LegalHold from '~/server/services/legal-hold.service';
import type * as Revocation from '~/server/services/user-token-revocation.service';

// A banned or deleted author's stories stop showing, so their story sparks are forfeited; an
// unban gives them back.

const { onStorySparkPostsHidden, onStorySparkPostsRestored } = vi.hoisted(() => ({
  onStorySparkPostsHidden: vi.fn(),
  onStorySparkPostsRestored: vi.fn(),
}));
vi.mock('~/server/events/points/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  onStorySparkPostsHidden,
  onStorySparkPostsRestored,
}));
vi.mock('~/server/services/user-token-revocation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Revocation>()),
  revokeUserTokens: vi.fn(async () => true),
}));
vi.mock('~/server/services/legal-hold.service', async (importOriginal) => ({
  ...(await importOriginal<typeof LegalHold>()),
  assertAccountNotUnderLegalHold: vi.fn(async () => ({ legs: [], markerView: false })),
}));

// event-engine-common is a git submodule and is not checked out by default; user.service's graph
// reaches it.
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

const { deleteUser, toggleBan } = await import('~/server/services/user.service');

const USER = 4242;
const account = (bannedAt: Date | null) => ({
  id: USER,
  bannedAt,
  meta: {},
  username: 'someone',
  email: 'someone@example.test',
});

beforeEach(() => {
  vi.clearAllMocks();
  onStorySparkPostsHidden.mockResolvedValue(undefined);
  for (const model of ['userLink', 'model', 'comment', 'commentV2', 'post', 'article'] as const) {
    dbMock.dbWrite[model].deleteMany?.mockResolvedValue({ count: 0 } as never);
    dbMock.dbWrite[model].updateMany?.mockResolvedValue({ count: 0 } as never);
  }
  dbMock.dbWrite.user.update.mockResolvedValue(account(new Date()) as never);
});

describe('toggleBan', () => {
  it("a ban forfeits the author's story sparks", async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(account(null) as never);
    dbMock.dbWrite.user.findUnique.mockResolvedValue(account(null) as never);
    await toggleBan({ id: USER, userId: 1, isModerator: true } as never);
    expect(onStorySparkPostsHidden).toHaveBeenCalledExactlyOnceWith({ authorId: USER });
    expect(onStorySparkPostsRestored).not.toHaveBeenCalled();
  });

  it("an unban gives the author's story sparks back and forfeits nothing", async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(account(new Date()) as never);
    dbMock.dbWrite.user.findUnique.mockResolvedValue(account(new Date()) as never);
    await toggleBan({ id: USER, userId: 1, isModerator: true } as never);
    expect(onStorySparkPostsRestored).toHaveBeenCalledExactlyOnceWith({ authorId: USER });
    expect(onStorySparkPostsHidden).not.toHaveBeenCalled();
  });
});

describe('deleteUser', () => {
  it("forfeits the author's story sparks, and waits for it", async () => {
    dbMock.dbWrite.user.findFirst.mockResolvedValue(account(null) as never);
    dbMock.dbWrite.$transaction.mockResolvedValue([] as never);
    let finish: () => void = () => undefined;
    onStorySparkPostsHidden.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    let settled = false;
    const deletion = deleteUser({
      id: USER,
      username: 'someone',
      removeModels: false,
    } as never).then(() => (settled = true));
    await vi.waitFor(() => expect(onStorySparkPostsHidden).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    finish();
    await deletion;
    expect(onStorySparkPostsHidden).toHaveBeenCalledExactlyOnceWith({ authorId: USER });
  });
});
