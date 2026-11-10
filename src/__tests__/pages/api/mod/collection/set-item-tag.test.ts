import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as CollectionService from '~/server/services/collection.service';

const { mockSetTag, session } = vi.hoisted(() => ({
  mockSetTag: vi.fn(),
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
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  setCollectionItemsTag: mockSetTag,
}));

import handler from '~/pages/api/mod/collection/set-item-tag';

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

const items = { type: 'image', ids: [216970661] };

beforeEach(() => {
  vi.clearAllMocks();
  mockSetTag.mockResolvedValue({ count: 1, collectionItemIds: [1] });
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('collection.setItemTag input', () => {
  it('passes an explicit null through as a clear', async () => {
    expect(await call({ collectionId: 17983600, items, tagId: null })).toBe(200);
    expect(mockSetTag).toHaveBeenCalledWith({ collectionId: 17983600, items, tagId: null });
  });

  // Clearing must be asked for; a caller that forgot the field must not wipe the tag.
  it('refuses a missing tagId rather than clearing', async () => {
    expect(await call({ collectionId: 17983600, items })).toBe(400);
    expect(mockSetTag).not.toHaveBeenCalled();
  });

  it.each([
    ['no ids', { ...items, ids: [] }],
    ['an unknown item type', { type: 'model3d', ids: [1] }],
    ['a non-positive id', { ...items, ids: [0] }],
  ])('refuses %s', async (_, badItems) => {
    expect(await call({ collectionId: 17983600, items: badItems, tagId: 195 })).toBe(400);
    expect(mockSetTag).not.toHaveBeenCalled();
  });
});
