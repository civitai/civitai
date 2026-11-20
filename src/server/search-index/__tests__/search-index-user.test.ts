import { describe, expect, it } from 'vitest';
import { userRefreshDocuments } from '~/server/search-index/search-index-user';

describe("the moderator search tools' user refresh documents", () => {
  it("carry the owner's profilePicture but not the legacy image", () => {
    const [doc] = userRefreshDocuments([
      {
        id: 1,
        user: { id: 7, username: 'author', image: 'legacy.png', profilePicture: { id: 70 } },
      },
    ]);
    expect(doc).toEqual({ id: 1, user: { id: 7, username: 'author', profilePicture: { id: 70 } } });
  });
});
