import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// The public listing looks the same to everyone: a moderator gets no Blocked-level cover here.
describe('comics.getPublicProjects for a moderator', () => {
  it('withholds a cover rated Blocked', async () => {
    const cover = {
      id: 1,
      url: 'cover-key',
      userId: 5,
      nsfwLevel: NsfwLevel.Blocked,
      modelRestricted: false,
    };
    dbMock.dbRead.comicProject.findMany.mockResolvedValue([
      {
        id: 3,
        name: 'Comic',
        description: null,
        coverImage: cover,
        heroImage: cover,
        heroImagePosition: null,
        genre: null,
        nsfwLevel: 1,
        updatedAt: new Date(2026, 0, 1),
        user: { id: 5, username: 'creator', image: null, deletedAt: null, cosmetics: [] },
        chapters: [],
      },
    ] as never);
    dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
    const caller = comicsRouter.createCaller({
      user: { id: 6, isModerator: true },
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      features: { trpcFlagGuardPerRequest: true, comicCreator: true, isGreen: false },
      req: undefined,
      res: { setHeader: () => undefined },
      cache: { edgeTTL: 0 },
      track: {},
      ip: '127.0.0.1',
    } as never);

    const { items } = await caller.getPublicProjects({ limit: 10, sort: 'Newest' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ coverImage: null, heroImage: null });
  });
});
