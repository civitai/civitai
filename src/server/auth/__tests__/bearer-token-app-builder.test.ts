import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as KeyGenerator from '~/server/utils/key-generator';
import { shapeSessionUser } from '../../../../apps/auth/src/lib/server/auth/session-shape';

/**
 * The API-key / OAuth bearer path builds its Flipt context from the SessionUser the hub produced
 * (`sessionClient.getSessionUserById`), not from a second derivation. So an approved builder
 * calling with an API key — the CLI, an agent — gets the same `appBuilderApproved` as their
 * browser session. This pins that the bearer path hands the hub's field through untouched.
 */

const { hubUser } = vi.hoisted(() => ({ hubUser: { current: null as unknown } }));

vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => key,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: vi.fn(async () => hubUser.current) },
}));

const { getSessionFromBearerToken } = await import('~/server/auth/bearer-token');
const { buildFliptContext } = await import('~/server/services/feature-flags.service');

const OWNER = 6110;

const hubSession = (appBuilderApproved: boolean) =>
  shapeSessionUser({
    row: {
      id: OWNER,
      username: 'cli_builder',
      name: null,
      email: null,
      emailVerified: null,
      image: null,
      createdAt: null,
      isModerator: false,
      showNsfw: false,
      blurNsfw: true,
      browsingLevel: 1,
      onboarding: 0,
      muted: false,
      mutedAt: null,
      bannedAt: null,
      deletedAt: null,
      customerId: null,
      paddleCustomerId: null,
      autoplayGifs: null,
      leaderboardShowcase: null,
      filePreferences: {},
      settings: {},
      meta: {},
      profilePicture: null,
      referral: null,
      appBuilderApproved,
    },
    subscriptionRows: [],
    permissions: [],
    roles: [],
  });

beforeEach(() => {
  dbMock.dbWrite.apiKey.findFirst.mockReset();
  dbMock.dbWrite.apiKey.findFirst.mockResolvedValue({
    id: 91,
    userId: OWNER,
    tokenScope: 1,
    lastUsedAt: new Date(),
    buzzLimit: null,
    clientId: null,
    type: 'User',
  });
});

describe('bearer token → Flipt context: appBuilderApproved', () => {
  it('🔴 an approved builder’s API key carries "true" into the context', async () => {
    hubUser.current = hubSession(true);
    const session = await getSessionFromBearerToken('rw6912-key-approved');
    expect(session?.user?.id).toBe(OWNER);
    expect(buildFliptContext(session!.user!).appBuilderApproved).toBe('true');
  });

  it('a key whose owner is not approved carries "false"', async () => {
    hubUser.current = hubSession(false);
    const session = await getSessionFromBearerToken('rw6912-key-plain');
    expect(buildFliptContext(session!.user!).appBuilderApproved).toBe('false');
  });
});
