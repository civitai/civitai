import { describe, expect, it, vi } from 'vitest';
import {
  enforceContextBinding,
  parseSubjectUserId,
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
