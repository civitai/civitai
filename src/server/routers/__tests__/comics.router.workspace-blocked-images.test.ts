import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signalClient } from '~/utils/signal-client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { BlockedReason, NsfwLevel, OnboardingSteps } from '~/server/common/enums';
import { comicsRouter } from '../comics.router';
import { ownerMediaAllowedWhere } from '~/server/common/image-visibility';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// A panel signal would reach the signals service.
beforeEach(() => {
  vi.spyOn(signalClient, 'send').mockResolvedValue(undefined as never);
  dbMock.dbWrite.image.create.mockResolvedValue({ id: 900 } as never);
});

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

const callerFor = (viewer: { id: number; isModerator: boolean }, scopedKey = false) =>
  comicsRouter.createCaller({
    user: { ...viewer, onboarding: OnboardingSteps.Buzz, muted: false },
    acceptableOrigin: true,
    tokenScope: scopedKey ? TokenScope.MediaRead : TokenScope.Full,
    ...(scopedKey ? { apiKeyId: 9 } : {}),
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
      image: { ...cleanImage, ...image },
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

describe('the public reader and a moderator', () => {
  const blockedPg = { ...blockedImage(BlockedReason.Moderated), nsfwLevel: NsfwLevel.PG };
  const read = async (scopedKey: boolean) => {
    dbMock.dbRead.comicProject.findUnique.mockResolvedValue({
      id: 3,
      name: 'Comic',
      userId: OWNER,
      status: 'Active',
      tosViolation: false,
      publishedAt: new Date(0),
      nsfwLevel: 1,
      user: { username: 'creator', bannedAt: null },
      meta: null,
      coverImage: { ...blockedPg },
      heroImage: null,
      chapters: [
        {
          id: 1,
          projectId: 3,
          name: 'One',
          position: 0,
          status: 'Published',
          nsfwLevel: 1,
          publishedAt: new Date(0),
          availability: 'Public',
          earlyAccessEndsAt: null,
          earlyAccessConfig: null,
          panels: [{ id: 7, imageUrl: 'panel-key', image: { ...blockedPg } }],
        },
      ],
    } as never);
    dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
    const comic = await callerFor(MODERATOR, scopedKey).getPublicProjectForReader({ id: 3 });
    return { cover: comic.coverImage?.id ?? null, panel: comic.chapters[0].panels[0].imageUrl };
  };

  it('keeps a blocked cover and panel on a session, and not on a scoped key', async () => {
    expect(await read(false)).toEqual({ cover: blockedPg.id, panel: 'panel-key' });
    expect(await read(true)).toEqual({ cover: null, panel: null });
  });
});

describe("the owner's project list", () => {
  it('takes its thumbnail only from a panel whose media the block leaves the owner', async () => {
    dbMock.dbRead.comicProject.findMany.mockResolvedValue([] as never);
    await callerFor(UPLOADER).getMyProjects();
    const { include } = dbMock.dbRead.comicProject.findMany.mock.calls.at(-1)![0] as {
      include: { chapters: { include: { panels: { where: { OR: unknown[] } } } } };
    };
    expect(include.chapters.include.panels.where.OR[1]).toEqual({
      image: { AND: [expect.anything(), ownerMediaAllowedWhere()] },
    });
  });
});

describe("a panel's metadata when its image is withheld", () => {
  const chapterWith = async (image: object, sourceRow?: object) => {
    dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({ id: 3, userId: OWNER } as never);
    dbMock.dbWrite.comicChapter.findUnique.mockResolvedValue({
      projectId: 3,
      position: 0,
      panels: [
        {
          id: 7,
          imageUrl: 'panel-key',
          image,
          metadata: {
            candidateImages: [{ key: 'panel-key' }, { key: 'other-key' }],
            sourceImageUrl: 'source-key',
          },
        },
      ],
    } as never);
    dbMock.dbWrite.image.findMany.mockResolvedValue(
      (sourceRow ? [{ url: 'source-key', ...sourceRow }] : []) as never
    );
    const { panels } = await callerFor(UPLOADER).getChapter({ projectId: 3, chapterPosition: 0 });
    const metadata = panels[0].metadata as {
      candidateImages: { key?: string }[];
      sourceImageUrl?: string;
    };
    return {
      imageUrl: panels[0].imageUrl,
      keys: metadata.candidateImages.map((c) => c.key ?? null),
      source: metadata.sourceImageUrl ?? null,
    };
  };

  it('gives the owner no candidate key on a blocked panel, and keeps them on a clean one', async () => {
    expect(await chapterWith({ ...blockedImage(BlockedReason.Moderated) })).toMatchObject({
      imageUrl: null,
      keys: [null, null],
    });
    expect(await chapterWith({ ...cleanImage })).toMatchObject({
      imageUrl: 'panel-key',
      keys: ['panel-key', 'other-key'],
    });
  });

  it('gives the owner no source image that a block refuses them', async () => {
    const blockedSource = { ...blockedImage(BlockedReason.Moderated), nsfwLevel: NsfwLevel.PG };
    expect((await chapterWith({ ...cleanImage }, blockedSource)).source).toBeNull();
    expect((await chapterWith({ ...cleanImage }, { ...cleanImage })).source).toBe('source-key');
  });
});

describe('a moderator on a scoped key', () => {
  it("is refused another owner's chapter and project, which a session moderator reads", async () => {
    dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({ id: 3, userId: OWNER } as never);
    dbMock.dbWrite.comicChapter.findUnique.mockResolvedValue({
      projectId: 3,
      position: 0,
      panels: [cleanPanel],
    } as never);
    const chapter = (scopedKey: boolean) =>
      callerFor(MODERATOR, scopedKey).getChapter({ projectId: 3, chapterPosition: 0 });
    await expect(chapter(false)).resolves.toBeTruthy();
    await expect(chapter(true)).rejects.toThrow();
  });

  it('gets no draft chapter on the public reader, which a session moderator gets', async () => {
    const draftChapters = async (scopedKey: boolean) => {
      dbMock.dbRead.comicProject.findUnique.mockResolvedValue({
        id: 3,
        name: 'Comic',
        userId: OWNER,
        status: 'Active',
        tosViolation: false,
        publishedAt: new Date(0),
        nsfwLevel: 1,
        user: { username: 'creator', bannedAt: null },
        meta: null,
        coverImage: null,
        heroImage: null,
        chapters: [
          {
            id: 1,
            projectId: 3,
            name: 'Draft',
            position: 0,
            status: 'Draft',
            nsfwLevel: 1,
            publishedAt: null,
            availability: 'Public',
            earlyAccessEndsAt: null,
            earlyAccessConfig: null,
            panels: [{ ...cleanPanel, status: 'Ready' }],
          },
        ],
      } as never);
      dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
      return (await callerFor(MODERATOR, scopedKey).getPublicProjectForReader({ id: 3 })).chapters
        .length;
    };
    expect(await draftChapters(false)).toBe(1);
    // With only a draft, the comic is not found at all.
    await expect(draftChapters(true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('the panel debug view, an update and a duplicate of a blocked panel', () => {
  const panelRow = (image: object) => ({
    id: 7,
    status: 'Ready',
    prompt: 'p',
    enhancedPrompt: null,
    imageUrl: 'panel-key',
    imageId: 1,
    workflowId: null,
    errorMessage: null,
    metadata: { candidateImages: [{ key: 'panel-key' }, { key: 'other-key' }] },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    position: 0,
    projectId: 3,
    chapterPosition: 0,
    image,
    references: [],
    chapter: { project: { userId: OWNER, baseModel: 'Flux1' } },
  });
  const keysOf = (metadata: unknown) =>
    ((metadata as { candidateImages: { key?: string }[] }).candidateImages ?? []).map(
      (c) => c.key ?? null
    );
  const blocked = () => ({ ...blockedImage(BlockedReason.Moderated) });
  const clean = () => ({ ...cleanImage });

  it('debug info gives the owner no image or candidate key of a blocked panel', async () => {
    const debug = async (image: object) => {
      dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue(panelRow(image) as never);
      const { panel } = await callerFor(UPLOADER).getPanelDebugInfo({ panelId: 7 });
      return { imageUrl: panel.imageUrl, keys: keysOf(panel.metadata) };
    };
    expect(await debug(blocked())).toEqual({ imageUrl: null, keys: [null, null] });
    expect(await debug(clean())).toEqual({
      imageUrl: 'panel-key',
      keys: ['panel-key', 'other-key'],
    });
  });

  it('an update returns no image or candidate key of a blocked panel', async () => {
    const update = async (image: object) => {
      dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue(panelRow(image) as never);
      dbMock.dbWrite.comicPanel.update.mockResolvedValue(panelRow(image) as never);
      const updated = await callerFor(UPLOADER).updatePanel({ panelId: 7, status: 'Generating' });
      return { imageUrl: updated.imageUrl, keys: keysOf(updated.metadata) };
    };
    expect(await update(blocked())).toEqual({ imageUrl: null, keys: [null, null] });
    expect(await update(clean())).toEqual({
      imageUrl: 'panel-key',
      keys: ['panel-key', 'other-key'],
    });
  });

  it('refuses to duplicate a blocked panel', async () => {
    dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue(panelRow(blocked()) as never);
    await expect(callerFor(UPLOADER).duplicatePanel({ panelId: 7 } as never)).rejects.toMatchObject(
      {
        code: 'BAD_REQUEST',
      }
    );
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });
});

describe('selecting a panel image', () => {
  const select = async (backing: object[]) => {
    dbMock.dbRead.comicPanel.findUnique.mockResolvedValue({
      id: 7,
      workflowId: null,
      metadata: { candidateImages: [{ key: 'candidate-key' }] },
      chapter: { project: { userId: OWNER } },
    } as never);
    dbMock.dbWrite.image.findMany.mockResolvedValue(backing as never);
    return callerFor(UPLOADER)
      .selectPanelImage({ panelId: 7, selectedImageKey: 'candidate-key' })
      .catch((e: unknown) => e);
  };
  const refusedAsBlocked = expect.objectContaining({
    message: 'This image is blocked and cannot be selected.',
  });

  it('refuses a key that already backs a blocked image', async () => {
    expect(await select([{ ingestion: 'Blocked', blockedFor: BlockedReason.Moderated }])).toEqual(
      refusedAsBlocked
    );
  });

  it('does not refuse a key whose image is clean or only held for its metadata', async () => {
    expect(await select([])).not.toEqual(refusedAsBlocked);
    expect(
      await select([{ ingestion: 'Blocked', blockedFor: BlockedReason.AiNotVerified }])
    ).not.toEqual(refusedAsBlocked);
  });
});

describe("a comic chapter's comment thread", () => {
  it('is not found on a draft chapter for a moderator on a scoped key', async () => {
    const { commentSurface } = await import('~/server/services/commentv3/surfaces');
    dbMock.dbRead.comicChapter.findUnique.mockResolvedValue({
      status: 'Draft',
      panels: [{ image: { tosViolation: false, needsReview: null, ingestion: 'Scanned' } }],
      project: {
        userId: OWNER,
        status: 'Active',
        tosViolation: false,
        publishedAt: new Date(0),
        nsfwLevel: 1,
        user: { bannedAt: null },
      },
    } as never);
    const ctx = (scopedKey: boolean) =>
      ({
        user: { ...MODERATOR },
        features: {},
        tokenScope: scopedKey ? TokenScope.MediaRead : TokenScope.Full,
        ...(scopedKey ? { apiKeyId: 9 } : {}),
      } as never);
    const check = (scopedKey: boolean) =>
      Promise.resolve(commentSurface('comicChapter').assertVisible?.(1, ctx(scopedKey)));
    await expect(check(false)).resolves.toBeUndefined();
    await expect(check(true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe("a reference's images", () => {
  const blockedRef = () => ({
    ...blockedImage(BlockedReason.Moderated),
    nsfwLevel: NsfwLevel.PG,
    url: 'ref-blocked',
  });
  const cleanRef = () => ({ ...cleanImage, url: 'ref-clean' });
  const reference = () => ({
    id: 11,
    userId: OWNER,
    images: [
      { position: 0, image: blockedRef() },
      { position: 1, image: cleanRef() },
    ],
  });
  const urls = (ref: { images: { image: { url: string } }[] }) =>
    ref.images.map((i) => i.image.url);

  it('leaves out a blocked image for its owner on getReference and getUserReferences', async () => {
    dbMock.dbRead.comicReference.findUnique.mockResolvedValue(reference() as never);
    expect(urls(await callerFor(UPLOADER).getReference({ referenceId: 11 }))).toEqual([
      'ref-clean',
    ]);

    dbMock.dbRead.comicReference.findMany.mockResolvedValue([reference()] as never);
    const [ref] = await callerFor(UPLOADER).getUserReferences();
    expect(urls(ref)).toEqual(['ref-clean']);
    expect(ref.images[0].image).not.toHaveProperty('blockedFor');
  });
});

describe('more panel and reference reads', () => {
  const blockedRow = (url: string) => ({
    url,
    ...blockedImage(BlockedReason.Moderated),
    nsfwLevel: NsfwLevel.PG,
  });

  it('a reference poll leaves out a blocked image for its owner', async () => {
    dbMock.dbWrite.comicReference.findUnique.mockResolvedValue({
      id: 11,
      userId: OWNER,
      status: 'Ready',
      images: [
        { position: 0, image: { ...blockedRow('ref-blocked'), id: 1 } },
        { position: 1, image: { ...cleanImage, url: 'ref-clean' } },
      ],
    } as never);
    const { images } = await callerFor(UPLOADER).pollReferenceStatus({ referenceId: 11 });
    expect(images.map((i) => i.image.url)).toEqual(['ref-clean']);
  });

  it('refuses to make a panel from a blocked image, and from a clean one goes past that check', async () => {
    const create = (image: object) => {
      dbMock.dbRead.image.findUnique.mockResolvedValue({
        id: 5,
        userId: OWNER,
        url: 'img',
        ...image,
      } as never);
      return callerFor(UPLOADER)
        .createPanelFromImage({ projectId: 3, chapterPosition: 0, imageId: 5 })
        .catch((e: unknown) => e);
    };
    const refused = expect.objectContaining({
      message: 'This image is blocked and cannot be used here.',
    });
    expect(await create({ ingestion: 'Blocked', blockedFor: BlockedReason.Moderated })).toEqual(
      refused
    );
    expect(await create({ ingestion: 'Scanned', blockedFor: null })).not.toEqual(refused);
  });

  it("strips a candidate key and a source that back a blocked image from a clean panel's metadata", async () => {
    dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({ id: 3, userId: OWNER } as never);
    dbMock.dbWrite.comicChapter.findUnique.mockResolvedValue({
      projectId: 3,
      position: 0,
      panels: [
        {
          id: 7,
          imageUrl: 'panel-key',
          image: { ...cleanImage },
          metadata: {
            candidateImages: [{ key: 'panel-key' }, { key: 'blocked-key' }],
            sourceImageUrl: 'blocked-source',
          },
        },
      ],
    } as never);
    dbMock.dbWrite.image.findMany.mockResolvedValue([
      blockedRow('blocked-key'),
      blockedRow('blocked-source'),
    ] as never);
    const { panels } = await callerFor(UPLOADER).getChapter({ projectId: 3, chapterPosition: 0 });
    const metadata = panels[0].metadata as {
      candidateImages: { key?: string }[];
      sourceImageUrl?: string;
    };
    expect(metadata.candidateImages.map((c) => c.key ?? null)).toEqual(['panel-key', null]);
    expect(metadata.sourceImageUrl).toBeUndefined();

    dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue({
      id: 7,
      status: 'Ready',
      prompt: 'p',
      enhancedPrompt: null,
      imageUrl: 'panel-key',
      workflowId: null,
      errorMessage: null,
      metadata: {
        candidateImages: [{ key: 'panel-key' }, { key: 'blocked-key' }],
        sourceImageUrl: 'blocked-source',
        other: 1,
      },
      createdAt: new Date(0),
      updatedAt: new Date(0),
      image: { ...cleanImage },
      references: [],
      chapter: { project: { userId: OWNER, baseModel: 'Flux1' } },
    } as never);
    const { panel } = await callerFor(UPLOADER).getPanelDebugInfo({ panelId: 7 });
    expect(panel.metadata).toEqual({
      candidateImages: [{ key: 'panel-key', nsfwLevel: null }, { nsfwLevel: null }],
      hasSourceImage: true,
    });
  });
});

describe('the rest of the panel and reference responses', () => {
  const blockedRow = (url: string) => ({
    url,
    ...blockedImage(BlockedReason.Moderated),
    nsfwLevel: NsfwLevel.PG,
  });
  const twoKeys = () => ({ candidateImages: [{ key: 'panel-key' }, { key: 'blocked-key' }] });
  const keysOf = (metadata: unknown) =>
    (metadata as { candidateImages: { key?: string }[] }).candidateImages.map((c) => c.key ?? null);
  /** The Image rows behind the panel's keys: the second key's image is blocked, or it has none. */
  const keyRows = (blocked: boolean) => (blocked ? [blockedRow('blocked-key')] : []);

  it('a duplicate of a clean panel carries no candidate key that backs a blocked image', async () => {
    const duplicate = async (blocked: boolean) => {
      dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue({
        id: 7,
        projectId: 3,
        chapterPosition: 0,
        position: 0,
        status: 'Ready',
        prompt: 'p',
        enhancedPrompt: null,
        imageUrl: 'panel-key',
        imageId: 2,
        metadata: twoKeys(),
        references: [],
        image: { ...cleanImage },
        chapter: { project: { userId: OWNER } },
      } as never);
      dbMock.dbWrite.comicPanel.create.mockResolvedValue({
        id: 9,
        status: 'Ready',
        imageUrl: 'panel-key',
        metadata: twoKeys(),
      } as never);
      dbMock.dbWrite.image.findMany.mockResolvedValue(keyRows(blocked) as never);
      const copy = await callerFor(UPLOADER).duplicatePanel({ panelId: 7 } as never);
      return { imageUrl: copy.imageUrl, keys: keysOf(copy.metadata) };
    };
    expect(await duplicate(true)).toEqual({ imageUrl: 'panel-key', keys: ['panel-key', null] });
    expect(await duplicate(false)).toEqual({
      imageUrl: 'panel-key',
      keys: ['panel-key', 'blocked-key'],
    });
  });

  it('replacing a panel image with the same one returns no media of a blocked panel', async () => {
    dbMock.dbWrite.comicPanel.update.mockClear();
    const replace = async (image: object) => {
      dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue({
        id: 7,
        status: 'Ready',
        imageUrl: 'panel-key',
        metadata: twoKeys(),
        image,
        chapter: { project: { userId: OWNER, id: 3 } },
      } as never);
      dbMock.dbWrite.image.findMany.mockResolvedValue([] as never);
      const panel = await callerFor(UPLOADER).replacePanelImage({
        panelId: 7,
        imageUrl: 'panel-key',
      });
      return { imageUrl: panel.imageUrl, keys: keysOf(panel.metadata) };
    };
    expect(await replace({ url: 'panel-key', ...blockedImage(BlockedReason.Moderated) })).toEqual({
      imageUrl: null,
      keys: [null, null],
    });
    expect(await replace({ url: 'panel-key', ...cleanImage })).toEqual({
      imageUrl: 'panel-key',
      keys: ['panel-key', 'blocked-key'],
    });
    expect(dbMock.dbWrite.comicPanel.update).not.toHaveBeenCalled();
  });

  const reference = () => ({
    id: 11,
    userId: OWNER,
    status: 'Ready',
    images: [
      { position: 0, image: { ...blockedRow('ref-blocked'), id: 1 } },
      { position: 1, image: { ...cleanImage, url: 'ref-clean' } },
    ],
  });
  const shownImages = (ref: { images: { image: object }[] }) =>
    ref.images.map(({ image }) => {
      const { url, blockedFor, ingestion } = image as Record<string, unknown>;
      return { url, blockedFor, ingestion };
    });
  const cleanOnly = [{ url: 'ref-clean', blockedFor: undefined, ingestion: undefined }];

  it('importable references leave out a blocked image for its owner', async () => {
    dbMock.dbRead.comicProject.findUnique.mockResolvedValue({ userId: OWNER } as never);
    dbMock.dbRead.comicProjectReference.findMany.mockResolvedValue([] as never);
    dbMock.dbRead.comicReference.findMany.mockResolvedValue([reference()] as never);
    const [ref] = await callerFor(UPLOADER).getImportableReferences({ projectId: 3 });
    expect(shownImages(ref)).toEqual(cleanOnly);
  });

  it("the project shell's references leave out a blocked image, without its block fields", async () => {
    dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({
      id: 3,
      userId: OWNER,
      tosViolation: false,
      coverImage: null,
      heroImage: null,
      chapters: [],
    } as never);
    dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
    dbMock.dbWrite.comicProjectReference.findMany.mockResolvedValue([{ referenceId: 11 }] as never);
    dbMock.dbWrite.comicReference.findMany.mockResolvedValue([reference()] as never);
    const { references } = await callerFor(UPLOADER).getProjectShell({ id: 3 });
    expect(references.map(shownImages)).toEqual([cleanOnly]);
  });
});

describe('a stored context key never leaves a panel response', () => {
  const blockedRow = (url: string) => ({
    url,
    ...blockedImage(BlockedReason.Moderated),
    nsfwLevel: NsfwLevel.PG,
  });
  /** Metadata of a panel generated with a context panel whose image was blocked since. */
  const withContext = () => ({
    candidateImages: [{ key: 'clean-key' }],
    previousPanelImageUrl: 'ctx-blocked',
    referencePanelImageUrl: 'ctx-blocked',
    referenceImages: [{ url: 'ctx-blocked', width: 1, height: 1 }],
  });
  const row = (over: Record<string, unknown> = {}) => ({
    id: 7,
    projectId: 3,
    chapterPosition: 0,
    position: 0,
    status: 'Ready',
    prompt: 'p',
    enhancedPrompt: null,
    imageUrl: 'panel-key',
    imageId: 2,
    workflowId: null,
    errorMessage: null,
    metadata: withContext(),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    references: [],
    image: { ...cleanImage },
    chapter: { project: { userId: OWNER, id: 3, baseModel: 'Flux1' } },
    ...over,
  });
  /** The context key is gone, and the clean candidate key (the control) is kept. */
  const contextFree = (metadata: unknown) => ({
    leaksContext: JSON.stringify(metadata).includes('ctx-blocked'),
    keys: (metadata as { candidateImages: { key?: string }[] }).candidateImages.map(
      (c) => c.key ?? null
    ),
  });
  const clean = { leaksContext: false, keys: ['clean-key'] };
  const givenContextBlocked = () =>
    dbMock.dbWrite.image.findMany.mockResolvedValue([blockedRow('ctx-blocked')] as never);

  it('by updatePanel', async () => {
    givenContextBlocked();
    dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue(row() as never);
    dbMock.dbWrite.comicPanel.update.mockResolvedValue(row() as never);
    const updated = await callerFor(UPLOADER).updatePanel({ panelId: 7, status: 'Generating' });
    expect(contextFree(updated.metadata)).toEqual(clean);
  });

  it('by duplicatePanel, in its response and in the row it writes', async () => {
    givenContextBlocked();
    dbMock.dbRead.comicPanel.findUnique.mockResolvedValue(row() as never);
    dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue(row() as never);
    dbMock.dbWrite.comicPanel.create.mockClear();
    dbMock.dbWrite.comicPanel.create.mockImplementation((async ({ data }: { data: object }) => ({
      id: 9,
      ...data,
    })) as never);
    const copy = await callerFor(UPLOADER).duplicatePanel({ panelId: 7 } as never);
    expect(contextFree(copy.metadata)).toEqual(clean);
    const [[{ data }]] = dbMock.dbWrite.comicPanel.create.mock.calls as unknown as [
      [{ data: { metadata: unknown } }]
    ][];
    expect(contextFree(data.metadata)).toEqual(clean);
  });

  it('by replacePanelImage', async () => {
    givenContextBlocked();
    dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue(
      row({ image: { url: 'panel-key', ...cleanImage } }) as never
    );
    const panel = await callerFor(UPLOADER).replacePanelImage({
      panelId: 7,
      imageUrl: 'panel-key',
    });
    expect(contextFree(panel.metadata)).toEqual(clean);
  });

  it('by getPanelDebugInfo', async () => {
    givenContextBlocked();
    dbMock.dbRead.comicPanel.findUnique.mockResolvedValue(row() as never);
    dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue(row() as never);
    const { panel } = await callerFor(UPLOADER).getPanelDebugInfo({ panelId: 7 });
    expect(contextFree(panel.metadata)).toEqual(clean);
  });

  it('by createPanelFromImage', async () => {
    givenContextBlocked();
    dbMock.dbRead.comicChapter.findUnique.mockResolvedValue({
      project: { userId: OWNER },
    } as never);
    dbMock.dbRead.image.findUnique.mockResolvedValue({
      id: 5,
      userId: OWNER,
      url: 'img',
      ingestion: 'Scanned',
      blockedFor: null,
    } as never);
    dbMock.dbWrite.comicPanel.findFirst.mockResolvedValue(null as never);
    dbMock.dbWrite.comicPanel.create.mockResolvedValue(row() as never);
    const panel = await callerFor(UPLOADER).createPanelFromImage({
      projectId: 3,
      chapterPosition: 0,
      imageId: 5,
    });
    expect(contextFree(panel.metadata)).toEqual(clean);
  });
});

describe('a block that has not reached the replica', () => {
  // The replica still shows the image clean; the primary has the block.
  const panelWith = (image: object) => ({
    id: 7,
    projectId: 3,
    chapterPosition: 0,
    position: 0,
    status: 'Ready',
    prompt: 'p',
    enhancedPrompt: null,
    imageUrl: 'panel-key',
    imageId: 1,
    workflowId: null,
    errorMessage: null,
    metadata: { candidateImages: [{ key: 'panel-key' }] },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    references: [],
    image,
    chapter: { project: { userId: OWNER, baseModel: 'Flux1' } },
  });
  const givenLag = () => {
    dbMock.dbRead.comicPanel.findUnique.mockResolvedValue(panelWith({ ...cleanImage }) as never);
    dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue(
      panelWith(blockedImage(BlockedReason.Moderated)) as never
    );
    dbMock.dbWrite.image.findMany.mockResolvedValue([] as never);
  };

  it('still withholds the image from the debug view', async () => {
    givenLag();
    const { panel } = await callerFor(UPLOADER).getPanelDebugInfo({ panelId: 7 });
    expect(panel.imageUrl).toBeNull();
  });

  it('still refuses a duplicate', async () => {
    givenLag();
    await expect(callerFor(UPLOADER).duplicatePanel({ panelId: 7 } as never)).rejects.toMatchObject(
      { code: 'BAD_REQUEST' }
    );
  });
});
