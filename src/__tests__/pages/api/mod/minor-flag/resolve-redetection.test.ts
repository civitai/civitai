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
vi.mock('~/server/services/text-scan/actions/redetection', () => ({
  resolveTextScanRedetection: mockResolve,
}));

import handler from '~/pages/api/mod/minor-flag/resolve-redetection';

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
  mockResolve.mockResolvedValue('kept');
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('minorFlag.resolveRedetection', () => {
  it('rules as the acting moderator', async () => {
    expect(await call({ modelId: 42, label: 'minor', keep: true })).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith({
      modelId: 42,
      label: 'minor',
      keep: true,
      userId: 7,
    });
  });

  it('passes a dismissal through as keep: false', async () => {
    await call({ modelId: 42, label: 'poi', keep: 'false' });
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'poi', keep: false })
    );
  });

  it('rejects an unknown label before resolving anything', async () => {
    expect(await call({ modelId: 42, label: 'nsfw', keep: true })).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });
});
