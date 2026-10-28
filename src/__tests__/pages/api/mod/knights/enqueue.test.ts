import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { mockEnqueue, session } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(),
  session: {
    user: {
      id: 7,
      isModerator: true,
      permissions: ['knightsEnqueue'] as string[],
      bannedAt: null,
    },
  },
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
vi.mock('~/server/db/kyselyDb', () => ({ kyselyWrite: { tag: 'write' } }));
vi.mock('~/server/services/knights/enqueue.service', () => ({ enqueueKnightsItems: mockEnqueue }));

import handler from '~/pages/api/mod/knights/enqueue';

async function call(body: Record<string, unknown>, method = 'POST') {
  const req = { method, headers: {}, body, query: {} } as Parameters<typeof handler>[0];
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(value: unknown) {
      payload = value;
      return res;
    },
    setHeader: vi.fn(),
    end: () => res,
  } as unknown as Parameters<typeof handler>[1];
  await handler(req, res);
  return { status: statusCode, body: payload as Record<string, unknown> };
}

const valid = {
  source: 'dataset-import',
  questionKey: 'knights.image.nsfwLevel',
  items: [{ imageId: 5, priority: 2 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  session.user.isModerator = true;
  session.user.permissions = ['knightsEnqueue'];
  mockEnqueue.mockResolvedValue([{ imageId: 5, outcome: 'enqueued', itemId: 11 }]);
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('knights.enqueue', () => {
  it('hands the contract to the queue and returns one outcome per item', async () => {
    mockEnqueue.mockResolvedValue([
      { imageId: 5, outcome: 'enqueued', itemId: 11 },
      { imageId: 6, outcome: 'duplicate' },
      { imageId: 7, outcome: 'refused', reason: 'bad-rank' },
    ]);

    const res = await call({
      ...valid,
      items: [
        {
          imageId: 5,
          priority: 1,
          minRank: 'Templar',
          votesNeeded: 3,
          expiresAt: '2026-12-20T00:00:00.000Z',
          prediction: { value: '4' },
        },
        { imageId: 6, priority: 3, expiresAt: null },
        { imageId: 7, priority: 2, minRank: 'Acolyte' },
      ],
    });

    expect(res.status).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledWith(expect.anything(), {
      source: 'dataset-import',
      questionKey: 'knights.image.nsfwLevel',
      items: [
        {
          imageId: 5,
          priority: 1,
          minRank: 'Templar',
          votesNeeded: 3,
          expiresAt: new Date('2026-12-20T00:00:00.000Z'),
          prediction: { value: '4' },
        },
        { imageId: 6, priority: 3, expiresAt: null },
        { imageId: 7, priority: 2, minRank: 'Acolyte' },
      ],
    });
    expect(res.body.results).toEqual([
      { imageId: 5, outcome: 'enqueued', itemId: 11 },
      { imageId: 6, outcome: 'duplicate' },
      { imageId: 7, outcome: 'refused', reason: 'bad-rank' },
    ]);
  });

  it('needs the knightsEnqueue grant on top of the moderator role', async () => {
    session.user.permissions = [];
    expect((await call(valid)).status).toBe(403);

    session.user.permissions = ['knightsEnqueue'];
    session.user.isModerator = false;
    expect((await call(valid)).status).toBe(403);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['a priority outside 1-3', { items: [{ imageId: 5, priority: 4 }] }],
    ['no items', { items: [] }],
    [
      'more than 1000 items',
      { items: Array.from({ length: 1001 }, (_, i) => ({ imageId: i + 1, priority: 1 })) },
    ],
    ['an image id that is not an integer', { items: [{ imageId: '5', priority: 1 }] }],
    ['a source with spaces', { source: 'Dataset Import' }],
    [
      'an expiry that is not a date',
      { items: [{ imageId: 5, priority: 1, expiresAt: 'tomorrow' }] },
    ],
  ])('answers 400 for %s', async (_label, patch) => {
    const res = await call({ ...valid, ...patch });
    expect(res.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('only answers POST', async () => {
    expect((await call(valid, 'GET')).status).toBe(405);
  });
});
