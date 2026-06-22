import { beforeEach, describe, expect, it, vi } from 'vitest';

// `getUnreadMessagesForUser` is the shared source for both the `chat.getUnreadCount`
// tRPC resolver AND the new `_app` SSR bootstrap seed. The seed value must be
// byte-identical to the resolver output (#2471 gotcha) or the primed client
// cache would mismatch and force the very bootstrap refetch we're cutting.
// We mock only the two DB reads and exercise the concat/shape contract.

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: h.queryRaw },
  dbWrite: {},
}));

// chat.service transitively imports `Prisma.validator<...>()(...)` selector
// files at module-eval; `Prisma.validator` isn't present in the SSR test
// transform of `@prisma/client`, so provide a pass-through (mirrors
// model3d-visible-id-for-post.test.ts). Unblocks the import chain without
// faking any logic this test exercises.
vi.mock('@prisma/client', () => ({
  Prisma: {
    validator: () => (x: unknown) => x,
    sql: () => ({}),
    join: () => ({}),
    raw: () => ({}),
    SortOrder: { asc: 'asc', desc: 'desc' },
  },
}));
vi.mock('unfurl.js', () => ({ unfurl: vi.fn() }));
vi.mock('linkifyjs', () => ({ find: vi.fn(() => []) }));
vi.mock('~/server/signals/wrapper', () => ({ withSignals: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedMessagePattern: vi.fn(),
}));
// Cut the heavy transitive import graph chat.service drags in at module-eval:
// `user.service` reaches `image.service` -> `event-engine-common/feeds` (a
// submodule outside src, unresolvable in the test transform), and
// `user-preferences.service` is unrelated to the unread-count query. Neither is
// used by `getUnreadMessagesForUser`, so stub them at the boundary.
vi.mock('~/server/services/user.service', () => ({ getUserSettings: vi.fn() }));
vi.mock('~/server/services/user-preferences.service', () => ({
  BlockedByUsers: { getCached: vi.fn() },
  BlockedUsers: { getCached: vi.fn() },
}));

const { getUnreadMessagesForUser } = await import('~/server/services/chat.service');

describe('getUnreadMessagesForUser (chat.getUnreadCount SSR-seed source)', () => {
  beforeEach(() => h.queryRaw.mockReset());

  it('returns the joined unread tallies concatenated with pending invites', async () => {
    // First call = unread (Joined), second = pending (Invited).
    h.queryRaw
      .mockResolvedValueOnce([{ chatId: 1, cnt: 3 }])
      .mockResolvedValueOnce([{ chatId: 9, cnt: 1 }]);

    const result = await getUnreadMessagesForUser({ userId: 42 });

    expect(h.queryRaw).toHaveBeenCalledTimes(2);
    // Byte-equality contract: the seed array shape == the resolver output —
    // `{ chatId, cnt }[]`, unread first then pending. A regression in either
    // query's ORDER or SHAPE breaks here.
    expect(result).toEqual([
      { chatId: 1, cnt: 3 },
      { chatId: 9, cnt: 1 },
    ]);
  });

  it('returns an empty array when the user has no unread or pending chats', async () => {
    h.queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const result = await getUnreadMessagesForUser({ userId: 7 });
    expect(result).toEqual([]);
  });
});
