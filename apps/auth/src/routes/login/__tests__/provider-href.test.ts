import { describe, expect, it } from 'vitest';
import { providerStartHref } from '../provider-href';

describe('providerStartHref', () => {
  it('is absolute on the hub origin and keeps the query', () => {
    const params = new URLSearchParams({ returnUrl: 'https://training.civitai.com/x?a=1' });
    params.set('prompt', 'select_account');
    const href = providerStartHref('https://auth.civitai.com', 'discord', params);
    expect(href.startsWith('https://auth.civitai.com/login/discord?')).toBe(true);
    const url = new URL(href);
    expect(url.pathname).toBe('/login/discord');
    expect(url.searchParams.get('returnUrl')).toBe('https://training.civitai.com/x?a=1');
    expect(url.searchParams.get('prompt')).toBe('select_account');
  });
});
