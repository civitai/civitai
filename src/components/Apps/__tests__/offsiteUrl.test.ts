import { describe, expect, it } from 'vitest';
import { isHttpsUrl } from '../offsiteUrl';

/**
 * W13 P3a — the defense-in-depth scheme guard for rendering a stored off-site
 * `externalUrl` as a clickable anchor on the mod/author surfaces. Only an https
 * URL becomes a link; everything else (http, javascript:, data:, non-string,
 * null/undefined) is treated as NON-clickable → rendered as inert text.
 */
describe('isHttpsUrl', () => {
  it('accepts https URLs (case-insensitive scheme)', () => {
    expect(isHttpsUrl('https://example.com/app')).toBe(true);
    expect(isHttpsUrl('HTTPS://Example.com')).toBe(true);
  });

  it('rejects non-https / dangerous schemes → inert text', () => {
    for (const u of [
      'http://insecure.example.com',
      // eslint-disable-next-line no-script-url
      'javascript:alert(1)',
      'data:text/html,alert(1)',
      'ftp://example.com',
      '//example.com',
      'example.com',
      ' https://leading-space.com',
    ]) {
      expect(isHttpsUrl(u)).toBe(false);
    }
  });

  it('rejects non-string / empty values', () => {
    expect(isHttpsUrl(null)).toBe(false);
    expect(isHttpsUrl(undefined)).toBe(false);
    expect(isHttpsUrl('')).toBe(false);
    expect(isHttpsUrl(123)).toBe(false);
    expect(isHttpsUrl({})).toBe(false);
  });
});
