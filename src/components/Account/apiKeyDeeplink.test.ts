import { describe, expect, it } from 'vitest';

import { parseApiKeyDeeplink } from '~/components/Account/apiKeyDeeplink';
import { TokenScope, TokenScopePresets } from '~/shared/constants/token-scope.constants';

describe('parseApiKeyDeeplink', () => {
  it('returns null without the addApiKey trigger', () => {
    expect(parseApiKeyDeeplink({})).toBeNull();
    expect(parseApiKeyDeeplink({ name: 'x', scope: 'AIServices' })).toBeNull();
  });

  it('prefills the name + the AIServices preset (the minimal dev:live scope)', () => {
    expect(
      parseApiKeyDeeplink({ addApiKey: '1', name: 'App Blocks dev:live', scope: 'AIServices' })
    ).toEqual({ name: 'App Blocks dev:live', tokenScope: TokenScopePresets.AIServices });
  });

  it('falls back to Full for a missing or unknown scope (never an invalid bitmask)', () => {
    expect(parseApiKeyDeeplink({ addApiKey: '1' })).toEqual({
      name: '',
      tokenScope: TokenScope.Full,
    });
    expect(parseApiKeyDeeplink({ addApiKey: '1', scope: 'Nope' })?.tokenScope).toBe(
      TokenScope.Full
    );
  });

  it('ignores array-valued name/scope params gracefully', () => {
    expect(
      parseApiKeyDeeplink({ addApiKey: '1', name: ['a', 'b'], scope: ['AIServices'] })
    ).toEqual({ name: '', tokenScope: TokenScope.Full });
  });
});
