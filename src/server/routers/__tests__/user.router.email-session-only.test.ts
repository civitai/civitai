import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EmailVerificationService from '~/server/services/email-verification.service';
import type * as UserController from '~/server/controllers/user.controller';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';

/**
 * Changing the account's email, and the onboarding step that sets it, need a signed-in session. An
 * API key or an OAuth app token is refused even when it carries UserWrite. The service and handler
 * are replaced, so these pin the procedure gate only.
 */

const { mockRequestEmailChange, mockCompleteOnboarding } = vi.hoisted(() => ({
  mockRequestEmailChange: vi.fn(),
  mockCompleteOnboarding: vi.fn(),
}));
vi.mock('~/server/services/email-verification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof EmailVerificationService>()),
  requestEmailChange: mockRequestEmailChange,
}));
vi.mock('~/server/controllers/user.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof UserController>()),
  completeOnboardingHandler: mockCompleteOnboarding,
}));

import { userRouter } from '~/server/routers/user.router';

const REQ = { headers: {}, socket: {} };
const USER = { id: 42, tier: 'free', username: 'u', muted: false, onboarding: 0 };

type Credential = {
  apiKeyId?: number;
  tokenScope?: number;
  subject?: { type: 'apiKey'; id: number } | { type: 'oauth'; id: string };
};

const caller = (cred: Credential = {}) =>
  userRouter.createCaller({
    acceptableOrigin: true,
    user: USER,
    apiKeyId: cred.apiKeyId ?? null,
    tokenScope: cred.tokenScope ?? TokenScope.Full,
    subject: cred.subject,
    req: REQ,
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: { userActivity: vi.fn() },
  } as never);

const BEARERS: [string, Credential][] = [
  [
    'an OAuth app token with UserWrite',
    { apiKeyId: 7, tokenScope: TokenScope.UserWrite, subject: { type: 'oauth', id: 'client-1' } },
  ],
  [
    'an API key with UserWrite',
    { apiKeyId: 8, tokenScope: TokenScope.UserWrite, subject: { type: 'apiKey', id: 8 } },
  ],
  [
    'a full-scope API key',
    { apiKeyId: 9, tokenScope: TokenScope.Full, subject: { type: 'apiKey', id: 9 } },
  ],
];

const PROCS = [
  [
    'requestEmailChange',
    (c: ReturnType<typeof caller>) => c.requestEmailChange({ newEmail: 'new@example.test' }),
    mockRequestEmailChange,
  ],
  [
    'completeOnboardingStep',
    (c: ReturnType<typeof caller>) =>
      c.completeOnboardingStep({
        step: OnboardingSteps.Profile,
        username: 'ada',
        email: 'new@example.test',
      }),
    mockCompleteOnboarding,
  ],
] as const;

beforeEach(() => {
  mockRequestEmailChange.mockReset().mockResolvedValue(undefined);
  mockCompleteOnboarding.mockReset().mockResolvedValue(undefined);
});

describe.each(PROCS)('user.%s', (_name, call, target) => {
  it.each(BEARERS)('refuses %s', async (_label, cred) => {
    await expect(call(caller(cred))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(target).not.toHaveBeenCalled();
  });

  it('reaches the handler for a signed-in session', async () => {
    await call(caller());
    expect(target).toHaveBeenCalledTimes(1);
  });
});
