import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { BlockedReason, NsfwLevel, OnboardingSteps } from '~/server/common/enums';
import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Blocked-level images stay with their uploader (civitai/civitai#9809).
const OWNER = 5;
const cleanImage = {
  id: 2,
  userId: OWNER,
  nsfwLevel: NsfwLevel.PG,
  modelRestricted: false,
  blockedFor: null,
  tosViolation: false,
  needsReview: null,
  ingestion: 'Scanned',
};
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
const UPLOADER = { id: OWNER, isModerator: false };
const panels = (blockedFor: string | null) => [
  { id: 7, imageUrl: 'panel-key', image: blockedImage(blockedFor) },
  { id: 8, imageUrl: 'clean-key', image: cleanImage },
];
const cleanPanel = { id: 8, imageUrl: 'clean-key', image: cleanImage };
const withheldPanel = { id: 7, imageUrl: null, image: null };

const shell = async (viewer: typeof MODERATOR, blockedFor: string | null) => {
  dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({
    id: 3,
    userId: OWNER,
    tosViolation: false,
    coverImage: blockedImage(blockedFor),
    heroImage: cleanImage,
    chapters: [],
  } as never);
  dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
  const { coverImage, heroImage } = await callerFor(viewer).getProjectShell({ id: 3 });
  return { coverImage, heroImage };
};

const chapterPanels = async (viewer: typeof MODERATOR, blockedFor: string | null) => {
  dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({ id: 3, userId: OWNER } as never);
  dbMock.dbWrite.comicChapter.findUnique.mockResolvedValue({
    projectId: 3,
    position: 0,
    panels: panels(blockedFor),
  } as never);
  return (await callerFor(viewer).getChapter({ projectId: 3, chapterPosition: 0 })).panels;
};

const readerPanels = async (viewer: typeof MODERATOR, blockedFor: string | null) => {
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
  return (await callerFor(viewer).getProjectForReader({ id: 3 })).chapters[0].panels;
};

describe.each([BlockedReason.CSAM, BlockedReason.Moderated, null])(
  'a moderator gets no image rated Blocked, and a clean one (blockedFor %s)',
  (blockedFor) => {
    it('in getProjectShell', async () => {
      expect(await shell(MODERATOR, blockedFor)).toEqual({
        coverImage: null,
        heroImage: cleanImage,
      });
    });

    it('in getChapter', async () => {
      expect(await chapterPanels(MODERATOR, blockedFor)).toEqual([withheldPanel, cleanPanel]);
    });

    it('in getProjectForReader', async () => {
      expect(await readerPanels(MODERATOR, blockedFor)).toEqual([withheldPanel, cleanPanel]);
    });
  }
);

describe.each([BlockedReason.Moderated, null])(
  'the uploader keeps their own image rated Blocked (blockedFor %s)',
  (blockedFor) => {
    it('in getProjectShell', async () => {
      expect(await shell(UPLOADER, blockedFor)).toEqual({
        coverImage: blockedImage(blockedFor),
        heroImage: cleanImage,
      });
    });

    it('in getChapter', async () => {
      expect(await chapterPanels(UPLOADER, blockedFor)).toEqual(panels(blockedFor));
    });

    it('in getProjectForReader', async () => {
      expect(await readerPanels(UPLOADER, blockedFor)).toEqual(panels(blockedFor));
    });
  }
);
