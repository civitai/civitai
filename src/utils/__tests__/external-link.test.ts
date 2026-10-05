import { describe, expect, it } from 'vitest';
import {
  externalLinkInterstitialHref,
  isExternalHref,
  parseExternalDestination,
} from '~/utils/external-link';

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

  // The other direction, and the one that was broken: `useInternalHosts` seeds itself from
  // `window.location.host`, which carries the port, while an href is compared as `url.hostname`,
  // which never does. In local dev on :3000 that made every absolute internal link external.
  it('treats an internal host entry carrying a port as matching the bare host', () => {
    expect(isExternalHref('http://localhost:3000/models/1', ['localhost:3000'])).toBe(false);
    expect(isExternalHref('https://civitai.com/models/1', ['civitai.com:3000'])).toBe(false);
  });

  it('still rejects a lookalike when the internal host entry carries a port', () => {
    expect(isExternalHref('https://evil-civitai.com/x', ['civitai.com:3000'])).toBe(true);
    expect(isExternalHref('https://cdn.civitai.com/x', ['civitai.com:3000'])).toBe(true);
  });

  it('treats an unknown host as external', () => {
    expect(isExternalHref('https://t.me/SomeGroup', hosts)).toBe(true);
  });

  it('does not treat a lookalike or subdomain host as internal', () => {
    expect(isExternalHref('https://evil-civitai.com/x', hosts)).toBe(true);
    expect(isExternalHref('https://civitai.com.evil.test/x', hosts)).toBe(true);
    expect(isExternalHref('https://cdn.civitai.com/x', hosts)).toBe(true);
  });

  // Only the creator schema refuses to store one; announcementMetaSchema does not.
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

describe('parseExternalDestination', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    '/models/1',
    '//evil.test/x',
    '',
  ])('refuses %j', (value) => {
    expect(parseExternalDestination(value)).toBeNull();
  });

  it('refuses a repeated query parameter, which arrives as an array', () => {
    expect(parseExternalDestination(['https://a.test', 'https://b.test'])).toBeNull();
  });

  it('accepts an absolute http(s) URL', () => {
    expect(parseExternalDestination('https://t.me/SomeGroup')).toBe('https://t.me/SomeGroup');
  });
});

describe('externalLinkInterstitialHref', () => {
  // What the page will read back out of the href it is given: `/leaving` offers no way onward
  // unless this is an absolute http(s) URL.
  const landed = (destination: string) =>
    parseExternalDestination(
      new URL(externalLinkInterstitialHref(destination), 'https://civitai.com').searchParams.get(
        'url'
      )
    );

  it.each([
    ['https://t.me/SomeGroup', 'https://t.me/SomeGroup'],
    ['https://example.com/a b?x=1&y=two#frag', 'https://example.com/a%20b?x=1&y=two#frag'],
    [
      'https://example.com/?next=https%3A%2F%2Fother.test',
      'https://example.com/?next=https%3A%2F%2Fother.test',
    ],
    // Scheme-relative: external to `isExternalHref`, so it reaches here as a button link.
    ['//example.com/x', 'https://example.com/x'],
  ])('lands %j on the warning page as %j', (destination, expected) => {
    expect(landed(destination)).toBe(expected);
  });

  it('keeps the destination readable in the href', () => {
    expect(externalLinkInterstitialHref('https://t.me/SomeGroup')).toBe(
      '/leaving?url=https://t.me/SomeGroup'
    );
  });
});
