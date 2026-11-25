import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/setup';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
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
  revokeCivitaiUserTokens: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => featuresMock()),
  isFliptDecisive: vi.fn(async () => decisiveMock()),
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksDevTunnelEnabled: devTunnelEnabledMock,
}));
vi.mock('~/server/services/blocks/dev-tunnel-frame.service', () => ({
  resolveDevTunnelFrame: resolveFrameMock,
}));
const { cachedSessionMock, decisiveMock } = vi.hoisted(() => ({
  cachedSessionMock: vi.fn<(id: number) => Promise<unknown>>(),
  decisiveMock: vi.fn<() => boolean>(() => true),
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: cachedSessionMock },
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
  getAppAssistantRefusalForUserId,
  getRunnerDevTunnelUser,
  mintAppAssistantToken,
} from '../app-assistant.service';
import { getFeatureFlagsAsync, isFliptDecisive } from '~/server/services/feature-flags.service';

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

describe('getAppAssistantRefusalForUserId (the runner’s mints)', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: USER_ID,
    bannedAt: null,
    onboarding: OnboardingSteps.Buzz,
    muted: false,
    emailVerified: new Date('2024-01-01'),
    meta: {},
    isModerator: false,
    ...overrides,
  });

  beforeEach(() => {
    // The session cache still holds the user as they were: clean, verified, onboarded.
    cachedSessionMock.mockResolvedValue(user({ tier: 'gold' } as Partial<SessionUser>));
    decisiveMock.mockReturnValue(true);
  });

  it('answers unavailable, never a refusal, when the session hub misses the user', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row() as never);
    cachedSessionMock.mockResolvedValue(null);
    // Even with the flags reading off on the bare row, as they would for a tier-segmented rollout.
    featuresMock.mockReturnValue({ appBlocks: true, appAssistant: false });
    expect(await getAppAssistantRefusalForUserId(USER_ID)).toMatchObject({
      status: 503,
      unavailable: true,
    });
  });

  it('answers unavailable when Flipt cannot decide the flags (the static fallback is not a refusal)', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row() as never);
    decisiveMock.mockReturnValue(false);
    featuresMock.mockReturnValue({ appBlocks: false, appAssistant: false });
    expect(await getAppAssistantRefusalForUserId(USER_ID)).toMatchObject({
      status: 503,
      unavailable: true,
    });
  });

  it('still refuses a banned user while the session hub or Flipt is down', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row({ bannedAt: new Date() }) as never);
    cachedSessionMock.mockResolvedValue(null);
    decisiveMock.mockReturnValue(false);
    expect(await getAppAssistantRefusalForUserId(USER_ID)).toMatchObject({
      status: 403,
      error: expect.stringMatching(/banned/),
    });
  });

  it('admits a user every gate admits', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row() as never);
    expect(await getAppAssistantRefusalForUserId(USER_ID)).toBeNull();
  });

  it('refuses a user banned since their session was cached, reading the database, not the cache', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row({ bannedAt: new Date() }) as never);
    expect(await getAppAssistantRefusalForUserId(USER_ID)).toMatchObject({
      status: 403,
      error: expect.stringMatching(/banned/),
    });
    expect(dbMock.dbWrite.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: USER_ID } })
    );
  });

  it('refuses a muted, unonboarded or unverified user, as the token route does', async () => {
    for (const [name, overrides] of [
      ['muted', { muted: true }],
      ['onboarding', { onboarding: 0 }],
      ['unverified', { emailVerified: null, meta: { emailVerificationRequired: true } }],
    ] as const) {
      dbMock.dbWrite.user.findUnique.mockResolvedValue(row(overrides) as never);
      expect(await getAppAssistantRefusalForUserId(USER_ID), name).toMatchObject({ status: 403 });
    }
  });

  it('refuses when the App Assistant flag is off for the user, judged with no request', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row() as never);
    featuresMock.mockReturnValue({ appBlocks: true, appAssistant: false });
    expect(await getAppAssistantRefusalForUserId(USER_ID)).toMatchObject({
      status: 403,
      error: 'App Assistant is not available on this account',
    });
    // Evaluated as for the user on civitai.com: the runner's own request is never handed in, and
    // Flipt's targeting attributes the database does not hold come from the session.
    expect(vi.mocked(getFeatureFlagsAsync)).toHaveBeenLastCalledWith({
      user: expect.objectContaining({ id: USER_ID, tier: 'gold', bannedAt: null }),
    });
  });

  it('refuses a user who no longer exists', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(null as never);
    expect(await getAppAssistantRefusalForUserId(USER_ID)).toMatchObject({ status: 403 });
  });

  it('with remoteRunner, also refuses once the server runner is off for the user (its kill switch)', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row() as never);
    featuresMock.mockReturnValue({ ...ON, appAssistantRemoteRunner: false });
    expect(await getAppAssistantRefusalForUserId(USER_ID, { remoteRunner: true })).toMatchObject({
      status: 403,
      error: 'Replies on the server are not available on this account',
    });
    // Control: the same user is admitted with the runner on, and without asking about it.
    expect(await getAppAssistantRefusalForUserId(USER_ID)).toBeNull();
    featuresMock.mockReturnValue({ ...ON, appAssistantRemoteRunner: true });
    expect(await getAppAssistantRefusalForUserId(USER_ID, { remoteRunner: true })).toBeNull();
  });

  it('with remoteRunner, answers unavailable (asked again), never a refusal, while Flipt cannot decide the runner flag', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row() as never);
    featuresMock.mockReturnValue({ ...ON, appAssistantRemoteRunner: false });
    vi.mocked(isFliptDecisive).mockImplementation(
      async (keys) => !keys.includes('appAssistantRemoteRunner')
    );
    expect(await getAppAssistantRefusalForUserId(USER_ID, { remoteRunner: true })).toMatchObject({
      status: 503,
      unavailable: true,
    });
    // Control: App Assistant's own mints are not held to the runner's flag.
    expect(await getAppAssistantRefusalForUserId(USER_ID)).toBeNull();
    vi.mocked(isFliptDecisive).mockImplementation(async () => decisiveMock());
  });
});

describe('getRunnerDevTunnelUser (the runner’s dev-tunnel endpoints)', () => {
  const RUNNER_USER_ID = 7301;
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: RUNNER_USER_ID,
    bannedAt: null,
    onboarding: OnboardingSteps.Buzz,
    muted: false,
    emailVerified: new Date('2024-01-01'),
    meta: {},
    isModerator: false,
    ...overrides,
  });
  const AUTHOR = { ...ON, appAssistantRemoteRunner: true, appBlocksAuthor: true };

  beforeEach(() => {
    cachedSessionMock.mockResolvedValue(
      user({ id: RUNNER_USER_ID, tier: 'silver' } as Partial<SessionUser>)
    );
    decisiveMock.mockReturnValue(true);
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row() as never);
    featuresMock.mockReturnValue(AUTHOR);
  });

  it('hands back the user, as the gates judged them, when every gate and the author capability admit them', async () => {
    const result = await getRunnerDevTunnelUser(RUNNER_USER_ID);
    expect(result.refusal).toBeNull();
    // The database row over the cached session: the fields the gates read are the fresh ones.
    expect(result.user).toMatchObject({ id: RUNNER_USER_ID, tier: 'silver', bannedAt: null });
    expect(dbMock.dbWrite.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: RUNNER_USER_ID } })
    );
  });

  it('refuses FORBIDDEN, as appDeveloperProcedure words it, without the author capability', async () => {
    featuresMock.mockReturnValue({ ...AUTHOR, appBlocksAuthor: false });
    expect(await getRunnerDevTunnelUser(RUNNER_USER_ID)).toEqual({
      refusal: {
        status: 403,
        error: 'You do not have access to Apps authoring',
        code: 'FORBIDDEN',
      },
    });
  });

  it('holds the user to the server runner’s own flag, answered refused', async () => {
    featuresMock.mockReturnValue({ ...AUTHOR, appAssistantRemoteRunner: false });
    expect(await getRunnerDevTunnelUser(RUNNER_USER_ID)).toEqual({
      refusal: {
        status: 403,
        error: 'Replies on the server are not available on this account',
        code: 'refused',
      },
    });
  });

  it('refuses a user banned now, answered refused, before reading the author capability', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row({ bannedAt: new Date() }) as never);
    const result = await getRunnerDevTunnelUser(RUNNER_USER_ID);
    expect(result.refusal).toMatchObject({ status: 403, code: 'refused' });
    expect(result.refusal?.error).toMatch(/banned/);
    expect(result.user).toBeUndefined();
  });

  it('answers unavailable, never a refusal, when the gates cannot be judged just now', async () => {
    cachedSessionMock.mockResolvedValue(null);
    expect(await getRunnerDevTunnelUser(RUNNER_USER_ID)).toEqual({
      refusal: {
        status: 503,
        error: 'App Assistant could not check this account just now',
        unavailable: true,
        code: 'unavailable',
      },
    });
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

  it("keeps bits the consent already carries beyond the assistant's own", async () => {
    const EXTRA = 1n << 30n;
    dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue({
      scope: TokenScope.UserRead | EXTRA,
      buzzLimit: null,
    });
    await enableAppAssistant(USER_ID);
    expect(dbMock.dbWrite.oauthConsent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ scope: SCOPE | EXTRA }) })
    );
  });

  it('heals a client whose allowed scopes were narrowed', async () => {
    dbMock.dbWrite.oauthClient.findUnique.mockResolvedValue({ allowedScopes: TokenScope.UserRead });
    await enableAppAssistant(USER_ID);
    expect(dbMock.dbWrite.oauthClient.upsert.mock.calls[0][0].update).toEqual({
      allowedScopes: SCOPE,
    });
  });

  // A ban marks the self-only client it disables (oauth-ban-marker); only a marked client is
  // re-opened. The mark lives on the cache Redis, a process boundary.
  describe('a disabled client', () => {
    const marks = new Set<string>();
    beforeEach(() => {
      marks.clear();
      redisMock.redis.exists.mockImplementation((async (key: string) =>
        marks.has(key) ? 1 : 0) as never);
      redisMock.redis.del.mockImplementation((async (key: string) =>
        marks.delete(key) ? 1 : 0) as never);
      dbMock.dbWrite.oauthClient.updateMany.mockReset();
      dbMock.dbWrite.oauthClient.updateMany.mockResolvedValue({ count: 1 } as never);
      dbMock.dbWrite.oauthClient.findUnique.mockResolvedValue({ allowedScopes: SCOPE });
    });

    it('🔴 one staff disabled (no ban mark) stays disabled when App Assistant is turned on', async () => {
      dbMock.dbWrite.oauthClient.findUnique.mockResolvedValue({
        allowedScopes: SCOPE,
        accessMode: 'disabled',
      });
      await enableAppAssistant(USER_ID);
      expect(dbMock.dbWrite.oauthClient.updateMany).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.oauthClient.upsert).not.toHaveBeenCalled();
    });

    it('🔴 one a ban disabled is re-opened once the user turns App Assistant on again', async () => {
      marks.add(`oauth:ban-disabled:${CLIENT_ID}`);
      // Matches however the cache client prefixes its keys.
      redisMock.redis.exists.mockImplementation((async (key: string) =>
        [...marks].some((m) => key.endsWith(m)) ? 1 : 0) as never);
      await enableAppAssistant(USER_ID);
      expect(dbMock.dbWrite.oauthClient.updateMany).toHaveBeenCalledWith({
        where: { id: CLIENT_ID, accessMode: 'disabled' },
        data: { accessMode: 'open' },
      });
    });
  });
});

describe('mintAppAssistantToken', () => {
  it('mints the spending scope for the chat against an existing consent, writing nothing', async () => {
    dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue({ scope: SCOPE });

    expect(await mintAppAssistantToken(USER_ID, 'chat', null)).toEqual({
      token: 'civ_assistant_oauth',
      expiresAt: '2099-01-01T01:00:00Z',
    });
    expect(mintAppTokenMock).toHaveBeenCalledWith({
      userId: USER_ID,
      clientId: CLIENT_ID,
      scope: SCOPE,
      impersonatedBy: null,
    });
    expect(dbMock.dbWrite.oauthConsent.upsert).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.oauthClient.upsert).not.toHaveBeenCalled();
  });

  it('mints UserRead alone for the sandbox service', async () => {
    dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue({ scope: SCOPE });
    await mintAppAssistantToken(USER_ID, 'sandbox', null);
    expect(mintAppTokenMock).toHaveBeenCalledWith({
      userId: USER_ID,
      clientId: CLIENT_ID,
      scope: TokenScope.UserRead,
      impersonatedBy: null,
    });
  });

  it.each([
    ['never turned on (or revoked), for the chat', null, 'chat'],
    ['never turned on (or revoked), for the sandbox', null, 'sandbox'],
    ['a consent without the spend bit, for the chat', { scope: TokenScope.UserRead }, 'chat'],
  ] as const)('returns null and re-grants nothing: %s', async (_label, consent, purpose) => {
    dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue(consent);
    expect(await mintAppAssistantToken(USER_ID, purpose, null)).toBeNull();
    expect(mintAppTokenMock).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.oauthConsent.upsert).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.oauthClient.upsert).not.toHaveBeenCalled();
  });
});

describe('getAppAssistantPreview', () => {
  // `host` rides along: the client checks the entry URL is on it (`fetchPreviewFrame`).
  const frame = {
    blockId: 'my-app',
    host: 'dev-0123456789abcdef.civit.ai',
    iframeSrc: 'https://dev-0123456789abcdef.civit.ai/?dev=t',
  };

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

  it('reports a live tunnel whose host is not resolvable yet as preparing, not as missing', async () => {
    featuresMock.mockReturnValue({ ...ON, appBlocksAuthor: true });
    resolveFrameMock.mockResolvedValue({ ...frame, iframeSrc: null, dnsPending: true });
    expect(await getAppAssistantPreview({ user: user(), blockId: 'my-app' })).toEqual({
      status: 'preparing',
    });
  });
  /**
   * App Assistant direct preview: a frame (re)mint stamps the session's idle clock (the tunnel
   * gate's entry-document stamp, for a path with no gate); the pane's 60 s liveness poll
   * (`?check=1`) never does, or an open tab alone would keep a session from ever idling out. The
   * stamp runs through the real dev-tunnel service, so it is read back from the stored record.
   */
  describe('the idle stamp of a direct preview', () => {
    const LABEL = 'sckpynuebrbgh2zm2f7vkbrk22akqcaqdaqcwv7vmqcbzawxned4cvl4enkzes';
    const DIRECT_HOST = `${LABEL}.preview.test`;
    const SESSION_KEY = 'system:blocks:dev-tunnel:session:bki_direct';
    const OLD = Math.floor(Date.now() / 1000) - 600;
    const record = {
      sessionId: 'bki_direct',
      userId: USER_ID,
      blockId: 'my-app',
      host: DIRECT_HOST,
      fingerprint: '',
      createdAt: OLD,
      hardExpiresAt: OLD + 8 * 3600,
      spendCapBuzz: 5000,
      lastActivityAt: OLD,
      transport: 'direct',
      previewId: '9f86d081884c7d659a2feaa0c55ad015',
    };
    const stored = new Map<string, string>();
    const lastActivity = () => JSON.parse(stored.get(SESSION_KEY)!).lastActivityAt as number;

    beforeEach(() => {
      setEnv({ APP_ASSISTANT_PREVIEW_DOMAIN: 'preview.test' });
      featuresMock.mockReturnValue({ ...ON, appBlocksAuthor: true });
      stored.clear();
      stored.set(`system:blocks:dev-tunnel:user:{${USER_ID}}:my-app`, 'bki_direct');
      stored.set(SESSION_KEY, JSON.stringify(record));
      const get = async (k: string) => stored.get(k) ?? null;
      redisMock.redis.get.mockImplementation(get);
      redisMock.sysRedis.get.mockImplementation(get);
      redisMock.sysRedis.set.mockImplementation(async (k: string, v: string) => {
        stored.set(k, v);
        return 'OK';
      });
      resolveFrameMock.mockResolvedValue({
        blockId: 'my-app',
        host: DIRECT_HOST,
        iframeSrc: `https://${DIRECT_HOST}/`,
        dnsPending: false,
        transport: 'direct',
      });
    });

    it('a ?check=1 fetch leaves lastActivityAt unchanged', async () => {
      const got = await getAppAssistantPreview({ user: user(), blockId: 'my-app', check: true });
      expect(got.status).toBe('ok');
      expect(lastActivity()).toBe(OLD);
    });

    it('a frame fetch without it stamps the session', async () => {
      const before = Math.floor(Date.now() / 1000);
      await getAppAssistantPreview({ user: user(), blockId: 'my-app' });
      expect(lastActivity()).toBeGreaterThanOrEqual(before);
    });

    it('a tunnel frame is never stamped here (its gate stamps it)', async () => {
      stored.set(SESSION_KEY, JSON.stringify({ ...record, transport: undefined }));
      resolveFrameMock.mockResolvedValue(frame);
      await getAppAssistantPreview({ user: user(), blockId: 'my-app' });
      expect(lastActivity()).toBe(OLD);
    });
  });
});
