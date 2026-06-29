import { describe, expect, it, vi } from 'vitest';
// Imported in setup-order so the test RSA env keys are in place before
// block-token.service evaluates (same posture as block-token.service.test.ts).
import '~/__tests__/setup';
import { SignJWT } from 'jose';
import {
  enforceContextBinding,
  parseSubjectUserId,
  verifyBlockToken,
  type BlockTokenClaims,
} from '../block-scope.middleware';
import type { NextApiRequest } from 'next';

function fakeReq(query: Record<string, string>): NextApiRequest {
  return { query } as unknown as NextApiRequest;
}

function fakeClaims(over: Partial<BlockTokenClaims>): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'jti',
    blockId: 'blk',
    appId: 'app',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_test',
    ctx: { modelId: 12345 },
    scopes: [],
    ...over,
  };
}

describe('parseSubjectUserId', () => {
  it('returns null for anon', () => {
    expect(parseSubjectUserId('anon')).toBeNull();
  });
  it('parses user:<id>', () => {
    expect(parseSubjectUserId('user:42')).toBe(42);
  });
  it('throws on malformed sub', () => {
    expect(() => parseSubjectUserId('42')).toThrow();
    expect(() => parseSubjectUserId('user:abc')).toThrow();
    expect(() => parseSubjectUserId('user:-1')).toThrow();
    // Number.parseInt would silently accept '123foo' as 123; the strict regex
    // catches that. This test is the regression guard for I3 from the audit.
    expect(() => parseSubjectUserId('user:123foo')).toThrow();
    expect(() => parseSubjectUserId('user:0')).toThrow();
    expect(() => parseSubjectUserId('user:01')).toThrow(); // leading zero
  });
});

describe('enforceContextBinding', () => {
  it('models:read:self requires matching modelId in query', () => {
    const claims = fakeClaims({ scopes: ['models:read:self'], ctx: { modelId: 12345 } });
    expect(() => enforceContextBinding(claims, fakeReq({ id: '12345' }))).not.toThrow();
    expect(() => enforceContextBinding(claims, fakeReq({ id: '99999' }))).toThrow();
  });

  it('ai:write:budgeted requires positive buzzBudget', () => {
    const noBudget = fakeClaims({ scopes: ['ai:write:budgeted'] });
    expect(() => enforceContextBinding(noBudget, fakeReq({}))).toThrow();
    const zero = fakeClaims({ scopes: ['ai:write:budgeted'], buzzBudget: 0 });
    expect(() => enforceContextBinding(zero, fakeReq({}))).toThrow();
    const ok = fakeClaims({ scopes: ['ai:write:budgeted'], buzzBudget: 100 });
    expect(() => enforceContextBinding(ok, fakeReq({}))).not.toThrow();
  });

  it('buzz:read:self / social:tip:self block anon subjects', () => {
    const anon = fakeClaims({ sub: 'anon', scopes: ['buzz:read:self'] });
    expect(() => enforceContextBinding(anon, fakeReq({}))).toThrow();
    const tipAnon = fakeClaims({ sub: 'anon', scopes: ['social:tip:self'] });
    expect(() => enforceContextBinding(tipAnon, fakeReq({}))).toThrow();
  });

  it('apps:storage:* block anon subjects (fix 3 / L-M6 no-fail-open)', () => {
    // Adding apps:storage:{read,write} to BLOCK_SCOPE_TO_OAUTH_BIT requires a
    // matching enforceContextBinding case, else the unknown-scope reject is
    // bypassed and the scope is accepted with no binding (fail-open).
    const anonRead = fakeClaims({ sub: 'anon', scopes: ['apps:storage:read'] });
    expect(() => enforceContextBinding(anonRead, fakeReq({}))).toThrow();
    const anonWrite = fakeClaims({ sub: 'anon', scopes: ['apps:storage:write'] });
    expect(() => enforceContextBinding(anonWrite, fakeReq({}))).toThrow();
    const authed = fakeClaims({ sub: 'user:42', scopes: ['apps:storage:write'] });
    expect(() => enforceContextBinding(authed, fakeReq({}))).not.toThrow();
  });

  it('block:settings:* binds to blockInstanceId in query', () => {
    const claims = fakeClaims({ scopes: ['block:settings:read'], blockInstanceId: 'bki_A' });
    expect(() =>
      enforceContextBinding(claims, fakeReq({ blockInstanceId: 'bki_A' }))
    ).not.toThrow();
    expect(() =>
      enforceContextBinding(claims, fakeReq({ blockInstanceId: 'bki_B' }))
    ).toThrow();
    expect(() => enforceContextBinding(claims, fakeReq({}))).toThrow();
  });

  it('rejects unknown scopes outright (deny-by-default at runtime)', () => {
    // Audit C2: middleware default case was "accept" for unknown scopes.
    // Flipped to deny so a malicious-but-approved manifest with a typo'd or
    // future scope can't carry it past the runtime gate.
    const claims = fakeClaims({ scopes: ['weird:scope:value'] });
    expect(() => enforceContextBinding(claims, fakeReq({}))).toThrow();
    const claimsAdminish = fakeClaims({ scopes: ['admin:write:all'] });
    expect(() => enforceContextBinding(claimsAdminish, fakeReq({}))).toThrow();
  });

  it('rejects array-form query params on context-bound scopes', () => {
    // ?id=12345&id=99999 — readBoundQueryString rejects array form so the
    // wrapped handler can't process a different value than the bound one.
    const claims = fakeClaims({ scopes: ['models:read:self'], ctx: { modelId: 12345 } });
    expect(() =>
      enforceContextBinding(claims, fakeReq({ id: ['12345', '99999'] as unknown as string }))
    ).toThrow();
  });

  it('rejects the retired catalog:read scope (no longer a known scope)', () => {
    // catalog:read was added in #2671 and retired the next day: the block
    // catalog endpoints now accept ANY valid token (no requiredScope) — see
    // block-scope.anytoken-mode.test.ts. A token still carrying the dead scope
    // is now an UNKNOWN scope → deny-by-default at runtime.
    const authed = fakeClaims({ scopes: ['catalog:read'] });
    expect(() => enforceContextBinding(authed, fakeReq({}))).toThrow();
  });
});

describe('isBlockJwt header decode (audit H-1.5 / strict)', () => {
  it('rejects opaque API keys that happen to contain two dots', async () => {
    // Three-dot strings with bogus headers — e.g. legacy API key formats —
    // must NOT trigger block-JWT verification. The middleware exports the
    // private isBlockJwt indirectly via withBlockScope routing; assert
    // shape by feeding `withBlockScope` a non-JWT bearer and confirming
    // it falls through to the wrapped handler (no 401 with "invalid block token").
    // We don't have direct access to isBlockJwt — but we can assert the
    // observable: a non-JWT bearer reaches the wrapped handler.
    const { withBlockScope } = await import('../block-scope.middleware');
    const wrappedHandler = vi.fn(async (_req: unknown, res: { _status: number; status: (n: number) => unknown }) => {
      res._status = 200;
      res.status(200);
    });
    const route = withBlockScope(wrappedHandler as never, { requiredScope: 'models:read:self' });
    const fakeReqWithApiKey = {
      method: 'GET',
      headers: { authorization: 'Bearer foo.bar.notarealjwt' },
      query: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
    const res = {
      _status: 0,
      setHeader: () => res,
      status: (n: number) => {
        (res as { _status: number })._status = n;
        return res;
      },
      json: () => res,
      end: () => res,
    } as unknown as { _status: number };
    await route(fakeReqWithApiKey as never, res as never);
    // The bearer is shape-3-segments but header decodes to something with
    // no alg=RS256 → isBlockJwt returns false → middleware falls through
    // → wrapped handler runs and sets 200.
    expect((res as { _status: number })._status).toBe(200);
    expect(wrappedHandler).toHaveBeenCalled();
  });
});

describe('verifyBlockToken fail-closed shapes (L-VERIFY / L-M6)', () => {
  async function importPrivateKey() {
    const { importPKCS8 } = await import('jose');
    const { env } = await import('~/env/server');
    return importPKCS8(env.BLOCK_TOKEN_PRIVATE_KEY as string, 'RS256');
  }

  const baseClaims = {
    blockId: 'b',
    appId: 'a',
    appBlockId: 'apb_a',
    blockInstanceId: 'bki_a',
    scopes: ['models:read:self'],
    ctx: { modelId: 1 },
  };

  it('accepts a token minted by BlockTokenService (carries kid + typ:JWT)', async () => {
    const { BlockTokenService } = await import('~/server/services/block-token.service');
    const r = await BlockTokenService.sign({ userId: 1, ...baseClaims });
    const claims = await verifyBlockToken(r.token);
    expect(claims).not.toBeNull();
    expect(claims?.blockInstanceId).toBe('bki_a');
  });

  it('rejects a validly-signed token that omits kid (no fan-out to all keys)', async () => {
    // Same RSA key the service signs with, but the header carries no kid.
    // The previous code fell open and tried every configured key; the fix
    // fails closed (a kid-less token is not one we mint — the signer has
    // stamped kid since the first App Blocks commit).
    const key = await importPrivateKey();
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ ...baseClaims, sub: 'user:1' })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' }) // NO kid
      .setIssuer('civitai')
      .setAudience('civitai-app-block')
      .setSubject('user:1')
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(key);
    expect(await verifyBlockToken(token)).toBeNull();
  });

  it('rejects a validly-signed token whose kid is unknown', async () => {
    const key = await importPrivateKey();
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ ...baseClaims, sub: 'user:1' })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'kid-that-is-not-configured' })
      .setIssuer('civitai')
      .setAudience('civitai-app-block')
      .setSubject('user:1')
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(key);
    expect(await verifyBlockToken(token)).toBeNull();
  });

  // --- Phase 3 maturity claim (catalog/generation clamp) shape guard ---

  async function configuredKid(): Promise<string> {
    // Derive the kid from a real service-minted token so it always matches the
    // verifier's key map (mirrors the accepted-token test's signing path).
    const { decodeProtectedHeader } = await import('jose');
    const { BlockTokenService } = await import('~/server/services/block-token.service');
    const r = await BlockTokenService.sign({ userId: 1, ...baseClaims });
    const kid = decodeProtectedHeader(r.token).kid;
    if (typeof kid !== 'string') throw new Error('no configured kid in test env');
    return kid;
  }

  async function signRaw(extra: Record<string, unknown>): Promise<string> {
    const key = await importPrivateKey();
    const kid = await configuredKid();
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ ...baseClaims, sub: 'user:1', ...extra })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
      .setIssuer('civitai')
      .setAudience('civitai-app-block')
      .setSubject('user:1')
      .setJti('test-jti')
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 600)
      .sign(key);
  }

  it('accepts + round-trips a finite numeric maxBrowsingLevel claim', async () => {
    const claims = await verifyBlockToken(await signRaw({ maxBrowsingLevel: 3, domain: 'blue' }));
    expect(claims).not.toBeNull();
    expect(claims?.maxBrowsingLevel).toBe(3);
    expect(claims?.domain).toBe('blue');
  });

  it('accepts a token with NO maturity claim (legacy / pre-#2670) — clamp fails closed downstream', async () => {
    const claims = await verifyBlockToken(await signRaw({}));
    expect(claims).not.toBeNull();
    expect(claims?.maxBrowsingLevel).toBeUndefined();
  });

  it('rejects a token with a non-finite maxBrowsingLevel (NaN/Infinity serialize to null → not a number)', async () => {
    // JSON has no NaN/Infinity; jose serializes them to null. A null
    // maxBrowsingLevel is present-but-non-numeric → the verify guard fails closed.
    expect(await verifyBlockToken(await signRaw({ maxBrowsingLevel: NaN }))).toBeNull();
    expect(await verifyBlockToken(await signRaw({ maxBrowsingLevel: Infinity }))).toBeNull();
  });

  it('rejects a token with a non-numeric maxBrowsingLevel', async () => {
    expect(await verifyBlockToken(await signRaw({ maxBrowsingLevel: '3' }))).toBeNull();
  });

  it('rejects a token with a non-string domain', async () => {
    expect(await verifyBlockToken(await signRaw({ domain: 123 }))).toBeNull();
  });

  // ---- Maturity claim shape guard (from #2670, redundant cross-check) -----
  // The maxBrowsingLevel claim is optional (absent on legacy tokens), but if
  // PRESENT it must be a finite number — a forged non-numeric value is rejected
  // outright so the generation clamp never coerces a junk ceiling.
  async function kidForCurrentKey(): Promise<string> {
    const { BlockTokenService } = await import('~/server/services/block-token.service');
    return BlockTokenService.getJwks().keys[0].kid;
  }

  it('passes through a valid numeric maxBrowsingLevel + domain claim', async () => {
    const { BlockTokenService } = await import('~/server/services/block-token.service');
    const r = await BlockTokenService.sign({
      userId: 1,
      ...baseClaims,
      domain: 'green',
      maxBrowsingLevel: 3,
    });
    const claims = await verifyBlockToken(r.token);
    expect(claims).not.toBeNull();
    expect(claims?.maxBrowsingLevel).toBe(3);
    expect(claims?.domain).toBe('green');
  });

  it('rejects a token whose maxBrowsingLevel claim is non-numeric (forged)', async () => {
    const key = await importPrivateKey();
    const kid = await kidForCurrentKey();
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ ...baseClaims, sub: 'user:1', maxBrowsingLevel: 'all' })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
      .setIssuer('civitai')
      .setAudience('civitai-app-block')
      .setSubject('user:1')
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 600)
      .sign(key);
    expect(await verifyBlockToken(token)).toBeNull();
  });

  it('rejects a token whose maxBrowsingLevel claim is NaN/Infinity', async () => {
    const key = await importPrivateKey();
    const kid = await kidForCurrentKey();
    const now = Math.floor(Date.now() / 1000);
    // JSON has no NaN literal; jose serializes it, but a forger could emit one
    // via a raw payload. Simulate the post-parse shape with a non-finite number
    // surrogate (a stringy huge value is the realistic forge vector handled
    // above; here we assert the Number.isFinite guard via an object).
    const token = await new SignJWT({
      ...baseClaims,
      sub: 'user:1',
      maxBrowsingLevel: [3] as unknown as number,
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
      .setIssuer('civitai')
      .setAudience('civitai-app-block')
      .setSubject('user:1')
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 600)
      .sign(key);
    expect(await verifyBlockToken(token)).toBeNull();
  });

  it('accepts a token that OMITS the maturity claim (legacy) — consumer fails closed', async () => {
    const { BlockTokenService } = await import('~/server/services/block-token.service');
    const r = await BlockTokenService.sign({ userId: 1, ...baseClaims });
    const claims = await verifyBlockToken(r.token);
    expect(claims).not.toBeNull();
    expect(claims?.maxBrowsingLevel).toBeUndefined();
  });
});

/**
 * Dev-token 4h lifetime + the per-token-type max-age cap.
 *
 * The dev-token endpoint mints with `dev: true` → a 4h lifetime + a `dev:true`
 * claim. `verifyBlockToken` reads that claim (AFTER the RS256 signature is
 * verified) to pick the max-age cap: 4h for dev, 15min for everything else.
 * This replaces the old global `maxTokenAge: '15m'` that would have rejected any
 * 4h dev token. These tests pin:
 *   - a dev token verifies < 4h and surfaces dev:true,
 *   - a dev token is REJECTED past 4h (cap is enforced, not unbounded),
 *   - a non-dev token is still rejected past 15min (prod lifetime unchanged) and
 *     accepted under 15min,
 *   - a non-boolean `dev` claim is rejected (shape guard),
 *   - a tampered-signature token carrying dev:true fails the signature gate
 *     (you can't forge dev:true).
 */
describe('dev-token 4h lifetime + per-type max-age cap', () => {
  const HOUR = 60 * 60;

  async function importPrivateKey() {
    const { importPKCS8 } = await import('jose');
    const { env } = await import('~/env/server');
    return importPKCS8(env.BLOCK_TOKEN_PRIVATE_KEY as string, 'RS256');
  }

  // Derive the kid the verifier expects from a real service-minted token.
  async function configuredKid(): Promise<string> {
    const { BlockTokenService } = await import('~/server/services/block-token.service');
    return BlockTokenService.getJwks().keys[0].kid;
  }

  const baseClaims = {
    blockId: 'b',
    appId: 'a',
    appBlockId: 'apb_a',
    blockInstanceId: 'bki_a',
    scopes: ['models:read:self'],
    ctx: { modelId: 1 },
  };

  /**
   * Sign a token whose `iat`/`exp` are anchored at `ageSeconds` AGO (so we can
   * simulate a token that has been alive for an arbitrary duration without
   * waiting). `exp` is set to iat + `lifetimeSeconds` so jwtVerify's own `exp`
   * check is satisfied independently of the age cap under test. `dev` and other
   * claim overrides pass through `extra`.
   */
  async function signAged(opts: {
    ageSeconds: number;
    lifetimeSeconds: number;
    extra?: Record<string, unknown>;
  }): Promise<string> {
    const key = await importPrivateKey();
    const kid = await configuredKid();
    const now = Math.floor(Date.now() / 1000);
    const iat = now - opts.ageSeconds;
    const exp = iat + opts.lifetimeSeconds;
    return new SignJWT({ ...baseClaims, sub: 'user:1', ...(opts.extra ?? {}) })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
      .setIssuer('civitai')
      .setAudience('civitai-app-block')
      .setSubject('user:1')
      .setJti('test-jti')
      .setIssuedAt(iat)
      .setNotBefore(iat)
      .setExpirationTime(exp)
      .sign(key);
  }

  it('a real dev-token mint (BlockTokenService.sign dev:true) verifies and carries dev:true at age < 4h', async () => {
    const { BlockTokenService } = await import('~/server/services/block-token.service');
    const r = await BlockTokenService.sign({ userId: 1, ...baseClaims, dev: true });
    // ~4h exp proves the longer lifetime was applied at sign time.
    const ttl = (new Date(r.expiresAt).getTime() - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(4 * HOUR - 120);
    expect(ttl).toBeLessThanOrEqual(4 * HOUR + 5);
    const claims = await verifyBlockToken(r.token);
    expect(claims).not.toBeNull();
    expect(claims?.dev).toBe(true);
  });

  it('accepts a dev token aged 3h (under the 4h cap, exp still valid)', async () => {
    // exp must outlive the age (a 4h-lifetime token at 3h is still valid).
    const token = await signAged({ ageSeconds: 3 * HOUR, lifetimeSeconds: 4 * HOUR, extra: { dev: true } });
    const claims = await verifyBlockToken(token);
    expect(claims).not.toBeNull();
    expect(claims?.dev).toBe(true);
  });

  it('REJECTS a dev token aged past 4h (cap is enforced, not unbounded)', async () => {
    // Sign with a deliberately over-long lifetime (5h) so jwtVerify's exp check
    // PASSES — isolating the per-type age cap as the thing that rejects. A
    // 4h05m-old token is past the 4h cap (+30s slack) → null. This is exactly
    // the "signer bug emitting a too-long exp" the belt defends against.
    const token = await signAged({
      ageSeconds: 4 * HOUR + 5 * 60,
      lifetimeSeconds: 5 * HOUR,
      extra: { dev: true },
    });
    expect(await verifyBlockToken(token)).toBeNull();
  });

  it('accepts a non-dev (default) token under 15min', async () => {
    const token = await signAged({ ageSeconds: 10 * 60, lifetimeSeconds: 15 * 60 });
    const claims = await verifyBlockToken(token);
    expect(claims).not.toBeNull();
    expect(claims?.dev).toBeUndefined();
  });

  it('REJECTS a non-dev (default) token past 15min — prod lifetime unchanged', async () => {
    // Over-long 4h lifetime so exp passes; the 15min default cap rejects it.
    // This proves removing the global maxTokenAge did NOT widen production: a
    // non-dev token still can't outlive 15min even if its exp says otherwise.
    const token = await signAged({ ageSeconds: 20 * 60, lifetimeSeconds: 4 * HOUR });
    expect(await verifyBlockToken(token)).toBeNull();
  });

  it('REJECTS a non-dev token past 15min even with dev:false (fails safe to the short cap)', async () => {
    const token = await signAged({
      ageSeconds: 20 * 60,
      lifetimeSeconds: 4 * HOUR,
      extra: { dev: false },
    });
    expect(await verifyBlockToken(token)).toBeNull();
  });

  it('REJECTS a token whose dev claim is non-boolean (shape guard)', async () => {
    // A string/number dev claim is rejected outright so the age-cap branch can
    // trust the boolean. (And a stringy "true" can never sneak into the 4h cap.)
    expect(
      await verifyBlockToken(
        await signAged({ ageSeconds: 60, lifetimeSeconds: 4 * HOUR, extra: { dev: 'true' } })
      )
    ).toBeNull();
    expect(
      await verifyBlockToken(
        await signAged({ ageSeconds: 60, lifetimeSeconds: 4 * HOUR, extra: { dev: 1 } })
      )
    ).toBeNull();
  });

  it('CANNOT forge dev:true — a tampered-signature token with dev:true fails verification', async () => {
    // Take a valid dev token and corrupt its signature segment. The RS256
    // signature gate (jwtVerify) runs BEFORE the dev claim is read, so a forged
    // dev:true never reaches the 4h cap.
    const good = await signAged({ ageSeconds: 60, lifetimeSeconds: 4 * HOUR, extra: { dev: true } });
    const [h, p] = good.split('.');
    // Re-sign nothing — just mangle the signature so the key check fails.
    const tampered = `${h}.${p}.AAAA${good.split('.')[2].slice(4)}`;
    expect(await verifyBlockToken(tampered)).toBeNull();
  });
});
