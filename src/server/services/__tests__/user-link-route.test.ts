import type * as UserService from '~/server/services/user.service';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getUserCreator } from '~/server/services/user.service';
import { getServerSideProps } from '~/pages/user-link/[userId]';

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserCreator: vi.fn(),
}));

const mockCreator = vi.mocked(getUserCreator);
const setHeader = vi.fn();
const run = (userId: string) =>
  getServerSideProps({ params: { userId }, res: { setHeader } } as never);

describe('/user-link/[userId]', () => {
  beforeEach(() => {
    mockCreator.mockReset();
    setHeader.mockReset();
  });

  test('redirects temporarily to the current username and is noindex', async () => {
    mockCreator.mockResolvedValue({ id: 7, username: 'New Name', deletedAt: null } as never);
    expect(await run('7')).toEqual({
      redirect: { destination: '/user/New%20Name', permanent: false },
    });
    expect(mockCreator).toHaveBeenCalledWith({ id: 7 });
    expect(setHeader).toHaveBeenCalledWith('X-Robots-Tag', 'noindex');
  });

  test.each(['abc', '7abc', '0', '-1', '99999999999', '2147483648', '1e3', ''])(
    'a malformed id %j is a 404 without a lookup',
    async (id) => {
      expect(await run(id)).toEqual({ notFound: true });
      expect(mockCreator).not.toHaveBeenCalled();
    }
  );

  test('the largest int32 id is still looked up', async () => {
    mockCreator.mockResolvedValue(null);
    await run('2147483647');
    expect(mockCreator).toHaveBeenCalledWith({ id: 2147483647 });
  });

  test.each([
    ['unknown user', null],
    ['no username', { id: 7, username: null, deletedAt: null }],
    ['deleted user', { id: 7, username: 'Gone', deletedAt: new Date() }],
  ])('%s is a 404', async (_n, user) => {
    mockCreator.mockResolvedValue(user as never);
    expect(await run('7')).toEqual({ notFound: true });
  });
});
