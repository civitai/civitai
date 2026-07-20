import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * Middleware-level wiring for `enforceTokenScope` (the single OAuth
 * scope-verification choke point). These lock the properties a refactor could
 * silently break — that the audit emit is gated behind the deny throws, fires
 * exactly once AFTER next() settles, and never fires for session / API-key auth.
 *
 * We exercise the extracted `runEnforceTokenScope` directly with a synthetic
 * { ctx, meta, path, next } (mirroring middleware.trpc.test.ts), mocking the
 * audit emit so we assert the wiring, not the sink.
 */

const { mockEmit } = vi.hoisted(() => ({ mockEmit: vi.fn() }));

vi.mock('~/server/services/oauth/oauth-scope-audit', () => ({
  maybeRecordOauthScopeUsage: mockEmit,
}));

import { TokenScope } from '~/shared/constants/token-scope.constants';
import { runEnforceTokenScope } from '~/server/services/oauth/enforce-token-scope';

const OAUTH_CTX = {
  tokenScope: TokenScope.Full,
  apiKeyId: 5,
  subject: { type: 'oauth' as const, id: 'appblk-my-app' },
  user: { id: 42 },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runEnforceTokenScope — deny paths emit nothing', () => {
  it('blockApiKeys denies a token request BEFORE any emit (and never calls next)', async () => {
    const next = vi.fn(async () => ({ ok: true }));
    expect(() =>
      runEnforceTokenScope({
        ctx: OAUTH_CTX,
        meta: { blockApiKeys: true },
        path: 'buzz.tip',
        next,
      })
    ).toThrow(TRPCError);
    // If the emit were moved above the deny throw, this would fire → test fails.
    expect(mockEmit).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('a scoped OAuth token missing the required bit is denied with no emit', async () => {
    const next = vi.fn(async () => ({ ok: true }));
    expect(() =>
      runEnforceTokenScope({
        ctx: { ...OAUTH_CTX, tokenScope: TokenScope.ModelsRead },
        meta: { requiredScope: TokenScope.MediaWrite },
        path: 'image.upload',
        next,
      })
    ).toThrow(/required scope/i);
    expect(mockEmit).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

describe('runEnforceTokenScope — authorized external OAuth emits exactly one row', () => {
  it('records once (200) AFTER next() settles, with the right subject/scope/endpoint', async () => {
    const order: string[] = [];
    const next = vi.fn(async () => {
      order.push('next');
      return { ok: true };
    });
    mockEmit.mockImplementation(() => order.push('emit'));

    await runEnforceTokenScope({
      ctx: { ...OAUTH_CTX, tokenScope: TokenScope.ModelsRead },
      meta: { requiredScope: TokenScope.ModelsRead },
      path: 'model.getById',
      next,
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    // Emitted AFTER the resolver ran.
    expect(order).toEqual(['next', 'emit']);
    expect(mockEmit).toHaveBeenCalledWith({
      subject: { type: 'oauth', id: 'appblk-my-app' },
      userId: 42,
      scopeBit: TokenScope.ModelsRead,
      endpoint: 'model.getById',
      statusCode: 200,
    });
  });

  it('a Full-scope OAuth token on an unannotated endpoint records scope=Full', async () => {
    const next = vi.fn(async () => ({ ok: true }));
    await runEnforceTokenScope({
      ctx: OAUTH_CTX, // tokenScope Full, no requiredScope meta
      meta: undefined,
      path: 'account.getSettings',
      next,
    });
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0]).toMatchObject({ scopeBit: TokenScope.Full, statusCode: 200 });
  });

  it('a resolver ERROR (v11 { ok:false, error }) still emits exactly one row, mapped to the real status', async () => {
    const next = vi.fn(async () => ({ ok: false, error: new TRPCError({ code: 'NOT_FOUND' }) }));
    await runEnforceTokenScope({
      ctx: { ...OAUTH_CTX, tokenScope: TokenScope.ModelsRead },
      meta: { requiredScope: TokenScope.ModelsRead },
      path: 'model.getById',
      next,
    });
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0].statusCode).toBe(404);
  });

  it('a genuine next() REJECTION still emits one row, then re-throws', async () => {
    const boom = new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
    const next = vi.fn(async () => {
      throw boom;
    });
    await expect(
      runEnforceTokenScope({
        ctx: { ...OAUTH_CTX, tokenScope: TokenScope.ModelsRead },
        meta: { requiredScope: TokenScope.ModelsRead },
        path: 'model.getById',
        next,
      })
    ).rejects.toBe(boom);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0].statusCode).toBe(500);
  });
});

describe('runEnforceTokenScope — non-OAuth auth emits nothing and takes the bare next()', () => {
  it('a session request (no subject) records nothing and returns next() directly', async () => {
    const sentinel = { ok: true, marker: 'bare' };
    const next = vi.fn(async () => sentinel);
    const result = await runEnforceTokenScope({
      ctx: { tokenScope: TokenScope.Full, subject: undefined, user: { id: 42 } },
      meta: { requiredScope: TokenScope.ModelsRead },
      path: 'model.getById',
      next,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockEmit).not.toHaveBeenCalled();
    // Bare path: the exact next() result propagates unchanged.
    expect(result).toBe(sentinel);
  });

  it('a personal API key (subject.apiKey) records nothing', async () => {
    const next = vi.fn(async () => ({ ok: true }));
    await runEnforceTokenScope({
      ctx: {
        tokenScope: TokenScope.Full,
        apiKeyId: 9,
        subject: { type: 'apiKey', id: 9 },
        user: { id: 42 },
      },
      meta: { requiredScope: TokenScope.ModelsRead },
      path: 'model.getById',
      next,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
