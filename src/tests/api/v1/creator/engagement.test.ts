import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EngagementService from '~/server/services/creator-engagement.service';
import type * as FeatureFlags from '~/server/services/feature-flags.service';

const { mockGetEngagement, mockFlags, mockWindow } = vi.hoisted(() => ({
  mockGetEngagement: vi.fn(),
  mockFlags: vi.fn(),
  mockWindow: vi.fn(),
}));

vi.mock('~/server/services/creator-engagement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof EngagementService>()),
  getCreatorEngagement: mockGetEngagement,
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlagsAsync: mockFlags,
}));
vi.mock('~/server/utils/public-api-rate-limit', () => ({ checkFixedWindow: mockWindow }));
vi.mock('@civitai/next-axiom', () => ({
  withAxiom:
    (h: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      h(...args),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: vi.fn() }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));

import '~/__tests__/mocks/db.mock';
import { TokenScope } from '@civitai/auth/token-scope';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { InvalidCursorError } from '~/server/services/creator-engagement.service';
import { ApiKeyType } from '~/shared/utils/prisma/enums';
import { createRealApiPair } from '~/server/utils/__tests__/real-api-response';
import handler from '~/pages/api/v1/creator/engagement';

const CALLER = 101;

type Credential = {
  apiKeyType: string;
  subject: { type: 'apiKey' | 'oauth'; id: number | string };
  tokenScope: number;
};
// What getServerAuthSession puts on req.context for a bearer token.
const FULL_KEY: Credential = {
  apiKeyType: ApiKeyType.User,
  subject: { type: 'apiKey', id: 1 },
  tokenScope: TokenScope.Full,
};

async function call(
  query: Record<string, string>,
  credential: Credential | 'session' | 'anonymous' = FULL_KEY
) {
  vi.mocked(getServerAuthSession).mockResolvedValue(
    (credential === 'anonymous' ? null : { user: { id: CALLER } }) as never
  );
  const bearer = typeof credential === 'object';
  const { req, res, header } = createRealApiPair({
    url: '/api/v1/creator/engagement',
    query,
    headers: bearer ? { authorization: 'Bearer test' } : {},
  });
  if (bearer) (req as unknown as { context: unknown }).context = { apiKeyId: 1, ...credential };
  let body: Record<string, unknown> | undefined;
  const json = res.json.bind(res);
  res.json = ((b: unknown) => {
    body = b as Record<string, unknown>;
    return json(b);
  }) as typeof res.json;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { statusCode: res.statusCode, body, header };
}

describe('GET /api/v1/creator/engagement', () => {
  beforeEach(() => {
    mockGetEngagement.mockReset().mockResolvedValue({ items: [], metadata: { nextCursor: null } });
    mockFlags.mockReset().mockResolvedValue({ creatorEngagementApi: true });
    mockWindow.mockReset().mockResolvedValue({ allowed: true });
  });

  it('answers 404 and reads nothing when the flag is off', async () => {
    mockFlags.mockResolvedValue({ creatorEngagementApi: false });
    const { statusCode } = await call({});
    expect(statusCode).toBe(404);
    expect(mockGetEngagement).not.toHaveBeenCalled();
  });

  it('scopes to the authenticated caller whatever user the query names', async () => {
    const { statusCode, header } = await call({
      userId: '202',
      username: 'someone',
      type: 'image',
    });
    expect(statusCode).toBe(200);
    expect(header('Cache-Control')).toBe('private, no-store');
    expect(mockGetEngagement).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CALLER, type: 'image', sort: 'engagement', limit: 20 })
    );
  });

  it('refuses a limit above the maximum', async () => {
    const { statusCode } = await call({ limit: '101' });
    expect(statusCode).toBe(400);
    expect(mockGetEngagement).not.toHaveBeenCalled();
  });

  it('answers 429 once the caller is over the window', async () => {
    mockWindow.mockResolvedValue({ allowed: false, retryAfterSeconds: 12 });
    const { statusCode, header } = await call({});
    expect(statusCode).toBe(429);
    expect(header('Retry-After')).toBe('12');
    expect(mockGetEngagement).not.toHaveBeenCalled();
  });

  it('answers 400 for a cursor the service rejects', async () => {
    mockGetEngagement.mockRejectedValue(new InvalidCursorError());
    const { statusCode, body } = await call({ cursor: 'forged' });
    expect(statusCode).toBe(400);
    expect(body).toEqual({ error: 'Invalid cursor' });
  });

  it('answers 401 without a session or token', async () => {
    const { statusCode } = await call({}, 'anonymous');
    expect(statusCode).toBe(401);
    expect(mockGetEngagement).not.toHaveBeenCalled();
  });

  it('serves a signed-in browser session', async () => {
    expect((await call({}, 'session')).statusCode).toBe(200);
  });

  it.each([
    [
      'an OAuth token with an unrelated scope',
      {
        apiKeyType: ApiKeyType.Access,
        subject: { type: 'oauth', id: 'client' },
        tokenScope: TokenScope.MediaRead,
      },
    ],
    [
      'a personal key without full scope',
      { ...FULL_KEY, tokenScope: TokenScope.UserRead | TokenScope.MediaRead },
    ],
  ] as const)('refuses %s with 403 before reading anything', async (_label, credential) => {
    const { statusCode } = await call({}, credential as Credential);
    expect(statusCode).toBe(403);
    expect(mockFlags).not.toHaveBeenCalled();
    expect(mockWindow).not.toHaveBeenCalled();
    expect(mockGetEngagement).not.toHaveBeenCalled();
  });
});
