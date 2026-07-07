import { describe, expect, it } from 'vitest';

import { extractListingMeta } from '~/server/utils/og-metadata';

/**
 * PURE OG/HTML metadata extraction — og:title/description/image + favicon/
 * apple-touch-icon + <title>, relative-URL resolution, and the missing-tags →
 * empty-object graceful case.
 */

const BASE = 'https://vendor.example.com/apps/cool';

describe('extractListingMeta', () => {
  it('pulls og:title / og:description / og:image + apple-touch-icon (absolute)', () => {
    const html = `
      <head>
        <meta property="og:title" content="Cool App" />
        <meta property="og:description" content="Does cool things" />
        <meta property="og:image" content="https://cdn.example.com/og.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="https://cdn.example.com/touch.png" />
      </head>`;
    expect(extractListingMeta(html, BASE)).toEqual({
      name: 'Cool App',
      tagline: 'Does cool things',
      coverImageUrl: 'https://cdn.example.com/og.png',
      iconImageUrl: 'https://cdn.example.com/touch.png',
    });
  });

  it('resolves RELATIVE asset URLs against the final page URL', () => {
    const html = `
      <meta property="og:image" content="/img/og.jpg">
      <link rel="icon" href="favicon.ico">`;
    const r = extractListingMeta(html, BASE);
    expect(r.coverImageUrl).toBe('https://vendor.example.com/img/og.jpg');
    // Relative to the page path (…/apps/cool) → …/apps/favicon.ico
    expect(r.iconImageUrl).toBe('https://vendor.example.com/apps/favicon.ico');
  });

  it('falls back to <title> for the name and meta[name=description] for the tagline', () => {
    const html = `<title>  Plain &amp; Simple  </title>
      <meta name="description" content="Fallback &quot;desc&quot;">`;
    const r = extractListingMeta(html, BASE);
    expect(r.name).toBe('Plain & Simple');
    expect(r.tagline).toBe('Fallback "desc"');
  });

  it('prefers apple-touch-icon, else the largest declared rel=icon', () => {
    const html = `
      <link rel="icon" sizes="16x16" href="/small.png">
      <link rel="icon" sizes="64x64" href="/big.png">`;
    expect(extractListingMeta(html, BASE).iconImageUrl).toBe('https://vendor.example.com/big.png');
  });

  it('uses twitter:image as a cover fallback when og:image is absent', () => {
    const html = `<meta name="twitter:image" content="https://cdn.example.com/tw.png">`;
    expect(extractListingMeta(html, BASE).coverImageUrl).toBe('https://cdn.example.com/tw.png');
  });

  it('returns {} for a page with no usable tags (graceful fallback)', () => {
    expect(extractListingMeta('<html><body><p>hi</p></body></html>', BASE)).toEqual({});
    expect(extractListingMeta('', BASE)).toEqual({});
  });

  it('drops a data: URI image (non-fetchable) rather than suggesting it', () => {
    const html = `<meta property="og:image" content="data:image/png;base64,AAAA">`;
    expect(extractListingMeta(html, BASE).coverImageUrl).toBeUndefined();
  });

  it('drops a non-https (http:) suggested image/icon so the preview matches the https-only accept path', () => {
    const html = `
      <meta property="og:image" content="http://cdn.example.com/og.png">
      <link rel="apple-touch-icon" href="http://cdn.example.com/touch.png">`;
    const r = extractListingMeta(html, BASE);
    expect(r.coverImageUrl).toBeUndefined();
    expect(r.iconImageUrl).toBeUndefined();
  });

  it('keeps a protocol-relative asset (//host/x) since it resolves to https against an https page', () => {
    const html = `<meta property="og:image" content="//cdn.example.com/og.png">`;
    expect(extractListingMeta(html, BASE).coverImageUrl).toBe('https://cdn.example.com/og.png');
  });

  it('clamps an over-long name to the listing name bound', () => {
    const long = 'x'.repeat(300);
    const r = extractListingMeta(`<meta property="og:title" content="${long}">`, BASE);
    expect(r.name?.length).toBe(120);
  });
});
