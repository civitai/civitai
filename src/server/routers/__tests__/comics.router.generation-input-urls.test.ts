import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

/** Each comics route that sends client urls to a generation checks them before it writes or generates. */

const mocks = vi.hoisted(() => ({
  assertUsable: vi.fn(),
  getOrchestratorToken: vi.fn(async () => 'token'),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ comicCreator: true }),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: mocks.getOrchestratorToken,
}));
vi.mock('~/server/services/generation-input-urls', () => ({
  assertGenerationInputUrlsUsable: mocks.assertUsable,
}));

import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

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

const checkedUrls = () =>
  mocks.assertUsable.mock.calls.map((c) => (c[0] as { urls: unknown }).urls);

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
    expect(mocks.assertUsable).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }));
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

  it('enhancePanel leaves a source saved without a prompt to the save checks', async () => {
    dbMock.dbWrite.comicPanel.findFirst.mockResolvedValue(null);
    await caller()
      .enhancePanel({
        projectId: 11,
        chapterPosition: 0,
        sourceImageUrl: SOURCE,
        sourceImageWidth: 512,
        sourceImageHeight: 512,
      })
      .catch(() => undefined);
    expect(mocks.assertUsable).not.toHaveBeenCalled();
  });

  it('bulkCreatePanels checks the source url of every panel it generates, and only those', async () => {
    await expect(
      caller().bulkCreatePanels({
        projectId: 11,
        chapterPosition: 0,
        panels: [
          { prompt: 'p', sourceImageUrl: SOURCE, sourceImageWidth: 512, sourceImageHeight: 512 },
          { sourceImageUrl: REF, sourceImageWidth: 512, sourceImageHeight: 512 },
          { prompt: 'text only' },
        ],
      })
    ).rejects.toBe(refused);
    expect(checkedUrls()).toEqual([[SOURCE, undefined]]);
    expectNothingStarted();
  });
});
