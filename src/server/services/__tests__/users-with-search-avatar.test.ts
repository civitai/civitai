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
  it('serves no avatar, rather than the unrated legacy image, when there is no profile picture', async () => {
    const user = await hitFor({ image: 'unrated.png' });
    expect(user.avatarUrl).toBeUndefined();
    expect(user).not.toHaveProperty('image');
    expect(mockSearch.mock.calls.at(-1)?.[1].attributesToRetrieve).not.toContain('image');
  });

  it("carries the profile picture's own rating (control)", async () => {
    const user = await hitFor({
      image: 'unrated.png',
      profilePicture: { url: 'avatar.png', nsfwLevel: NsfwLevel.R },
    });
    expect(user).toMatchObject({ avatarUrl: 'avatar.png', avatarNsfw: NsfwLevel.R });
  });
});
