import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { publishModelHandler, session } = vi.hoisted(() => ({
  publishModelHandler: vi.fn(),
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
vi.mock('~/server/controllers/model.controller', () => ({ publishModelHandler }));

import handler from '~/pages/api/mod/model/republish';

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

const model = (over: Record<string, unknown> = {}) => ({
  status: 'UnpublishedViolation',
  deletedAt: null,
  modelVersions: [{ id: 11 }, { id: 12 }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  publishModelHandler.mockResolvedValue({ status: 'Published' });
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

// Approving a model appeal in the moderator app republishes through this, so it must be the
// model page's own moderator republish: every version, as the acting moderator.
describe('model.republish', () => {
  it('publishes every version of a violation-unpublished model as the moderator', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(model() as never);
    expect(await call({ modelId: 42 })).toBe(200);
    expect(publishModelHandler).toHaveBeenCalledWith({
      input: { id: 42, versionIds: [11, 12] },
      ctx: expect.objectContaining({ user: expect.objectContaining({ id: 7, isModerator: true }) }),
    });
  });

  it.each([
    ['published', { status: 'Published' }],
    ['unpublished by its owner', { status: 'Unpublished' }],
    ['deleted', { deletedAt: new Date('2026-10-01') }],
  ])('refuses a model that is %s', async (_label, over) => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(model(over) as never);
    expect(await call({ modelId: 42 })).toBe(400);
    expect(publishModelHandler).not.toHaveBeenCalled();
  });

  it('is a 404 for a model that does not exist', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(null as never);
    expect(await call({ modelId: 42 })).toBe(404);
    expect(publishModelHandler).not.toHaveBeenCalled();
  });
});
