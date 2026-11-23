import { describe, expect, it } from 'vitest';
import { transformData } from '~/server/search-index/users.search-index';

type Input = Parameters<typeof transformData>[0];

describe('users search index document', () => {
  it("stores the user's profilePicture and an explicit null image, so an update clears an old one", async () => {
    const [record] = await transformData({
      users: [{ id: 5, username: 'u', createdAt: new Date(0), deletedAt: null }],
      metrics: [],
      ranks: [],
      profilePictures: { 5: { id: 50 } },
      cosmetics: {},
    } as unknown as Input);
    expect(record.image).toBeNull();
    expect(record.profilePicture).toEqual({ id: 50 });
  });
});
