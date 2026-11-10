import type { NextApiRequest, NextApiResponse } from 'next';
import client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GenerationFetch from '~/server/services/download-link/generation-fetch.service';
import type * as TokenStore from '~/server/services/provider-download/provider-token.store';
import type * as DeliveryWorker from '~/utils/delivery-worker';

// A per-provider download token (`?token=<provider>:<secret>`) on the model download route.

const {
  mockGetServerAuthSession,
  mockGetFileForModelVersion,
  mockGetLiveProviderTokens,
  mockCheckGenerationFetch,
  mockResolveDownloadUrl,
  mockModelVersionEvent,
  mockTrackerCtor,
} = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockGetFileForModelVersion: vi.fn(),
  mockGetLiveProviderTokens: vi.fn(),
  mockCheckGenerationFetch: vi.fn(),
  mockResolveDownloadUrl: vi.fn(),
  mockModelVersionEvent: vi.fn(),
  mockTrackerCtor: vi.fn(),
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockGetServerAuthSession,
}));
vi.mock('~/server/services/file.service', () => ({
  getFileForModelVersion: mockGetFileForModelVersion,
  getDownloadFilename: () => 'file.safetensors',
}));
vi.mock('~/server/services/user.service', () => ({
  bustUserDownloadsCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: undefined,
  Tracker: class {
    constructor(...args: unknown[]) {
      mockTrackerCtor(...args);
    }
    modelVersionEvent = mockModelVersionEvent;
  },
}));
vi.mock('~/server/utils/rate-limiting', () => ({
  createLimiter: () => ({
    hasExceededLimit: vi.fn().mockResolvedValue(false),
    increment: vi.fn().mockResolvedValue(undefined),
    getCount: vi.fn(),
  }),
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));
vi.mock('~/server/services/provider-download/provider-token.store', async (importOriginal) => ({
  ...(await importOriginal<typeof TokenStore>()),
  getLiveProviderTokens: mockGetLiveProviderTokens,
}));
vi.mock('~/server/services/download-link/generation-fetch.service', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationFetch>()),
  checkGenerationFetch: mockCheckGenerationFetch,
}));
vi.mock('~/utils/delivery-worker', async (importOriginal) => ({
  ...(await importOriginal<typeof DeliveryWorker>()),
  resolveDownloadUrl: mockResolveDownloadUrl,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import handler from '~/pages/api/download/models/[modelVersionId]';
import { hashProviderSecret } from '~/server/services/provider-download/provider-token';

const SECRET = 'ab'.repeat(32);
/** The hourly counter's value after this request's INCR. */
const mockCounter = vi.fn<() => Promise<number>>();
const mockCounterSet = vi.fn();
const LIVE = [{ provider: 'RunPods', hash: hashProviderSecret(SECRET), hourlyCeiling: 100 }];
const PUBLIC_VERSION = 123;

async function run(
  query: Record<string, string | string[]>,
  headers: Record<string, string> = {},
  url?: string
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    for (const v of Array.isArray(value) ? value : [value]) search.append(key, v);
  const req = {
    method: 'GET',
    url: url ?? `/api/download/models/${PUBLIC_VERSION}?${search}`,
    query: { modelVersionId: String(PUBLIC_VERSION), ...query },
    headers: { 'user-agent': 'python-requests/2.31', ...headers },
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    headersSent: false,
  } as unknown as NextApiResponse;
  await handler(req, res);
  return { req, res };
}

async function counter(provider: string, result: string) {
  const metric = client.register.getSingleMetric('civitai_provider_download_total');
  const values = (await metric?.get())?.values ?? [];
  return values
    .filter((v) => v.labels.provider === provider && v.labels.result === result)
    .reduce((sum, v) => sum + v.value, 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEnv();
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  mockGetServerAuthSession.mockResolvedValue(null);
  // An anonymous caller may download this version.
  mockGetFileForModelVersion.mockResolvedValue({
    status: 'success',
    url: 'https://storage.example/public',
    published: true,
    isDownloadable: true,
    metadata: {},
    modelId: 1,
    fileId: 1,
    nsfw: false,
    inEarlyAccess: false,
    urlExpiresAt: new Date(Date.now() + 3600_000),
  });
  mockGetLiveProviderTokens.mockResolvedValue(LIVE);
  mockCheckGenerationFetch.mockResolvedValue({
    ok: true,
    modelId: 1,
    modelVersionId: PUBLIC_VERSION,
    fileId: 7,
    fileUrl: 'https://bucket/7.safetensors',
    fileName: '7.safetensors',
    sizeKB: 1,
    nsfw: false,
    inEarlyAccess: false,
    isPublic: false,
  });
  mockResolveDownloadUrl.mockResolvedValue({
    url: 'https://storage.example/private?sig=1',
    urlExpiryDate: new Date(Date.now() + 3600_000),
  });
  mockModelVersionEvent.mockResolvedValue(true);
  mockCounter.mockReset().mockResolvedValue(1);
  mockCounterSet.mockReset();
  redisMock.sysRedis.multi.mockReset().mockImplementation(() => {
    const chain = {
      set: (...args: unknown[]) => {
        mockCounterSet(...args);
        return chain;
      },
      incr: () => chain,
      exec: async () => ['OK', await mockCounter()],
    };
    return chain;
  });
});

describe('an unknown provider token', () => {
  it('is a 401 with the provider body on a version anyone can download, not an anonymous download', async () => {
    // Control: the same request without the token downloads.
    const anonymous = await run({});
    expect(anonymous.res.redirect).toHaveBeenCalledWith('https://storage.example/public');

    const before = await counter('unknown', 'refused_401');
    const beforeRunPods = await counter('RunPods', 'refused_401');
    const { res } = await run({ token: `RunPods:${'cd'.repeat(32)}` });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'invalid provider token' });
    expect(res.redirect).not.toHaveBeenCalled();
    expect(await counter('RunPods', 'refused_401')).toBe(beforeRunPods + 1);
    expect(await counter('unknown', 'refused_401')).toBe(before);
  });

  it('is a 401 whatever comes before the colon', async () => {
    const { res } = await run({ token: 'not a provider:x' });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'invalid provider token' });
  });
});

describe('a configured webhook token that contains a colon', () => {
  const WEBHOOK = `hook:${'ef'.repeat(20)}`;

  it('keeps the path it had before provider tokens: not a provider token, left on the request', async () => {
    setEnv({ WEBHOOK_TOKEN: WEBHOOK });
    const { req, res } = await run({ token: WEBHOOK });

    expect(mockGetLiveProviderTokens).not.toHaveBeenCalled();
    expect(req.query.token).toBe(WEBHOOK);
    expect(res.redirect).toHaveBeenCalledWith('https://storage.example/public');
  });

  it('control: only the exact value is exempt; one character more is a provider token', async () => {
    setEnv({ WEBHOOK_TOKEN: WEBHOOK });
    const { res } = await run({ token: `${WEBHOOK}0` });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'invalid provider token' });
  });
});

describe('a live provider token', () => {
  it('302s to the file and records a GenerationFetch carrying the provider', async () => {
    const { res } = await run({ token: `RunPods:${SECRET}` });

    expect(res.redirect).toHaveBeenCalledWith('https://storage.example/private?sig=1');
    expect(mockCheckGenerationFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        modelVersionId: PUBLIC_VERSION,
        principal: { kind: 'provider', provider: 'RunPods' },
      })
    );
    // The event is recorded with no user, even when the request carries one.
    expect(mockTrackerCtor).toHaveBeenCalledWith(expect.anything(), expect.anything(), null);
    expect(mockModelVersionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'GenerationFetch', provider: 'RunPods', fileId: 7 })
    );
    expect(mockGetFileForModelVersion).not.toHaveBeenCalled();
  });

  it('never resolves a session, even with an Authorization header', async () => {
    await run(
      { token: `RunPods:${SECRET}` },
      { authorization: 'Bearer 0123456789abcdef0123456789abcdef' }
    );
    expect(mockGetServerAuthSession).not.toHaveBeenCalled();
  });

  it('is removed from req.query and req.url, so later code never sees it', async () => {
    mockResolveDownloadUrl.mockRejectedValue(new Error('storage down'));
    const { req, res } = await run({ token: `RunPods:${SECRET}`, type: 'Model' });

    expect(res.status).toHaveBeenCalledWith(500);
    expect(req.query.token).toBeUndefined();
    expect(req.url).toBe(`/api/download/models/${PUBLIC_VERSION}?type=Model`);
  });

  it('never reaches a log line, through the split-query repair, a bad query or a 401', async () => {
    const token = `RunPods:${SECRET}`;
    // A client that appended a second `?`: the repair recovers `token` from inside `type`.
    await run(
      { type: `Model?token=${token}` },
      {},
      `/api/download/models/${PUBLIC_VERSION}?type=Model?token=${token}`
    );
    await run({ token, type: 'NotAType' });
    await run({ token: `RunPods:${'cd'.repeat(32)}` });

    const logged = JSON.stringify(loggingMock.logToAxiom.mock.calls);
    // Control: the repair log, written while the token was still on the request, did fire.
    expect(logged).toContain('split-query-repaired');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('cd'.repeat(32));
  });

  it('passes the file selectors to the gate', async () => {
    await run({ token: `RunPods:${SECRET}`, format: 'GGUF', type: 'Model' });
    expect(mockCheckGenerationFetch).toHaveBeenCalledWith(
      expect.objectContaining({ selectors: { format: 'GGUF', type: 'Model' } })
    );
  });

  it("answers the gate's refusal", async () => {
    mockCheckGenerationFetch.mockResolvedValue({ ok: false, error: 'in-review' });
    const { res } = await run({ token: `RunPods:${SECRET}` });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'in-review' });
  });
});

describe('the hourly ceiling', () => {
  it('429s past the ceiling', async () => {
    mockCounter.mockResolvedValue(101);
    const { res } = await run({ token: `RunPods:${SECRET}` });
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockCheckGenerationFetch).not.toHaveBeenCalled();
  });

  it('creates the hour counter with its expiry in the same MULTI as the count', async () => {
    await run({ token: `RunPods:${SECRET}` });
    expect(mockCounterSet).toHaveBeenCalledWith(
      expect.stringMatching(/^download:provider:RunPods:\d+$/),
      '0',
      { NX: true, EX: 7200 }
    );
  });

  it('allows the download that reaches the ceiling exactly', async () => {
    mockCounter.mockResolvedValue(100);
    const { res } = await run({ token: `RunPods:${SECRET}` });
    expect(res.redirect).toHaveBeenCalledWith('https://storage.example/private?sig=1');
  });

  it('allows the download when the counter is unavailable', async () => {
    mockCounter.mockRejectedValue(new Error('redis down'));
    const { res } = await run({ token: `RunPods:${SECRET}` });
    expect(res.redirect).toHaveBeenCalledWith('https://storage.example/private?sig=1');
  });
});

it('a token store that cannot be read is a 503, never a 401', async () => {
  mockGetLiveProviderTokens.mockRejectedValue(new Error('db down'));
  const { res } = await run({ token: `RunPods:${SECRET}` });
  expect(res.status).toHaveBeenCalledWith(503);
});

it('two tokens on one request are a 400', async () => {
  const { res } = await run({ token: [`RunPods:${SECRET}`, '0123456789abcdef0123456789abcdef'] });
  expect(res.status).toHaveBeenCalledWith(400);
  expect(mockGetServerAuthSession).not.toHaveBeenCalled();
});

it('a user API key on the same route still resolves a session', async () => {
  await run({ token: '0123456789abcdef0123456789abcdef' });
  expect(mockGetServerAuthSession).toHaveBeenCalled();
  expect(mockGetLiveProviderTokens).not.toHaveBeenCalled();
});
