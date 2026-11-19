import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as AccountStanding from '~/server/services/account-standing.service';

const { cancelPendingWorkflowsIfMuted, cancelPendingWorkflows, session } = vi.hoisted(() => ({
  cancelPendingWorkflowsIfMuted: vi.fn(async (_userId: number) => undefined),
  cancelPendingWorkflows: vi.fn(async (_userId: number) => undefined),
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
vi.mock('~/server/services/account-standing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountStanding>()),
  cancelPendingWorkflowsIfMuted,
}));
vi.mock('~/server/services/orchestrator/cancel-pending-workflows', () => ({
  cancelPendingWorkflows,
}));

import handler from '~/pages/api/mod/user/cancel-pending-workflows';

async function call(body: Record<string, unknown>) {
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
  await handler(req, res);
  return statusCode;
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

describe('user.cancelPendingWorkflows', () => {
  // The moderator app's only way to cancel: it must re-check the stored mute, so a call for an
  // account that is not muted cancels nothing.
  it('cancels through the muted-only check, never unconditionally', async () => {
    expect(await call({ userId: 42 })).toBe(200);
    expect(cancelPendingWorkflowsIfMuted).toHaveBeenCalledWith(42);
    expect(cancelPendingWorkflows).not.toHaveBeenCalled();
  });
});
