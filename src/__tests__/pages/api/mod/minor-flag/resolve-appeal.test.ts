import { TRPCError } from '@trpc/server';
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

  it('passes a per-label ruling and its reason to the service unchecked', async () => {
    const split = { modelId: 42, uphold: true, poi: 'overturn', resolvedReason: 'flag-confirmed' };
    expect(await call(split)).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        uphold: true,
        labels: { poi: 'overturn' },
        resolvedReason: 'flag-confirmed',
      })
    );
  });

  it("answers the service's refusal of a reason as a 400", async () => {
    mockResolve.mockRejectedValue(new TRPCError({ code: 'BAD_REQUEST', message: 'not a reason' }));
    expect(await call({ modelId: 42, uphold: false, resolvedReason: 'flag-confirmed' })).toBe(400);
  });

  it('refuses a note over the limit before resolving anything', async () => {
    const note = 'x'.repeat(RESOLUTION_NOTE_MAX_LENGTH + 1);
    expect(
      await call({ modelId: 42, uphold: false, resolvedReason: 'other', internalNotes: note })
    ).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('rules without a reason when none is sent', async () => {
    expect(await call({ modelId: 42, uphold: false })).toBe(200);
    expect(mockResolve.mock.calls[0][0].resolvedReason).toBeUndefined();
  });
});
