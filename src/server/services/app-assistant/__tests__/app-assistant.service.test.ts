import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/setup';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

const { mintAppTokenMock, featuresMock, devTunnelEnabledMock, resolveFrameMock } = vi.hoisted(
  () => ({
    mintAppTokenMock: vi.fn(async () => ({
      accessToken: 'civ_assistant_oauth',
      expiresAt: '2099-01-01T01:00:00Z',
      expiresIn: 3600,
      scope: 0,
    })),
    featuresMock: vi.fn<() => Record<string, boolean | undefined>>(),
    devTunnelEnabledMock: vi.fn(async () => true),
    resolveFrameMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  })
);
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  mintAppToken: mintAppTokenMock,
}));
vi.mock('~/server/http/orchestrator/api-key-spend', () => ({
  bustBuzzLimitCache: vi.fn(async () => undefined),
  deleteAuthSubject: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/civitai', () => ({
  invalidateCivitaiUser: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => featuresMock()),
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksDevTunnelEnabled: devTunnelEnabledMock,
}));
vi.mock('~/server/services/blocks/dev-tunnel-frame.service', () => ({
  resolveDevTunnelFrame: resolveFrameMock,
}));

import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type { SessionUser } from '~/types/session';
import { APP_ASSISTANT_DAILY_BUZZ_CAP } from '~/shared/constants/app-assistant.constants';
import {
  appAssistantClientId,
  enableAppAssistant,
  getAppAssistantPreview,
  getAppAssistantRefusal,
  mintAppAssistantToken,
} from '../app-assistant.service';

const USER_ID = 42;
const CLIENT_ID = 'appassist-42';
const SCOPE = TokenScope.UserRead | TokenScope.AIServicesWrite;
const ON = { appBlocks: true, appAssistant: true };

const user = (overrides: Partial<SessionUser> = {}) =>
  ({
    id: USER_ID,
    onboarding: OnboardingSteps.Buzz,
    emailVerified: new Date('2024-01-01'),
    ...overrides,
  } as SessionUser);

beforeEach(() => {
  vi.clearAllMocks();
  featuresMock.mockReturnValue(ON);
  devTunnelEnabledMock.mockResolvedValue(true);
  dbMock.dbWrite.oauthClient.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.oauthClient.upsert.mockResolvedValue({ id: CLIENT_ID });
  dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.oauthConsent.upsert.mockResolvedValue({ id: 1 });
});

describe('getAppAssistantRefusal', () => {
  it('admits a verified, onboarded user who holds both flags', async () => {
    expect(await getAppAssistantRefusal({ user: user() })).toBeNull();
  });

  it.each([
    ['the feature flag is off', ON, { appBlocks: true }],
    ['the block runtime is off', ON, { appAssistant: true }],
  ])('refuses when %s', async (_label, _on, features) => {
    featuresMock.mockReturnValue(features);
    expect(await getAppAssistantRefusal({ user: user() })).toEqual({
      status: 403,
      error: 'App Assistant is not available on this account',
    });
  });

  it('refuses a banned user before reading any flag', async () => {
    const refusal = await getAppAssistantRefusal({ user: user({ bannedAt: new Date() }) });
    expect(refusal?.error).toMatch(/banned/);
    expect(featuresMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a muted user', { muted: true }, /restricted/],
    ['a user who has not finished onboarding', { onboarding: 0 }, /onboarding/],
    [
      'a new user who has not verified their email',
      { emailVerified: null, meta: { emailVerificationRequired: true } },
      /Verify your email/,
    ],
  ] as const)('refuses %s before reading any flag', async (_label, overrides, error) => {
    const refusal = await getAppAssistantRefusal({
      user: user(overrides as Partial<SessionUser>),
    });
    expect(refusal?.error).toMatch(error);
    expect(featuresMock).not.toHaveBeenCalled();
  });
});

describe('enableAppAssistant', () => {
  it("creates the user's own client and consents them with a daily cap", async () => {
    await enableAppAssistant(USER_ID);

    expect(appAssistantClientId(USER_ID)).toBe(CLIENT_ID);
    expect(CLIENT_ID.startsWith('firstparty-')).toBe(false);
    const upsert = dbMock.dbWrite.oauthClient.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ id: CLIENT_ID });
    expect(upsert.update).toEqual({ allowedScopes: SCOPE });
    expect(upsert.create).toMatchObject({
      id: CLIENT_ID,
      userId: USER_ID,
      allowedScopes: SCOPE,
      redirectUris: [],
      grants: [],
      isConfidential: false,
    });
    expect(dbMock.dbWrite.oauthConsent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          userId: USER_ID,
          clientId: CLIENT_ID,
          scope: SCOPE,
          buzzLimit: [
            expect.objectContaining({ limit: APP_ASSISTANT_DAILY_BUZZ_CAP, window: 'day' }),
          ],
        },
      })
    );
    expect(mintAppTokenMock).not.toHaveBeenCalled();
  });

  it('writes nothing once client and consent are in place, so a limit the user changed survives', async () => {
    dbMock.dbWrite.oauthClient.findUnique.mockResolvedValue({ allowedScopes: SCOPE });
    dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue({
      scope: SCOPE,
      buzzLimit: [{ type: 'sliding', unit: 1, window: 'day', limit: 250 }],
    });

    await enableAppAssistant(USER_ID);

    expect(dbMock.dbWrite.oauthConsent.upsert).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.oauthClient.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['a custom limit', [{ type: 'sliding', unit: 1, window: 'day', limit: 250 }]],
    ['no limit', null],
  ])(
    "widens a consent missing the spend bit while keeping the user's limit (%s)",
    async (_l, buzzLimit) => {
      dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue({
        scope: TokenScope.UserRead,
        buzzLimit,
      });

      await enableAppAssistant(USER_ID);

      expect(dbMock.dbWrite.oauthConsent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { scope: SCOPE, buzzLimit: buzzLimit ?? Prisma.DbNull } })
      );
    }
  );

  it('heals a client whose allowed scopes were narrowed', async () => {
    dbMock.dbWrite.oauthClient.findUnique.mockResolvedValue({ allowedScopes: TokenScope.UserRead });
    await enableAppAssistant(USER_ID);
    expect(dbMock.dbWrite.oauthClient.upsert.mock.calls[0][0].update).toEqual({
      allowedScopes: SCOPE,
    });
  });
});

describe('mintAppAssistantToken', () => {
  it('mints the spending scope for the chat against an existing consent, writing nothing', async () => {
    dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue({ scope: SCOPE });

    expect(await mintAppAssistantToken(USER_ID, 'chat')).toEqual({
      token: 'civ_assistant_oauth',
      expiresAt: '2099-01-01T01:00:00Z',
    });
    expect(mintAppTokenMock).toHaveBeenCalledWith({
      userId: USER_ID,
      clientId: CLIENT_ID,
      scope: SCOPE,
    });
    expect(dbMock.dbWrite.oauthConsent.upsert).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.oauthClient.upsert).not.toHaveBeenCalled();
  });

  it('mints UserRead alone for the sandbox service', async () => {
    dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue({ scope: SCOPE });
    await mintAppAssistantToken(USER_ID, 'sandbox');
    expect(mintAppTokenMock).toHaveBeenCalledWith({
      userId: USER_ID,
      clientId: CLIENT_ID,
      scope: TokenScope.UserRead,
    });
  });

  it.each([
    ['never turned on (or revoked)', null],
    ['a consent without the spend bit', { scope: TokenScope.UserRead }],
  ])('returns null and re-grants nothing when there is %s', async (_label, consent) => {
    dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue(consent);
    expect(await mintAppAssistantToken(USER_ID, 'chat')).toBeNull();
    expect(mintAppTokenMock).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.oauthConsent.upsert).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.oauthClient.upsert).not.toHaveBeenCalled();
  });
});

describe('getAppAssistantPreview', () => {
  const frame = { blockId: 'my-app', iframeSrc: 'https://dev-0123456789abcdef.civit.ai/?dev=t' };

  it('returns the frame when the caller authors, has dev tunnels, and the tunnel is live', async () => {
    featuresMock.mockReturnValue({ ...ON, appBlocksAuthor: true });
    resolveFrameMock.mockResolvedValue(frame);
    expect(await getAppAssistantPreview({ user: user(), blockId: 'my-app' })).toEqual({
      status: 'ok',
      frame,
    });
    expect(resolveFrameMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      'my-app'
    );
  });

  it('refuses without the author capability or the dev-tunnel flag, before resolving anything', async () => {
    featuresMock.mockReturnValue(ON);
    expect((await getAppAssistantPreview({ user: user(), blockId: 'my-app' })).status).toBe(
      'forbidden'
    );
    featuresMock.mockReturnValue({ ...ON, appBlocksAuthor: true });
    devTunnelEnabledMock.mockResolvedValue(false);
    expect((await getAppAssistantPreview({ user: user(), blockId: 'my-app' })).status).toBe(
      'forbidden'
    );
    expect(resolveFrameMock).not.toHaveBeenCalled();
  });

  it('separates an app that is not theirs from one with no tunnel yet', async () => {
    featuresMock.mockReturnValue({ ...ON, appBlocksAuthor: true });
    resolveFrameMock.mockResolvedValue(null);
    expect((await getAppAssistantPreview({ user: user(), blockId: 'x-app' })).status).toBe(
      'not-found'
    );
    resolveFrameMock.mockResolvedValue({ ...frame, iframeSrc: null });
    expect((await getAppAssistantPreview({ user: user(), blockId: 'my-app' })).status).toBe(
      'no-tunnel'
    );
  });
});
