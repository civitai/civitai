import { describe, expect, it, vi, beforeEach } from 'vitest';
// Setup-order import: installs the ~/env/server mock with the real test RSA
// keypair BEFORE block-token.service / the middleware evaluate env at module
// load (same posture as block-scope.required-scope-binding.test.ts).
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * THE ANON CONTRACT OF `/api/v1/blocks/app-storage/*`, driven through the REAL
 * `withBlockScope` over a REAL minted token.
 *
 * 🔴 WHY THIS FILE EXISTS. The five app-storage REST routes are the FIRST live
 * callers of `enforceContextBinding`'s `apps:storage:read` / `apps:storage:write`
 * case. That case was written defensively (audit fix 3 / L-M6) so that adding
 * these scopes to `BLOCK_SCOPE_TO_OAUTH_BIT` could not silently reintroduce a
 * fail-open — and until these routes existed, NOTHING reached it. A defensive
 * branch with no caller is a branch nobody has watched work.
 *
 * WHAT IT MEANS FOR A BLOCK, stated plainly because it is a DELIBERATE
 * DIVERGENCE from the postMessage bridge and an SDK author will hit it:
 *
 *   bridge, anon viewer:  get -> { value: null },  list -> { keys: [] },
 *                         getQuota -> zeros,       set/delete -> UNAUTHORIZED
 *   REST,   anon viewer:  ALL FIVE -> 403, before the handler runs
 *
 * The bridge's clean-null is a UX affordance ("render defaults without a 401
 * round-trip"); the binding refusal is a security control. Loosening a security
 * control so a new transport can be more convenient is the "adapter disarmed a
 * gate" shape, so the control wins and the divergence is documented on the routes
 * instead. The information content is the same either way — an anon viewer HAS no
 * per-viewer storage.
 *
 * 🔴 REACHABILITY IS THE POINT OF THE FIRST TEST. A guard that an earlier check
 * always rejects before is unreachable, and asserting on it proves nothing.
 * `apps:storage:*` is CONSENT-EXEMPT, so the anon mint does NOT strip it: the
 * token really does carry the scope, the middleware's scope-presence check really
 * does pass, and the binding really is what refuses. If these scopes were ever
 * made consent-gated, the anon token would not carry them, the scope check would
 * 403 FIRST, and this file's later assertions would be green for the wrong
 * reason — which is why the mechanism is asserted and not assumed.
 *
 * Only the runtime flag, revocation and the approved-status gate are stubbed —
 * each is a precondition of the path under test rather than part of it, and each
 * has its own suite (same posture as the sibling binding suite).
 */

const { isFliptMock } = vi.hoisted(() => ({
  isFliptMock: vi.fn(async (flag: string) => flag === 'app-blocks-runtime-enabled'),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: isFliptMock }));

const { isRevokedMock } = vi.hoisted(() => ({ isRevokedMock: vi.fn(async () => false) }));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: isRevokedMock },
}));

vi.mock('~/server/services/blocks/block-approval.service', () => ({
  resolveRestApprovalVerdict: vi.fn(async () => 'ok' as const),
}));

import { withBlockScope, verifyBlockToken } from '../block-scope.middleware';
import { BlockTokenService } from '~/server/services/block-token.service';
import { ANON_SUBJECT } from '~/server/services/block-token-subject';

const STORAGE_READ = 'apps:storage:read';
const STORAGE_WRITE = 'apps:storage:write';

// A non-round, distinctive id so it cannot coincide with a literal in a mutant.
const VIEWER_ID = 73391;

async function mintToken(opts: { userId: number | null; scopes: string[] }): Promise<string> {
  const r = await BlockTokenService.sign({
    userId: opts.userId,
    blockId: 'blk_appstorage',
    appId: 'app_appstorage',
    appBlockId: 'apb_appstorage',
    blockInstanceId: 'bki_appstorage',
    scopes: opts.scopes,
    ctx: {},
    maxBrowsingLevel: 3,
    domain: 'green',
  });
  return r.token;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send() {
      return this;
    },
    end() {
      return this;
    },
    setHeader(k: string, v: unknown) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    removeHeader() {
      return this;
    },
    writeHead() {
      return this;
    },
    getHeader(k: string) {
      return this.headers[k.toLowerCase()];
    },
    on() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & {
    statusCode: number;
    body: unknown;
    headers: Record<string, unknown>;
  };
}

function makeReq(token: string, url: string): NextApiRequest {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    query: {},
    body: { key: 'k' },
    url,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

/** A stand-in route so "the handler ran" is directly observable. */
function route(requiredScope: string, endpoint: 'app_storage_get' | 'app_storage_set') {
  const handler = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
    res.status(200).json({ reached: requiredScope });
  });
  return {
    handler,
    wrapped: withBlockScope(handler as never, { endpoint, requiredScope, allowOpaqueOrigin: true }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isFliptMock.mockImplementation(async (flag: string) => flag === 'app-blocks-runtime-enabled');
  isRevokedMock.mockImplementation(async () => false);
});

describe('app-storage REST: the anon refusal is REACHABLE, not shadowed', () => {
  it('an anon token actually CARRIES apps:storage:* — so the binding is what refuses', async () => {
    // The reachability proof. If the anon mint stripped these scopes, the
    // middleware's scope-presence check would 403 first and every assertion in
    // the next describe would be green for a reason that has nothing to do with
    // the binding under test.
    const token = await mintToken({ userId: null, scopes: [STORAGE_READ, STORAGE_WRITE] });
    const claims = await verifyBlockToken(token);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe(ANON_SUBJECT);
    expect(claims!.scopes).toContain(STORAGE_READ);
    expect(claims!.scopes).toContain(STORAGE_WRITE);
  });
});

describe('app-storage REST: anon is refused on every route', () => {
  it.each([
    [STORAGE_READ, 'app_storage_get' as const, '/api/v1/blocks/app-storage/get'],
    [STORAGE_READ, 'app_storage_get' as const, '/api/v1/blocks/app-storage/list'],
    [STORAGE_READ, 'app_storage_get' as const, '/api/v1/blocks/app-storage/quota'],
    [STORAGE_WRITE, 'app_storage_set' as const, '/api/v1/blocks/app-storage/set'],
    [STORAGE_WRITE, 'app_storage_set' as const, '/api/v1/blocks/app-storage/delete'],
  ])(
    '%s at %s refuses an anon subject with 403 and never runs the handler',
    async (scope, endpoint, url) => {
      const token = await mintToken({ userId: null, scopes: [STORAGE_READ, STORAGE_WRITE] });
      const { handler, wrapped } = route(scope, endpoint);
      const res = makeRes();
      await wrapped(makeReq(token, url), res);

      expect(res.statusCode).toBe(403);
      // 🔴 The SPECIFIC message, not merely "a 403". A different guard's 403 — the
      // scope-presence check, the approval gate, revocation — would satisfy a bare
      // status assertion while THIS guard never executed, which is exactly how a
      // mutation test passes for the wrong reason.
      expect((res.body as { error?: string }).error).toBe(
        `${scope} requires authenticated subject`
      );
      // And the refusal is BEFORE the handler: nothing downstream got a chance to
      // decide, which is what "fail closed at the edge" has to mean.
      expect(handler).not.toHaveBeenCalled();
    }
  );
});

describe('app-storage REST: an authenticated subject is NOT refused', () => {
  // 🔴 THE NEGATIVE CONTROL. Without it, a middleware that refused EVERY request
  // — a broken scope table, a wrong endpoint label, an always-throwing binding —
  // would satisfy every assertion above. This is what separates "anon is
  // refused" from "nothing works".
  it.each([
    [STORAGE_READ, 'app_storage_get' as const, '/api/v1/blocks/app-storage/get'],
    [STORAGE_WRITE, 'app_storage_set' as const, '/api/v1/blocks/app-storage/set'],
  ])('%s at %s reaches the handler for a signed-in viewer', async (scope, endpoint, url) => {
    const token = await mintToken({ userId: VIEWER_ID, scopes: [STORAGE_READ, STORAGE_WRITE] });
    const { handler, wrapped } = route(scope, endpoint);
    const res = makeRes();
    await wrapped(makeReq(token, url), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toStrictEqual({ reached: scope });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a read-only token is refused on a WRITE route — the scopes are not interchangeable', async () => {
    // The other half of the surface's authorization story, and the reason there
    // are two scopes rather than one `apps:storage`. A token approved to READ a
    // viewer's store must not be able to overwrite or delete it.
    const token = await mintToken({ userId: VIEWER_ID, scopes: [STORAGE_READ] });
    const { handler, wrapped } = route(STORAGE_WRITE, 'app_storage_set');
    const res = makeRes();
    await wrapped(makeReq(token, '/api/v1/blocks/app-storage/set'), res);

    expect(res.statusCode).toBe(403);
    expect((res.body as { error?: string }).error).toBe(`missing required scope: ${STORAGE_WRITE}`);
    expect(handler).not.toHaveBeenCalled();
  });
});
