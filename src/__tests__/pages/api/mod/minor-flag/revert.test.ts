import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as MinorHashService from '~/server/services/minor-hash.service';

const { mockRevert, session } = vi.hoisted(() => ({
  mockRevert: vi.fn(),
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
vi.mock('~/server/services/minor-hash.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MinorHashService>()),
  revertMinorHashAutoFlag: mockRevert,
}));

import handler from '~/pages/api/mod/minor-flag/revert';

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
  mockRevert.mockResolvedValue({ rolledBack: 1, failed: 0, candidates: 1 });
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

// A moderator's revert must hold against a rescan of the same text, which the ruling stamp does.
describe('minorFlag.revert', () => {
  it("records the moderator's text-scan ruling", async () => {
    expect(await call({ modelId: 42 })).toBe(200);
    expect(mockRevert).toHaveBeenCalledWith({
      modelId: 42,
      userId: 7,
      recordTextScanRuling: true,
    });
  });
});
