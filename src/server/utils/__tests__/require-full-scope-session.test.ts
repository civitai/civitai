import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  isFullScopeSession,
  requireFullScopeSession,
} from '~/server/utils/require-full-scope-session';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const REDUCED = TokenScope.Full & ~TokenScope.UserRead;

function request({
  context,
  authorization,
  query = {},
  url = '/api/x',
}: {
  context?: Record<string, unknown>;
  authorization?: string;
  query?: Record<string, unknown>;
  url?: string;
} = {}) {
  return {
    method: 'GET',
    url,
    headers: authorization ? { authorization } : {},
    query,
    ...(context ? { context } : {}),
  } as unknown as NextApiRequest;
}

const personalKey = (tokenScope: number, apiKeyType: string | null = 'User') => ({
  apiKeyId: 1,
  ...(apiKeyType ? { apiKeyType } : {}),
  subject: { type: 'apiKey', id: 1 },
  tokenScope,
});

describe('isFullScopeSession', () => {
  it('accepts a request with no bearer credential (a browser session)', () => {
    expect(isFullScopeSession(request())).toBe(true);
    expect(isFullScopeSession(request({ context: { session: {} } }))).toBe(true);
  });

  it('accepts a full-scope personal API key', () => {
    expect(
      isFullScopeSession(
        request({ authorization: 'Bearer k', context: personalKey(TokenScope.Full) })
      )
    ).toBe(true);
  });

  it('refuses a reduced-scope personal API key', () => {
    expect(
      isFullScopeSession(request({ authorization: 'Bearer k', context: personalKey(REDUCED) }))
    ).toBe(false);
  });

  it.each(['System', 'Access', 'Refresh', 'SomethingNew'])(
    'refuses a full-scope %s key',
    (apiKeyType) => {
      expect(
        isFullScopeSession(
          request({ authorization: 'Bearer k', context: personalKey(TokenScope.Full, apiKeyType) })
        )
      ).toBe(false);
    }
  );

  it('refuses a full-scope key whose type was not recorded', () => {
    expect(
      isFullScopeSession(
        request({ authorization: 'Bearer k', context: personalKey(TokenScope.Full, null) })
      )
    ).toBe(false);
  });

  it('refuses a User key that carries an OAuth subject', () => {
    const context = {
      apiKeyId: 4,
      apiKeyType: 'User',
      subject: { type: 'oauth', id: 'c' },
      tokenScope: TokenScope.Full,
    };
    expect(isFullScopeSession(request({ authorization: 'Bearer k', context }))).toBe(false);
  });

  it('refuses an OAuth token even at the full scope', () => {
    const context = {
      apiKeyId: 2,
      apiKeyType: 'Access',
      subject: { type: 'oauth', id: 'c' },
      tokenScope: TokenScope.Full,
    };
    expect(isFullScopeSession(request({ authorization: 'Bearer k', context }))).toBe(false);
  });

  it('refuses a token in the parsed query, and one only present in the raw url', () => {
    const context = personalKey(TokenScope.Full);
    expect(isFullScopeSession(request({ context, query: { token: 'k' } }))).toBe(false);
    expect(isFullScopeSession(request({ context, url: '/api/x?token=k' }))).toBe(false);
  });

  it('treats an Authorization header with no resolved credential context as a bearer', () => {
    expect(isFullScopeSession(request({ authorization: 'Bearer k' }))).toBe(false);
  });

  it.each([
    ['apiKeyId', { apiKeyId: 3 }],
    ['apiKeyType', { apiKeyType: 'User' }],
    ['subject', { subject: { type: 'oauth', id: 'c' } }],
    ['tokenScope', { tokenScope: TokenScope.Full }],
  ])('treats a context carrying only %s as a bearer', (_field, context) => {
    expect(isFullScopeSession(request({ context }))).toBe(false);
  });
});

describe('requireFullScopeSession', () => {
  function response() {
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    return res;
  }

  it('responds 403 and returns false when refused', () => {
    const res = response();
    const req = request({ authorization: 'Bearer k', context: personalKey(REDUCED) });
    expect(requireFullScopeSession(req, res as unknown as NextApiResponse)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledTimes(1);
  });

  it('writes nothing and returns true when allowed', () => {
    const res = response();
    expect(requireFullScopeSession(request(), res as unknown as NextApiResponse)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
