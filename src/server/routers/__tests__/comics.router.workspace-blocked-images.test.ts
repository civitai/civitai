import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { BlockedReason, NsfwLevel, OnboardingSteps } from '~/server/common/enums';
import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// A Blocked rating stays with its uploader (civitai/civitai#9809); a block does not.
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
/** A block withholds the media and leaves the image row, so the owner still sees why. */
const blockedPanel = (blockedFor: string | null) => ({
  id: 7,
  imageUrl: null,
  image: blockedImage(blockedFor),
});

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
  const { panels: returned } = await callerFor(viewer).getChapter({
    projectId: 3,
    chapterPosition: 0,
  });
  return returned.map(({ id, imageUrl, image }) => ({ id, imageUrl, image }));
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

describe.each([null, BlockedReason.AiNotVerified])(
  'the uploader keeps the cover of their own image rated Blocked (blockedFor %s)',
  (blockedFor) => {
    it('in getProjectShell', async () => {
      expect(await shell(UPLOADER, blockedFor)).toEqual({
        coverImage: blockedImage(blockedFor),
        heroImage: cleanImage,
      });
    });
  }
);

describe.each([BlockedReason.Moderated, BlockedReason.CSAM, 'zzz'])(
  'a block refuses the cover to its uploader too (blockedFor %s)',
  (blockedFor) => {
    it('in getProjectShell', async () => {
      expect(await shell(UPLOADER, blockedFor)).toEqual({
        coverImage: null,
        heroImage: cleanImage,
      });
    });
  }
);

describe.each([null, BlockedReason.AiNotVerified])(
  'the uploader keeps the panel of their own image rated Blocked (blockedFor %s)',
  (blockedFor) => {
    it('in getChapter', async () => {
      expect(await chapterPanels(UPLOADER, blockedFor)).toEqual(panels(blockedFor));
    });

    it('in getProjectForReader', async () => {
      expect(await readerPanels(UPLOADER, blockedFor)).toEqual(panels(blockedFor));
    });
  }
);

describe.each([BlockedReason.Moderated, BlockedReason.CSAM, BlockedReason.TOS, 'zzz'])(
  'a block refuses the panel to its uploader too (blockedFor %s)',
  (blockedFor) => {
    it('in getChapter', async () => {
      expect(await chapterPanels(UPLOADER, blockedFor)).toEqual([
        blockedPanel(blockedFor),
        cleanPanel,
      ]);
    });

    it('in getProjectForReader', async () => {
      expect(await readerPanels(UPLOADER, blockedFor)).toEqual([
        blockedPanel(blockedFor),
        cleanPanel,
      ]);
    });
  }
);

describe('a moderator keeps the media of a blocked image not rated Blocked', () => {
  const blockedPg = { ...blockedImage(BlockedReason.Moderated), nsfwLevel: NsfwLevel.PG };
  // Fresh rows per read: the withholding writes to the panels it is given.
  const blockedPanels = () => [
    { id: 7, imageUrl: 'panel-key', image: { ...blockedPg } },
    { ...cleanPanel, image: { ...cleanImage } },
  ];

  it('in getChapter, and the uploader gets the row without it', async () => {
    dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({ id: 3, userId: OWNER } as never);
    const chapter = (viewer: typeof MODERATOR) => {
      dbMock.dbWrite.comicChapter.findUnique.mockResolvedValue({
        projectId: 3,
        position: 0,
        panels: blockedPanels(),
      } as never);
      return callerFor(viewer)
        .getChapter({ projectId: 3, chapterPosition: 0 })
        .then((c) => c.panels.map(({ id, imageUrl, image }) => ({ id, imageUrl, image })));
    };
    expect(await chapter(MODERATOR)).toEqual([
      { id: 7, imageUrl: 'panel-key', image: blockedPg },
      cleanPanel,
    ]);
    expect(await chapter(UPLOADER)).toEqual([
      { id: 7, imageUrl: null, image: blockedPg },
      cleanPanel,
    ]);
  });

  it('in getProjectShell, and the uploader gets no cover', async () => {
    const cover = async (viewer: typeof MODERATOR) => {
      dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({
        id: 3,
        userId: OWNER,
        tosViolation: false,
        coverImage: blockedPg,
        heroImage: cleanImage,
        chapters: [],
      } as never);
      dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
      return (await callerFor(viewer).getProjectShell({ id: 3 })).coverImage;
    };
    expect(await cover(MODERATOR)).toEqual(blockedPg);
    expect(await cover(UPLOADER)).toBeNull();
  });
});

describe('pollPanelStatus', () => {
  const poll = async (image: { ingestion: string; blockedFor: string | null }) => {
    dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue({
      id: 7,
      status: 'Ready',
      workflowId: null,
      imageUrl: 'panel-key',
      errorMessage: null,
      metadata: null,
      image,
      chapter: { project: { userId: OWNER } },
    } as never);
    return (await callerFor(UPLOADER).pollPanelStatus({ panelId: 7 })).imageUrl;
  };

  it('withholds a blocked panel image from its owner, and keeps the metadata hold', async () => {
    expect(await poll({ ingestion: 'Blocked', blockedFor: BlockedReason.Moderated })).toBeNull();
    expect(await poll({ ingestion: 'Blocked', blockedFor: BlockedReason.AiNotVerified })).toBe(
      'panel-key'
    );
  });
});

it('a Blocked ingestion with no reason refuses the panel to its uploader', async () => {
  dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({ id: 3, userId: OWNER } as never);
  dbMock.dbWrite.comicChapter.findUnique.mockResolvedValue({
    projectId: 3,
    position: 0,
    panels: [
      { id: 7, imageUrl: 'panel-key', image: { ...cleanImage, id: 1, ingestion: 'Blocked' } },
      cleanPanel,
    ],
  } as never);
  const { panels: returned } = await callerFor(UPLOADER).getChapter({
    projectId: 3,
    chapterPosition: 0,
  });
  expect(returned.map(({ id, imageUrl, image }) => ({ id, imageUrl, image }))).toEqual([
    { id: 7, imageUrl: null, image: { ...cleanImage, id: 1, ingestion: 'Blocked' } },
    cleanPanel,
  ]);
});
