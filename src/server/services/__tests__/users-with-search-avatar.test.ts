import { describe, expect, it, vi } from 'vitest';
import type * as MeiliClient from '~/server/meilisearch/client';
import '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';

const { mockSearch } = vi.hoisted(() => ({ mockSearch: vi.fn() }));

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  searchClient: { index: () => ({ search: mockSearch }) },
  withMeili: (_op: string, fn: () => unknown) => fn(),
}));

import { getUsersWithSearch } from '~/server/services/user.service';

async function hitFor(hit: Record<string, unknown>) {
  mockSearch.mockResolvedValue({ hits: [{ id: 1, username: 'a', ...hit }] });
  const [user] = await getUsersWithSearch({ query: 'a', limit: 10 } as never);
  return user;
}

describe('getUsersWithSearch avatar rating', () => {
  it('rates the unrated image fallback 0, not PG', async () => {
    const user = await hitFor({ image: 'unrated.png' });
    expect(user.avatarUrl).toBe('unrated.png');
    expect(user.avatarNsfw).toBe(0);
  });

  it("carries the profile picture's own rating (control)", async () => {
    const user = await hitFor({
      image: 'unrated.png',
      profilePicture: { url: 'avatar.png', nsfwLevel: NsfwLevel.R },
    });
    expect(user).toMatchObject({ avatarUrl: 'avatar.png', avatarNsfw: NsfwLevel.R });
  });
});
