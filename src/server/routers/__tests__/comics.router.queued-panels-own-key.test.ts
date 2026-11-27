import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as FliptClient from '~/server/flipt/client';
import type * as GetOrchestratorToken from '~/server/orchestrator/get-orchestrator-token';
import { envMock } from '~/__tests__/mocks/env.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

// Queued comic panels are submitted later by a job on the user's System token. smartCreateChapter
// refuses to queue them for a request that getOrchestratorToken would send as its own limited key,
// asking the real predicate, so each case follows its own flag.

const h = vi.hoisted(() => ({
  flags: { userKey: false, offlineGrant: false },
  available: 0,
  mintOrigin: 'refresh' as string | null,
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ comicCreator: true }),
}));
vi.mock('~/utils/signal-client', () => ({ signalClient: { send: async () => undefined } }));
vi.mock('~/server/orchestrator/get-orchestrator-token', async (importOriginal) => ({
  ...(await importOriginal<typeof GetOrchestratorToken>()),
  getOrchestratorToken: vi.fn(async () => 'token'),
}));
vi.mock('~/server/services/orchestrator/queue-limits', () => ({
  assertCanGenerate: async () => undefined,
  getUserQueueStatus: async () => ({ canGenerate: true, available: h.available }),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFlipt: vi.fn(async (key: string) =>
      key === actual.FLIPT_FEATURE_FLAGS.USER_KEY_BUZZ_LIMIT_PROXY
        ? h.flags.userKey
        : key === actual.FLIPT_FEATURE_FLAGS.OAUTH_OFFLINE_GRANT
        ? h.flags.offlineGrant
        : false
    ),
  };
});
vi.mock('~/server/db/kyselyDb', () => {
  const qb = {
    select: () => qb,
    where: () => qb,
    executeTakeFirst: async () => ({ mintOrigin: h.mintOrigin }),
  };
  return { kyselyWrite: { selectFrom: () => qb } };
});

import { comicsRouter } from '../comics.router';
import { QUEUED_PANELS_REFUSED_FOR_OWN_KEY } from '../comics.router';

const USER_ID = 7;
const LIMIT = [{ type: 'sliding', limit: 500, window: 'day', unit: 1 }];
const credentials = {
  personal: { apiKeyId: 3, apiKeyType: ApiKeyType.User, subject: { type: 'apiKey', id: 3 } },
  oauth: { apiKeyId: 9, apiKeyType: ApiKeyType.Access, subject: { type: 'oauth', id: 'app' } },
};

const caller = (credential: keyof typeof credentials | 'session') =>
  comicsRouter.createCaller({
    user: { id: USER_ID, isModerator: false, onboarding: OnboardingSteps.Buzz, muted: false },
    domain: 'red',
    acceptableOrigin: true,
    needsUpdate: false,
    tokenScope: TokenScope.Full,
    features: { comicCreator: true },
    req: {
      url: '/api/trpc/comics.smartCreateChapter',
      headers: credential === 'session' ? {} : { authorization: 'Bearer caller-key' },
      context: {
        session: { user: { id: USER_ID } },
        ...(credential === 'session' ? {} : { ...credentials[credential], buzzLimit: LIMIT }),
      },
    },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    track: {},
    ip: '127.0.0.1',
    fingerprint: 'test',
  } as never);

const createChapter = (credential: Parameters<typeof caller>[0], panels = 2) =>
  caller(credential)
    .smartCreateChapter({
      projectId: 11,
      referenceIds: [],
      panels: Array.from({ length: panels }, (_, i) => ({ prompt: `panel ${i}` })),
    })
    .catch((e: unknown) => e);

// Past the refusal, the chapter write is where the run stops.
const PAST_REFUSAL = new Error('chapter create reached');

beforeEach(() => {
  vi.clearAllMocks();
  envMock.set({ ORCHESTRATOR_MODE: 'prod' });
  h.flags = { userKey: false, offlineGrant: false };
  h.available = 0;
  h.mintOrigin = 'refresh';
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: false, bannedAt: null } as never);
  dbMock.dbRead.comicProject.findUnique.mockResolvedValue({
    id: 11,
    userId: USER_ID,
    baseModel: null,
  } as never);
  dbMock.dbRead.comicChapter.findFirst.mockResolvedValue(null as never);
  dbMock.dbWrite.comicChapter.create.mockRejectedValue(PAST_REFUSAL);
});

const refused = { code: 'FORBIDDEN', message: QUEUED_PANELS_REFUSED_FOR_OWN_KEY };

describe('queueing comic panels', () => {
  it.each([
    ['a limited personal key with its flag on', 'personal', { userKey: true, offlineGrant: false }],
    [
      'a capped offline OAuth token with its flag on',
      'oauth',
      { userKey: false, offlineGrant: true },
    ],
  ] as const)('is refused for %s, before the chapter is created', async (_, credential, flags) => {
    h.flags = { ...flags };
    expect(await createChapter(credential)).toMatchObject(refused);
    expect(dbMock.dbWrite.comicChapter.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a limited personal key with only the OAuth flag on',
      'personal',
      { userKey: false, offlineGrant: true },
    ],
    [
      'a capped OAuth token with only the personal-key flag on',
      'oauth',
      { userKey: true, offlineGrant: false },
    ],
    ['a session, both flags on', 'session', { userKey: true, offlineGrant: true }],
  ] as const)('goes ahead for %s', async (_, credential, flags) => {
    h.flags = { ...flags };
    expect(await createChapter(credential)).toMatchObject({ message: PAST_REFUSAL.message });
  });

  it('goes ahead for an OAuth token not minted from a refresh grant', async () => {
    h.flags = { userKey: true, offlineGrant: true };
    h.mintOrigin = 'auth_code';
    expect(await createChapter('oauth')).toMatchObject({ message: PAST_REFUSAL.message });
  });

  it('goes ahead for a limited key when every panel fits in the open slots', async () => {
    h.flags = { userKey: true, offlineGrant: true };
    h.available = 2;
    expect(await createChapter('personal', 2)).toMatchObject({ message: PAST_REFUSAL.message });
  });
});
