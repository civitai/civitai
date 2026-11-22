import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { getUserLinks } from '~/server/services/user-link.service';
import { userWithProfileSelect } from '~/server/selectors/user.selector';

/**
 * A ban whose profile archive failed keeps the user's links as evidence, so every public read of
 * links must skip a banned user's rather than rely on the rows being gone.
 */
describe('a banned user’s links are not served', () => {
  it('getUserLinks reads only an unbanned owner’s links', async () => {
    dbMock.dbRead.userLink.findMany.mockResolvedValue([] as never);
    await getUserLinks({ userId: 990400001 });
    expect(dbMock.dbRead.userLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 990400001, user: { bannedAt: null } } })
    );
  });

  it('the public profile select skips a banned owner’s links', () => {
    expect(userWithProfileSelect.links).toMatchObject({ where: { user: { bannedAt: null } } });
  });
});
