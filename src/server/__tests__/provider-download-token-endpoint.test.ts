import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModeratorService from '~/server/services/moderator.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';

// /api/admin/provider-download-token end to end with the token store: a minted token resolves on
// the download path, a retired one stops resolving, and a token retired permanently stays retired.

const TOKEN = 'test-provider-download-admin-token-0';

const { trackModActivity, store } = vi.hoisted(() => ({
  trackModActivity: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  store: {
    row: null as { key: string; value: unknown } | null,
    providers: [] as string[],
    inTransaction: false,
    lockReads: [] as { sql: string; inTransaction: boolean }[],
  },
}));

vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity,
}));

const handler = (await import('~/pages/api/admin/provider-download-token')).default;
const { getLiveProviderTokens } = await import(
  '~/server/services/provider-download/provider-token.store'
);
const { matchProviderToken } = await import('~/server/services/provider-download/provider-token');

function call(
  body: Record<string, unknown>,
  { token = TOKEN as string | null, method = 'POST' } = {}
) {
  let status = 0;
  let payload: any = {};
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(data: unknown) {
      payload = data;
      return res;
    },
    send: () => res,
    setHeader: () => res,
    end: () => res,
  };
  const req = {
    method,
    query: {},
    url: '/api/admin/provider-download-token',
    headers: token === null ? {} : { 'x-admin-token': token },
    body: { actorUserId: 9, ...body },
  };
  return (
    handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse) as Promise<void>
  ).then(() => ({ status, body: payload }));
}

const resolves = async (token: string) =>
  !!matchProviderToken(token, await getLiveProviderTokens());

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({ PROVIDER_DOWNLOAD_TOKEN_ADMIN_TOKEN: TOKEN });
  store.row = null;
  store.providers = ['RunPods', 'FalAI'];
  const findRow = async () => store.row;
  const providers = async () => store.providers.map((provider) => ({ provider }));
  for (const db of [dbMock.dbRead, dbMock.dbWrite]) {
    db.keyValue.findUnique.mockImplementation(findRow as never);
    db.workerClient.findMany.mockImplementation(providers as never);
  }
  dbMock.dbWrite.keyValue.upsert.mockImplementation((async ({ create }: any) => {
    store.row ??= create;
    return store.row;
  }) as never);
  dbMock.dbWrite.keyValue.update.mockImplementation((async ({ data }: any) => {
    store.row = { ...store.row!, value: data.value };
    return store.row;
  }) as never);
  store.inTransaction = false;
  store.lockReads = [];
  dbMock.dbWrite.$queryRaw.mockImplementation((async (sql: TemplateStringsArray) => {
    store.lockReads.push({ sql: sql.join('?'), inTransaction: store.inTransaction });
    return store.row ? [store.row] : [];
  }) as never);
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: any) => {
    store.inTransaction = true;
    try {
      return await fn(dbMock.dbWrite);
    } finally {
      store.inTransaction = false;
    }
  }) as never);
});

describe('mint', () => {
  it('returns provider:secret once, stores only its hash, and the token resolves', async () => {
    const res = await call({ action: 'mint', provider: 'RunPods', hourlyCeiling: 500 });

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^RunPods:[0-9a-f]{64}$/);
    const secret = res.body.token.split(':')[1];
    expect(JSON.stringify(store.row)).not.toContain(secret);
    expect(res.body.hash).toBeUndefined();
    expect(await resolves(res.body.token)).toBe(true);
    expect(trackModActivity).toHaveBeenCalledWith(-1, {
      entityType: 'user',
      activity: 'providerDownloadToken:mint:RunPods',
    });
  });

  it('reads the records under a row lock, inside the write transaction', async () => {
    await call({ action: 'mint', provider: 'RunPods', hourlyCeiling: 5 });
    expect(store.lockReads).toEqual([
      {
        sql: expect.stringMatching(/FROM "KeyValue" WHERE key = \? FOR UPDATE$/),
        inTransaction: true,
      },
    ]);
  });

  it('refuses a provider no worker client uses', async () => {
    const res = await call({ action: 'mint', provider: 'NotAProvider', hourlyCeiling: 500 });
    expect(res.status).toBe(400);
    expect(await call({ action: 'list' })).toMatchObject({ body: [] });
  });

  it('never shows a token again: the list carries names, state, ceiling and times only', async () => {
    await call({ action: 'mint', provider: 'RunPods', hourlyCeiling: 500 });
    const list = await call({ action: 'list' });
    expect(Object.keys(list.body[0]).sort()).toEqual(
      ['hourlyCeiling', 'id', 'mintedAt', 'provider', 'retiredAt', 'retiredFor'].sort()
    );
    expect(JSON.stringify(list.body)).not.toMatch(/[0-9a-f]{64}/);
  });

  it('refuses a ceiling out of bounds', async () => {
    for (const hourlyCeiling of [0, -1, 1.5, 1_000_001])
      expect((await call({ action: 'mint', provider: 'RunPods', hourlyCeiling })).status).toBe(400);
    expect(await call({ action: 'list' })).toMatchObject({ body: [] });
  });

  it('records a ceiling change in the moderator audit', async () => {
    await call({ action: 'mint', provider: 'RunPods', hourlyCeiling: 500 });
    expect((await call({ action: 'ceiling', provider: 'RunPods', hourlyCeiling: 50 })).status).toBe(
      200
    );
    expect(trackModActivity).toHaveBeenCalledWith(-1, {
      entityType: 'user',
      activity: 'providerDownloadToken:ceiling:RunPods',
    });
  });
});

describe('retire', () => {
  it('stops the token resolving while the other provider keeps working', async () => {
    const runpods = (await call({ action: 'mint', provider: 'RunPods', hourlyCeiling: 5 })).body;
    const fal = (await call({ action: 'mint', provider: 'FalAI', hourlyCeiling: 5 })).body;

    expect((await call({ action: 'retire', id: runpods.id, reason: 'planned' })).status).toBe(200);

    expect(await resolves(runpods.token)).toBe(false);
    expect(await resolves(fal.token)).toBe(true);
  });

  it('a planned retirement can be undone', async () => {
    const minted = (await call({ action: 'mint', provider: 'RunPods', hourlyCeiling: 5 })).body;
    await call({ action: 'retire', id: minted.id, reason: 'planned' });
    expect((await call({ action: 'unretire', id: minted.id })).status).toBe(200);
    expect(await resolves(minted.token)).toBe(true);
  });

  it('a token retired permanently cannot be unretired', async () => {
    const minted = (await call({ action: 'mint', provider: 'RunPods', hourlyCeiling: 5 })).body;
    await call({ action: 'retire', id: minted.id, reason: 'permanent' });

    const res = await call({ action: 'unretire', id: minted.id });

    expect(res.status).toBe(400);
    expect(await resolves(minted.token)).toBe(false);
  });

  it('a permanent retirement stays permanent when the token is retired again as planned', async () => {
    const minted = (await call({ action: 'mint', provider: 'RunPods', hourlyCeiling: 5 })).body;
    await call({ action: 'retire', id: minted.id, reason: 'permanent' });
    await call({ action: 'retire', id: minted.id, reason: 'planned' });

    expect((await call({ action: 'unretire', id: minted.id })).status).toBe(400);
    expect(await resolves(minted.token)).toBe(false);
  });
});

describe('through the cache the download route reads', () => {
  beforeEach(() => {
    const cache = new Map<string, unknown>();
    redisMock.redis.packed.get.mockImplementation(
      (async (key: string) => cache.get(key) ?? null) as never
    );
    redisMock.redis.packed.set.mockImplementation((async (key: string, value: unknown) => {
      cache.set(key, value);
      return 'OK';
    }) as never);
    redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true as never);
  });

  it('a retire reaches a warm cache at once', async () => {
    const minted = (await call({ action: 'mint', provider: 'RunPods', hourlyCeiling: 5 })).body;
    expect(await resolves(minted.token)).toBe(true);
    // Served from the cache from here on: the row is no longer read.
    dbMock.dbWrite.keyValue.findUnique.mockClear();
    expect(await resolves(minted.token)).toBe(true);
    expect(dbMock.dbWrite.keyValue.findUnique).not.toHaveBeenCalled();

    await call({ action: 'retire', id: minted.id, reason: 'permanent' });

    expect(await resolves(minted.token)).toBe(false);
  });

  it('requests that find the cache cold while another refill holds the lock share one row read', async () => {
    const minted = (await call({ action: 'mint', provider: 'RunPods', hourlyCeiling: 5 })).body;
    redisMock.redis.packed.get.mockResolvedValue(null as never);
    redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(false as never);
    dbMock.dbWrite.keyValue.findUnique.mockClear();

    const results = await Promise.all(Array.from({ length: 5 }, () => resolves(minted.token)));

    expect(results).toEqual([true, true, true, true, true]);
    expect(dbMock.dbWrite.keyValue.findUnique).toHaveBeenCalledTimes(1);
  });

  it('a cache that cannot be read falls back to the row', async () => {
    const minted = (await call({ action: 'mint', provider: 'RunPods', hourlyCeiling: 5 })).body;
    redisMock.redis.packed.get.mockRejectedValue(new Error('cache down'));
    expect(await resolves(minted.token)).toBe(true);
  });

  it('a row that cannot be read throws, so the route answers 503 rather than 401', async () => {
    redisMock.redis.packed.get.mockRejectedValue(new Error('cache down'));
    dbMock.dbWrite.keyValue.findUnique.mockRejectedValue(new Error('db down'));
    await expect(getLiveProviderTokens()).rejects.toThrow('db down');
  });

  it('a refill whose row read fails throws, rather than retrying the row', async () => {
    dbMock.dbWrite.keyValue.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(getLiveProviderTokens()).rejects.toThrow('db down');
  });
});

describe('gating', () => {
  it('401s without the admin token', async () => {
    expect((await call({ action: 'list' }, { token: null })).status).toBe(401);
    expect(
      (await call({ action: 'list' }, { token: 'wrong-token-wrong-token-wrong-123' })).status
    ).toBe(401);
  });

  it('405s anything but POST', async () => {
    expect((await call({ action: 'list' }, { method: 'GET' })).status).toBe(405);
  });

  it.each([
    'SYSTEM_ACCOUNT_KEY_TOKEN',
    'SYSTEM_ACCOUNT_PROFILE_TOKEN',
    'WEBHOOK_TOKEN',
    'WEBHOOK_TOKEN_PREVIOUS',
    'PROBE_TOKEN',
    'JOB_TOKEN',
  ])('is off while its token repeats %s', async (other) => {
    // Distinct per row: env overrides persist across tests in a file.
    const shared = `shared-${other}`.padEnd(40, 's');
    setEnv({ PROVIDER_DOWNLOAD_TOKEN_ADMIN_TOKEN: shared, [other]: shared });
    expect((await call({ action: 'list' }, { token: shared })).status).toBe(503);
  });
});
