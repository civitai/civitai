import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as Workflows from '~/server/services/orchestrator/workflows';

/**
 * The orchestrator client resolves on an HTTP error, so a refused unlock (no Buzz, the cap) must be
 * surfaced by the site. The orchestrator client is faked at `@civitai/orchestration-client`; the site's own
 * `updateWorkflow` runs for real and turns the response into the error the panel's toast shows.
 */

const mocks = vi.hoisted(() => ({ getWorkflow: vi.fn() }));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ comicCreator: true }),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: async () => 'token',
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  getWorkflow: mocks.getWorkflow,
}));

import { handleError, updateWorkflow as clientUpdateWorkflow } from '@civitai/orchestration-client';
import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const USER_ID = 7;
const PANEL_ID = 21;

function caller({ domain = 'red', showNsfw = true } = {}) {
  return comicsRouter.createCaller({
    user: {
      id: USER_ID,
      isModerator: false,
      onboarding: OnboardingSteps.Buzz,
      muted: false,
      showNsfw,
    },
    domain,
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
}

const unlock = (opts?: Parameters<typeof caller>[0]) =>
  caller(opts).unlockPanelGeneration({ panelId: PANEL_ID });

/** The orchestrator refuses the unlock write, as the generated client reports it: resolved. */
const orchestratorRefuses = (status: number, detail: string) =>
  vi.mocked(clientUpdateWorkflow).mockResolvedValue({
    data: undefined,
    error: { detail },
    response: { ok: false, status },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(handleError).mockImplementation((error) => (error as { detail: string }).detail);
  const panel = {
    id: PANEL_ID,
    projectId: 11,
    workflowId: 'wf-1',
    status: 'RequireUnlock',
    metadata: { quantity: 1, blockedReason: 'canUpgrade' },
    chapter: { project: { userId: USER_ID } },
  };
  dbMock.dbRead.comicPanel.findUnique.mockResolvedValue(panel);
  dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue(panel);
  // Locked, with an output the unlock would release.
  mocks.getWorkflow.mockResolvedValue({
    id: 'wf-1',
    status: 'succeeded',
    allowMatureContent: false,
    steps: [
      {
        $type: 'comfy',
        name: '$0',
        output: { blobs: [{ id: 'b0', available: true, nsfwLevel: 'x', url: 'https://x/b0' }] },
      },
    ],
  });
});

describe('comics.unlockPanelGeneration - an orchestrator refusal', () => {
  it("shows the orchestrator's insufficient-Buzz refusal and leaves the panel alone", async () => {
    orchestratorRefuses(403, 'You need 120 more yellow Buzz to unlock this.');

    await expect(unlock()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'You need 120 more yellow Buzz to unlock this.',
    });
    expect(clientUpdateWorkflow).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.comicPanel.update).not.toHaveBeenCalled();
  });

  it("shows the orchestrator's 400 refusal", async () => {
    orchestratorRefuses(400, 'This workflow cannot be upgraded.');

    await expect(unlock()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This workflow cannot be upgraded.',
    });
    expect(dbMock.dbWrite.comicPanel.update).not.toHaveBeenCalled();
  });

  it('keeps a rate limit a rate limit', async () => {
    orchestratorRefuses(429, 'Slow down.');

    await expect(unlock()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });
});

describe('comics.unlockPanelGeneration - who may unlock', () => {
  beforeEach(() => orchestratorRefuses(403, 'refused'));

  it('refuses a user with mature content off, before reaching the orchestrator', async () => {
    await expect(unlock({ showNsfw: false })).rejects.toThrow(/Enable mature content/);
    expect(mocks.getWorkflow).not.toHaveBeenCalled();
    expect(clientUpdateWorkflow).not.toHaveBeenCalled();
  });

  it('refuses the green domain, before reaching the orchestrator', async () => {
    await expect(unlock({ domain: 'green' })).rejects.toThrow(/civitai\.red/);
    expect(mocks.getWorkflow).not.toHaveBeenCalled();
    expect(clientUpdateWorkflow).not.toHaveBeenCalled();
  });

  it('CONTROL: sends the unlock for a red-domain user with mature content on', async () => {
    await expect(unlock()).rejects.toThrow('refused');
    expect(clientUpdateWorkflow).toHaveBeenCalledTimes(1);
  });
});
