import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import type * as LegalHold from '~/server/services/legal-hold.service';
import type * as Revocation from '~/server/services/user-token-revocation.service';
import type * as ApiKeyService from '~/server/services/api-key.service';

// A ban and an unban must reach the account-standing cache, or block submits and comic generation
// keep answering from the standing cached before it.

const { revokeUserTokens, forgetGenerationToken } = vi.hoisted(() => ({
  revokeUserTokens: vi.fn(),
  forgetGenerationToken: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/api-key.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyService>()),
  forgetGenerationToken,
}));
vi.mock('~/server/services/user-token-revocation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Revocation>()),
  revokeUserTokens,
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

const { toggleBan } = await import('~/server/services/user.service');
const { assertAccountNotRestricted } = await import(
  '~/server/services/account-restriction.service'
);

const USER = 4242;
const account = (bannedAt: Date | null) => ({
  id: USER,
  bannedAt,
  muted: false,
  meta: {},
  username: 'someone',
  email: 'someone@example.test',
});
// `toggleBan` reads the account from the replica; the standing reads the primary.
const given = (bannedAt: Date | null) => {
  dbMock.dbRead.user.findUnique.mockResolvedValue(account(bannedAt) as never);
  dbMock.dbWrite.user.findUnique.mockResolvedValue(account(bannedAt) as never);
};
const check = () =>
  assertAccountNotRestricted(USER).then(
    () => 'admitted',
    () => 'refused'
  );

beforeEach(() => {
  vi.clearAllMocks();
  installFakeCacheRedis();
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  revokeUserTokens.mockResolvedValue(true);
  for (const model of ['userLink', 'model', 'post', 'article'] as const) {
    dbMock.dbWrite[model].deleteMany?.mockResolvedValue({ count: 0 } as never);
    dbMock.dbWrite[model].updateMany?.mockResolvedValue({ count: 0 } as never);
  }
  dbMock.dbWrite.user.update.mockResolvedValue(account(new Date()) as never);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('a ban reaches the cached account standing', () => {
  it('a ban is refused on the next check, over a warm cache', async () => {
    given(null);
    expect(await check()).toBe('admitted');
    await toggleBan({ id: USER, userId: 1, isModerator: true } as never);
    given(new Date());
    expect(await check()).toBe('refused');
  });

  it('an unban is admitted on the next check, over a warm cache', async () => {
    given(new Date());
    expect(await check()).toBe('refused');
    await toggleBan({ id: USER, userId: 1, isModerator: true } as never);
    given(null);
    expect(await check()).toBe('admitted');
  });
});
