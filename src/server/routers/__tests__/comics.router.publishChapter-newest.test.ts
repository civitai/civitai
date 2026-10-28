import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as SearchIndex from '~/server/search-index';
import type * as NsfwLevels from '~/server/services/nsfwLevels.service';
import type * as NotificationService from '~/server/services/notification.service';

/**
 * The comics Newest feed orders by project `updatedAt`, so a chapter going live must bump it —
 * and re-publishing a chapter that is already live (e.g. to change early access) must not.
 */

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  comicsSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));
vi.mock('~/server/services/nsfwLevels.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NsfwLevels>()),
  updateComicNsfwLevels: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: vi.fn(async () => undefined),
}));
// See comics.router.createChapterComment.test.ts: `isFlagProtected` recomputes flags.
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ comicCreator: true }),
}));

import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { ComicChapterStatus } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const USER_ID = 7;
const PROJECT_ID = 11;

const publish = () =>
  comicsRouter
    .createCaller({
      user: { id: USER_ID, isModerator: false, onboarding: OnboardingSteps.Buzz, muted: false },
      acceptableOrigin: true,
      needsUpdate: false,
      tokenScope: TokenScope.Full,
      features: { comicCreator: true },
      req: undefined,
      res: { setHeader: () => undefined },
      cache: { edgeTTL: 0 },
      track: {},
      ip: '127.0.0.1',
      fingerprint: 'test',
    } as never)
    .publishChapter({ projectId: PROJECT_ID, chapterPosition: 2 });

const givenChapter = (status: ComicChapterStatus, projectPublishedAt: Date | null) =>
  dbMock.dbRead.comicChapter.findUnique.mockResolvedValue({
    id: 99,
    name: 'Ch2',
    status,
    availability: 'Public',
    project: {
      id: PROJECT_ID,
      userId: USER_ID,
      name: 'Proj',
      publishedAt: projectPublishedAt,
      user: { username: 'author' },
      engagements: [],
    },
  });

const projectWrites = () => dbMock.dbWrite.comicProject.updateMany.mock.calls.map(([a]) => a);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.comicPanel.findMany.mockResolvedValue([]);
  dbMock.dbWrite.comicChapter.update.mockResolvedValue({});
});

describe('comics.publishChapter - Newest ordering', () => {
  it('bumps updatedAt, and leaves publishedAt alone, when a new chapter of a published comic goes live', async () => {
    givenChapter(ComicChapterStatus.Draft, new Date('2026-01-01'));
    await publish();
    expect(projectWrites()).toEqual([
      { where: { id: { in: [PROJECT_ID] } }, data: { updatedAt: expect.any(Date) } },
      // Guarded on null, so it is a no-op for a comic that already has a publishedAt.
      {
        where: { id: { in: [PROJECT_ID] }, publishedAt: null },
        data: { publishedAt: expect.any(Date) },
      },
    ]);
  });

  it("sets publishedAt on the comic's first-ever publish", async () => {
    givenChapter(ComicChapterStatus.Draft, null);
    await publish();
    expect(dbMock.dbWrite.comicProject.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [PROJECT_ID] }, publishedAt: null },
      data: { publishedAt: expect.any(Date) },
    });
  });

  it('does not touch the comic when a chapter that is already live is re-published', async () => {
    givenChapter(ComicChapterStatus.Published, new Date('2026-01-01'));
    await publish();
    expect(dbMock.dbWrite.comicChapter.update).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.comicProject.updateMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.comicProject.update).not.toHaveBeenCalled();
  });
});
