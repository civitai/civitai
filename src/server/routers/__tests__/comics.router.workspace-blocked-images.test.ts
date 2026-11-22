import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { BlockedReason, NsfwLevel, OnboardingSteps } from '~/server/common/enums';
import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OWNER = 5;
const blockedImage = (blockedFor: string | null) => ({
  id: 1,
  userId: OWNER,
  nsfwLevel: NsfwLevel.Blocked,
  modelRestricted: false,
  blockedFor,
  tosViolation: false,
  needsReview: null,
  ingestion: 'Scanned',
});

const callerFor = (viewer: { id: number; isModerator: boolean }) =>
  comicsRouter.createCaller({
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

const MODERATOR = { id: 6, isModerator: true };
const blocks = [BlockedReason.CSAM, BlockedReason.Moderated, null];
const panels = (blockedFor: string | null) => [
  { id: 7, imageUrl: 'panel-key', image: blockedImage(blockedFor) },
];
const withheld = [{ id: 7, imageUrl: null, image: null }];

describe.each(blocks)('a moderator gets no image rated Blocked (blockedFor %s)', (blockedFor) => {
  it('in getProjectShell', async () => {
    dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({
      id: 3,
      userId: OWNER,
      tosViolation: false,
      coverImage: blockedImage(blockedFor),
      heroImage: blockedImage(blockedFor),
      chapters: [],
    } as never);
    dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
    const project = await callerFor(MODERATOR).getProjectShell({ id: 3 });
    expect(project).toMatchObject({ coverImage: null, heroImage: null });
  });

  it('in getChapter', async () => {
    dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({ id: 3, userId: OWNER } as never);
    dbMock.dbWrite.comicChapter.findUnique.mockResolvedValue({
      projectId: 3,
      position: 0,
      panels: panels(blockedFor),
    } as never);
    const chapter = await callerFor(MODERATOR).getChapter({ projectId: 3, chapterPosition: 0 });
    expect(chapter.panels).toEqual(withheld);
  });

  it('in getProjectForReader', async () => {
    dbMock.dbRead.comicProject.findUnique.mockResolvedValue({
      id: 3,
      name: 'Comic',
      userId: OWNER,
      user: { username: 'creator' },
      meta: null,
      chapters: [
        { projectId: 3, name: 'One', position: 0, nsfwLevel: 1, panels: panels(blockedFor) },
      ],
    } as never);
    const project = await callerFor(MODERATOR).getProjectForReader({ id: 3 });
    expect(project.chapters[0].panels).toEqual(withheld);
  });
});
