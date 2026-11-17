import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as GenerationService from '~/server/services/generation/generation.service';

/**
 * The generation kill switch refuses a preset action before its first paid or committed step:
 *   - comics smart create, before the chapter or any panel is written (it queues panels for the
 *     background job, which would otherwise fail them one by one);
 *   - comics planChapterPanels, before the paid story plan;
 *   - comics enhancePromptText, before the paid prompt enhancement;
 *   - orchestrator iterateGenerate, before the paid prompt enhancement.
 */

const h = vi.hoisted(() => ({
  state: { known: true, status: { mode: 'enabled', message: 'paused' } } as {
    known: boolean;
    status: { mode: string; message: string };
  },
  // Rejecting ends the procedure at its first step past the gate.
  getOrchestratorToken: vi.fn(async (): Promise<string> => {
    throw new Error('past the gate');
  }),
  planChapterPanels: vi.fn(),
  enhanceComicPrompt: vi.fn(),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ comicCreator: true }),
}));
vi.mock('~/server/services/generation/generation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationService>()),
  getGenerationStatusState: async () => h.state,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: h.getOrchestratorToken,
}));
vi.mock('~/server/services/comics/story-plan', () => ({
  planChapterPanels: h.planChapterPanels,
}));
vi.mock('~/server/services/comics/prompt-enhance', () => ({
  enhanceComicPrompt: h.enhanceComicPrompt,
}));

import { comicsRouter, getOrchestratorErrorMessage } from '../comics.router';
import { GenerationStatusRefusedError } from '~/server/services/generation/generation-kill-switch';
import { orchestratorRouter } from '../orchestrator.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

const USER_ID = 7;

const ctxFor = (user: { isModerator: boolean; tier?: string }) =>
  ({
    user: {
      id: USER_ID,
      onboarding: OnboardingSteps.Buzz,
      emailVerified: new Date('2020-01-01'),
      muted: false,
      bannedAt: null,
      ...user,
    },
    domain: 'red',
    acceptableOrigin: true,
    needsUpdate: false,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    features: { comicCreator: true },
    req: undefined,
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    track: {},
    ip: '127.0.0.1',
    fingerprint: 'test',
  } as never);

const smartCreate = (user: { isModerator: boolean; tier?: string }) =>
  comicsRouter
    .createCaller(ctxFor(user))
    .smartCreateChapter({ projectId: 11, panels: [{ prompt: 'a cat' }] });
const planPanels = (user: { isModerator: boolean; tier?: string }) =>
  comicsRouter
    .createCaller(ctxFor(user))
    .planChapterPanels({ projectId: 11, storyDescription: 'a story' });
const enhancePromptText = (user: { isModerator: boolean; tier?: string }) =>
  comicsRouter
    .createCaller(ctxFor(user))
    .enhancePromptText({ projectId: 11, chapterPosition: 0, prompt: 'a cat' });
const iterate = (user: { isModerator: boolean; tier?: string }) =>
  orchestratorRouter.createCaller(ctxFor(user)).iterateGenerate({ prompt: 'a cat' });

const givenSwitch = (mode: string, known = true) => {
  h.state = { known, status: { mode, message: 'paused' } };
};

const expectNothingWritten = () => {
  expect(h.getOrchestratorToken).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.comicChapter.create).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.comicPanel.create).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  resetEnv();
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: false, bannedAt: null } as never);
  dbMock.dbRead.comicProject.findUnique.mockResolvedValue({ userId: USER_ID } as never);
  dbMock.dbRead.comicChapter.findUnique.mockResolvedValue({
    project: { userId: USER_ID },
  } as never);
  dbMock.dbRead.comicReference.findMany.mockResolvedValue([] as never);
});

describe('comics smart create obeys the generation kill switch', () => {
  it.each([
    ['disabled', { isModerator: false, tier: 'gold' }],
    ['memberOnly', { isModerator: false, tier: 'free' }],
    ['memberOnly', { isModerator: false }],
  ])('%s refuses %j before anything is written', async (mode, user) => {
    givenSwitch(mode);
    await expect(smartCreate(user)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'paused',
    });
    expectNothingWritten();
  });

  it('a switch that cannot be read refuses a moderator too', async () => {
    givenSwitch('enabled', false);
    await expect(smartCreate({ isModerator: true })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expectNothingWritten();
  });

  it.each([
    ['disabled', { isModerator: true, tier: 'free' }],
    ['memberOnly', { isModerator: false, tier: 'gold' }],
    ['enabled', { isModerator: false, tier: 'free' }],
  ])('%s lets %j past the gate', async (mode, user) => {
    givenSwitch(mode);
    await expect(smartCreate(user)).rejects.toThrow('past the gate');
    expect(h.getOrchestratorToken).toHaveBeenCalledTimes(1);
  });

  it('PRESET_ENFORCE_GENERATION_STATUS off: disabled no longer refuses (the previous behaviour)', async () => {
    setEnv({ PRESET_ENFORCE_GENERATION_STATUS: false });
    givenSwitch('disabled', false);
    await expect(smartCreate({ isModerator: false, tier: 'free' })).rejects.toThrow(
      'past the gate'
    );
  });
});

describe.each([
  ['comics planChapterPanels', planPanels, () => h.planChapterPanels],
  ['comics enhancePromptText', enhancePromptText, () => h.enhanceComicPrompt],
  ['orchestrator iterateGenerate', iterate, () => h.enhanceComicPrompt],
])('%s obeys the generation kill switch', (_, call, paidStep) => {
  it.each([
    ['disabled', { isModerator: false, tier: 'gold' }],
    ['memberOnly', { isModerator: false, tier: 'free' }],
  ])('%s refuses %j before anything is charged', async (mode, user) => {
    givenSwitch(mode);
    await expect(call(user)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'paused' });
    expect(h.getOrchestratorToken).not.toHaveBeenCalled();
    expect(paidStep()).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled', { isModerator: true, tier: 'free' }],
    ['memberOnly', { isModerator: false, tier: 'gold' }],
  ])('%s lets %j past the gate', async (mode, user) => {
    givenSwitch(mode);
    await expect(call(user)).rejects.toThrow('past the gate');
  });

  it('PRESET_ENFORCE_GENERATION_STATUS off: not refused', async () => {
    setEnv({ PRESET_ENFORCE_GENERATION_STATUS: false });
    givenSwitch('disabled');
    await expect(call({ isModerator: false, tier: 'free' })).rejects.toThrow('past the gate');
  });
});

// Every comics path shows a failed generation through getOrchestratorErrorMessage, which rewrites
// errors that mention a network, a timeout or Buzz. The operator's refusal is shown as written.
describe("comics show the kill switch's refusal verbatim", () => {
  it.each([
    'Generation is paused for network maintenance',
    'Members only while we add Buzz capacity',
  ])('%j', (message) => {
    expect(getOrchestratorErrorMessage(new GenerationStatusRefusedError(message))).toBe(message);
  });

  it('CONTROL: an orchestrator error with the same words is still rewritten', () => {
    expect(getOrchestratorErrorMessage(new Error('network maintenance'))).not.toBe(
      'network maintenance'
    );
  });
});
