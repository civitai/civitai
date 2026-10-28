import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { publishModelHandler, session, restoreModelRemovedWithOwner } = vi.hoisted(() => ({
  publishModelHandler: vi.fn(),
  restoreModelRemovedWithOwner: vi.fn(),
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
vi.mock('~/server/services/model-removed-with-owner.service', () => ({
  restoreModelRemovedWithOwner,
}));
const { bustMvCache, queueUpdate, refreshCounts } = vi.hoisted(() => ({
  bustMvCache: vi.fn(),
  queueUpdate: vi.fn(),
  refreshCounts: vi.fn(),
}));
vi.mock('~/server/services/model-version.service', () => ({ bustMvCache }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate } }));
vi.mock('~/server/redis/caches', () => ({ userContentOverviewCache: { refresh: refreshCounts } }));

import handler from '~/pages/api/mod/model/republish';

let sent: unknown;
function call(body: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body, query: {} } as Parameters<typeof handler>[0];
  let statusCode = 200;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json: (payload: unknown) => {
      sent = payload;
      return res;
    },
    setHeader: vi.fn(),
    end: () => res,
  } as unknown as Parameters<typeof handler>[1];
  return handler(req, res).then(() => statusCode);
}

const TAKEN_DOWN = '2026-10-01T00:00:00.000Z';
// The query only returns violation-unpublished versions; their stamps say which take-down moved them.
const model = (over: Record<string, unknown> = {}) => ({
  status: 'UnpublishedViolation',
  deletedAt: null,
  meta: { unpublishedAt: TAKEN_DOWN },
  modelVersions: [
    { id: 11, status: 'UnpublishedViolation', meta: { unpublishedAt: TAKEN_DOWN } },
    { id: 12, status: 'UnpublishedViolation', meta: { unpublishedAt: TAKEN_DOWN } },
    { id: 13, status: 'UnpublishedViolation', meta: { unpublishedAt: '2026-09-01T00:00:00.000Z' } },
    // The owner's own unpublish, before the take-down.
    { id: 14, status: 'Unpublished', meta: { unpublishedAt: '2026-08-01T00:00:00.000Z' } },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  sent = undefined;
  publishModelHandler.mockResolvedValue({ status: 'Published' });
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

// Approving a model appeal in the moderator app republishes through this, as the acting moderator.
describe('model.republish', () => {
  it('publishes only the versions the same take-down unpublished', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(model() as never);
    expect(await call({ modelId: 42 })).toBe(200);
    expect(publishModelHandler).toHaveBeenCalledWith({
      input: { id: 42, versionIds: [11, 12] },
      ctx: expect.objectContaining({ user: expect.objectContaining({ id: 7, isModerator: true }) }),
    });
    // The moderator app reads `status` to tell the appellant whether the model is live again.
    expect(sent).toEqual({ modelId: 42, status: 'Published', versionIds: [11, 12] });
  });

  it('asks only the database for violation-unpublished versions, so drafts never go live', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(model() as never);
    await call({ modelId: 42 });
    expect(dbMock.dbWrite.model.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          modelVersions: expect.objectContaining({
            where: { status: { in: ['UnpublishedViolation', 'Unpublished'] } },
          }),
        }),
      })
    );
  });

  it('falls back to every violation-unpublished version when the model carries no stamp', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(model({ meta: null }) as never);
    expect(await call({ modelId: 42 })).toBe(200);
    expect(publishModelHandler).toHaveBeenCalledWith(
      expect.objectContaining({ input: { id: 42, versionIds: [11, 12, 13] } })
    );
  });

  it('puts back the versions a ban unpublished, which it marks Unpublished, not a violation', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      model({
        modelVersions: [
          { id: 21, status: 'Unpublished', meta: { unpublishedAt: TAKEN_DOWN } },
          { id: 22, status: 'Unpublished', meta: { unpublishedAt: '2026-08-01T00:00:00.000Z' } },
        ],
      }) as never
    );
    expect(await call({ modelId: 42 })).toBe(200);
    expect(publishModelHandler).toHaveBeenCalledWith(
      expect.objectContaining({ input: { id: 42, versionIds: [21] } })
    );
  });

  it('refuses when no version came down with the model', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      model({
        modelVersions: [
          {
            id: 13,
            status: 'UnpublishedViolation',
            meta: { unpublishedAt: '2026-09-01T00:00:00.000Z' },
          },
        ],
      }) as never
    );
    expect(await call({ modelId: 42 })).toBe(400);
    expect(publishModelHandler).not.toHaveBeenCalled();
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

describe('model.republish on a model a content wipe kept', () => {
  it('restores its prior status and versions instead of publishing it', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      model({ meta: { removedWithOwner: true, statusBeforeRemoval: 'Unpublished' } }) as never
    );
    restoreModelRemovedWithOwner.mockResolvedValue({
      status: 'Unpublished',
      userId: 5,
      versionIds: [11],
    });

    expect(await call({ modelId: 42 })).toBe(200);
    expect(restoreModelRemovedWithOwner).toHaveBeenCalledWith(42);
    expect(publishModelHandler).not.toHaveBeenCalled();
    expect(sent).toMatchObject({ modelId: 42, status: 'Unpublished', versionIds: [11] });
    // Off its cached and indexed "hidden" state, and its owner's counts redone.
    expect(bustMvCache).toHaveBeenCalledWith([11], 42);
    expect(queueUpdate).toHaveBeenCalledWith([{ id: 42, action: 'Update' }]);
    expect(refreshCounts).toHaveBeenCalledWith(5);
  });
});
