import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * MOD REVIEW SANDBOX (#2831) — coverage for the Traefik forwardAuth target
 * GET /api/internal/mod-gate.
 *
 *   - moderator + flag on  → 200 + X-Mod-Id / X-Mod-Name headers
 *   - logged-in non-mod    → 401
 *   - anonymous            → 401
 *   - moderator but flag off (fail-closed) → 401
 *
 * The handler is driven directly with mock req/res; the session helper + the
 * review-sandbox flag are mocked.
 */

const { mockSession, mockFlag, mockGetSession, mockIsEnabled } = vi.hoisted(() => {
  const mockSession = { value: null as null | { user: Record<string, unknown> } };
  const mockFlag = { enabled: true };
  return {
    mockSession,
    mockFlag,
    mockGetSession: vi.fn(async () => mockSession.value),
    mockIsEnabled: vi.fn(async () => mockFlag.enabled),
  };
});

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockGetSession,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksReviewSandboxEnabled: mockIsEnabled,
}));

import handler from '~/pages/api/internal/mod-gate';

function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    _headers: headers,
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: unknown; _headers: Record<string, string> };
}

const req = { method: 'GET', headers: {}, cookies: {} } as unknown as NextApiRequest;

describe('GET /api/internal/mod-gate', () => {
  beforeEach(() => {
    mockSession.value = null;
    mockFlag.enabled = true;
    mockGetSession.mockClear();
    mockIsEnabled.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it('returns 200 + mod identity headers for a moderator when the flag is on', async () => {
    mockSession.value = { user: { id: 7, username: 'modder', isModerator: true } };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._headers['X-Mod-Id']).toBe('7');
    expect(res._headers['X-Mod-Name']).toBe('modder');
  });

  it('returns 401 for a logged-in non-moderator', async () => {
    mockSession.value = { user: { id: 8, username: 'user', isModerator: false } };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for an anonymous request', async () => {
    mockSession.value = null;
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for a moderator when the flag is OFF (fail-closed)', async () => {
    mockSession.value = { user: { id: 7, username: 'modder', isModerator: true } };
    mockFlag.enabled = false;
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });
});
