import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Handler-level coverage for POST /api/blocks/submit-version — the dedicated
 * 72mb upload route that replaced the `blocks.submitVersion` tRPC mutation (so
 * the shared tRPC route could revert to 17mb). The route is a thin auth/flag/
 * validation shell over the well-tested `submitVersion` service
 * (publish-request.orchestration.test.ts), so this exercises only the shell.
 *
 * Following the repo's `moderator-endpoint.test.ts` convention, we mock
 * `~/server/utils/endpoint-helpers` rather than drive the real `withAxiom`
 * wrapper (heavy, and its closure is captured at module-load so a per-file
 * vi.mock of withAxiom is unreliable in the full-suite run). The `ModEndpoint`
 * stub below reproduces the REAL gate logic verbatim (method allowlist → 405;
 * session + isModerator + not-banned → 401), so the 405/401 cases stay
 * faithful; the flag/storage/validation/decode/service branches run the real
 * handler body.
 */

const {
  mockSession,
  mockEnv,
  mockOther,
  mockIsAllowedOrigin,
  mockIsAppBlocksEnabled,
  mockSubmitVersion,
} = vi.hoisted(() => ({
  mockSession: {
    value: null as { user: { id: number; isModerator?: boolean; bannedAt: Date | null } } | null,
  },
  mockEnv: { BUNDLE_S3_ENDPOINT: 'https://s3.example', BUNDLE_S3_BUCKET: 'bundles' } as {
    BUNDLE_S3_ENDPOINT?: string;
    BUNDLE_S3_BUCKET?: string;
  },
  // Toggle the isProd branch of the CSRF guard per-test.
  mockOther: { isProd: false },
  mockIsAllowedOrigin: vi.fn<(req: unknown) => boolean>(() => true),
  mockIsAppBlocksEnabled: vi.fn<() => Promise<boolean>>(async () => true),
  mockSubmitVersion: vi.fn<(...args: any[]) => Promise<any>>(),
}));

vi.mock('~/env/server', () => ({ env: mockEnv }));
vi.mock('~/env/other', () => ({
  get isProd() {
    return mockOther.isProd;
  },
}));
vi.mock('~/server/utils/origin-helpers', () => ({
  isAllowedOriginRequest: mockIsAllowedOrigin,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  submitVersion: mockSubmitVersion,
}));
// Faithful ModEndpoint reproduction (mirrors endpoint-helpers.ts) — avoids the
// real withAxiom + db/orchestrator import chain while keeping the auth gate's
// behaviour identical. Reads mockSession.value the same way the real wrapper
// reads getServerAuthSession().
vi.mock('~/server/utils/endpoint-helpers', () => ({
  ModEndpoint:
    (
      handler: (req: NextApiRequest, res: NextApiResponse, user: { id: number }) => Promise<void>,
      allowedMethods: string[] = ['GET']
    ) =>
    async (req: NextApiRequest, res: NextApiResponse) => {
      if (!req.method || !allowedMethods.includes(req.method)) {
        res.setHeader('Allow', allowedMethods.join(', '));
        res.status(405).json({ error: 'Method not allowed' });
        return;
      }
      const session = mockSession.value;
      if (!session || !session.user?.isModerator || !!session.user.bannedAt) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      await handler(req, res, session.user);
    },
}));

function makeReq(opts: { method?: string; body?: unknown } = {}): NextApiRequest {
  return {
    method: opts.method ?? 'POST',
    headers: {},
    body: opts.body,
    query: {},
  } as unknown as NextApiRequest;
}

function makeRes(): NextApiResponse & { _status: number; _body: any } {
  const res = {
    _status: 0,
    _body: null as any,
    setHeader: vi.fn(function (this: any) {
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
  return res as unknown as NextApiResponse & { _status: number; _body: any };
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
    mockOther.isProd = false;
    mockIsAllowedOrigin.mockReturnValue(true);
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

  it('403s a prod cross-origin POST and does not call the service (CSRF guard)', async () => {
    mockOther.isProd = true;
    mockIsAllowedOrigin.mockReturnValue(false);
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64 } }), res);
    expect(res._status).toBe(403);
    expect(res._body).toEqual({ message: 'Cross-origin request blocked' });
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('lets a prod same-origin POST through to the service (CSRF guard)', async () => {
    mockOther.isProd = true;
    mockIsAllowedOrigin.mockReturnValue(true);
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64 } }), res);
    expect(res._status).toBe(200);
    expect(mockSubmitVersion).toHaveBeenCalledTimes(1);
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

  // ---------------------------------------------------------------------------
  // #4059 build provenance. The route's job is to pass the client's CLAIM
  // through unchanged and to reject a malformed one with a message that names
  // the field — a provenance rejection reported as "Invalid bundle payload"
  // sends the author hunting the zip.
  // ---------------------------------------------------------------------------
  const SHA = '4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3';

  it('passes sourceCommit + sourceDirty through to the service verbatim', async () => {
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64, sourceCommit: SHA, sourceDirty: true } }), res);
    expect(res._status).toBe(200);
    const arg = mockSubmitVersion.mock.calls[0][0];
    expect(arg.sourceCommit).toBe('4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3');
    expect(arg.sourceDirty).toBe(true);
  });

  it('passes sourceDirty:false through as FALSE, not as absent', async () => {
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64, sourceCommit: SHA, sourceDirty: false } }), res);
    expect(res._status).toBe(200);
    const arg = mockSubmitVersion.mock.calls[0][0];
    expect(arg.sourceDirty).toBe(false);
  });

  it('a submit with NO provenance still reaches the service with both undefined', async () => {
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64 } }), res);
    expect(res._status).toBe(200);
    const arg = mockSubmitVersion.mock.calls[0][0];
    expect(arg.sourceCommit).toBeUndefined();
    expect(arg.sourceDirty).toBeUndefined();
  });

  // 🔴 JSON `null` = UNKNOWN and must NOT 400 — pinned at the ROUTE as well as
  // at the schema, so the two surfaces cannot disagree in isolation.
  it('JSON null on both provenance fields is a 200 (UNKNOWN), reaching the service as undefined', async () => {
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64, sourceCommit: null, sourceDirty: null } }), res);
    expect(res._status).toBe(200);
    expect(mockSubmitVersion).toHaveBeenCalledTimes(1);
    const arg = mockSubmitVersion.mock.calls[0][0];
    // undefined, NOT null — undefined is what makes Prisma omit the column.
    expect(arg.sourceCommit).toBeUndefined();
    expect(arg.sourceDirty).toBeUndefined();
    expect(arg.sourceCommit).not.toBeNull();
    expect(arg.sourceDirty).not.toBeNull();
  });

  it('JSON null on ONE field does not take a valid SIBLING down with it', async () => {
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64, sourceCommit: SHA, sourceDirty: null } }), res);
    expect(res._status).toBe(200);
    const arg = mockSubmitVersion.mock.calls[0][0];
    expect(arg.sourceCommit).toBe('4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3');
    expect(arg.sourceDirty).toBeUndefined();
  });

  it('400s a malformed sourceCommit with a message NAMING the field, and never submits', async () => {
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64, sourceCommit: 'not-a-sha' } }), res);
    expect(res._status).toBe(400);
    expect((res._body as { message: string }).message).toContain('sourceCommit');
    // 🔴 The rejection must NOT be reported as a bundle problem.
    expect((res._body as { message: string }).message).not.toBe('Invalid bundle payload');
    // And it is a rejection, not a silent drop.
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('400s an UPPERCASE sourceCommit (lowercase 40-hex only)', async () => {
    const res = makeRes();
    await invoke(
      makeReq({ body: { bundleBase64, sourceCommit: '4F3A9C2E17B06D85FA1C39E470B28D6AC519E0F3' } }),
      res
    );
    expect(res._status).toBe(400);
    expect((res._body as { message: string }).message).toContain('sourceCommit');
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('400s a non-boolean sourceDirty with a message NAMING the field', async () => {
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64, sourceDirty: 'true' } }), res);
    expect(res._status).toBe(400);
    expect((res._body as { message: string }).message).toContain('sourceDirty');
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('BUNDLE rejections keep the exact legacy message (unchanged by #4059)', async () => {
    const res = makeRes();
    await invoke(makeReq({ body: { bundleBase64: '' } }), res);
    expect(res._status).toBe(400);
    expect(res._body).toEqual({ message: 'Invalid bundle payload' });

    const res2 = makeRes();
    await invoke(makeReq({ body: {} }), res2);
    expect(res2._status).toBe(400);
    expect(res2._body).toEqual({ message: 'Invalid bundle payload' });
  });
});
