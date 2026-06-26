import { describe, expect, it } from 'vitest';

import { parseApiKeyDeeplink } from '~/components/Account/apiKeyDeeplink';
import { TokenScopePresets } from '~/shared/constants/token-scope.constants';

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

  it('falls back to the least-privilege ReadOnly preset for a missing/unknown scope', () => {
    expect(parseApiKeyDeeplink({ addApiKey: '1' })).toEqual({
      name: '',
      tokenScope: TokenScopePresets.ReadOnly,
    });
    expect(parseApiKeyDeeplink({ addApiKey: '1', scope: 'Nope' })?.tokenScope).toBe(
      TokenScopePresets.ReadOnly
    );
  });

  it('NEVER pre-selects Full via a URL — a crafted scope=Full degrades to ReadOnly', () => {
    expect(parseApiKeyDeeplink({ addApiKey: '1', scope: 'Full' })?.tokenScope).toBe(
      TokenScopePresets.ReadOnly
    );
  });

  it('trims + length-clamps the name to the input maxLength (64)', () => {
    const long = 'x'.repeat(200);
    const r = parseApiKeyDeeplink({ addApiKey: '1', name: `  ${long}  `, scope: 'AIServices' });
    expect(r?.name).toBe('x'.repeat(64));
  });

  it('ignores array-valued name/scope params gracefully', () => {
    expect(
      parseApiKeyDeeplink({ addApiKey: '1', name: ['a', 'b'], scope: ['AIServices'] })
    ).toEqual({ name: '', tokenScope: TokenScopePresets.ReadOnly });
  });
});
