import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Handler-level coverage for POST /api/blocks/submit-version — the dedicated
 * 72mb upload route that replaced the `blocks.submitVersion` tRPC mutation (so
 * the shared tRPC route could revert to 17mb). The route is a thin auth/flag/
 * validation shell over the well-tested `submitVersion` service
 * (publish-request.orchestration.test.ts), so this exercises only the shell:
 * the ModEndpoint moderator gate, the appBlocks flag (503), the bundle-storage
 * precondition (412), schema validation (400), and the success/error mapping.
 *
 * We drive the REAL ModEndpoint wrapper (mocking only getServerAuthSession +
 * withAxiom) so the moderator/method gate is genuinely tested, and mock the
 * flag, env, and service so the handler runs end-to-end in unit scope.
 */

const { mockSession, mockEnv, mockIsAppBlocksEnabled, mockSubmitVersion } = vi.hoisted(() => ({
  mockSession: {
    value: null as { user: { id: number; isModerator?: boolean; bannedAt: Date | null } } | null,
  },
  mockEnv: {
    BUNDLE_S3_ENDPOINT: 'https://s3.example',
    BUNDLE_S3_BUCKET: 'bundles',
    // Read at endpoint-helpers module load (allowedOrigins computation).
    NEXTAUTH_URL: 'https://civitai.com',
    TRPC_ORIGINS: [] as string[],
  } as {
    BUNDLE_S3_ENDPOINT?: string;
    BUNDLE_S3_BUCKET?: string;
    NEXTAUTH_URL?: string;
    TRPC_ORIGINS?: string[];
  },
  mockIsAppBlocksEnabled: vi.fn<() => Promise<boolean>>(async () => true),
  mockSubmitVersion: vi.fn<(...args: any[]) => Promise<any>>(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
// Mirror the global setup's Proxy approach: serve our explicit BUNDLE_S3_* keys
// (mutable per-test), a benign LOGGING default for module-load consumers
// (createLogger), and undefined for everything else.
vi.mock('~/env/server', () => ({
  env: new Proxy(mockEnv as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'LOGGING') return '';
      return undefined;
    },
  }),
}));
// endpoint-helpers imports `dbRead` at module load → the real db/client would
// run createPrismaClient against our partial env mock. Stub it; the route under
// test never touches the DB directly (the service does, and that's mocked).
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
// endpoint-helpers also imports getOrchestratorToken, which eagerly builds a
// redis client at module load. The route never uses it — stub to cut the chain.
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({ getOrchestratorToken: vi.fn() }));
vi.mock('~/server/utils/server-domain', () => ({ getAllServerHosts: () => ['civitai.com'] }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => mockSession.value),
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  submitVersion: mockSubmitVersion,
}));

function makeReq(opts: { method?: string; body?: unknown } = {}): NextApiRequest {
  return {
    method: opts.method ?? 'POST',
    headers: {},
    body: opts.body,
    query: {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

function makeRes(): NextApiResponse & { _status: number; _body: any; _headers: Record<string, string> } {
  const res = {
    _status: 0,
    _body: null,
    _headers: {} as Record<string, string>,
    setHeader: vi.fn(function (this: any, name: string, value: string) {
      this._headers[String(name).toLowerCase()] = value;
      return this;
    }),
    status: vi.fn(function (this: any, n: number) {
      this._status = n;
      return this;
    }),
    json: vi.fn(function (this: any, body: unknown) {
      this._body = body;
      return this;
    }),
    end: vi.fn(function (this: any) {
      return this;
    }),
  };
  return res as unknown as NextApiResponse & { _status: number; _body: any; _headers: Record<string, string> };
}

async function invoke(req: NextApiRequest, res: NextApiResponse) {
  const handler = (await import('~/pages/api/blocks/submit-version')).default;
  await handler(req, res);
}

const MOD = { user: { id: 42, isModerator: true, bannedAt: null } };
const bundleBase64 = Buffer.from('fake-zip-bytes').toString('base64');
const SERVICE_RESULT = { publishRequestId: 'pr_1', slug: 'my-app', version: '1.0.0' };

describe('POST /api/blocks/submit-version', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.value = MOD;
    mockEnv.BUNDLE_S3_ENDPOINT = 'https://s3.example';
    mockEnv.BUNDLE_S3_BUCKET = 'bundles';
    mockIsAppBlocksEnabled.mockResolvedValue(true);
    mockSubmitVersion.mockReset();
    mockSubmitVersion.mockResolvedValue(SERVICE_RESULT);
  });

  it('405s a non-POST method', async () => {
    const res = makeRes();
    await invoke(makeReq({ method: 'GET' }), res);
    expect(res._status).toBe(405);
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('401s when there is no session', async () => {
    mockSession.value = null;
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64 } }), res);
    expect(res._status).toBe(401);
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('401s a logged-in non-moderator', async () => {
    mockSession.value = { user: { id: 7, isModerator: false, bannedAt: null } };
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64 } }), res);
    expect(res._status).toBe(401);
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('401s a banned moderator', async () => {
    mockSession.value = { user: { id: 42, isModerator: true, bannedAt: new Date() } };
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64 } }), res);
    expect(res._status).toBe(401);
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('503s when the appBlocks flag is off', async () => {
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64 } }), res);
    expect(res._status).toBe(503);
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('412s when bundle storage is not configured', async () => {
    mockEnv.BUNDLE_S3_ENDPOINT = undefined;
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64 } }), res);
    expect(res._status).toBe(412);
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('400s an invalid payload (empty bundleBase64)', async () => {
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64: '' } }), res);
    expect(res._status).toBe(400);
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('400s a payload missing bundleBase64', async () => {
    const res = makeRes();
    await invoke(makeReq({ body: {} }), res);
    expect(res._status).toBe(400);
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('200s on success: decodes the bundle and calls the service with the moderator id', async () => {
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64 } }), res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual(SERVICE_RESULT);
    expect(mockSubmitVersion).toHaveBeenCalledTimes(1);
    const arg = mockSubmitVersion.mock.calls[0][0];
    expect(arg.submittedByUserId).toBe(42);
    expect(Buffer.isBuffer(arg.bundleBuffer)).toBe(true);
    expect((arg.bundleBuffer as Buffer).equals(Buffer.from('fake-zip-bytes'))).toBe(true);
  });

  it('400s and surfaces the service error message', async () => {
    mockSubmitVersion.mockRejectedValue(new Error('bundle exceeds 50 MiB'));
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64 } }), res);
    expect(res._status).toBe(400);
    expect(res._body).toEqual({ message: 'bundle exceeds 50 MiB' });
  });
});
