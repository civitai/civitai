import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as RulingService from '~/server/services/text-scan/actions/restricted-nsfw-verdict';

/** `model/resolve-restricted-nsfw-verdict` through the real moderator endpoint: what it rules on. */

const m = vi.hoisted(() => ({
  resolve: vi.fn(),
  session: { user: { id: 7, isModerator: true, permissions: [], bannedAt: null } },
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => m.session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = vi.fn();
    userActivity = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/text-scan/actions/restricted-nsfw-verdict', async (importOriginal) => ({
  ...(await importOriginal<typeof RulingService>()),
  resolveRestrictedNsfwVerdict: m.resolve,
}));

import handler from '~/server/api-routes/mod/model/resolve-restricted-nsfw-verdict';

function call(body: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body, query: {} } as Parameters<typeof handler>[0];
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json: (p: unknown) => {
      payload = p;
      return res;
    },
    setHeader: vi.fn(),
    end: () => res,
  } as unknown as Parameters<typeof handler>[1];
  return handler(req, res).then(() => ({ status: statusCode, payload }));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.resolve.mockResolvedValue({ modelId: 42, ruling: 'keep' });
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('model/resolve-restricted-nsfw-verdict', () => {
  it('rules on the lead revision the moderator posted, as the acting moderator', async () => {
    const res = await call({ modelId: 42, ruling: 'keep', revision: 'rev-1' });
    expect(res.status).toBe(200);
    expect(m.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 42, ruling: 'keep', userId: 7, revision: 'rev-1' })
    );
  });
});
