import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel, OnboardingSteps } from '~/server/common/enums';
import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OWNER = 5;
const blockedImage = () => ({
  id: 1,
  userId: OWNER,
  nsfwLevel: NsfwLevel.Blocked,
  modelRestricted: false,
  tosViolation: false,
  needsReview: null,
  ingestion: 'Scanned',
});

const panelFor = async (viewer: { id: number; isModerator: boolean }) => {
  dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({ id: 3, userId: OWNER } as never);
  dbMock.dbWrite.comicChapter.findUnique.mockResolvedValue({
    projectId: 3,
    position: 0,
    panels: [{ id: 7, imageUrl: 'panel-key', image: blockedImage() }],
  } as never);
  const caller = comicsRouter.createCaller({
    user: { ...viewer, onboarding: OnboardingSteps.Buzz, muted: false },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { trpcFlagGuardPerRequest: true, comicCreator: true, isGreen: false },
    req: undefined,
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    track: {},
    ip: '127.0.0.1',
  } as never);
  const chapter = await caller.getChapter({ projectId: 3, chapterPosition: 0 });
  const [panel] = (chapter as { panels: { imageUrl: string | null; image: unknown }[] }).panels;
  return { imageUrl: panel.imageUrl, image: panel.image };
};

describe('comics.getChapter panel images rated Blocked', () => {
  it('reach a moderator reviewing the chapter', async () => {
    expect(await panelFor({ id: 6, isModerator: true })).toEqual({
      imageUrl: 'panel-key',
      image: blockedImage(),
    });
  });
});
