import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel, OnboardingSteps } from '~/server/common/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OWNER = 5;
const MODERATOR = 6;
const OTHER = 7;

const imageRow = (url: string, nsfwLevel: number, userId = OWNER, id = 0) => ({
  id,
  url,
  nsfwLevel,
  userId,
  modelRestricted: false,
  blockedFor: null,
  needsReview: null,
  ingestion: ImageIngestionStatus.Scanned,
});

const storedMetadata = (sourceImageUrl: string) => ({
  enhanceEnabled: true,
  useContext: false,
  referencePanelId: 3,
  includePreviousImage: true,
  quantity: 2,
  selectedImageIds: [11, 12],
  blockedReason: 'canUpgrade',
  sourceImageUrl,
  previousPanelImageUrl: 'prev-key',
  referencePanelImageUrl: 'ref-panel-key',
  layoutImagePath: 'layout-key',
  referenceImages: [{ url: 'ref-key', width: 1, height: 1 }],
  previousPanelPrompt: 'p',
  somethingNew: 'x',
  generationParams: {
    engine: 'e',
    baseModel: 'b',
    checkpointVersionId: 9,
    width: 512,
    height: 768,
    prompt: 'a',
    negativePrompt: '',
    images: ['nested-key'],
    extra: { url: 'nested-url' },
  },
  candidateImages: [
    'plain-key',
    { key: 'cand-key', nsfwLevel: 1 },
    {
      requiresUnlock: true,
      blockedReason: 'canUpgrade',
      blurredPreviewUrl: 'blur-url',
      key: 'locked-key',
      nsfwLevel: 8,
    },
  ],
});

const shownSelected = [
  imageRow('a', NsfwLevel.PG, OWNER, 11),
  imageRow('b', NsfwLevel.PG, OWNER, 12),
];

type PanelFields = Record<string, unknown>;

async function chapterPanelFor(
  viewer: { id: number; isModerator: boolean },
  {
    source = 'source-key',
    rows = [imageRow('source-key', NsfwLevel.PG)],
    selectedRows = shownSelected,
    isGreen = false,
    panel = {} as PanelFields,
    metadata = storedMetadata(source) as PanelFields,
  } = {}
) {
  dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({ id: 3, userId: OWNER } as never);
  dbMock.dbWrite.comicChapter.findUnique.mockResolvedValue({
    projectId: 3,
    position: 0,
    nsfwLevel: 1,
    panels: [{ id: 1, imageUrl: null, imageId: null, image: null, metadata, ...panel }],
  } as never);
  dbMock.dbWrite.image.findMany.mockImplementation((async (args: {
    where: { id?: unknown; url?: { in: string[] } };
  }) =>
    args.where.id
      ? selectedRows
      : rows.filter((row) => args.where.url?.in.includes(row.url))) as never);
  const caller = comicsRouter.createCaller({
    user: { ...viewer, onboarding: OnboardingSteps.Buzz, muted: false },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { trpcFlagGuardPerRequest: true, comicCreator: true, isGreen },
    req: undefined,
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    track: {},
    ip: '127.0.0.1',
  } as never);
  const chapter = await caller.getChapter({ projectId: 3, chapterPosition: 0 });
  return chapter.panels[0] as unknown as PanelFields;
}

async function panelMetadataFor(
  viewer: { id: number; isModerator: boolean },
  options: Parameters<typeof chapterPanelFor>[1] = {}
) {
  return (await chapterPanelFor(viewer, options)).metadata as PanelFields;
}

const owner = { id: OWNER, isModerator: false };
const moderator = { id: MODERATOR, isModerator: true };

describe('getChapter returned fields', () => {
  it('returns the listed fields to the owner', async () => {
    expect(await panelMetadataFor(owner)).toEqual({
      enhanceEnabled: true,
      useContext: false,
      referencePanelId: 3,
      includePreviousImage: true,
      quantity: 2,
      selectedImageIds: [11, 12],
      blockedReason: 'canUpgrade',
      sourceImageUrl: 'source-key',
      hasSourceImage: true,
      generationParams: {
        engine: 'e',
        baseModel: 'b',
        checkpointVersionId: 9,
        width: 512,
        height: 768,
        prompt: 'a',
        negativePrompt: '',
      },
      candidateImages: [
        { key: 'plain-key', nsfwLevel: null },
        { key: 'cand-key', nsfwLevel: 1 },
        { requiresUnlock: true, blockedReason: 'canUpgrade', nsfwLevel: 8 },
      ],
    });
  });

  it('returns the listed candidate fields to another viewer', async () => {
    expect((await panelMetadataFor(moderator)).candidateImages).toEqual([
      { nsfwLevel: null },
      { nsfwLevel: 1 },
      { requiresUnlock: true, blockedReason: 'canUpgrade', nsfwLevel: 8 },
    ]);
  });

  it('returns the source field to a moderator when its image may be shown', async () => {
    expect((await panelMetadataFor(moderator)).sourceImageUrl).toBe('source-key');
  });

  it('returns the source field to the uploader only, by the shared visibility rule', async () => {
    const rows = [imageRow('source-key', NsfwLevel.Blocked, OWNER)];
    expect((await panelMetadataFor(moderator, { rows })).sourceImageUrl).toBeUndefined();
    expect((await panelMetadataFor(owner, { rows })).sourceImageUrl).toBe('source-key');
  });

  it('withholds the source field when no image row matches', async () => {
    expect((await panelMetadataFor(owner, { rows: [] })).sourceImageUrl).toBeUndefined();
  });

  it('withholds the source field when any matching row may not be shown', async () => {
    const rows = [
      imageRow('source-key', NsfwLevel.PG),
      imageRow('source-key', NsfwLevel.Blocked, OTHER),
    ];
    expect((await panelMetadataFor(owner, { rows })).sourceImageUrl).toBeUndefined();
  });

  it('withholds the source field by level on the green site', async () => {
    const rows = [imageRow('source-key', NsfwLevel.R)];
    expect((await panelMetadataFor(owner, { rows, isGreen: true })).sourceImageUrl).toBeUndefined();
    expect((await panelMetadataFor(owner, { rows })).sourceImageUrl).toBe('source-key');
  });

  it('says a source exists when its url is withheld', async () => {
    const metadata = await panelMetadataFor(owner, { rows: [] });
    expect(metadata.hasSourceImage).toBe(true);
    expect(metadata).not.toHaveProperty('sourceImageUrl');
  });

  it('says no source exists when none was stored', async () => {
    expect((await panelMetadataFor(owner, { source: '' })).hasSourceImage).toBe(false);
  });
});

const candidateMetadata = (candidateImages: unknown[]) => ({ candidateImages });
const SITE_RESTRICTED = { requiresUnlock: true, blockedReason: 'siteRestricted' };

describe('getChapter candidate fields', () => {
  const stored = [
    'plain-key',
    { key: 'safe-key', nsfwLevel: NsfwLevel.PG },
    { key: 'mature-key', nsfwLevel: NsfwLevel.R },
    { key: 'unrated-key', nsfwLevel: 0 },
  ];

  it('returns candidate keys on the green site only for a rated safe level', async () => {
    const metadata = await panelMetadataFor(owner, {
      isGreen: true,
      metadata: candidateMetadata(stored),
    });
    expect(metadata.candidateImages).toEqual([
      { ...SITE_RESTRICTED, nsfwLevel: null },
      { key: 'safe-key', nsfwLevel: NsfwLevel.PG },
      { ...SITE_RESTRICTED, nsfwLevel: NsfwLevel.R },
      { ...SITE_RESTRICTED, nsfwLevel: 0 },
    ]);
  });

  it('returns every unlocked candidate key off the green site', async () => {
    const metadata = await panelMetadataFor(owner, { metadata: candidateMetadata(stored) });
    expect(metadata.candidateImages).toEqual([
      { key: 'plain-key', nsfwLevel: null },
      { key: 'safe-key', nsfwLevel: NsfwLevel.PG },
      { key: 'mature-key', nsfwLevel: NsfwLevel.R },
      { key: 'unrated-key', nsfwLevel: 0 },
    ]);
  });

  it('withholds a candidate key whose image row may not be shown', async () => {
    const metadata = await panelMetadataFor(owner, {
      metadata: candidateMetadata([{ key: 'safe-key', nsfwLevel: NsfwLevel.PG }]),
      rows: [imageRow('safe-key', NsfwLevel.PG), imageRow('safe-key', NsfwLevel.Blocked, OTHER)],
    });
    expect(metadata.candidateImages).toEqual([{ ...SITE_RESTRICTED, nsfwLevel: NsfwLevel.PG }]);
  });

  it('withholds a candidate key on the green site when its image row is rated above it', async () => {
    const metadata = await panelMetadataFor(owner, {
      isGreen: true,
      metadata: candidateMetadata([{ key: 'safe-key', nsfwLevel: NsfwLevel.PG }]),
      rows: [imageRow('safe-key', NsfwLevel.R)],
    });
    expect(metadata.candidateImages).toEqual([{ ...SITE_RESTRICTED, nsfwLevel: NsfwLevel.PG }]);
  });

  it('never returns the key a locked candidate keeps', async () => {
    const locked = { requiresUnlock: true, blockedReason: 'canUpgrade', key: 'kept', nsfwLevel: 1 };
    const metadata = await panelMetadataFor(owner, { metadata: candidateMetadata([locked]) });
    expect(metadata.candidateImages).toEqual([
      { requiresUnlock: true, blockedReason: 'canUpgrade', nsfwLevel: 1 },
    ]);
  });

  it('drops the stored ids, retained keys and output ids', async () => {
    const metadata = await panelMetadataFor(owner, {
      metadata: {
        candidateImages: [{ key: 'safe-key', nsfwLevel: 1, outputId: 'o1' }],
        retainedCandidateKeys: ['old-key'],
      },
    });
    expect(metadata).not.toHaveProperty('retainedCandidateKeys');
    expect(metadata.candidateImages).toEqual([{ key: 'safe-key', nsfwLevel: 1 }]);
  });
});

describe('getChapter panel fields', () => {
  it('returns only the selected ids whose image may be shown', async () => {
    const selectedRows = [
      imageRow('a', NsfwLevel.PG, OWNER, 11),
      imageRow('b', NsfwLevel.Blocked, OTHER, 12),
    ];
    expect((await panelMetadataFor(owner, { selectedRows })).selectedImageIds).toEqual([11]);
  });

  it('returns no selected id that has no image row', async () => {
    expect((await panelMetadataFor(owner, { selectedRows: [] })).selectedImageIds).toEqual([]);
  });

  it('returns no image id or image meta for a withheld panel image', async () => {
    const image = { ...imageRow('panel-key', NsfwLevel.R), meta: { prompt: 'p' } };
    const fields = await chapterPanelFor(owner, {
      isGreen: true,
      panel: { imageUrl: 'panel-key', imageId: 40, image },
    });
    expect(fields.imageUrl).toBeNull();
    expect(fields.imageId).toBeNull();
    expect((fields.image as PanelFields).meta).toBeNull();
  });

  it('returns the image id and meta of a shown panel image', async () => {
    const image = { ...imageRow('panel-key', NsfwLevel.PG), meta: { prompt: 'p' } };
    const fields = await chapterPanelFor(owner, {
      panel: { imageUrl: 'panel-key', imageId: 40, image },
    });
    expect(fields.imageId).toBe(40);
    expect((fields.image as PanelFields).meta).toEqual({ prompt: 'p' });
  });

  it('returns the error text without links', async () => {
    const fields = await chapterPanelFor(owner, {
      panel: { errorMessage: 'failed on https://host.example/a.png?x=1 retry' },
    });
    expect(fields.errorMessage).toBe('failed on [link] retry');
  });

  it('refuses a viewer who is neither the owner nor a moderator', async () => {
    await expect(chapterPanelFor({ id: OTHER, isModerator: false })).rejects.toThrow();
  });

  it('returns no panel image a restricted image row may not show this viewer', async () => {
    const image = {
      ...imageRow('panel-key', NsfwLevel.R, OTHER),
      modelRestricted: true,
      meta: null,
    };
    const fields = await chapterPanelFor(moderator, {
      panel: { imageUrl: 'panel-key', imageId: 40, image },
    });
    expect(fields.imageUrl).toBeNull();
    expect(fields.imageId).toBeNull();
  });

  it('drops non-scalar values, non-numeric ids and non-record metadata', async () => {
    const metadata = await panelMetadataFor(owner, {
      metadata: { quantity: { nested: 1 }, selectedImageIds: ['11', 11] },
    });
    expect(metadata).not.toHaveProperty('quantity');
    expect(metadata.selectedImageIds).toEqual([11]);
    expect(await panelMetadataFor(owner, { metadata: 'raw' as never })).toBeNull();
  });
});

describe('getChapter source fields across panels', () => {
  it('withholds only the source whose own image row may not be shown', async () => {
    dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({ id: 3, userId: OWNER } as never);
    dbMock.dbWrite.comicChapter.findUnique.mockResolvedValue({
      projectId: 3,
      position: 0,
      nsfwLevel: 1,
      panels: ['shown-key', 'blocked-key'].map((source, i) => ({
        id: i + 1,
        imageUrl: null,
        imageId: null,
        image: null,
        metadata: { sourceImageUrl: source },
      })),
    } as never);
    const rows = [
      imageRow('shown-key', NsfwLevel.PG),
      imageRow('blocked-key', NsfwLevel.Blocked, OTHER),
    ];
    dbMock.dbWrite.image.findMany.mockImplementation((async () => rows) as never);
    const caller = comicsRouter.createCaller({
      user: { ...owner, onboarding: OnboardingSteps.Buzz, muted: false },
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
    expect(chapter.panels.map((p) => (p.metadata as PanelFields).sourceImageUrl)).toEqual([
      'shown-key',
      undefined,
    ]);
  });
});
