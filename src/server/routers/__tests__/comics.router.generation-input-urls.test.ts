import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

/** Each comics route that sends client urls to a generation checks them before it writes or generates. */

const mocks = vi.hoisted(() => ({
  assertUsable: vi.fn(),
  assertStoredUnblocked: vi.fn(),
  getOrchestratorToken: vi.fn(async () => 'token'),
  submit: vi.fn(),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ comicCreator: true }),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: mocks.getOrchestratorToken,
}));
vi.mock('~/server/services/orchestrator/queue-limits', () => ({
  assertCanGenerate: async () => undefined,
  getUserQueueStatus: async () => ({}),
}));
vi.mock('~/server/services/orchestrator/preset-image-gen.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitPresetImageGen: mocks.submit,
}));
vi.mock('~/server/services/generation-input-urls', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertGenerationInputUrlsUsable: mocks.assertUsable,
  assertStoredImageUrlsUnblocked: mocks.assertStoredUnblocked,
}));

import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { LAYOUT_OPTIONS } from '~/components/Comics/LayoutPicker';

const USER_ID = 7;
const SOURCE = 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
const REF = 'cd34ab12-ef56-4a7b-8c9d-0e1f2a3b4c5d';

const caller = () =>
  comicsRouter.createCaller({
    user: { id: USER_ID, isModerator: false, onboarding: OnboardingSteps.Buzz, muted: false },
    domain: 'red',
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
  } as never);

const refused = new TRPCError({ code: 'BAD_REQUEST', message: 'unavailable' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertUsable.mockRejectedValue(refused);
  const project = { id: 11, userId: USER_ID, baseModel: null };
  dbMock.dbRead.comicProject.findUnique.mockResolvedValue(project);
  dbMock.dbRead.comicChapter.findUnique.mockResolvedValue({ project });
});

/** Nothing written and nothing sent to generation. */
const expectNothingStarted = () => {
  expect(mocks.getOrchestratorToken).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.comicPanel.updateMany).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.comicPanel.findFirst).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.comicPanel.create).not.toHaveBeenCalled();
};

/** The urls of each check, each made for the signed-in user. */
const checkedUrls = () =>
  mocks.assertUsable.mock.calls.map((c) => {
    const { urls, userId } = c[0] as { urls: unknown; userId: number };
    expect(userId).toBe(USER_ID);
    return urls;
  });

describe('comics generation inputs', () => {
  it('iterateGenerate checks its source and reference urls', async () => {
    await expect(
      caller().iterateGenerate({
        projectId: 11,
        chapterPosition: 0,
        prompt: 'p',
        sourceImageUrl: SOURCE,
        sourceImageWidth: 512,
        sourceImageHeight: 512,
        userReferenceImages: [{ url: REF, width: 512, height: 512 }],
      })
    ).rejects.toBe(refused);
    expect(checkedUrls()).toEqual([[SOURCE, REF]]);
    expectNothingStarted();
  });

  it('generateComicImage checks its reference urls', async () => {
    await expect(
      caller().generateComicImage({
        prompt: 'p',
        userReferenceImages: [{ url: REF, width: 512, height: 512 }],
      })
    ).rejects.toBe(refused);
    expect(checkedUrls()).toEqual([[REF]]);
    expectNothingStarted();
  });

  it.each([
    ['a prompt', { prompt: 'make it a comic' }],
    ['forced generation', { forceGenerate: true }],
  ])('enhancePanel checks its source url when given %s', async (_, over) => {
    await expect(
      caller().enhancePanel({
        projectId: 11,
        chapterPosition: 0,
        sourceImageUrl: SOURCE,
        sourceImageWidth: 512,
        sourceImageHeight: 512,
        ...over,
      })
    ).rejects.toBe(refused);
    expect(checkedUrls()).toEqual([[SOURCE]]);
    expectNothingStarted();
  });

  it.each([
    ['no prompt', {}],
    ['a blank prompt', { prompt: '   ' }],
  ])('enhancePanel leaves a source saved with %s to the save checks', async (_, over) => {
    dbMock.dbWrite.comicPanel.findFirst.mockResolvedValue(null);
    await caller()
      .enhancePanel({
        projectId: 11,
        chapterPosition: 0,
        sourceImageUrl: SOURCE,
        sourceImageWidth: 512,
        sourceImageHeight: 512,
        ...over,
      })
      .catch(() => undefined);
    // Reached the save path, so the route did not stop before the check for another reason.
    expect(dbMock.dbWrite.comicPanel.findFirst).toHaveBeenCalled();
    expect(mocks.assertUsable).not.toHaveBeenCalled();
  });

  it('createPanel takes only a bundled layout image path', async () => {
    const input = { projectId: 11, chapterPosition: 0, prompt: 'p' };
    for (const layoutImagePath of ['@evil.example/x.png', '/../x.png', '//evil.example/x.png'])
      await expect(caller().createPanel({ ...input, layoutImagePath })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('layoutImagePath'),
      });
    for (const { imagePath } of LAYOUT_OPTIONS)
      await expect(
        caller().createPanel({ ...input, layoutImagePath: imagePath })
      ).rejects.not.toMatchObject({ message: expect.stringContaining('layoutImagePath') });
  });

  it('bulkCreatePanels checks the source url of every panel it generates, and only those', async () => {
    await expect(
      caller().bulkCreatePanels({
        projectId: 11,
        chapterPosition: 0,
        panels: [
          { prompt: 'p', sourceImageUrl: SOURCE, sourceImageWidth: 512, sourceImageHeight: 512 },
          { sourceImageUrl: REF, sourceImageWidth: 512, sourceImageHeight: 512 },
          { prompt: '  ', sourceImageUrl: REF, sourceImageWidth: 512, sourceImageHeight: 512 },
          { prompt: 'text only' },
        ],
      })
    ).rejects.toBe(refused);
    expect(checkedUrls()).toEqual([[SOURCE]]);
    expectNothingStarted();
  });
});

describe('comics generation inputs the server loads', () => {
  beforeEach(() => {
    mocks.assertUsable.mockResolvedValue(undefined);
    dbMock.dbRead.comicPanel.findFirst.mockResolvedValue({ imageUrl: REF });
  });

  it.each([
    [
      'createPanel',
      () =>
        caller().createPanel({
          projectId: 11,
          chapterPosition: 0,
          prompt: 'p',
          referencePanelId: 3,
        }),
    ],
    [
      'enhancePanel',
      () =>
        caller().enhancePanel({
          projectId: 11,
          chapterPosition: 0,
          sourceImageUrl: SOURCE,
          sourceImageWidth: 512,
          sourceImageHeight: 512,
          prompt: 'p',
          referencePanelId: 3,
        }),
    ],
  ])('%s checks its reference panel image before it starts', async (_, run) => {
    mocks.assertStoredUnblocked.mockRejectedValueOnce(refused);
    await expect(run()).rejects.toBe(refused);
    expect(mocks.assertStoredUnblocked).toHaveBeenCalledExactlyOnceWith([REF]);
    // Only a panel in the caller's project is looked up.
    expect(dbMock.dbRead.comicPanel.findFirst).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: { id: 3, chapter: { projectId: 11 } } })
    );
    expectNothingStarted();
  });

  it("sends a reference's unblocked images and leaves out a blocked one", async () => {
    dbMock.dbRead.comicReference.findMany.mockResolvedValue([{ id: 5, name: 'A' }]);
    dbMock.dbRead.comicReference.findUnique.mockResolvedValue({
      name: 'A',
      images: [
        { image: { id: 1, url: REF, width: 512, height: 512, blockedFor: 'moderated' } },
        { image: { id: 2, url: SOURCE, width: 512, height: 512, blockedFor: null } },
      ],
    });
    mocks.submit.mockRejectedValue(new Error('stop'));
    await caller()
      .iterateGenerate({ projectId: 11, chapterPosition: 0, prompt: 'p', referenceIds: [5] })
      .catch(() => undefined);
    expect(mocks.submit).toHaveBeenCalledOnce();
    const sent = (mocks.submit.mock.calls[0][0] as { images: { url: string }[] }).images;
    expect(sent.map((i) => i.url)).toEqual([expect.stringContaining(SOURCE)]);
  });
});
