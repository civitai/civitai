import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as GenerationService from '~/server/services/generation/generation.service';

/**
 * Smart create is the one comics path that queues panels for the background job. The generation
 * kill switch refuses it up front, before the chapter or any panel is written, so a refused caller
 * is told why now instead of finding a chapter of Failed panels later.
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

import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

const USER_ID = 7;

const smartCreate = (user: { isModerator: boolean; tier?: string }) =>
  comicsRouter
    .createCaller({
      user: { id: USER_ID, onboarding: OnboardingSteps.Buzz, muted: false, ...user },
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
    } as never)
    .smartCreateChapter({ projectId: 11, panels: [{ prompt: 'a cat' }] });

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
