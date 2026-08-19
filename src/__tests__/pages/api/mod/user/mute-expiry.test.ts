import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BEHAVIOURAL guard on the expiry `user.mute` writes.
 *
 * The property: an indefinite mute must CLEAR any expiry already on the account, not merely decline
 * to set one. `setUserMuted` writes `muteExpiresAt` only when the caller names a value, so a
 * pass-through (`expiresAt: input.expiresAt`) silently leaves a strike's old date in place — and
 * `processTimedUnmutes` then lifts the moderator's indefinite mute on it. That mutant keeps the
 * parameter, the call and the types, so nothing structural sees it; only the argument does.
 *
 * Lives outside `src/pages/**` because Next enumerates every file under it as a route — see the
 * guard in `src/__tests__/pages/no-test-files-in-pages-tree.test.ts`.
 */

const { mockAudit } = vi.hoisted(() => ({ mockAudit: vi.fn() }));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => ({
    user: { id: 7, isModerator: true, permissions: [], bannedAt: null },
  })),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = mockAudit;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: (
    res: { status: (n: number) => { json: (b: unknown) => unknown } },
    e: unknown
  ) => res.status(500).json({ error: 'error', message: (e as Error).message }),
}));

const setUserMuted = vi.fn(async () => ({}));
vi.mock('~/server/services/user.service', () => ({
  setUserMuted: (...a: unknown[]) => setUserMuted(...(a as [])),
}));

import handler from '~/pages/api/mod/user/mute';
import { redisMock } from '~/__tests__/mocks/redis.mock';

function call(body: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body, query: {} } as Parameters<typeof handler>[0];
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader: vi.fn(),
    end() {
      return res;
    },
  } as unknown as Parameters<typeof handler>[1];
  return handler(req, res).then(() => ({ status: statusCode, body: payload }));
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('user.mute — the expiry it writes', () => {
  it('CLEARS a stale expiry when muting indefinitely (null, not undefined)', async () => {
    const { status } = await call({ userId: 42 });
    expect(status).toBe(200);
    // `null` is the whole point: `undefined` would leave a strike's date on the row.
    expect(setUserMuted).toHaveBeenCalledWith({ userId: 42, muted: true, expiresAt: null });
  });

  it('passes a requested expiry through as a Date, and reports it back', async () => {
    const iso = '2026-09-01T00:00:00.000Z';
    const { status, body } = await call({ userId: 42, expiresAt: iso });
    expect(status).toBe(200);
    expect(setUserMuted).toHaveBeenCalledWith({
      userId: 42,
      muted: true,
      expiresAt: new Date(iso),
    });
    expect(body).toEqual({ muted: true, expiresAt: new Date(iso) });
  });

  it('refuses an unparseable expiry rather than muting indefinitely by accident', async () => {
    const { status } = await call({ userId: 42, expiresAt: 'whenever' });
    expect(status).toBe(400);
    expect(setUserMuted).not.toHaveBeenCalled();
  });
});
