import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two gates in front of the account-level dismissal store, neither of which fails loudly.
 *
 * `.default({})` is the one that matters: the client calls the query with no argument, so without
 * it every signed-in user's request is rejected by zod and the cross-device merge simply never
 * happens — no error on screen, no 5xx, and the device store still works.
 */

import type * as MiddlewareTrpc from '~/server/middleware.trpc';

const { mockDismiss, mockGetDismissed } = vi.hoisted(() => ({
  mockDismiss: vi.fn(),
  mockGetDismissed: vi.fn(),
}));

// The router imports the whole announcement surface; the rest of it is not under test and pulls
// in Prisma, Redis and the image services on import.
vi.mock('~/server/services/announcement.service', () => ({
  dismissAnnouncementsForUser: (...args: unknown[]) => mockDismiss(...args),
  getDismissedAnnouncementIds: (...args: unknown[]) => mockGetDismissed(...args),
}));
vi.mock('~/server/services/creator-announcement.service', () => ({}));
// Only `rateLimit` is stubbed, and only because it reaches Redis. `applyRequestDomainColor` is
// left REAL, since whether the domain is stamped is one of the things under test.
vi.mock('~/server/middleware.trpc', async (importOriginal) => {
  const { middleware } = await import('~/server/trpc');
  return {
    ...(await importOriginal<typeof MiddlewareTrpc>()),
    rateLimit: () => middleware(async ({ next }) => next()),
  };
});

import { announcementRouter } from '../announcement.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { DomainColor } from '~/shared/utils/prisma/enums';

function callerFor(user: { id: number } | undefined) {
  return announcementRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDismissed.mockResolvedValue([]);
});

describe('announcement dismissal procedures', () => {
  /**
   * 🔴 The client calls this with no argument. Dropping `.default({})` leaves zod nothing to
   * parse and nothing for `applyRequestDomainColor` to stamp — see the comment on that
   * middleware, which states the same requirement from the other side.
   */
  it('accepts the query with no input at all', async () => {
    await expect(callerFor({ id: 7 }).getDismissedAnnouncements()).resolves.toEqual([]);
  });

  /**
   * The domain is stamped from the request host, never taken from the caller. Asserted by sending
   * one and watching it be overwritten — the host here resolves to no color, so what the service
   * must NOT see is the caller's value.
   */
  it('overwrites a caller-supplied domain', async () => {
    await callerFor({ id: 7 }).getDismissedAnnouncements({ domain: DomainColor.red });

    expect(mockGetDismissed).toHaveBeenCalledWith({ userId: 7, domain: undefined });
  });

  it('takes the user from the session on the write path', async () => {
    await callerFor({ id: 7 }).dismissAnnouncements({ ids: [1, 2] });

    expect(mockDismiss).toHaveBeenCalledWith({ userId: 7, ids: [1, 2] });
  });

  it('refuses both procedures without a session', async () => {
    await expect(callerFor(undefined).getDismissedAnnouncements()).rejects.toThrow('UNAUTHORIZED');
    await expect(callerFor(undefined).dismissAnnouncements({ ids: [1] })).rejects.toThrow(
      'UNAUTHORIZED'
    );
    expect(mockGetDismissed).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('rejects a dismissal list longer than one request allows', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);

    await expect(callerFor({ id: 7 }).dismissAnnouncements({ ids })).rejects.toThrow();
    expect(mockDismiss).not.toHaveBeenCalled();
  });
});
