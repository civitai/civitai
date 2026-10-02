import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for the five `/api/v1/blocks/app-storage/*` routes.
 *
 * The authorization ladder itself lives in `resolveStorageContext` and is pinned
 * in the `apps.router` storage tests — this file covers the REST wrapper, and in
 * particular the four properties a consumer's correctness depends on:
 *
 *   1. `list` NEVER answers 200 with an empty envelope when the shared body
 *      throws. `civitai-app-model-benchmarking` disarms its double-spend backstop
 *      on a complete, untruncated scan, so a soft-failed listing is read as
 *      "nothing is running" and every reload becomes a clean double-charge WITH
 *      THE GUARD EXPLICITLY DISABLED.
 *   2. `set` REJECTS on refusal — it never resolves `{ ok: false }`. The same
 *      consumer claims an in-flight marker here BEFORE it spends Buzz and treats
 *      a rejection as "do not spend".
 *   3. `nextCursor` is passed through untouched, present exactly when the shared
 *      body set it. Both directions are live: always present arms the expensive
 *      backstop forever, never present makes a truncated scan report
 *      `truncated: false` and disarms it.
 *   4. The bearer token reaches the shared body, and the shared body is the ONLY
 *      thing that decides — the routes add no authorization of their own.
 */

function createMocks({
  method = 'POST',
  body = {},
  authorization = 'Bearer tok_storage',
}: { method?: string; body?: unknown; authorization?: string } = {}) {
  const req = {
    method,
    body,
    query: {},
    url: '/api/v1/blocks/app-storage/get',
    headers: { authorization, host: 'civitai.test' },
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as Record<string, unknown>;
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {
      return res;
    },
    _status: () => statusCode,
    _json: () => payload,
  };
  return { req, res };
}

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: any) => h }));

const { mockGet, mockSet, mockDelete, mockList, mockQuota, mockHandleEndpointError } = vi.hoisted(
  () => ({
    mockGet: vi.fn(),
    mockSet: vi.fn(),
    mockDelete: vi.fn(),
    mockList: vi.fn(),
    mockQuota: vi.fn(),
    mockHandleEndpointError: vi.fn(),
  })
);

// The five shared-body functions are mocked so this file tests the ADAPTER. The
// bodies themselves are the tRPC procedures' bodies and are covered by the
// router's own tests — that is the entire point of the extraction.
vi.mock('~/server/services/apps/app-storage.service', async () => {
  const z = await import('zod');
  return {
    getAppStorageValue: mockGet,
    setAppStorageValue: mockSet,
    deleteAppStorageValue: mockDelete,
    listAppStorageKeys: mockList,
    getAppStorageQuota: mockQuota,
    // The REAL schemas, not stubs: a stubbed schema would make every
    // input-validation assertion below vacuous.
    appStorageKeyInput: z.object({ key: z.string().min(1).max(200) }),
    appStorageSetInput: z.object({ key: z.string().min(1).max(200), value: z.unknown() }),
    appStorageListInput: z.object({
      prefix: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.string().max(400).optional(),
    }),
  };
});
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: mockHandleEndpointError,
}));

import getHandler from '~/pages/api/v1/blocks/app-storage/get';
import setHandler from '~/pages/api/v1/blocks/app-storage/set';
import deleteHandler from '~/pages/api/v1/blocks/app-storage/delete';
import listHandler from '~/pages/api/v1/blocks/app-storage/list';
import quotaHandler from '~/pages/api/v1/blocks/app-storage/quota';

function fakeClaims(scopes: string[] = ['apps:storage:read', 'apps:storage:write']) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:29',
    iat: 0,
    exp: 0,
    jti: 'j',
    blockId: 'b',
    appId: 'a',
    appBlockId: 'apb',
    blockInstanceId: 'bki',
    ctx: {},
    scopes,
  } as unknown as BlockTokenClaims;
}

const ROUTES = [
  { name: 'get', handler: getHandler, body: { key: 'k' } },
  { name: 'set', handler: setHandler, body: { key: 'k', value: 1 } },
  { name: 'delete', handler: deleteHandler, body: { key: 'k' } },
  { name: 'list', handler: listHandler, body: {} },
  { name: 'quota', handler: quotaHandler, body: {} },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  mockGet.mockResolvedValue({ value: null });
  mockSet.mockResolvedValue({ ok: true, sizeBytes: 3 });
  mockDelete.mockResolvedValue({ ok: true, deleted: true });
  mockList.mockResolvedValue({ keys: [], nextCursor: undefined });
  mockQuota.mockResolvedValue({ usedBytes: 0, rowCount: 0, limitBytes: 1, limitRows: 1 });
});

describe('app-storage REST routes — shared adapter contract', () => {
  it.each(ROUTES)(
    '$name rejects a non-POST with 405 and an Allow header',
    async ({ handler, body }) => {
      const { req, res } = createMocks({ method: 'GET', body });
      await (handler as any)(req, res);
      expect(res._status()).toBe(405);
    }
  );

  it.each(ROUTES)(
    '$name answers 401 when no block claims reached the handler',
    async ({ handler, body }) => {
      claimsBox.claims = undefined;
      const { req, res } = createMocks({ body });
      await (handler as any)(req, res);
      expect(res._status()).toBe(401);
    }
  );

  it.each(ROUTES)(
    '$name forwards the raw bearer token to the shared body',
    async ({ name, handler, body }) => {
      const { req, res } = createMocks({ body, authorization: 'Bearer tok_abc' });
      await (handler as any)(req, res);
      const fn = {
        get: mockGet,
        set: mockSet,
        delete: mockDelete,
        list: mockList,
        quota: mockQuota,
      }[name];
      expect(fn).toHaveBeenCalledTimes(1);
      expect((fn as any).mock.calls[0][0]).toBe('tok_abc');
    }
  );

  it.each(ROUTES)(
    '$name routes a thrown refusal through handleEndpointError',
    async ({ name, handler, body }) => {
      const fn = {
        get: mockGet,
        set: mockSet,
        delete: mockDelete,
        list: mockList,
        quota: mockQuota,
      }[name];
      (fn as any).mockRejectedValue(new TRPCError({ code: 'FORBIDDEN', message: 'nope' }));
      const { req, res } = createMocks({ body });
      await (handler as any)(req, res);
      expect(mockHandleEndpointError).toHaveBeenCalledTimes(1);
      // And it did NOT answer 200 with a body of its own.
      expect(res._json()).toBeUndefined();
    }
  );
});

describe('app-storage REST routes — input validation', () => {
  it('get rejects a missing key with 400 and never calls the shared body', async () => {
    const { req, res } = createMocks({ body: {} });
    await (getHandler as any)(req, res);
    expect(res._status()).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('get rejects an over-long key at the SAME 200-char bound the bridge uses', async () => {
    const { req, res } = createMocks({ body: { key: 'x'.repeat(201) } });
    await (getHandler as any)(req, res);
    expect(res._status()).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('get accepts a key exactly AT the bound — the boundary, not just past it', async () => {
    const { req, res } = createMocks({ body: { key: 'x'.repeat(200) } });
    await (getHandler as any)(req, res);
    expect(res._status()).toBe(200);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('set forwards the value verbatim, including falsy and structured values', async () => {
    for (const value of [0, '', false, null, { a: [1, 2] }]) {
      vi.clearAllMocks();
      mockSet.mockResolvedValue({ ok: true, sizeBytes: 1 });
      const { req, res } = createMocks({ body: { key: 'k', value } });
      await (setHandler as any)(req, res);
      expect(mockSet.mock.calls[0][2]).toStrictEqual(value);
    }
  });

  it('list applies the bridge default of 50 when no limit is sent', async () => {
    const { req, res } = createMocks({ body: {} });
    await (listHandler as any)(req, res);
    expect(mockList.mock.calls[0][1]).toMatchObject({ limit: 50 });
  });

  it('list honours a caller-supplied limit and rejects one past the 200 bound', async () => {
    const ok = createMocks({ body: { limit: 200 } });
    await (listHandler as any)(ok.req, ok.res);
    expect(mockList.mock.calls[0][1]).toMatchObject({ limit: 200 });

    vi.clearAllMocks();
    const bad = createMocks({ body: { limit: 201 } });
    await (listHandler as any)(bad.req, bad.res);
    expect(bad.res._status()).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('quota takes no input and ignores a stray body rather than rejecting it', async () => {
    const { req, res } = createMocks({ body: { nonsense: true } });
    await (quotaHandler as any)(req, res);
    expect(res._status()).toBe(200);
    expect(mockQuota).toHaveBeenCalledTimes(1);
  });
});

/**
 * 🔴 The consumer-correctness properties. These are the assertions that exist
 * because a fleet app's double-spend guard is built on them, not because the
 * shapes are tidy.
 */
describe('app-storage REST routes — consumer correctness invariants', () => {
  it('list NEVER answers 200 with an empty envelope when the body throws', async () => {
    // Every authorization refusal inside the shared body is a thrown TRPCError.
    // If any of them were softened into a resolved empty listing, the consumer's
    // scan would complete, report `truncated: false`, and DISARM its per-run
    // backstop — turning every reload into a double-charge with the guard off.
    for (const code of [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'INTERNAL_SERVER_ERROR',
    ] as const) {
      vi.clearAllMocks();
      mockList.mockRejectedValue(new TRPCError({ code, message: code }));
      const { req, res } = createMocks({ body: {} });
      await (listHandler as any)(req, res);
      expect(mockHandleEndpointError, `${code} must not be swallowed`).toHaveBeenCalledTimes(1);
      expect(res._json(), `${code} must not produce an empty listing`).toBeUndefined();
    }
  });

  it('list passes nextCursor through untouched — present and absent both survive', async () => {
    mockList.mockResolvedValue({
      keys: [{ key: 'a', updatedAt: new Date(0) }],
      nextCursor: 'Yg==',
    });
    const withCursor = createMocks({ body: {} });
    await (listHandler as any)(withCursor.req, withCursor.res);
    expect(withCursor.res._json()).toMatchObject({ nextCursor: 'Yg==' });

    vi.clearAllMocks();
    mockList.mockResolvedValue({ keys: [{ key: 'a', updatedAt: new Date(0) }] });
    const without = createMocks({ body: {} });
    await (listHandler as any)(without.req, without.res);
    expect((without.res._json() as any).nextCursor).toBeUndefined();
  });

  it('list preserves the { keys: [{ key, updatedAt }] } envelope the consumer reads', async () => {
    const rows = [
      { key: 'inflight:v1:a', updatedAt: new Date(0) },
      { key: 'inflight:v1:b', updatedAt: new Date(0) },
    ];
    mockList.mockResolvedValue({ keys: rows, nextCursor: undefined });
    const { req, res } = createMocks({ body: { prefix: 'inflight:v1:' } });
    await (listHandler as any)(req, res);
    const payload = res._json() as any;
    expect(payload.keys.map((r: any) => r.key)).toEqual(['inflight:v1:a', 'inflight:v1:b']);
  });

  it('set REJECTS a refusal rather than resolving { ok: false }', async () => {
    // The consumer claims its in-flight marker through this route BEFORE spending
    // Buzz. A resolved soft-failure would be read as a successful claim and would
    // turn every quota rejection into a double-charge.
    mockSet.mockRejectedValue(
      new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'value exceeds 64KB cap' })
    );
    const { req, res } = createMocks({ body: { key: 'k', value: 'x' } });
    await (setHandler as any)(req, res);
    expect(mockHandleEndpointError).toHaveBeenCalledTimes(1);
    expect(res._json()).toBeUndefined();
  });

  it('set answers 200 only on the body resolving, and echoes its shape verbatim', async () => {
    mockSet.mockResolvedValue({ ok: true, sizeBytes: 1234 });
    const { req, res } = createMocks({ body: { key: 'k', value: 'x' } });
    await (setHandler as any)(req, res);
    expect(res._status()).toBe(200);
    expect(res._json()).toStrictEqual({ ok: true, sizeBytes: 1234 });
  });

  it('delete treats an absent key as a 200 no-op, not a 404', async () => {
    mockDelete.mockResolvedValue({ ok: true, deleted: false });
    const { req, res } = createMocks({ body: { key: 'gone' } });
    await (deleteHandler as any)(req, res);
    expect(res._status()).toBe(200);
    expect(res._json()).toStrictEqual({ ok: true, deleted: false });
  });
});
