import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RESOLUTION_NOTE_MAX_LENGTH } from '@civitai/shared/resolution-reasons';
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
vi.mock('~/server/services/text-scan/actions/bounty-poi', () => ({
  resolveBountyPoiAppeal: mockResolve,
}));

import handler from '~/pages/api/mod/bounty-poi/resolve-appeal';

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

describe('bountyPoi.resolveAppeal', () => {
  it('forwards a reason that belongs to the verdict, with its note', async () => {
    expect(
      await call({
        bountyId: 9,
        uphold: false,
        resolvedReason: 'context-provided',
        internalNotes: 'licensed likeness',
      })
    ).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        bountyId: 9,
        uphold: false,
        userId: 7,
        resolvedReason: 'context-provided',
        internalNotes: 'licensed likeness',
      })
    );
  });

  it.each([
    ['an overturn reason on an uphold', { uphold: true, resolvedReason: 'not-a-real-person' }],
    ['Other without a note', { uphold: true, resolvedReason: 'other' }],
    ['a keep reason on an overturn', { uphold: false, resolvedReason: 'flag-confirmed' }],
    ['a minor reason on a real-person flag', { uphold: false, resolvedReason: 'not-a-minor' }],
    [
      'a note over the limit',
      {
        uphold: true,
        resolvedReason: 'other',
        internalNotes: 'x'.repeat(RESOLUTION_NOTE_MAX_LENGTH + 1),
      },
    ],
  ])('refuses %s before resolving anything', async (_, ruling) => {
    expect(await call({ bountyId: 9, ...ruling })).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('rules without a reason when none is sent', async () => {
    expect(await call({ bountyId: 9, uphold: true })).toBe(200);
    expect(mockResolve.mock.calls[0][0].resolvedReason).toBeUndefined();
  });
});
