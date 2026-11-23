import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel, OnboardingSteps } from '~/server/common/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OWNER = 5;
const MODERATOR = 6;
const OTHER = 7;

const imageRow = (url: string, nsfwLevel: number, userId = OWNER) => ({
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

async function panelMetadataFor(
  viewer: { id: number; isModerator: boolean },
  { source = 'source-key', rows = [imageRow('source-key', NsfwLevel.PG)], isGreen = false } = {}
) {
  dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({ id: 3, userId: OWNER } as never);
  dbMock.dbWrite.comicChapter.findUnique.mockResolvedValue({
    projectId: 3,
    position: 0,
    nsfwLevel: 1,
    panels: [{ id: 1, imageUrl: null, image: null, metadata: storedMetadata(source) }],
  } as never);
  dbMock.dbWrite.image.findMany.mockResolvedValue(rows as never);
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
  return chapter.panels[0].metadata as Record<string, unknown>;
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
