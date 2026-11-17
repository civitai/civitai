import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import type * as SessionCache from '~/server/auth/session-cache';
import type * as SessionInvalidation from '~/server/auth/session-invalidation';
import type * as TosReacceptance from '~/server/services/tos-reacceptance.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { RESTRICTED_ACCOUNT_MESSAGE } from '~/server/common/content-restriction';

const { shouldOfferTosReacceptance } = vi.hoisted(() => ({
  shouldOfferTosReacceptance: vi.fn(async (_userId: number) => false),
}));
vi.mock('~/server/services/tos-reacceptance.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TosReacceptance>()),
  shouldOfferTosReacceptance,
}));
vi.mock('~/server/auth/session-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionCache>()),
  clearSessionCache: vi.fn(async () => undefined),
}));
vi.mock('~/server/auth/session-invalidation', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionInvalidation>()),
  refreshSession: vi.fn(async () => undefined),
  invalidateSession: vi.fn(async () => undefined),
}));
// A mute calls the orchestrator to cancel the account's generations; never from a test.
vi.mock('~/server/services/orchestrator/cancel-pending-workflows', () => ({
  cancelPendingWorkflows: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens: vi.fn(async () => true),
}));

import { assertAccountNotRestricted } from '~/server/services/account-restriction.service';
import {
  ACCOUNT_STANDING_REBUST_MS,
  afterAccountBanChanged,
  afterAccountStandingChanged,
} from '~/server/services/account-standing.service';
import { REDIS_KEYS } from '~/server/redis/client';

const USER = 42;
type Row = { muted: boolean; bannedAt: Date | null } | null;
const givenRow = (row: Row) => dbMock.dbWrite.user.findUnique.mockResolvedValue(row as never);
const reads = () => dbMock.dbWrite.user.findUnique.mock.calls.length;

/** What the assert answered: `'admitted'`, or the refusal's message and ToS flag. */
async function outcome(session?: { mutedAt?: Date | null }) {
  try {
    await assertAccountNotRestricted(USER, session);
    return 'admitted';
  } catch (e) {
    const err = e as { message: string; cause?: { tosReacceptRequired?: boolean } };
    return { message: err.message, tos: err.cause?.tosReacceptRequired === true };
  }
}
const REFUSED = { message: RESTRICTED_ACCOUNT_MESSAGE, tos: false };
const REFUSED_WITH_TOS = { message: RESTRICTED_ACCOUNT_MESSAGE, tos: true };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.user.findUnique.mockReset();
  shouldOfferTosReacceptance.mockResolvedValue(false);
  installFakeCacheRedis();
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('assertAccountNotRestricted reads the standing cache', () => {
  it('serves a repeat check from the cache, not the primary', async () => {
    givenRow({ muted: false, bannedAt: null });
    expect(await outcome()).toBe('admitted');
    expect(await outcome()).toBe('admitted');
    expect(reads()).toBe(1);
  });

  it('refuses a mute at once after the change is announced, over a warm cache', async () => {
    givenRow({ muted: false, bannedAt: null });
    expect(await outcome()).toBe('admitted');
    givenRow({ muted: true, bannedAt: null });
    await afterAccountStandingChanged(USER, { kind: 'invalidate', caller: 'moderation' });
    expect(await outcome()).toEqual(REFUSED);
  });

  it('refuses a ban at once after the ban is announced, over a warm cache', async () => {
    givenRow({ muted: false, bannedAt: null });
    expect(await outcome()).toBe('admitted');
    givenRow({ muted: false, bannedAt: new Date() });
    await afterAccountBanChanged(USER);
    expect(await outcome()).toEqual(REFUSED);
  });

  it('busts a ban again after the rebust delay, past a refill that read the row before it', async () => {
    givenRow({ muted: false, bannedAt: null });
    await afterAccountBanChanged(USER);
    // The racing refill: written after the first bust, from a read taken before the ban.
    expect(await outcome()).toBe('admitted');
    givenRow({ muted: false, bannedAt: new Date() });
    await vi.advanceTimersByTimeAsync(ACCOUNT_STANDING_REBUST_MS);
    expect(await outcome()).toEqual(REFUSED);
  });

  it('refuses a banned account and a missing row', async () => {
    givenRow({ muted: false, bannedAt: new Date() });
    expect(await outcome()).toEqual(REFUSED);
    await afterAccountBanChanged(USER);
    givenRow(null);
    expect(await outcome()).toEqual(REFUSED);
  });

  it('refuses, never admits, when neither the cache nor the primary answers', async () => {
    redisMock.redis.packed.get.mockRejectedValue(new Error('cache down'));
    dbMock.dbWrite.user.findUnique.mockRejectedValue(new Error('db down'));
    await expect(assertAccountNotRestricted(USER)).rejects.toThrow('db down');
  });

  // A pod from before the standing object writes a bare `muted` boolean under the same key.
  it.each([
    ['admits a good account', { muted: false, bannedAt: null }, 'admitted'],
    ['refuses a banned one', { muted: false, bannedAt: new Date() }, REFUSED],
  ] as const)('over an old boolean entry, reads the primary: %s', async (_, row, expected) => {
    await redisMock.redis.packed.set(
      `${REDIS_KEYS.CACHES.ACCOUNT_STANDING}:${USER}` as never,
      { data: false, cachedAt: Date.now() } as never
    );
    givenRow(row);
    expect(await outcome()).toEqual(expected);
  });
});

describe('assertAccountNotRestricted offers the Terms like the mute guard', () => {
  it('offers them to a muted account the Terms would release, when given the session', async () => {
    shouldOfferTosReacceptance.mockResolvedValue(true);
    givenRow({ muted: true, bannedAt: null });
    expect(await outcome({ mutedAt: null })).toEqual(REFUSED_WITH_TOS);
  });

  it('does not offer them for a moderator’s mute, a ban, or a caller without a session', async () => {
    shouldOfferTosReacceptance.mockResolvedValue(true);
    givenRow({ muted: true, bannedAt: null });
    expect(await outcome({ mutedAt: new Date() })).toEqual(REFUSED);
    expect(await outcome()).toEqual(REFUSED);
    await afterAccountBanChanged(USER);
    givenRow({ muted: true, bannedAt: new Date() });
    expect(await outcome({ mutedAt: null })).toEqual(REFUSED);
  });

  it('still refuses, without the offer, when the offer lookup fails', async () => {
    shouldOfferTosReacceptance.mockRejectedValue(new Error('replica down'));
    givenRow({ muted: true, bannedAt: null });
    expect(await outcome({ mutedAt: null })).toEqual(REFUSED);
  });
});
