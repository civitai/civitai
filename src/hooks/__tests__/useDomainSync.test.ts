import { describe, expect, it } from 'vitest';
import { syncReturnUrl } from '~/hooks/useDomainSync';

const at = (qs: string) => `https://civitai.com/support?${qs}`;

describe('syncReturnUrl', () => {
  it('is null without the sync marker', () => {
    expect(syncReturnUrl(at('sync-redirect=/support-portal'))).toBeNull();
  });

  it('lands on the current page when there is no sync-redirect', () => {
    expect(syncReturnUrl(at('sync-account=red&x=1'))).toBe('/support?x=1');
  });

  it('honours a same-origin relative sync-redirect', () => {
    expect(syncReturnUrl(at('sync-account=red&sync-redirect=/support-portal'))).toBe(
      '/support-portal'
    );
    expect(syncReturnUrl(at('sync-account=red&sync-redirect=%2Fa%3Fb%3D1%23c'))).toBe('/a?b=1#c');
  });

  it.each([
    ['absolute url', 'https://evil.com/x'],
    ['protocol-relative', '//evil.com'],
    ['backslash', '/\\evil.com'],
    ['tab', '/\t/evil.com'],
    ['newline', '/\n/evil.com'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['dot-segment to //', '/.//evil.com'],
    ['no leading slash', 'evil.com'],
    ['empty', ''],
  ])('refuses %s and falls back to the current page', (_name, value) => {
    const href = at(`sync-account=red&sync-redirect=${encodeURIComponent(value)}`);
    expect(syncReturnUrl(href)).toBe('/support');
  });
});
