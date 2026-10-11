import { describe, expect, it } from 'vitest';
import { getRequestCredential } from '~/server/auth/request-credential';
import { TokenScope } from '~/shared/constants/token-scope.constants';

describe('getRequestCredential', () => {
  it('reads every credential field the session layer recorded', () => {
    const context = {
      tokenScope: TokenScope.UserRead,
      apiKeyId: 17,
      apiKeyType: 'Access',
      subject: { type: 'oauth', id: 'client-abc' },
    };
    expect(getRequestCredential({ context })).toEqual(context);
  });

  it('keeps a recorded scope of zero', () => {
    expect(getRequestCredential({ context: { tokenScope: 0, apiKeyId: 17 } }).tokenScope).toBe(0);
  });

  it.each([
    ['a request with no context', {}],
    ['an empty context', { context: {} }],
    [
      'a context whose fields are null',
      { context: { tokenScope: null, apiKeyId: null, apiKeyType: null, subject: null } },
    ],
  ])('treats %s as a session: full scope, no key fields', (_label, req) => {
    expect(getRequestCredential(req)).toEqual({
      tokenScope: TokenScope.Full,
      apiKeyId: undefined,
      apiKeyType: undefined,
      subject: undefined,
    });
  });
});
