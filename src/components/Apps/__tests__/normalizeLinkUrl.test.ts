import { describe, expect, it } from 'vitest';
import { normalizeLinkUrl } from '~/components/Apps/offsiteSubmitFormConfig';
import { validateExternalUrl } from '~/server/schema/blocks/external-app.schema';

/**
 * W13 — External-link "Link URL" NORMALIZER. Locked policy: prepend https:// when
 * the scheme is missing, but REJECT an explicit http:// (no silent upgrade). Pins
 * every branch so the stored/submitted value is always a canonical https URL (or a
 * surfaced error) and can't drift from the shared `validateExternalUrl` contract.
 */

describe('normalizeLinkUrl — bare domain → https (prepend)', () => {
  it('prepends https:// to a bare host', () => {
    expect(normalizeLinkUrl('example.com')).toEqual({ url: 'https://example.com/' });
  });

  it('prepends https:// to a bare host + path', () => {
    expect(normalizeLinkUrl('example.com/app')).toEqual({ url: 'https://example.com/app' });
  });

  it('prepends https:// to a host:port (colon is a port, not a scheme)', () => {
    expect(normalizeLinkUrl('example.com:8443/app')).toEqual({
      url: 'https://example.com:8443/app',
    });
  });

  it('prepends https:// to a subdomain host', () => {
    expect(normalizeLinkUrl('vitrine.civitai.com')).toEqual({
      url: 'https://vitrine.civitai.com/',
    });
  });
});

describe('normalizeLinkUrl — explicit http:// is REJECTED (not upgraded)', () => {
  it('rejects http:// with the fix-it message', () => {
    expect(normalizeLinkUrl('http://example.com')).toEqual({
      url: '',
      error: 'Use https:// (or omit the scheme)',
    });
  });

  it('rejects HTTP:// case-insensitively', () => {
    expect(normalizeLinkUrl('HTTP://Example.com')).toEqual({
      url: '',
      error: 'Use https:// (or omit the scheme)',
    });
  });

  it('does NOT silently upgrade http:// to https:// (stays an error)', () => {
    const result = normalizeLinkUrl('http://example.com/app');
    expect(result.url).toBe('');
    expect(result.error).toBeDefined();
  });
});

describe('normalizeLinkUrl — valid https passthrough (canonicalized)', () => {
  it('keeps an https URL and canonicalizes it', () => {
    expect(normalizeLinkUrl('https://example.com/app')).toEqual({
      url: 'https://example.com/app',
    });
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(normalizeLinkUrl('  https://example.com/app  ')).toEqual({
      url: 'https://example.com/app',
    });
  });

  it('a bare host that normalizes then passes validateExternalUrl round-trips', () => {
    const result = normalizeLinkUrl('example.com/app');
    expect(result.error).toBeUndefined();
    // The normalized value is itself a valid external URL (server contract).
    expect(validateExternalUrl(result.url).ok).toBe(true);
  });
});

describe('normalizeLinkUrl — hostile schemes are rejected', () => {
  it.each([
    ['javascript pseudo-scheme', 'javascript:alert(1)'],
    ['data URI', 'data:text/html,<script>'],
    ['ftp scheme (has ://, not upgraded)', 'ftp://example.com'],
  ])('%s → error, empty url', (_label, input) => {
    const result = normalizeLinkUrl(input);
    expect(result.url).toBe('');
    expect(result.error).toBeDefined();
  });

  // NOTE: a scheme-LIKE prefix with no `://` and an `@` (e.g. `mailto:x@host`) is,
  // under the locked `://` policy, prepended to `https://mailto:x@host` — which
  // WHATWG-parses `mailto:x` as USERINFO. Since `validateExternalUrl` now rejects
  // any URL carrying userinfo (the phishing-vector fold-in), this is rejected.
  it('a scheme-like prefix that parses as userinfo is now rejected', () => {
    const result = normalizeLinkUrl('mailto:x@host.com');
    expect(result.url).toBe('');
    expect(result.error).toBeDefined();
  });
});

describe('normalizeLinkUrl — embedded credentials (userinfo) are rejected (mirrors the server)', () => {
  it.each([
    ['host-confusion', 'https://example.com@evil.com'],
    ['user:pass', 'https://user:pass@evil.com'],
    ['bare-domain host-confusion (no scheme)', 'example.com@evil.com'],
  ])('%s → error (credentials rejected)', (_label, input) => {
    const result = normalizeLinkUrl(input);
    expect(result.url).toBe('');
    expect(result.error).toMatch(/credential/i);
  });
});

describe('normalizeLinkUrl — empty / whitespace', () => {
  it('empty string → error', () => {
    const result = normalizeLinkUrl('');
    expect(result.url).toBe('');
    expect(result.error).toBe('externalUrl must not be empty');
  });

  it('whitespace-only → error', () => {
    const result = normalizeLinkUrl('   ');
    expect(result.url).toBe('');
    expect(result.error).toBe('externalUrl must not be empty');
  });
});
