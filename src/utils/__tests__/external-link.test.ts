import { describe, expect, it } from 'vitest';
import { isExternalHref } from '~/utils/external-link';

const hosts = ['civitai.com', 'www.civitai.com', 'civitai.red'];

describe('isExternalHref', () => {
  it('treats a site-relative path as internal', () => {
    expect(isExternalHref('/models/123', hosts)).toBe(false);
  });

  it('treats a fragment or query-only href as internal', () => {
    expect(isExternalHref('#section', hosts)).toBe(false);
    expect(isExternalHref('?tab=posts', hosts)).toBe(false);
  });

  it('treats an empty or whitespace href as internal', () => {
    expect(isExternalHref('', hosts)).toBe(false);
    expect(isExternalHref('   ', hosts)).toBe(false);
  });

  it('treats a known host as internal regardless of case or trailing dot', () => {
    expect(isExternalHref('https://civitai.com/models/1', hosts)).toBe(false);
    expect(isExternalHref('https://CIVITAI.com/models/1', hosts)).toBe(false);
    expect(isExternalHref('https://civitai.com./models/1', hosts)).toBe(false);
  });

  it('treats an alias host as internal', () => {
    expect(isExternalHref('https://www.civitai.com/models/1', hosts)).toBe(false);
  });

  it('treats a host with a port as internal when the bare host matches', () => {
    expect(isExternalHref('http://civitai.com:3000/models/1', hosts)).toBe(false);
  });

  it('treats an unknown host as external', () => {
    expect(isExternalHref('https://t.me/SomeGroup', hosts)).toBe(true);
  });

  // A subdomain is a different origin and a different owner. `evil-civitai.com`
  // and `civitai.com.evil.test` are the attacks a suffix match would let through.
  it('does not treat a lookalike or subdomain host as internal', () => {
    expect(isExternalHref('https://evil-civitai.com/x', hosts)).toBe(true);
    expect(isExternalHref('https://civitai.com.evil.test/x', hosts)).toBe(true);
    expect(isExternalHref('https://cdn.civitai.com/x', hosts)).toBe(true);
  });

  // The announcement schema already refuses to store one, but a helper that reads
  // `//evil.com` as a relative path is a trap for the next caller.
  it('treats a scheme-relative URL as external', () => {
    expect(isExternalHref('//evil.com/x', hosts)).toBe(true);
  });

  it('treats a non-http scheme as internal, so it is never gated by this modal', () => {
    expect(isExternalHref('mailto:a@b.test', hosts)).toBe(false);
    expect(isExternalHref('javascript:alert(1)', hosts)).toBe(false);
  });

  it('is external when no internal hosts are known and the href is absolute', () => {
    expect(isExternalHref('https://civitai.com/x', [])).toBe(true);
  });
});
