import { describe, expect, it, vi, beforeEach } from 'vitest';
// Setup-order import: installs the ~/env/server mock with the real test RSA
// keypair BEFORE block-token.service / the middleware evaluate env at module
// load (same posture as block-scope.anytoken-mode.test.ts).
import '~/__tests__/setup';
import fs from 'fs';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * #5063 — `enforceContextBinding` runs the binding for THE ROUTE'S
 * `requiredScope`, not for every scope the token happens to carry.
 *
 * WHAT WAS BROKEN. The binding switch used to iterate `claims.scopes`, so any
 * declared scope's binding ran on every block REST request the token made:
 *
 *   1. `models:read:self` binds `query.id ≡ ctx.modelId`. On a request with no
 *      `id` it parsed NaN and threw — so an app declaring the most common scope
 *      in the fleet 403'd on `blocks/buzz` and all nine `blocks/shared-storage/*`
 *      routes, with an error naming a scope the caller never invoked.
 *   2. `apps:storage:shared:write` is CONSENT-EXEMPT, so the anon mint does not
 *      strip it — and its binding refuses an anon subject. An anon token
 *      therefore 403'd a shared-storage READ, contradicting the
 *      `apps:storage:shared:read` case directly above it in the same switch,
 *      which says in as many words that anon reads are allowed.
 *
 * WHAT THIS FILE PINS. The first two cases are the REGRESSION tests (watched red
 * against the pre-change middleware). The rest are the counter-tests that stop
 * the narrowing from being a hole — each was GREEN before and must stay green,
 * which is exactly why they are here: the interesting failure mode of this
 * change is a check that stopped firing, not one that started.
 *
 * These drive the REAL `withBlockScope` over a REAL minted token. Only the
 * runtime flag, revocation and the approved-status gate are stubbed (same
 * posture, and same reasons, as block-scope.anytoken-mode.test.ts): each is a
 * precondition of the path under test rather than part of it, and each has its
 * own suite.
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

import { withBlockScope, enforceContextBinding } from '../block-scope.middleware';
import { BlockTokenService } from '~/server/services/block-token.service';
import { BLOCK_SCOPE_TO_OAUTH_BIT } from '~/shared/constants/block-scope.constants';

const SHARED_READ = 'apps:storage:shared:read';
const SHARED_WRITE = 'apps:storage:shared:write';
const MODELS_READ = 'models:read:self';
const BUZZ_READ = 'buzz:read:self';
const USER_READ = 'user:read:self';

// Pairwise-distinct, non-round fixture ids so a transposition (the bound
// modelId read as the requested one, or vice versa) cannot survive by landing
// on an equal value, and so neither can equal a hardcoded literal in a mutant.
const BOUND_MODEL_ID = 51843;
const OTHER_MODEL_ID = 92617;

async function mintToken(opts: {
  userId: number | null;
  scopes: string[];
  modelId?: number;
}): Promise<string> {
  const r = await BlockTokenService.sign({
    userId: opts.userId,
    blockId: 'blk_5063',
    appId: 'app_5063',
    appBlockId: 'apb_5063',
    blockInstanceId: 'bki_5063',
    scopes: opts.scopes,
    ctx: opts.modelId != null ? { modelId: opts.modelId } : {},
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

function makeReq(token: string, query: Record<string, unknown> = {}): NextApiRequest {
  return {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    query,
    url: '/api/v1/blocks/under-test',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

/** A route that answers 200 with a marker so "the handler ran" is observable. */
function route(requiredScope: string) {
  const handler = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
    res.status(200).json({ ok: requiredScope });
  });
  return { handler, wrapped: withBlockScope(handler as never, { endpoint: 'me', requiredScope }) };
}

beforeEach(() => {
  isFliptMock.mockClear();
  isRevokedMock.mockClear();
  isRevokedMock.mockResolvedValue(false);
});

describe('#5063 REGRESSION — an unrelated declared scope no longer 403s the route', () => {
  it('an ANON token carrying shared:read AND shared:write can READ shared storage', async () => {
    // Instance 2, and the one with no workaround: an app cannot un-declare the
    // write scope it needs in order to make its read path work. The write scope
    // is consent-exempt, so the anon mint leaves it on the token; its binding
    // (non-anon subject) then fired on a READ route that explicitly allows anon.
    const token = await mintToken({ userId: null, scopes: [SHARED_READ, SHARED_WRITE] });
    const { handler, wrapped } = route(SHARED_READ);

    const res = makeRes();
    await wrapped(makeReq(token) as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: SHARED_READ });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a token carrying models:read:self reads blocks/buzz with NO query params', async () => {
    // Instance 1. `models:read:self`'s binding wants query.id ≡ ctx.modelId; a
    // buzz read carries neither, so it parsed NaN and threw
    // `models:read:self bound to different modelId` on a route that never reads
    // a model. The token here carries a REAL ctx.modelId — the binding was
    // satisfiable, just not by this request.
    const token = await mintToken({
      userId: 42,
      scopes: [MODELS_READ, BUZZ_READ],
      modelId: BOUND_MODEL_ID,
    });
    const { handler, wrapped } = route(BUZZ_READ);

    const res = makeRes();
    await wrapped(makeReq(token, {}) as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: BUZZ_READ });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('#5063 COUNTER-TESTS — every check that must still fire', () => {
  it('an ANON token still cannot WRITE shared storage (the middleware layer refuses)', async () => {
    // Narrowing removed the binding from routes that do NOT require the write
    // scope. On the route that DOES require it, the same case still runs and
    // still refuses anon — and it is the FIRST of two independent layers: the
    // second is `resolveSharedContext`'s min-trust gate + the per-op READ_OPS
    // check inside the handler, which this request never reaches.
    const token = await mintToken({ userId: null, scopes: [SHARED_READ, SHARED_WRITE] });
    const { handler, wrapped } = route(SHARED_WRITE);

    const res = makeRes();
    await wrapped(makeReq(token) as never, res as never);

    expect(res.statusCode).toBe(403);
    // Name the scope: a bare 403 would pass while some other gate fired.
    expect(res.body).toEqual({ error: `${SHARED_WRITE} requires authenticated subject` });
    expect(handler).not.toHaveBeenCalled();
  });

  it('a token LACKING the route scope is still rejected (the presence check is untouched)', async () => {
    const token = await mintToken({ userId: 42, scopes: [BUZZ_READ] });
    const { handler, wrapped } = route(USER_READ);

    const res = makeRes();
    await wrapped(makeReq(token) as never, res as never);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: `missing required scope: ${USER_READ}` });
    expect(handler).not.toHaveBeenCalled();
  });

  it('models:read:self STILL binds query.id on a models route — mismatch refused, match served', async () => {
    // The whole point of the binding, on the one route it applies to. Both
    // directions, so a mutant that always-throws or always-passes dies.
    const token = await mintToken({
      userId: 42,
      scopes: [MODELS_READ],
      modelId: BOUND_MODEL_ID,
    });

    const bad = route(MODELS_READ);
    const badRes = makeRes();
    await bad.wrapped(makeReq(token, { id: String(OTHER_MODEL_ID) }) as never, badRes as never);
    expect(badRes.statusCode).toBe(403);
    expect(badRes.body).toEqual({ error: 'models:read:self bound to different modelId' });
    expect(bad.handler).not.toHaveBeenCalled();

    const good = route(MODELS_READ);
    const goodRes = makeRes();
    await good.wrapped(makeReq(token, { id: String(BOUND_MODEL_ID) }) as never, goodRes as never);
    expect(goodRes.statusCode).toBe(200);
    expect(good.handler).toHaveBeenCalledTimes(1);

    // …and the ABSENT-param case is still refused HERE, where the route really
    // does require the scope. #5063 narrowed WHERE the binding runs, not what it
    // decides: a models route with no id is still a binding failure.
    const missing = route(MODELS_READ);
    const missingRes = makeRes();
    await missing.wrapped(makeReq(token, {}) as never, missingRes as never);
    expect(missingRes.statusCode).toBe(403);
    expect(missing.handler).not.toHaveBeenCalled();
  });

  it('the unknown-scope deny-by-default is STILL token-wide, not narrowed with the switch', async () => {
    // The one gate that deliberately did NOT narrow: an unknown scope is never
    // legitimate on any route, so it is rejected even when it is not the scope
    // the route requires. Called directly because the mint would not produce it.
    expect(() =>
      enforceContextBinding(
        { scopes: [BUZZ_READ, 'weird:scope:value'], sub: 'user:42' } as never,
        { query: {} } as never,
        BUZZ_READ
      )
    ).toThrow('unknown scope: weird:scope:value');

    // Positive control for the same call shape: without the unknown scope it
    // passes, so the throw above is attributable to the unknown scope and not
    // to the fixture being malformed.
    expect(() =>
      enforceContextBinding(
        { scopes: [BUZZ_READ], sub: 'user:42' } as never,
        { query: {} } as never,
        BUZZ_READ
      )
    ).not.toThrow();
  });
});

describe('#5063 STRUCTURAL — what the narrowing shifted onto a static gate', () => {
  const MIDDLEWARE = fs.readFileSync(
    path.resolve(__dirname, '../block-scope.middleware.ts'),
    'utf8'
  );

  it('EVERY known block scope has a binding case', () => {
    // Before #5063 an under-wired scope was caught (brutally) at runtime: the
    // switch ran for every scope on the token, so the `default:` arm 403'd every
    // request the token made. Narrowed, it is only caught on the route that
    // declares the scope — i.e. possibly not until production. This assertion is
    // the replacement, and it is strictly earlier and louder.
    //
    // Scoped to the binding function's own text so an unrelated `case` elsewhere
    // in the file cannot satisfy it.
    const start = MIDDLEWARE.indexOf('export function enforceContextBinding(');
    expect(start).toBeGreaterThan(-1);
    const end = MIDDLEWARE.indexOf('export function withBlockScope(', start);
    expect(end).toBeGreaterThan(start);
    const body = MIDDLEWARE.slice(start, end);

    const known = Object.keys(BLOCK_SCOPE_TO_OAUTH_BIT).sort();
    expect(known.length).toBeGreaterThan(0); // positive control: the set is real
    const wired = known.filter((scope) => body.includes(`case '${scope}':`));
    expect(wired).toEqual(known);
  });

  it('pins the ONLY handler that reads a scope other than its own requiredScope', () => {
    // 🔴 THE SEAM THIS CHANGE CREATES. The middleware now binds one scope; a
    // handler that consults a SECOND scope off `claims.scopes` to widen what it
    // returns owns that scope's binding itself. Today there is exactly one such
    // scope and two call sites. Both routes require `collections:read:self`
    // (non-anon), and `collections:read:private` is CONSENT-GATED so the anon
    // mint strips it — so an anon token can neither reach these handlers nor
    // carry the scope. That argument is specific to these entries, which is why
    // the ledger is asserted in BOTH directions: a new entry must be reasoned
    // about, not inherit this one's clearance.
    const LEDGER = [
      'pages/api/v1/blocks/collections/[id]/index.ts:collections:read:private',
      'pages/api/v1/blocks/collections/index.ts:collections:read:private',
    ];

    const root = path.resolve(__dirname, '../../../pages/api/v1/blocks');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const src = fs.readFileSync(full, 'utf8');
        for (const m of src.matchAll(/\.scopes\.includes\(\s*'([^']+)'\s*\)/g)) {
          const rel = path.relative(path.resolve(__dirname, '../../..'), full);
          found.push(`${rel}:${m[1]}`);
        }
      }
    };
    walk(root);

    expect(found.sort()).toEqual(LEDGER.sort());
  });
});
