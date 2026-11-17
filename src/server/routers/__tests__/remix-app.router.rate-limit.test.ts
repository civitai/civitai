import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvOther from '~/env/other';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * run, start and advance each reach the orchestrator on every call. The REAL `rateLimit` runs
 * here: `~/env/other` says this is not a test (it skips itself in tests), the caller is not a
 * moderator (it skips them), and redis holds the recorded attempts.
 */

const h = vi.hoisted(() => ({
  startRemixRun: vi.fn(async () => ({ status: 'running' })),
  advanceRemixRun: vi.fn(async () => ({ status: 'running' })),
  runRemixApp: vi.fn(async () => ({ workflowId: 'wf-1' })),
}));

vi.mock('~/server/services/remix-app-run.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startRemixRun: h.startRemixRun,
  advanceRemixRun: h.advanceRemixRun,
}));
vi.mock('~/server/services/remix-app.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runRemixApp: h.runRemixApp,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(async () => 'orch-token'),
}));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: vi.fn(async () => undefined) }));
vi.mock('~/env/other', async () => ({
  ...(await vi.importActual<typeof EnvOther>('~/env/other')),
  isDev: false,
  isTest: false,
  isPreview: false,
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';

const { remixAppRouter } = await import('~/server/routers/remix-app.router');

const user = { id: 42, isModerator: false, onboarding: OnboardingSteps.Buzz, muted: false };
const caller = () =>
  remixAppRouter.createCaller({
    user,
    acceptableOrigin: true,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    features: { remixApps: true, trpcFlagGuardPerRequest: true },
    domain: 'green',
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
  } as never);

/** `n` attempts spread across the last 59 seconds. */
const attempts = (n: number) =>
  Array.from({ length: n }, (_, i) => Date.now() - Math.round((59_000 * i) / n));

const procedures = [
  {
    name: 'run',
    call: () => caller().run({ slug: 'anime-it', imageId: 5, nonce: 'nonce-0001', quote: 30 }),
    service: h.runRemixApp,
  },
  {
    name: 'start',
    call: () => caller().start({ slug: 'anime-it', imageId: 5, nonce: 'nonce-0001' }),
    service: h.startRemixRun,
  },
  {
    name: 'advance',
    call: () => caller().advance({ runId: `r${'0'.repeat(20)}` }),
    service: h.advanceRemixRun,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(procedures)('remixApp.$name', ({ call, service }) => {
  it('refuses the 31st call in a minute before reaching the service', async () => {
    redisMock.redis.packed.hGet.mockResolvedValue(attempts(30));
    await expect(call()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(service).not.toHaveBeenCalled();
  });

  it('serves the 30th', async () => {
    redisMock.redis.packed.hGet.mockResolvedValue(attempts(29));
    await expect(call()).resolves.toBeDefined();
    expect(service).toHaveBeenCalledTimes(1);
  });
});
