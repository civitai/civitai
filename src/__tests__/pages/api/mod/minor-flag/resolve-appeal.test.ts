import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { mockResolve, session } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
  session: { user: { id: 7, isModerator: true, permissions: [], bannedAt: null } },
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = vi.fn();
    userActivity = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/minor-hash.service', () => ({ resolveMinorFlagAppeal: mockResolve }));

import handler from '~/pages/api/mod/minor-flag/resolve-appeal';

function call(body: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body, query: {} } as Parameters<typeof handler>[0];
  let statusCode = 200;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json: () => res,
    setHeader: vi.fn(),
    end: () => res,
  } as unknown as Parameters<typeof handler>[1];
  return handler(req, res).then(() => statusCode);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockResolvedValue({ rescanQueued: false });
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('minorFlag.resolveAppeal', () => {
  it('forwards a reason that belongs to the verdict, with its note', async () => {
    expect(
      await call({
        modelId: 42,
        uphold: true,
        resolvedReason: 'flag-confirmed',
        internalNotes: 'seen it',
      })
    ).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 42,
        uphold: true,
        userId: 7,
        resolvedReason: 'flag-confirmed',
        internalNotes: 'seen it',
      })
    );
  });

  it('checks a per-label ruling that lifts a flag against the Approved list', async () => {
    const split = { modelId: 42, uphold: false, minor: 'uphold', poi: 'overturn' };
    expect(await call({ ...split, resolvedReason: 'not-a-real-person' })).toBe(200);
    expect(await call({ ...split, resolvedReason: 'flag-confirmed' })).toBe(400);
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an uphold reason on an overturn', { uphold: false, resolvedReason: 'flag-confirmed' }],
    ['a held-detection reason', { uphold: true, resolvedReason: 'detection-correct' }],
    ['Other without a note', { uphold: false, resolvedReason: 'other' }],
  ])('refuses %s before resolving anything', async (_, ruling) => {
    expect(await call({ modelId: 42, ...ruling })).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('rules without a reason when none is sent', async () => {
    expect(await call({ modelId: 42, uphold: false })).toBe(200);
    expect(mockResolve.mock.calls[0][0].resolvedReason).toBeUndefined();
  });
});
