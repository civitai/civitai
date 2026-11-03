import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EngagementService from '~/server/services/creator-engagement.service';

const { mockGetEngagement, mockFlags, mockWindow } = vi.hoisted(() => ({
  mockGetEngagement: vi.fn(),
  mockFlags: vi.fn(),
  mockWindow: vi.fn(),
}));

vi.mock('~/server/services/creator-engagement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof EngagementService>()),
  getCreatorEngagement: mockGetEngagement,
}));
vi.mock('~/server/services/feature-flags.service', () => ({ getFeatureFlagsAsync: mockFlags }));
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
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { createRealApiPair } from '~/server/utils/__tests__/real-api-response';
import handler from '~/pages/api/v1/creator/engagement';

const CALLER = 101;

async function call(query: Record<string, string>, signedIn = true) {
  vi.mocked(getServerAuthSession).mockResolvedValue(
    (signedIn ? { user: { id: CALLER } } : null) as never
  );
  const { req, res } = createRealApiPair({
    url: '/api/v1/creator/engagement',
    query,
    headers: signedIn ? { authorization: 'Bearer test' } : {},
  });
  let body: Record<string, unknown> | undefined;
  const json = res.json.bind(res);
  res.json = ((b: unknown) => {
    body = b as Record<string, unknown>;
    return json(b);
  }) as typeof res.json;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { statusCode: res.statusCode, body };
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
    const { statusCode } = await call({ userId: '202', username: 'someone', type: 'image' });
    expect(statusCode).toBe(200);
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
    const { statusCode } = await call({});
    expect(statusCode).toBe(429);
    expect(mockGetEngagement).not.toHaveBeenCalled();
  });
});
